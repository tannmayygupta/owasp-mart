// Tests for the S-14 check, the render command, the offline validator of vercel.json and the probe upstream (story LE-3). No network beyond 127.0.0.1: the real
// probe runs in this process and small proxies play a good Vercel rewrite and many broken ones. Whether the REAL Vercel behaves like the good one is what the live run decides.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProbe, numberParam } from '../infra/caddy/probe/server.mjs';
import { runChecks, validateVercelConfig, parseCli, renderProbe, originHost, PLACEHOLDER_HOST } from './check-sse-rewrite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-sse-rewrite.mjs');
const SECRET = 'set-by-the-proxy';
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const STREAM_MS = 100; // the stream interval used by the tests instead of the real 2000 ms

/** A small gate in front of the probe: 403 unless the secret is the one the proxy sets (plays Caddy; body "forbidden" like the real gate). */
function gate(upstreamPort, body = 'forbidden') {
  return http.createServer((req, res) => {
    if (req.headers['x-origin-secret'] !== SECRET) { res.writeHead(403); return res.end(body); }
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: req.headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => res.destroy());
    req.pipe(up);
    return undefined;
  });
}

/**
 * A proxy in front of the probe. Modes (each one a way a real rewrite could be wrong):
 * good, buffer (collects a whole stream), batch (flushes a stream in groups), cut (kills a stream after 150 ms), cache (keeps the first answer per URL),
 * nosecret (does not set the header), passvisitor (keeps a visitor secret, sets its own only when absent), dropcookie (no Set-Cookie), stripattrs (cookie attributes removed),
 * dropreqcookie (request cookie dropped), compress (adds content-encoding to the stream), rewritecc (rewrites cache-control of the stream), dropquery (query string lost), dropbody (POST body lost).
 */
function proxy(upstreamPort, mode = 'good') {
  const cache = new Map();
  return http.createServer((req, res) => {
    const headers = { ...req.headers };
    delete headers.host;
    if (mode === 'passvisitor') headers['x-origin-secret'] = req.headers['x-origin-secret'] ?? SECRET;
    else if (mode !== 'nosecret') headers['x-origin-secret'] = SECRET; // overwrites a visitor value, like the Vercel transform
    if (mode === 'dropreqcookie') delete headers.cookie;
    if (mode === 'dropbody') { delete headers['content-length']; delete headers['transfer-encoding']; }
    const target = mode === 'dropquery' && !req.url.includes('/stream') ? req.url.split('?')[0] : req.url;
    if (mode === 'cache' && req.method === 'GET' && !target.includes('/stream') && cache.has(target)) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-vercel-cache': 'HIT' });
      return res.end(cache.get(target));
    }
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, path: target, method: req.method, headers }, (ur) => {
      const sse = String(ur.headers['content-type']).includes('event-stream');
      const rh = { ...ur.headers };
      if (mode === 'dropcookie') delete rh['set-cookie'];
      if (mode === 'stripattrs' && rh['set-cookie']) rh['set-cookie'] = rh['set-cookie'].map((c) => c.replace(/;\s*(HttpOnly|Secure|SameSite=\w+)/gi, ''));
      if (mode === 'compress' && sse) rh['content-encoding'] = 'identity';
      if (mode === 'rewritecc' && sse) rh['cache-control'] = 'max-age=60';
      if (sse && (mode === 'buffer' || mode === 'batch')) {
        const chunks = [];
        const flush = () => { if (chunks.length) res.write(Buffer.concat(chunks.splice(0))); };
        res.writeHead(ur.statusCode, rh);
        if (mode === 'buffer') { ur.on('data', (c) => chunks.push(c)); ur.on('end', () => { flush(); res.end(); }); return; }
        // headers are sent at once, the data only in groups (5 events per flush)
        const t = setInterval(flush, STREAM_MS * 5);
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => { clearInterval(t); flush(); res.end(); });
        res.on('close', () => clearInterval(t));
        return;
      }
      if (mode === 'cache' && req.method === 'GET') { let b = ''; ur.on('data', (c) => (b += c)); ur.on('end', () => { cache.set(target, b); res.writeHead(ur.statusCode, rh); res.end(b); }); return; }
      res.writeHead(ur.statusCode, rh);
      ur.pipe(res);
      if (mode === 'cut' && sse) setTimeout(() => res.destroy(), 150);
    });
    up.on('error', () => res.destroy());
    if (mode === 'dropbody') { req.resume(); up.end(); } else req.pipe(up);
    return undefined;
  });
}

async function withRig(mode, fn, { gateBody } = {}) {
  const probe = createProbe({ heartbeatMs: 30 });
  const pp = await listen(probe);
  const gt = gate(pp, gateBody);
  const gp = await listen(gt);
  const px = proxy(mode === 'passvisitor' ? gp : pp, mode);
  const xp = await listen(px);
  try { return await fn(`http://127.0.0.1:${xp}`, { probePort: pp, gatePort: gp }); } finally { for (const s of [px, gt, probe]) { s.closeAllConnections(); s.close(); } }
}
const run = (url, o = {}) => runChecks({ url, holdMs: 300, streamIntervalMs: STREAM_MS, ...o });
const failing = (r) => r.lines.filter((l) => l.startsWith('FAIL')).map((l) => l.split(':')[0].slice(6));

test('a good rewrite passes every check; no secret value is printed; the information line is not a PASS', async () => {
  await withRig('good', async (url) => {
    const r = await run(url);
    assert.deepEqual(failing(r), [], r.lines.join('\n'));
    assert.equal(r.code, 0);
    const text = r.lines.join('\n');
    for (const n of ['echo-through-rewrite', 'visitor-header-overwritten', 'stream-steady', 'stream-no-compression', 'stream-cache-control', 'stream-longest', 'cookie-passthrough', 'no-shared-cache', 'request-body-and-query']) assert.match(text, new RegExp(`PASS  ${n}`), n);
    assert.match(text, /SKIP  direct-access-refused/);
    assert.match(text, /INFO  host-and-forwarding-seen/);
    assert.ok(!text.includes(SECRET));
  });
});

test('with --direct a good rewrite gives ten PASS lines (nine checks and the direct check)', async () => {
  await withRig('good', async (url) => {
    const g = http.createServer((q, s) => { s.writeHead(403); s.end('forbidden'); });
    const gp = await listen(g);
    try {
      const r = await run(url, { direct: `http://127.0.0.1:${gp}` });
      assert.equal(r.lines.filter((l) => l.startsWith('PASS')).length, 10, r.lines.join('\n'));
      assert.equal(r.code, 0);
    } finally { g.close(); }
  });
});

test('an event split across two network chunks is counted once (frames are read per blank line)', async () => {
  await withRig('good', async (url) => {
    const splitFetch = async (u, init) => {
      const res = await fetch(u, init);
      if (!String(u).includes('/stream?interval=') || String(u).includes('interval=600000')) return res;
      const reader = res.body.getReader();
      const body = new ReadableStream({
        async pull(c) {
          const { done, value } = await reader.read();
          if (done) return c.close();
          const mid = Math.floor(value.length / 2);
          c.enqueue(value.subarray(0, mid));
          await new Promise((r) => setTimeout(r, 5));
          c.enqueue(value.subarray(mid));
          return undefined;
        },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const r = await run(url, { fetchImpl: splitFetch });
    assert.deepEqual(failing(r), [], r.lines.join('\n'));
  });
});

// One failing case per check: the named check must fail (and the run exits 1).
const CASES = [
  ['buffer', 'stream-steady', 'a buffered rewrite (all events at the end)'],
  ['batch', 'stream-steady', 'events delivered in batches'],
  ['nosecret', 'echo-through-rewrite', 'a rewrite that does not set the secret header'],
  ['passvisitor', 'visitor-header-overwritten', 'a rewrite that forwards the visitor secret (the gate in front answers 403)'],
  ['compress', 'stream-no-compression', 'a content-encoding added to the stream'],
  ['rewritecc', 'stream-cache-control', 'a rewritten cache-control on the stream'],
  ['cache', 'no-shared-cache', 'a shared cache that keeps the first answer'],
  ['dropcookie', 'cookie-passthrough', 'Set-Cookie dropped'],
  ['stripattrs', 'cookie-passthrough', 'cookie attributes HttpOnly, Secure and SameSite removed'],
  ['dropreqcookie', 'cookie-passthrough', 'the request cookie header dropped'],
  ['dropquery', 'request-body-and-query', 'the query string lost'],
  ['dropbody', 'request-body-and-query', 'the POST body lost'],
];
for (const [mode, check, what] of CASES) {
  test(`${what} fails ${check}`, async () => {
    await withRig(mode, async (url) => {
      const r = await run(url);
      assert.ok(failing(r).includes(check), `${check} should fail:\n${r.lines.join('\n')}`);
      assert.equal(r.code, 1);
    });
  });
}

test('a stream cut by the rewrite is reported with its time and fails the longest-stream check', async () => {
  await withRig('cut', async (url) => {
    const r = await run(url, { holdMs: 2000 });
    assert.ok(failing(r).includes('stream-longest'), r.lines.join('\n'));
    assert.match(r.lines.find((l) => l.includes('stream-longest')), /CUT after/);
  });
});

test('direct access: 403 with the body "forbidden" passes; another body, an open origin and an unreachable origin fail', async () => {
  const mk = (status, body) => http.createServer((q, s) => { s.writeHead(status); s.end(body); });
  const servers = [mk(403, 'forbidden'), mk(403, 'nope'), mk(200, '{}')];
  const [ok, otherBody, open] = await Promise.all(servers.map(listen));
  try {
    await withRig('good', async (url) => {
      const f = async (d) => failing(await run(url, { direct: d })).includes('direct-access-refused');
      assert.equal(await f(`http://127.0.0.1:${ok}`), false);
      assert.equal(await f(`http://127.0.0.1:${otherBody}`), true);
      assert.equal(await f(`http://127.0.0.1:${open}`), true);
      assert.equal(await f('http://127.0.0.1:1'), true);
    });
  } finally { servers.forEach((s) => s.close()); }
});

test('a request that never answers is cut by the request timeout (no check waits forever)', async () => {
  const hang = http.createServer(() => {}); // never responds
  const hp = await listen(hang);
  try {
    const t0 = Date.now();
    const r = await runChecks({ url: `http://127.0.0.1:${hp}`, holdMs: 200, streamIntervalMs: STREAM_MS, requestTimeoutMs: 200 });
    assert.equal(r.code, 1);
    assert.ok(Date.now() - t0 < 8000, 'the run ended in time');
    assert.match(r.lines.find((l) => l.includes('echo-through-rewrite')), /request failed/);
  } finally { hang.closeAllConnections(); hang.close(); }
});

test('an unreachable url fails every live check and exits 1 without throwing', async () => {
  const r = await run('http://127.0.0.1:1');
  assert.equal(r.code, 1);
  assert.ok(failing(r).length >= 8);
});

test('parseCli: https only, no credentials, hold range, validate alone, render needs out', () => {
  assert.deepEqual(parseCli(['--url', 'https://a.vercel.app', '--hold', '5']), { validate: false, url: 'https://a.vercel.app', holdMs: 5000 });
  assert.equal(parseCli(['--url', 'https://a.vercel.app', '--direct', 'https://b.example']).direct, 'https://b.example');
  assert.match(parseCli([]).error, /--url is required/);
  assert.match(parseCli(['--url', 'http://a.vercel.app']).error, /https/);
  assert.match(parseCli(['--url', 'https://u:p@a.vercel.app']).error, /credentials/);
  assert.match(parseCli(['--url', 'https://a.vercel.app', '--hold', '0']).error, /--hold/);
  assert.match(parseCli(['--url']).error, /needs a value/);
  assert.match(parseCli(['--url', 'https://a.vercel.app', '--bogus']).error, /unknown argument/);
  assert.deepEqual(parseCli(['--validate']), { validate: true });
  assert.deepEqual(parseCli(['--validate', 'x.json']), { validate: true, config: 'x.json' });
  assert.match(parseCli(['--validate', '--url', 'https://a.vercel.app']).error, /cannot be combined/);
  assert.deepEqual(parseCli(['--render', 'https://a.duckdns.org', '--out', 'd']), { render: 'https://a.duckdns.org', out: 'd' });
  assert.match(parseCli(['--render', 'https://a.duckdns.org']).error, /go together/);
  assert.match(parseCli(['--out', 'd']).error, /go together/);
  assert.match(parseCli(['--render', 'https://a.duckdns.org', '--out', 'd', '--url', 'https://a.vercel.app']).error, /cannot be combined/);
});

// ---- offline validator
const good = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'infra', 'vercel', 's14-probe', 'vercel.json'), 'utf8'));

test('validator: the committed vercel.json of the probe project is valid and has the placeholder host, no brace variables', () => {
  assert.deepEqual(validateVercelConfig(good()), []);
  const text = fs.readFileSync(path.join(ROOT, 'infra', 'vercel', 's14-probe', 'vercel.json'), 'utf8');
  assert.ok(text.includes(`https://${PLACEHOLDER_HOST}/api/$1`));
  assert.ok(!text.includes('${'), 'only transform args use $VAR (documented); dest is a plain URL');
});

test('validator: each broken shape is named, none crashes', () => {
  const mutate = (fn) => { const c = good(); fn(c); return validateVercelConfig(c).join(' | '); };
  assert.match(validateVercelConfig([]).join(), /JSON object/);
  assert.match(validateVercelConfig(null).join(), /JSON object/);
  for (const k of ['rewrites', 'redirects', 'headers', 'cleanUrls', 'trailingSlash']) {
    assert.match(mutate((c) => { c[k] = k === 'cleanUrls' || k === 'trailingSlash' ? true : []; }), new RegExp(`"${k}" cannot be combined with "routes"`), k);
  }
  assert.match(mutate((c) => { c.routes = []; }), /exactly one route/);
  assert.match(mutate((c) => { c.routes = [null]; }), /route must be an object/);
  assert.match(mutate((c) => { c.routes = 'x'; }), /exactly one route/);
  assert.match(mutate((c) => { c.routes[0].transforms = [null]; }), /transform must be an object/);
  assert.match(mutate((c) => { c.routes[0].transforms = [5]; }), /transform must be an object/);
  assert.match(mutate((c) => { c.routes[0].transforms = ['x']; }), /transform must be an object/);
  assert.match(mutate((c) => { c.routes[0].transforms = []; }), /exactly one transform/);
  assert.match(mutate((c) => { c.routes[0].transforms[0].op = 'append'; }), /op must be "set"/);
  assert.match(mutate((c) => { c.routes[0].transforms[0].type = 'response.headers'; }), /request\.headers/);
  assert.match(mutate((c) => { c.routes[0].transforms[0].target.key = 'x-other'; }), /target must be exactly/);
  assert.match(mutate((c) => { c.routes[0].transforms[0].target = 'x-origin-secret'; }), /target must be exactly/);
  assert.match(mutate((c) => { c.routes[0].transforms[0].target.extra = 'v'; }), /target must be exactly/);
  assert.match(mutate((c) => { c.routes[0].transforms[0].args = 'abc'; }), /args must be exactly/, 'even a short literal secret is refused');
  assert.match(mutate((c) => { c.routes[0].transforms[0].args = '$OTHER'; }), /args must be exactly/);
  assert.match(mutate((c) => { delete c.routes[0].transforms[0].env; }), /transform env/);
  assert.match(mutate((c) => { c.routes[0].transforms[0].env = ['ORIGIN_SECRET', 'AWS_KEY']; }), /transform env/);
  assert.match(mutate((c) => { c.routes[0].dest = 'https://origin.example.org/api/$1'; }), /route dest must be/);
  assert.match(mutate((c) => { c.routes[0].dest = 'https://a.duckdns.org/$1'; }), /route dest must be/);
  assert.match(mutate((c) => { c.routes[0].dest = '${ORIGIN_URL}/api/$1'; }), /route dest must be/);
  assert.match(mutate((c) => { c.routes[0].src = '/(.*)'; }), /src must be/);
  assert.match(mutate((c) => { c.routes[0].env = ['ORIGIN_URL']; }), /unexpected route key "env"/);
  assert.match(mutate((c) => { c.routes[0].note = 'hunter2'; }), /unexpected route key "note"/);
  // S-14 live finding (2026-10-18): the cache opt-out must sit inside the route, with value 0 and nothing else.
  assert.match(mutate((c) => { delete c.routes[0].headers; }), /x-vercel-enable-rewrite-caching/);
  assert.match(mutate((c) => { c.routes[0].headers['x-vercel-enable-rewrite-caching'] = '1'; }), /x-vercel-enable-rewrite-caching/);
  assert.match(mutate((c) => { c.routes[0].headers['cache-control'] = 'public'; }), /x-vercel-enable-rewrite-caching/);
  assert.match(mutate((c) => { c.routes[0].transforms[0].note = 'hunter2'; }), /unexpected transform key/);
  assert.match(mutate((c) => { c.extra = 'x'; }), /unexpected top-level key "extra"/);
  assert.match(mutate((c) => { c.$schema = 'https://evil.example/schema.json'; }), /"\$schema" must be/);
  assert.equal(mutate((c) => { c.routes[0].dest = 'https://some-name.duckdns.org/api/$1'; }), '', 'a rendered file (real DuckDNS label) is valid');
});

test('originHost and renderProbe: only https://<label>.duckdns.org is accepted; the output is the probe folder with the host filled in and valid', () => {
  assert.equal(originHost('https://my-platform.duckdns.org'), 'my-platform.duckdns.org');
  assert.equal(originHost('https://my-platform.duckdns.org/'), 'my-platform.duckdns.org');
  for (const bad of ['http://a.duckdns.org', 'https://evil.example', 'https://a.b.duckdns.org', 'https://a.duckdns.org/path', 'https://a.duckdns.org:8443', 'https://u@a.duckdns.org', 'https://a.duckdns.org/?x=1', 'duckdns.org', 'https://duckdns.org', `https://${PLACEHOLDER_HOST}`, '', 'not a url']) assert.equal(originHost(bad), null, bad);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-render-'));
  try {
    const out = path.join(dir, 'deploy');
    renderProbe({ origin: 'https://my-platform.duckdns.org', outDir: out });
    const cfg = JSON.parse(fs.readFileSync(path.join(out, 'vercel.json'), 'utf8'));
    assert.equal(cfg.routes[0].dest, 'https://my-platform.duckdns.org/api/$1');
    assert.deepEqual(validateVercelConfig(cfg), []);
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
    assert.ok(!fs.readFileSync(path.join(out, 'vercel.json'), 'utf8').includes('REPLACE'));
    assert.throws(() => renderProbe({ origin: 'https://evil.example', outDir: path.join(dir, 'x') }), /refused origin/);
    assert.ok(!fs.existsSync(path.join(dir, 'x')), 'nothing is written for a refused origin');
    assert.throws(() => renderProbe({ origin: 'https://a.duckdns.org', outDir: path.join(ROOT, 'infra', 'vercel', 's14-probe') }), /source folder/);
    // the command line: exit codes and the printed line
    const ok = spawnSync(process.execPath, [SCRIPT, '--render', 'https://my-platform.duckdns.org', '--out', path.join(dir, 'cli')], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^PASS  rendered and validated/);
    const bad = spawnSync(process.execPath, [SCRIPT, '--render', 'https://evil.example', '--out', path.join(dir, 'cli2')], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /refused origin/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validator command: exit 0 for the committed file, exit 1 and the problem for a bad one, exit 2 for bad usage', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--validate'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /PASS/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-vercel-'));
  try {
    const bad = good();
    bad.routes[0].transforms = [null];
    const f = path.join(dir, 'vercel.json');
    fs.writeFileSync(f, JSON.stringify(bad));
    const r = spawnSync(process.execPath, [SCRIPT, '--validate', f], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL.*transform must be an object/);
    assert.ok(!r.stderr.includes('TypeError'), 'no stack trace');
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--bogus'], { cwd: ROOT, encoding: 'utf8' }).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the probe upstream
test('probe numberParam: null, empty and non-numeric give the default; the rest is cut to the range', () => {
  assert.equal(numberParam(null, 1000, 10, 60000), 1000);
  assert.equal(numberParam('', 1000, 10, 60000), 1000);
  assert.equal(numberParam('   ', 1000, 10, 60000), 1000);
  assert.equal(numberParam('abc', 1000, 10, 60000), 1000);
  assert.equal(numberParam('NaN', 1000, 10, 60000), 1000);
  assert.equal(numberParam('1', 1000, 10, 60000), 10);
  assert.equal(numberParam('999999', 1000, 10, 60000), 60000);
  assert.equal(numberParam('250.9', 1000, 10, 60000), 250);
  assert.equal(numberParam('99999', 600, 1, 3600), 3600, 'the maximum stream age has a ceiling');
});

test('probe: an empty interval and heartbeat do not make a 10 ms flood, and a stream ends at its maximum age', async () => {
  const probe = createProbe({ heartbeatMs: 15000 });
  const port = await listen(probe);
  try {
    const t0 = Date.now();
    const text = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/v1/stream?interval=&heartbeat=&count=&max=1' }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
        res.on('error', reject);
      }).on('error', reject);
    });
    assert.ok(Date.now() - t0 < 4000, 'ended at the maximum age (1 s)');
    assert.ok((text.match(/^event: tick$/gm) ?? []).length <= 2, `at most the default rate (1 per second), got ${(text.match(/^event: tick$/gm) ?? []).length}`);
  } finally { probe.closeAllConnections(); probe.close(); }
});

test('probe: the cacheable endpoint is public with a random body per request; echo returns the POST body and query', async () => {
  const probe = createProbe();
  const port = await listen(probe);
  const get = (p, opt = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, ...opt }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ res, body: JSON.parse(b) })); });
    r.on('error', reject);
    r.end(opt.payload);
  });
  try {
    const a = await get('/api/v1/cacheable');
    const b = await get('/api/v1/cacheable');
    assert.equal(a.res.headers['cache-control'], 'public, max-age=60');
    assert.notEqual(a.body.rand, b.body.rand);
    const e = await get('/api/v1/echo?x=1', { method: 'POST', payload: 'hello' });
    assert.equal(e.body.body, 'hello');
    assert.equal(e.body.path, '/api/v1/echo?x=1');
    assert.equal(e.body.secretPresent, false);
  } finally { probe.closeAllConnections(); probe.close(); }
});
