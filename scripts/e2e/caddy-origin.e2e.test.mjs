// End-to-end tests of the origin-secret gate and the unbuffered stream (story LE-3, ADR 0031) with STOCK Caddy (digest pinned in infra/caddy/compose.p.yaml)
// and the probe upstream, both in Docker. Needs Docker running; the production-shape tests also need openssl (they are skipped with a message without it).
// Run: node --test scripts/e2e/caddy-origin.e2e.test.mjs   (any single test also passes alone: --test-name-pattern)
// The secrets are random per test and live only in temporary folders and in memory; nothing is written to the repository.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CADDY_DIR = path.join(ROOT, 'infra', 'caddy');
const composeText = fs.readFileSync(path.join(CADDY_DIR, 'compose.p.yaml'), 'utf8');
const compose = yaml.load(composeText);
// One source of truth for the image digests and run flags: the compose file of vm-p.
const CADDY_IMAGE = compose.services.caddy.image;
const NODE_IMAGE = compose.services.probe.image;
const RUN = `vm-origin-${randomBytes(3).toString('hex')}`;
const NET = `${RUN}-net`;
const SOCK = 'unix//tmp/caddy-admin.sock';
const RELOAD = ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--address', SOCK];
const sh = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: 240000, ...opts });
const hex = () => randomBytes(32).toString('hex'); // 64 lower-case hex characters, like `openssl rand -hex 32`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-origin-secrets-'));
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-origin-empty-'));
const extraDirs = [];
const containers = [];
let port; let failClosedPort; let probePort;
const CUR = 'origin_secret_current';
const PREV = 'origin_secret_previous';

const hostPort = (name, inner) => {
  const r = sh(['port', name, `${inner}/tcp`]);
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim().split('\n')[0].split(':').pop());
};

/** One request with exact headers (a header with an empty value is possible here, unlike with curl). Resolves to {status, body, headers}; never throws inside a callback. */
const req = (p, headers = {}, to = port, { tls = false, method = 'GET', payload } = {}) => new Promise((resolve, reject) => {
  const mod = tls ? https : http;
  const r = mod.request({ host: '127.0.0.1', port: to, path: p, method, headers, timeout: 8000, ...(tls ? { agent: new https.Agent({ rejectUnauthorized: false }), servername: 'localhost' } : {}) }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    res.on('error', reject);
  });
  r.on('error', reject);
  r.end(payload);
});
const waitUp = async (to, tls = false) => {
  for (let i = 0; i < 80; i++) {
    try { await req('/', {}, to, { tls }); return; } catch { await sleep(250); }
  }
  throw new Error('caddy did not come up');
};
const probeHits = async () => JSON.parse((await req('/api/v1/hits', {}, probePort)).body).hits;
const containerSees = (name, file) => sh(['exec', name, 'sh', '-c', `cat /run/secrets/${file} 2>/dev/null`]).stdout.trim();

/**
 * Give the main rig its own secrets for ONE test (null removes a file) and wait until the container sees them (a bind mount on Docker Desktop can lag).
 * The files are written in place and the test restores the defaults in finally (withSecrets).
 */
async function setSecrets({ current = null, previous = null }) {
  for (const [name, value] of [[CUR, current], [PREV, previous]]) {
    const file = path.join(secretDir, name);
    if (value === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, value === '' ? '' : `${value}\n`);
  }
  for (const [name, value] of [[CUR, current], [PREV, previous]]) {
    let seen;
    for (let i = 0; i < 30; i++) { seen = containerSees(`${RUN}-caddy`, name); if (seen === (value ?? '')) break; await sleep(100); }
    assert.equal(seen, value ?? '', `the container did not see the new ${name} within 3 s`);
  }
}
async function withSecrets(secrets, fn) {
  try { await setSecrets(secrets); await fn(); } finally { await setSecrets({}); }
}

/** The run flags of a compose service as docker run arguments, so the production-shape test starts the container exactly as compose.p.yaml describes it. */
function composeFlags(svc, mounts) {
  const a = [];
  if (svc.user) a.push('--user', String(svc.user));
  if (svc.read_only) a.push('--read-only');
  for (const c of svc.cap_drop ?? []) a.push('--cap-drop', c);
  for (const c of svc.cap_add ?? []) a.push('--cap-add', c);
  for (const s of svc.security_opt ?? []) a.push('--security-opt', s);
  for (const t of svc.tmpfs ?? []) a.push('--tmpfs', t);
  for (const [k, v] of Object.entries(svc.environment ?? {})) a.push('-e', `${k}=${v}`);
  for (const v of svc.volumes ?? []) {
    const [host, inner, mode] = v.split(':');
    const hostPath = host.startsWith('./') ? path.join(CADDY_DIR, host.slice(2)) : mounts[inner];
    assert.ok(hostPath, `the compose file has a mount (${inner}) that this test does not know: add it to the test`);
    a.push('-v', `${hostPath}:${inner}${mode ? `:${mode}` : ''}`);
  }
  return a;
}

before(() => {
  const info = sh(['info', '--format', '{{.ServerVersion}}'], { timeout: 20000 });
  assert.ok(info.status === 0 && /^\d/.test(info.stdout.trim()), 'Docker is not running: start Docker Desktop, then run the e2e tests again.');
  assert.equal(sh(['network', 'create', NET]).status, 0);
  const pr = sh(['run', '-d', '--name', `${RUN}-probe`, '--network', NET, '--network-alias', 'probe', '-p', '127.0.0.1::8080', '-e', 'HEARTBEAT_MS=200',
    '-v', `${path.join(CADDY_DIR, 'probe')}:/app:ro`, NODE_IMAGE, 'node', '/app/server.mjs']);
  assert.equal(pr.status, 0, pr.stderr);
  containers.push(`${RUN}-probe`);
  probePort = hostPort(`${RUN}-probe`, 8080);
  fs.writeFileSync(path.join(secretDir, CUR), `${hex()}\n`); // placeholders so the mount exists; every test sets its own
  for (const [name, dir] of [[`${RUN}-caddy`, secretDir], [`${RUN}-closed`, emptyDir]]) {
    const r = sh(['run', '-d', '--name', name, '--network', NET, '-p', '127.0.0.1::8080', '-e', 'UPSTREAM=probe:8080',
      '-v', `${path.join(CADDY_DIR, 'Caddyfile.test')}:/etc/caddy/Caddyfile:ro`,
      '-v', `${path.join(CADDY_DIR, 'origin-gate.caddy')}:/etc/caddy/origin-gate.caddy:ro`,
      '-v', `${dir}:/run/secrets:ro`, CADDY_IMAGE]);
    assert.equal(r.status, 0, r.stderr);
    containers.push(name);
  }
  port = hostPort(`${RUN}-caddy`, 8080);
  failClosedPort = hostPort(`${RUN}-closed`, 8080);
});
after(() => {
  for (const n of containers) sh(['rm', '-f', n]);
  sh(['network', 'rm', NET]);
  for (const d of [secretDir, emptyDir, ...extraDirs]) fs.rmSync(d, { recursive: true, force: true });
});
const ready = async () => { await waitUp(port); await waitUp(failClosedPort); for (let i = 0; i < 60; i++) { try { await req('/api/v1/healthz', {}, probePort); return; } catch { await sleep(250); } } };

test('no secret: 403 and the upstream is not called', async () => {
  await ready();
  await withSecrets({ current: hex() }, async () => {
    const before = await probeHits();
    const r = await req('/api/v1/echo');
    assert.equal(r.status, 403);
    assert.equal(r.body, 'forbidden');
    assert.equal(await probeHits(), before);
  });
});

test('wrong, empty, near-miss, short, upper-case and non-hex secrets: 403, upstream not called', async () => {
  await ready();
  const secret = hex();
  await withSecrets({ current: secret }, async () => {
    const before = await probeHits();
    for (const v of [hex(), '', `${secret}x`, secret.slice(0, -1), secret.toUpperCase(), '*', 'x'.repeat(64)]) {
      assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': v })).status, 403, `value ${v.length} chars`);
    }
    assert.equal(await probeHits(), before);
  });
});

test('right secret: proxied, the upstream sees the client address header and the /api prefix, the echo never returns the secret', async () => {
  await ready();
  const secret = hex();
  await withSecrets({ current: secret }, async () => {
    const r = await req('/api/v1/echo', { 'X-Origin-Secret': secret, 'X-Forwarded-For': '203.0.113.9' });
    assert.equal(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    assert.equal(j.secretPresent, true);
    assert.equal(j.headers['x-edge-forwarded-for'], '203.0.113.9');
    assert.ok(!r.body.includes(secret));
    assert.equal(j.path, '/api/v1/echo', 'the /api prefix reaches the upstream unchanged (ADR 0031 D2)');
  });
});

test('rotation: new in current and old in previous both accepted, then the old one removed leaves only the new', async () => {
  await ready();
  const oldS = hex(); const newS = hex();
  await withSecrets({ current: oldS }, async () => {
    assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': oldS })).status, 200);
    await setSecrets({ current: newS, previous: oldS });
    assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': newS })).status, 200);
    assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': oldS })).status, 200);
    await setSecrets({ current: newS });
    assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': newS })).status, 200);
    assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': oldS })).status, 403);
  });
});

test('a secret file with a * (wildcard in Caddy\'s header matcher) never opens the gate; a 64-hex secret does; a file of another length or case never matches', async () => {
  await ready();
  const probeHeader = hex();
  for (const bad of ['*', `${probeHeader.slice(0, 10)}*`, `*${probeHeader.slice(10)}`, `${hex()}*`]) {
    await withSecrets({ current: bad }, async () => {
      assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': probeHeader })).status, 403, `current file ${bad.length} chars with *`);
    });
    await withSecrets({ current: hex(), previous: bad }, async () => {
      assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': probeHeader })).status, 403, `previous file ${bad.length} chars with *`);
    });
  }
  const good = hex();
  await withSecrets({ current: good }, async () => assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': good })).status, 200));
  const short = hex().slice(0, 32);
  await withSecrets({ current: short }, async () => assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': short })).status, 403, 'a 32-character secret is refused'));
  const upper = hex().toUpperCase();
  await withSecrets({ current: upper }, async () => assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': upper })).status, 403, 'upper-case hex is refused'));
});

test('SSE: events reach the client spread over time, not at the end (flush_interval -1)', async () => {
  await ready();
  const secret = hex();
  await withSecrets({ current: secret }, async () => {
    const stamps = [];
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/api/v1/stream?interval=400&count=6&heartbeat=100000', headers: { 'X-Origin-Secret': secret } }, (res) => {
        try {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers['content-type'], /text\/event-stream/);
          assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
          assert.equal(res.headers['content-encoding'], undefined, 'no compression');
        } catch (e) { res.destroy(); return reject(e); }
        res.on('data', (c) => { for (const _ of c.toString().matchAll(/^event: tick$/gm)) stamps.push(Date.now() - t0); });
        res.on('end', resolve);
        res.on('error', reject);
        return undefined;
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(stamps.length, 6);
    assert.ok(stamps[0] < 1500, `the first event arrived early (${stamps[0]} ms)`);
    assert.ok(stamps[5] - stamps[0] >= 1500, `the events were spread over ${stamps[5] - stamps[0]} ms (6 events, 400 ms apart, would be about 2000)`);
  });
});

test('SSE heartbeat comments pass through while no event is due', async () => {
  await ready();
  const secret = hex();
  await withSecrets({ current: secret }, async () => {
    const text = await new Promise((resolve, reject) => {
      let buf = '';
      let done = false;
      const r = http.request({ host: '127.0.0.1', port, path: '/api/v1/stream?interval=60000&heartbeat=150&max=10', headers: { 'X-Origin-Secret': secret } }, (res) => {
        res.on('data', (c) => { buf += c; if (!done && (buf.match(/^: heartbeat/gm) ?? []).length >= 2) { done = true; resolve(buf); r.destroy(); } });
        res.on('error', () => {});
      });
      r.on('error', (e) => (done ? undefined : reject(e)));
      r.end();
    });
    assert.match(text, /^retry: 3000$/m);
    assert.ok((text.match(/^: heartbeat/gm) ?? []).length >= 2);
  });
});

test('logs: requests are logged and the secret never appears (current, previous, wrong or empty)', async () => {
  await ready();
  const cur = hex(); const prev = hex(); const wrong = hex();
  await withSecrets({ current: cur, previous: prev }, async () => {
    await req('/api/v1/echo', { 'X-Origin-Secret': cur });
    await req('/api/v1/echo', { 'X-Origin-Secret': prev });
    await req('/api/v1/echo', { 'X-Origin-Secret': wrong });
    // a stream the client abandons makes the proxy log a warning with the request headers (found by this test)
    await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port, path: '/api/v1/stream?interval=60000&heartbeat=100000&max=5', headers: { 'X-Origin-Secret': cur } }, (res) => { res.on('data', () => { r.destroy(); resolve(); }); res.on('error', () => {}); }); r.on('error', () => resolve()); r.end(); });
    await sleep(700);
    const logs = sh(['logs', `${RUN}-caddy`]);
    const text = logs.stdout + logs.stderr;
    assert.match(text, /\/api\/v1\/echo/, 'the access log has lines');
    for (const s of [cur, prev, wrong]) assert.ok(!text.includes(s), 'a secret value is in the log');
  });
});

test('no secret file at start: Caddy is up and refuses every request, including an empty header (fail closed)', async () => {
  await ready();
  for (const h of [{}, { 'X-Origin-Secret': '' }, { 'X-Origin-Secret': 'anything' }, { 'X-Origin-Secret': hex() }]) {
    assert.equal((await req('/api/v1/echo', h, failClosedPort)).status, 403, JSON.stringify(h));
  }
});

test('an empty secret file also fails closed', async () => {
  await ready();
  await withSecrets({ current: '' }, async () => {
    for (const h of [{}, { 'X-Origin-Secret': '' }, { 'X-Origin-Secret': hex() }]) assert.equal((await req('/api/v1/echo', h)).status, 403, JSON.stringify(h));
  });
});

test('Caddyfile.p adapts: the default logger deletes the secret header, the access log does too, the admin endpoint is a unix socket, the stream is unbuffered', () => {
  const r = sh(['run', '--rm', '-v', `${path.join(CADDY_DIR, 'Caddyfile.p')}:/etc/caddy/Caddyfile:ro`, '-v', `${path.join(CADDY_DIR, 'origin-gate.caddy')}:/etc/caddy/origin-gate.caddy:ro`,
    CADDY_IMAGE, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(r.stdout);
  const enc = cfg.logging?.logs?.default?.encoder;
  assert.equal(enc?.format, 'filter', 'the default logger uses a filter encoder');
  assert.deepEqual(enc?.fields?.['request>headers>X-Origin-Secret'], { filter: 'delete' });
  const access = Object.entries(cfg.logging.logs).find(([k]) => k !== 'default');
  assert.deepEqual(access?.[1]?.encoder?.fields?.['request>headers>X-Origin-Secret'], { filter: 'delete' }, 'the access log deletes it too');
  assert.equal(cfg.admin?.listen, SOCK, 'the admin endpoint is the unix socket, not a TCP port');
  assert.match(r.stdout, /"flush_interval":-1/);
  assert.match(r.stdout, /fullchain\.pem/);
  assert.match(r.stdout, /\[0-9a-f\]\{64\}/, 'the 64-hex rule is in the adapted gate');
});

test('caddy reload through the admin socket succeeds in the running container (the renewal hook of H-115)', async () => {
  await ready();
  const secret = hex();
  await withSecrets({ current: secret }, async () => {
    const r = sh(['exec', `${RUN}-caddy`, ...RELOAD]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': secret })).status, 200, 'the gate still works after the reload');
  });
});

// ------------------------------------------------------------------ production shape: the REAL Caddyfile.p with the flags of compose.p.yaml, TLS on a mapped port
const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
const SKIP_PROD = openssl.status !== 0 ? 'openssl is not installed: the production-shape tests need it to make a self-signed certificate' : false;

/** Start the REAL Caddyfile.p and gate with the flags of compose.p.yaml. mounts maps the container path of each non-./ mount to a host path. */
async function startProduction(tag, { certDir, curFile, prevFile }) {
  const name = `${RUN}-prod-${tag}`;
  const svc = compose.services.caddy;
  const args = ['run', '-d', '--name', name, '--network', NET, '-p', '127.0.0.1::443',
    ...composeFlags({ ...svc, environment: { ...svc.environment, UPSTREAM: 'probe:8080' } }, { '/certs': certDir, [`/run/secrets/${CUR}`]: curFile, [`/run/secrets/${PREV}`]: prevFile }), svc.image];
  const r = sh(args);
  assert.equal(r.status, 0, r.stderr);
  containers.push(name);
  const p = hostPort(name, 443);
  try { await waitUp(p, true); } catch (e) {
    const l = sh(['logs', '--tail', '40', name]); // the container's own words in the failure (a Linux runner differs from Docker Desktop)
    throw new Error(`${e.message}\n${l.stdout}${l.stderr}`);
  }
  return { name, port: p };
}
function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-origin-certs-'));
  fs.chmodSync(dir, 0o755); // mkdtemp makes 0700; the container (root without CAP_DAC_OVERRIDE, cap_drop ALL) is not the owner on a Linux runner
  extraDirs.push(dir);
  const g = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'privkey.pem'), '-out', path.join(dir, 'fullchain.pem'), '-days', '1', '-subj', '/CN=localhost'], { encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  // In production the key is 0600 root and the container runs as root, its owner. Here the owner is the test user, and cap_drop ALL removes the root override, so make it readable.
  fs.chmodSync(path.join(dir, 'privkey.pem'), 0o644);
  return dir;
}
const tmpFile = (dir, name, value) => { const f = path.join(dir, name); fs.writeFileSync(f, value); return f; };

test('production shape: the real Caddyfile.p with the flags of compose.p.yaml serves TLS, refuses without the secret, proxies with it, reloads through the socket, logs no secret', { skip: SKIP_PROD }, async () => {
  await ready();
  const certDir = makeCert();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-origin-prod-'));
  fs.chmodSync(dir, 0o755);
  extraDirs.push(dir);
  const secret = hex();
  const prod = await startProduction('ok', { certDir, curFile: tmpFile(dir, CUR, `${secret}\n`), prevFile: tmpFile(dir, PREV, '') });
  const ins = JSON.parse(sh(['inspect', prod.name]).stdout)[0];
  assert.equal(ins.HostConfig.ReadonlyRootfs, true, 'read-only root');
  assert.deepEqual(ins.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(ins.HostConfig.CapAdd.map((c) => c.replace(/^CAP_/, '')), ['NET_BIND_SERVICE']);
  assert.ok(ins.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  const denied = await req('/api/v1/echo', {}, prod.port, { tls: true });
  assert.equal(denied.status, 403);
  assert.equal(denied.body, 'forbidden');
  const wrong = await req('/api/v1/echo', { 'X-Origin-Secret': hex() }, prod.port, { tls: true });
  assert.equal(wrong.status, 403);
  const ok = await req('/api/v1/echo', { 'X-Origin-Secret': secret }, prod.port, { tls: true });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(JSON.parse(ok.body).secretPresent, true);
  const reload = sh(['exec', prod.name, ...RELOAD]);
  assert.equal(reload.status, 0, `reload in the read-only container: ${reload.stdout}${reload.stderr}`);
  assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': secret }, prod.port, { tls: true })).status, 200, 'the gate works after the reload');
  const logs = sh(['logs', prod.name]);
  assert.ok(!(logs.stdout + logs.stderr).includes(secret), 'the secret is not in the log of the production-shape container');
  assert.match(logs.stdout + logs.stderr, /\/api\/v1\/echo/);
});

test('production shape, secret file missing at start: Docker creates a directory, Caddy fails closed, and the runbook preflight (test -f) catches it', { skip: SKIP_PROD }, async () => {
  await ready();
  const certDir = makeCert();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-origin-prod-'));
  fs.chmodSync(dir, 0o755);
  extraDirs.push(dir);
  const missingCur = path.join(dir, CUR); // never created: the short -v syntax (and compose) make Docker create a DIRECTORY here
  const prevFile = tmpFile(dir, PREV, '');
  const prod = await startProduction('missing', { certDir, curFile: missingCur, prevFile });
  assert.ok(fs.statSync(missingCur).isDirectory(), 'Docker created a directory at the missing host path');
  for (const h of [{}, { 'X-Origin-Secret': hex() }, { 'X-Origin-Secret': '' }]) {
    assert.equal((await req('/api/v1/echo', h, prod.port, { tls: true })).status, 403, `fail closed: ${JSON.stringify(h)}`);
  }
  // The preflight of the runbook, the same command on the same mount: it fails for a directory and passes for a file.
  const pre = (cur, prev) => sh(['run', '--rm', '-v', `${cur}:/s/current:ro`, '-v', `${prev}:/s/previous:ro`, CADDY_IMAGE, 'sh', '-c', 'test -f /s/current && test -f /s/previous']).status;
  assert.notEqual(pre(missingCur, prevFile), 0, 'test -f fails when a secret path is a directory');
  const goodCur = tmpFile(dir, 'current-ok', `${hex()}\n`);
  assert.equal(pre(goodCur, prevFile), 0, 'test -f passes for two files');
});

test('production shape, previous file missing at start (a directory) but current present: the current secret works and nothing else does', { skip: SKIP_PROD }, async () => {
  await ready();
  const certDir = makeCert();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-origin-prod-'));
  fs.chmodSync(dir, 0o755);
  extraDirs.push(dir);
  const secret = hex();
  const missingPrev = path.join(dir, PREV);
  const prod = await startProduction('noprev', { certDir, curFile: tmpFile(dir, CUR, `${secret}\n`), prevFile: missingPrev });
  assert.ok(fs.statSync(missingPrev).isDirectory());
  assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': secret }, prod.port, { tls: true })).status, 200);
  assert.equal((await req('/api/v1/echo', { 'X-Origin-Secret': hex() }, prod.port, { tls: true })).status, 403);
});
