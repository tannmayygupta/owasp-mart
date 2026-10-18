// The detection helper integration (story 6.5, D-70): one test per row of the I/O matrix. The helper (Go, Coraza and CRS) is faked here by a
// tiny Node HTTP server; the real helper is tested by services/sidecar/crs/crs_test.go and by scripts/crs-accuracy.mjs. The rule that every
// test checks again: the player's bytes are the same with or without the helper, whatever the helper does.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createCrs, mapTags, mapRuleIds, mapScore, buildInspectDoc, matchData } from '../src/crs.mjs';
import { main } from '../src/main.mjs';
import { buildCapture } from '../src/capture.mjs';
import { closeServer, listen } from '../src/common.mjs';
import { startServer } from '../../../contracts/mocks/fake-ingest/server.mjs';
import { freshValues, startDoc, flagOf, fakeFlag, until, wait, request, freePort, shop, boot } from './helpers.mjs';

const hashOf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const quietIngest = (v) => startServer({ key: v.event_key, instance: v.instance_id, epoch: v.epoch, port: 0, host: '127.0.0.1', log: () => {} });
const eventsOf = (ing, type) => ing.ingest.stored.map((x) => x.event).filter((e) => e.type === type);

const SQLI = { rule_ids: ['942100', '942190'], tags: ['application-multi', 'language-multi', 'platform-multi', 'attack-sqli', 'paranoia-level/1', 'OWASP_CRS', 'capec/1000/152/248/66'], anomaly_score: 10 };

// A fake helper: answer(doc) -> object | { delay, body, status }. Records every document it received and when.
async function fakeHelper(answer) {
  const docs = [];
  const server = http.createServer((req, res) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', async () => {
      const at = Date.now();
      let doc = null;
      try { doc = JSON.parse(Buffer.concat(c).toString('utf8')); } catch { /* recorded as null */ }
      docs.push({ doc, at, path: req.url, method: req.method });
      const a = (await answer(doc)) ?? {};
      if (a.delay) await wait(a.delay);
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
      res.end(a.raw ?? JSON.stringify(a.body ?? a));
    });
  });
  return { server, docs, port: await listen(server, 0, '127.0.0.1') };
}

// Boots a sidecar (and a shop that returns a fixed page) with a crs object that talks to the given port; returns the player's answer for a request.
async function setup({ helperPort, v = freshValues(), page = '<p>hello</p>', crsOptions = {} }) {
  const ing = await quietIngest(v);
  const up = await shop(() => ({ headers: { 'content-type': 'text/html' }, body: page }));
  const crs = helperPort === null ? null : createCrs({ manage: false, port: helperPort, ...crsOptions });
  const b = await boot({ relayPort: ing.port, upstreamPort: up.port, v, crs });
  const stop = async () => { await b.sc.stop(); await closeServer(ing.server); await closeServer(up.server); };
  return { b, ing, up, crs, v, stop };
}

test('tag map: CRS tags to ^[a-z0-9_]{1,32}$, only attack-, language-, platform-, at most 20, no repeats; a long tag is cut at 32', () => {
  assert.deepEqual(mapTags(['attack-sqli']), ['attack_sqli']);
  assert.deepEqual(mapTags(SQLI.tags), ['language_multi', 'platform_multi', 'attack_sqli']);
  const long = 'attack-' + 'x'.repeat(60);
  assert.equal(mapTags([long])[0].length, 32);
  assert.deepEqual(mapTags(['ATTACK-Rce', 'attack-rce', 'attack-protocol', 'attack-a.b/c d']), ['attack_rce', 'attack_protocol', 'attack_a_b_c_d']);
  assert.equal(mapTags(Array.from({ length: 40 }, (_, i) => `attack-t${i}`)).length, 20);
  assert.deepEqual(mapTags([1, null, {}, 'language-']), ['language_']);
  assert.deepEqual(mapTags('x'), []);
  for (const t of mapTags(Array.from({ length: 40 }, (_, i) => `platform-Odd Tag/${i}`))) assert.match(t, /^[a-z0-9_]{1,32}$/);
});

test('rule ids are numeric, 3 to 9 digits, at most 50; the score is an integer capped at 10000', () => {
  assert.deepEqual(mapRuleIds(['942100', 942190, '12', '1234567890', 'abc', '942100', '9421x0']), ['942100', '942190']);
  assert.equal(mapRuleIds(Array.from({ length: 80 }, (_, i) => String(100000 + i))).length, 50);
  assert.equal(mapScore(5), 5); assert.equal(mapScore(99999), 10000); assert.equal(mapScore(-3), 0); assert.equal(mapScore(1.5), 0); assert.equal(mapScore('7'), 0);
  assert.equal(matchData({ rule_ids: [], tags: ['attack-sqli'], anomaly_score: 9 }), null);
  assert.equal(matchData(null), null);
  assert.deepEqual(matchData({ rule_ids: ['942100'], tags: ['attack-sqli'], anomaly_score: 5, action: 'deny', status: 403 }), { rule_ids: ['942100'], tags: ['attack_sqli'], anomaly_score: 5 });
});

test('the document sent to the helper holds no cookie, authorization or x-vm-* header and no flag-like text; the body is cut at 8 KiB', () => {
  const flag = fakeFlag();
  const doc = buildInspectDoc({
    method: 'POST', url: `/api/x?q=1&t=${flag}`,
    headers: { host: 'shop', cookie: 'sid=abc', authorization: 'Bearer abc', 'x-vm-session-kind': 'bot', 'x-note': `see ${flag}`, 'user-agent': 'ua' },
    bodyBuf: Buffer.from(JSON.stringify({ password: 'hunter2', q: `a ${flag}`, pad: 'x'.repeat(9000) })),
  });
  const text = JSON.stringify(doc);
  assert.ok(!text.includes(flag) && !text.includes('sid=abc') && !text.includes('Bearer'));
  assert.deepEqual(Object.keys(doc.headers).sort(), ['host', 'user-agent', 'x-note']);
  assert.ok(doc.body.length <= 8192);
  assert.equal(doc.method, 'POST');
});

test('a classic login injection in a password field reaches the helper (review finding C2) while the evidence capture still blanks the field', () => {
  const attack = "' OR 1=1--";
  const doc = buildInspectDoc({ method: 'POST', url: '/login', headers: { 'content-type': 'application/json' },
    bodyBuf: Buffer.from(JSON.stringify({ email: 'a@b.c', password: attack })) });
  assert.ok(doc.body.includes(attack), 'the helper sees the payload');
  const form = buildInspectDoc({ method: 'POST', url: '/login?token=' + encodeURIComponent(attack), headers: {}, bodyBuf: Buffer.from('email=a%40b.c&password=' + encodeURIComponent(attack)) });
  assert.ok(form.body.includes(encodeURIComponent(attack)) && form.uri.includes(encodeURIComponent(attack)));
  const kept = buildCapture({ method: 'POST', url: '/login', headers: {}, bodyBuf: Buffer.from(JSON.stringify({ password: attack })) });
  assert.ok(!kept.body.includes(attack), 'the stored capture is blanked');
});

test('a Referer or Origin with a secret query value is blanked in the stored capture (review finding C9)', () => {
  const kept = buildCapture({ method: 'GET', url: '/x', headers: { referer: 'https://shop.test/a?token=abc123&password=hunter2&q=1', origin: 'https://shop.test' }, bodyBuf: null });
  assert.ok(!JSON.stringify(kept).includes('abc123') && !JSON.stringify(kept).includes('hunter2'));
  assert.ok(kept.headers_redacted.referer.includes('q=1') && kept.headers_redacted.origin === 'https://shop.test');
});

test('SQLi: a valid proxy.crs_match with attack_sqli reaches the fake ingest, after the answer was sent; the answer is byte-identical to a run without the helper', async () => {
  const page = '<p>products</p>';
  const helper = await fakeHelper(() => ({ delay: 120, body: SQLI }));
  const ctx = await setup({ helperPort: helper.port, page });
  const plain = await setup({ helperPort: null, page });
  try {
    const path = '/api/products/search?q=%27%20UNION%20SELECT%201,2,3,4--';
    const t0 = Date.now();
    const r = await request(ctx.b.ports.playerPort, { path, headers: { cookie: 'sid=secret-cookie', 'user-agent': 'x' } });
    const took = Date.now() - t0;
    const r0 = await request(plain.b.ports.playerPort, { path, headers: { cookie: 'sid=secret-cookie', 'user-agent': 'x' } });
    assert.equal(hashOf(r.body), hashOf(r0.body));
    assert.equal(r.status, r0.status);
    assert.ok(took < 100, `the player did not wait for the helper (${took} ms)`);
    assert.ok(await until(() => eventsOf(ctx.ing, 'proxy.crs_match').length === 1), 'event delivered');
    const e = eventsOf(ctx.ing, 'proxy.crs_match')[0];
    assert.equal(e.source, 'sidecar');
    assert.deepEqual(e.data, { rule_ids: ['942100', '942190'], tags: ['language_multi', 'platform_multi', 'attack_sqli'], anomaly_score: 10, route_template: '/api/products/search' });
    assert.equal(ctx.ing.ingest.security.length, 0);
    assert.equal(helper.docs.length, 1);
    assert.equal(helper.docs[0].path, '/inspect'); assert.equal(helper.docs[0].method, 'POST');
    assert.ok(!JSON.stringify(helper.docs[0].doc).includes('secret-cookie'), 'the cookie never reaches the helper');
    assert.equal(eventsOf(plain.ing, 'proxy.crs_match').length, 0);
  } finally { await ctx.stop(); await plain.stop(); await closeServer(helper.server); }
});

test('SSRF: an answer with an attack tag becomes an event; the same code path serves any family', async () => {
  const helper = await fakeHelper(() => ({ rule_ids: ['931130'], tags: ['attack-rfi', 'attack-ssrf'], anomaly_score: 5 }));
  const ctx = await setup({ helperPort: helper.port });
  try {
    await request(ctx.b.ports.playerPort, { method: 'POST', path: '/api/import', headers: { 'content-type': 'application/json' }, body: '{"url":"http://169.254.169.254/latest/user-data"}' });
    assert.ok(await until(() => eventsOf(ctx.ing, 'proxy.crs_match').length === 1));
    assert.deepEqual(eventsOf(ctx.ing, 'proxy.crs_match')[0].data.tags, ['attack_rfi', 'attack_ssrf']);
    assert.match(helper.docs[0].doc.body, /169\.254\.169\.254/);
  } finally { await ctx.stop(); await closeServer(helper.server); }
});

test('benign and logic bug: no match from the helper means no event', async () => {
  const helper = await fakeHelper(() => ({ rule_ids: [], tags: [], anomaly_score: 0 }));
  const ctx = await setup({ helperPort: helper.port });
  try {
    for (const p of ['/api/products/search?q=blue+lamp', '/api/refunds', '/api/auth/legacy-login']) await request(ctx.b.ports.playerPort, { path: p });
    assert.ok(await until(() => helper.docs.length === 3));
    await wait(80);
    assert.equal(eventsOf(ctx.ing, 'proxy.crs_match').length, 0);
    assert.equal(ctx.crs.stats.crs_matches, 0);
  } finally { await ctx.stop(); await closeServer(helper.server); }
});

test('detect only: an answer that carries an action, a status or a block changes nothing: no field of it reaches the event or the player', async () => {
  const page = '<p>ok</p>';
  const helper = await fakeHelper(() => ({ body: { rule_ids: ['942100'], tags: ['attack-sqli'], anomaly_score: 10000000, action: 'deny', status: 403, interruption: { action: 'drop' }, redirect: 'http://evil.example/' } }));
  const ctx = await setup({ helperPort: helper.port, page });
  try {
    const r = await request(ctx.b.ports.playerPort, { path: '/x?a=%27%20OR%201=1--' });
    assert.equal(r.status, 200); assert.equal(r.text, page); assert.equal(r.headers.location, undefined);
    assert.ok(await until(() => eventsOf(ctx.ing, 'proxy.crs_match').length === 1));
    const e = eventsOf(ctx.ing, 'proxy.crs_match')[0];
    assert.deepEqual(Object.keys(e.data).sort(), ['anomaly_score', 'route_template', 'rule_ids', 'tags']);
    assert.equal(e.data.anomaly_score, 10000);
  } finally { await ctx.stop(); await closeServer(helper.server); }
});

test('helper down: traffic and flag events continue, crs_unavailable counted, no crs event', async () => {
  const v = freshValues();
  const page = `<p>${flagOf(v, 'C05')}</p>`;
  const ctx = await setup({ helperPort: await freePort(), v, page });
  try {
    const r = await request(ctx.b.ports.playerPort, { path: '/a' });
    assert.equal(r.text, page);
    assert.ok(await until(() => eventsOf(ctx.ing, 'proxy.flag_seen').length === 1), 'flag events still go out');
    assert.ok(await until(() => ctx.crs.stats.crs_unavailable === 1));
    assert.equal(eventsOf(ctx.ing, 'proxy.crs_match').length, 0);
  } finally { await ctx.stop(); }
});

test('helper slow: an answer after the 300 ms limit is abandoned, counted, no event; the player is not delayed', async () => {
  const helper = await fakeHelper(() => ({ delay: 700, body: SQLI }));
  const ctx = await setup({ helperPort: helper.port });
  try {
    const t0 = Date.now();
    const r = await request(ctx.b.ports.playerPort, { path: '/a?x=%27%20UNION%20SELECT%201--' });
    assert.ok(Date.now() - t0 < 200);
    assert.equal(r.status, 200);
    assert.ok(await until(() => ctx.crs.stats.crs_timeouts === 1, 2000));
    await wait(700);
    assert.equal(eventsOf(ctx.ing, 'proxy.crs_match').length, 0);
  } finally { await ctx.stop(); await closeServer(helper.server); }
});

test('busy: at most 8 calls in flight, the others are skipped and counted; every player request is answered', async () => {
  const helper = await fakeHelper(() => ({ delay: 500, body: SQLI }));
  const ctx = await setup({ helperPort: helper.port, crsOptions: { timeoutMs: 400 } });
  try {
    const rs = await Promise.all(Array.from({ length: 14 }, (_, i) => request(ctx.b.ports.playerPort, { path: `/p${i}` })));
    assert.ok(rs.every((r) => r.status === 200 && r.text === '<p>hello</p>'));
    assert.ok(await until(() => ctx.crs.stats.crs_calls + ctx.crs.stats.crs_busy === 14, 2000));
    assert.equal(ctx.crs.stats.crs_calls, 8);
    assert.equal(ctx.crs.stats.crs_busy, 6);
    assert.ok(ctx.crs.inFlight() <= 8);
  } finally { await ctx.stop(); await closeServer(helper.server); }
});

test('helper answers garbage, a 500 or a huge document: counted as errors, no event, traffic fine', async () => {
  for (const a of [{ raw: 'not json' }, { status: 500, body: {} }, { raw: JSON.stringify({ rule_ids: 'x' }) }, { raw: '"x"' }, { raw: JSON.stringify({ pad: 'y'.repeat(100000) }) }]) {
    const helper = await fakeHelper(() => a);
    const ctx = await setup({ helperPort: helper.port });
    try {
      assert.equal((await request(ctx.b.ports.playerPort, { path: '/a' })).status, 200);
      assert.ok(await until(() => helper.docs.length === 1));
      await wait(60);
      assert.equal(eventsOf(ctx.ing, 'proxy.crs_match').length, 0);
    } finally { await ctx.stop(); await closeServer(helper.server); }
  }
});

test('big body: a 20 KiB POST reaches the helper cut to 8 KiB (the helper then inspects the first 8 KiB, ProcessPartial)', async () => {
  const helper = await fakeHelper(() => ({ rule_ids: [], tags: [], anomaly_score: 0 }));
  const ctx = await setup({ helperPort: helper.port });
  try {
    const big = 'a'.repeat(20 * 1024);
    const r = await request(ctx.b.ports.playerPort, { method: 'POST', path: '/api/x', headers: { 'content-type': 'text/plain' }, body: big });
    assert.equal(r.status, 200);
    assert.ok(await until(() => helper.docs.length === 1));
    assert.equal(helper.docs[0].doc.body.length, 8192);
    assert.equal(ctx.up.seen[0].body.length, 20 * 1024, 'the shop still got the whole body');
  } finally { await ctx.stop(); await closeServer(helper.server); }
});

test('no binary: the helper is off without an error; --no-crs is accepted and turns it off', async () => {
  const none = createCrs({ binary: '/definitely/not/here/crs-detect' });
  assert.equal(none.enabled, false);
  assert.equal(await none.inspect({ method: 'GET', url: '/', headers: {} }), null);
  assert.equal(createCrs({ binary: '/bin/sh', enabled: false, existsFn: () => true }).enabled, false);
  const seen = [];
  const v = freshValues();
  const wrapped = { createSidecar: (o) => { seen.push(o.crs); return { listen: async () => ({ playerPort: 1, eventsPort: 2 }), nextSeq: () => 1 }; } };
  const log = console.log; console.log = () => {};
  try {
    const r = await main(['--no-crs', '--relay', 'http://127.0.0.1:1/x'], {}, { stdin: Readable.from([JSON.stringify(startDoc(v))]), deps: wrapped });
    assert.equal(r, null);
  } finally { console.log = log; }
  assert.equal(seen[0].enabled, false);
});

test('supervisor: spawned without a shell with the loopback address; restarted at most 3 times in a minute, then an alarm line once and no more tries', async () => {
  const spawned = [];
  const alarms = [];
  const spawnFn = (bin, args, opts) => {
    const c = new EventEmitter(); c.kill = () => {}; spawned.push({ bin, args, opts });
    setImmediate(() => c.emit('exit', 1));
    return c;
  };
  const crs = createCrs({ binary: '/app/crs-detect', existsFn: () => true, spawnFn, restartDelayMs: 1, alarm: (m) => alarms.push(m) });
  try {
    assert.ok(await until(() => alarms.length === 1, 2000));
    await wait(80);
    assert.equal(spawned.length, 4, 'the first start and three restarts');
    assert.equal(crs.stats.crs_restarts, 3);
    assert.equal(crs.stats.crs_gave_up, 1);
    assert.equal(spawned[0].bin, '/app/crs-detect');
    assert.deepEqual(spawned[0].args.slice(0, 2), ['--listen', '127.0.0.1:9100']);
    assert.equal(spawned[0].opts.shell, false);
    assert.match(alarms[0], /^alarm: crs helper stopped/);
  } finally { crs.stop(); }
});

test('supervisor: a spawn that throws does not stop the sidecar', async () => {
  const crs = createCrs({ binary: '/app/crs-detect', existsFn: () => true, spawnFn: () => { throw new Error('no'); }, restartDelayMs: 1 });
  try {
    await wait(30);
    assert.equal(await crs.inspect({ method: 'GET', url: '/', headers: {} }), null);
  } finally { crs.stop(); }
});
