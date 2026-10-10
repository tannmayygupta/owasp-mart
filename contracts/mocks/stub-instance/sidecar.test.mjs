// Unit tests of the stub sidecar (IF-4 sections 3 to 6): answers to the shop, seq from first_seq, signing, retry and drop rules, bounded buffer.
// The relay side is either the real fake ingest (contracts/mocks/fake-ingest) or a scripted server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { createSidecar, readStartDocument } from './sidecar.mjs';
import { startServer } from '../fake-ingest/server.mjs';
import { listen, closeServer } from './common.mjs';
import { postedEvent } from './shop.mjs';
import { freshValues, sidecarStartDocument } from './fixtures.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(15); }
  return false;
}
function request(port, { method = 'POST', path = '/v1/events', headers = { 'content-type': 'application/json' }, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t, headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function boot({ relayPort, v = freshValues(), ...opts }) {
  const alarms = [];
  const start = sidecarStartDocument(v);
  const sc = createSidecar({ start, relayUrl: `http://127.0.0.1:${relayPort}/internal/v1/events`, upstreamUrl: 'http://127.0.0.1:1', alarm: (m) => alarms.push(m), retryMinMs: 15, retryMaxMs: 60, requestTimeoutMs: 500, ...opts });
  const ports = await sc.listen({ eventsPort: 0, playerPort: 0, host: '127.0.0.1' });
  return { sc, ports, v, alarms, post: (body, extra = {}) => request(ports.eventsPort, { body: typeof body === 'string' ? body : JSON.stringify(body), ...extra }) };
}

test('start document: a valid one is read once; a bad one is refused', async () => {
  const v = freshValues();
  const ok = await readStartDocument(Readable.from([JSON.stringify(sidecarStartDocument(v))]));
  assert.equal(ok.ok, true);
  assert.equal(ok.start.first_seq, v.first_seq);
  for (const bad of ['', '{', JSON.stringify({ ...sidecarStartDocument(v), first_seq: 0 }), JSON.stringify({ ...sidecarStartDocument(v), event_key: 'short' }), JSON.stringify({ ...sidecarStartDocument(v), seed: 'x' })]) {
    assert.equal((await readStartDocument(Readable.from([bad]))).ok, false, bad.slice(0, 20));
  }
});

test('an app event is accepted 202, gets instance_id and seq = first_seq, is signed, and the fake ingest stores and verifies it', async () => {
  const v = freshValues();
  const ing = await startServer({ key: v.event_key, instance: v.instance_id, port: 0, host: '127.0.0.1', log: () => {} });
  const b = await boot({ relayPort: ing.port, v });
  try {
    const r1 = await b.post(postedEvent());
    assert.equal(r1.status, 202);
    const r2 = await b.post(postedEvent());
    assert.equal(r2.status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 2), 'delivered');
    assert.deepEqual(ing.ingest.stored.map((x) => [x.event.instance_id, x.event.seq]), [[v.instance_id, v.first_seq], [v.instance_id, v.first_seq + 1]]);
    assert.equal(ing.ingest.security.length, 0, 'no signature problem');
    assert.equal(b.sc.queue.length, 0);
  } finally { await b.sc.stop(); await closeServer(ing.server); }
});

test('IF-4 answers: 405 GET, 415 wrong type, 413 over 4 KiB, 400 not JSON, 422 for a forbidden source, an extra field and an unknown type; nothing forwarded', async () => {
  const v = freshValues();
  const ing = await startServer({ key: v.event_key, instance: v.instance_id, port: 0, host: '127.0.0.1', log: () => {} });
  const b = await boot({ relayPort: ing.port, v });
  try {
    const ev = postedEvent();
    assert.equal((await request(b.ports.eventsPort, { method: 'GET' })).status, 405);
    assert.equal((await b.post(JSON.stringify(ev), { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await b.post(JSON.stringify(postedEvent({ data: { route: '/a', error_class: 'sql_syntax', pad: 'x'.repeat(5000) } })))).status, 413);
    assert.equal((await b.post('{"type": ')).status, 400);
    for (const source of ['sidecar', 'orchestrator', 'platform']) assert.equal((await b.post(postedEvent({ source }))).status, 422, source);
    assert.equal((await b.post({ ...ev, instance_id: v.instance_id })).status, 422, 'instance_id sent by the poster');
    assert.equal((await b.post({ ...ev, seq: 5 })).status, 422, 'seq sent by the poster');
    assert.equal((await b.post(postedEvent({ type: 'not.a.type' }))).status, 422);
    assert.equal((await b.post('[]')).status, 422);
    const p = await b.post(postedEvent({ source: 'sidecar' }));
    assert.equal(JSON.parse(p.text).code, 'EVT-SCHEMA');
    assert.match(p.headers['content-type'], /problem\+json/);
    assert.equal((await request(b.ports.eventsPort, { path: '/other' })).status, 404);
    await wait(100);
    assert.equal(ing.ingest.stored.length, 0, 'nothing forwarded');
    assert.equal(b.sc.queue.length, 0);
    assert.equal(b.sc.nextSeq(), v.first_seq, 'a refused event does not use a seq');
  } finally { await b.sc.stop(); await closeServer(ing.server); }
});

test('ingest down: the event is kept and retried until it is delivered', async () => {
  const v = freshValues();
  const port = await freePort();
  const b = await boot({ relayPort: port, v });
  let ing;
  try {
    assert.equal((await b.post(postedEvent())).status, 202);
    assert.ok(await until(() => b.sc.stats.retries >= 2), 'retries while the relay is unreachable');
    assert.equal(b.sc.queue.length, 1, 'still kept');
    ing = await startServer({ key: v.event_key, instance: v.instance_id, port, host: '127.0.0.1', log: () => {} });
    assert.ok(await until(() => ing.ingest.stored.length === 1), 'delivered once the ingest is back');
    assert.equal(ing.ingest.stored[0].event.seq, v.first_seq);
    assert.equal(b.sc.queue.length, 0);
  } finally { await b.sc.stop(); if (ing) await closeServer(ing.server); }
});

// A relay that answers from a script, so each status can be tried.
async function scripted(statuses) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { calls.push({ sig: req.headers['x-vm-signature'], body: Buffer.concat(chunks).toString('utf8') }); res.writeHead(statuses[Math.min(calls.length - 1, statuses.length - 1)]); res.end('{}'); });
  });
  return { server, calls, port: await listen(server, 0, '127.0.0.1') };
}

test('drop rules: 401, 409, 413 and 422 drop the event with an alarm that holds only seq and status', async () => {
  for (const status of [401, 409, 413, 422]) {
    const rel = await scripted([status]);
    const b = await boot({ relayPort: rel.port });
    try {
      assert.equal((await b.post(postedEvent())).status, 202);
      assert.ok(await until(() => b.sc.stats.dropped === 1), `dropped on ${status}`);
      assert.equal(b.sc.queue.length, 0);
      assert.equal(rel.calls.length, 1, 'not retried');
      assert.equal(b.alarms.length, 1);
      assert.match(b.alarms[0], new RegExp(`seq=${b.v.first_seq} .*${status}`));
      assert.ok(!b.alarms[0].includes(b.v.event_key) && !b.alarms[0].includes('sql_syntax'));
    } finally { await b.sc.stop(); await closeServer(rel.server); }
  }
});

test('keep rules: 500 and 503 are retried until 202; 200 (duplicate) counts as delivered', async () => {
  const rel = await scripted([500, 503, 202]);
  const b = await boot({ relayPort: rel.port });
  try {
    await b.post(postedEvent());
    assert.ok(await until(() => b.sc.stats.delivered === 1));
    assert.equal(rel.calls.length, 3);
    assert.equal(b.sc.stats.dropped, 0);
    assert.ok(rel.calls.every((c) => c.body === rel.calls[0].body && c.sig === rel.calls[0].sig), 'the same signed bytes each time');
  } finally { await b.sc.stop(); await closeServer(rel.server); }
  const rel2 = await scripted([200]);
  const b2 = await boot({ relayPort: rel2.port });
  try {
    await b2.post(postedEvent());
    assert.ok(await until(() => b2.sc.stats.delivered === 1));
  } finally { await b2.sc.stop(); await closeServer(rel2.server); }
});

test('bounded buffer: when full the oldest event is dropped first, with an alarm', async () => {
  const port = await freePort();
  const b = await boot({ relayPort: port, bufferMax: 3 });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await b.post(postedEvent())).status, 202);
    assert.equal(b.sc.queue.length, 3);
    assert.equal(b.sc.stats.overflowed, 2);
    assert.deepEqual(b.sc.queue.map((x) => x.seq), [b.v.first_seq + 2, b.v.first_seq + 3, b.v.first_seq + 4]);
    assert.equal(b.alarms.length, 2);
  } finally { await b.sc.stop(); }
});

test('player traffic on the player port is passed to the shop unchanged', async () => {
  const up = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { res.writeHead(201, { 'x-up': '1' }); res.end(`${req.method} ${req.url} ${Buffer.concat(c)}`); }); });
  const upPort = await listen(up, 0, '127.0.0.1');
  const port = await freePort();
  const b = await boot({ relayPort: port, upstreamUrl: `http://127.0.0.1:${upPort}` });
  try {
    const r = await request(b.ports.playerPort, { method: 'POST', path: '/a/b?x=1', body: 'payload' });
    assert.equal(r.status, 201);
    assert.equal(r.text, 'POST /a/b?x=1 payload');
    assert.equal(r.headers['x-up'], '1');
    assert.equal((await request(b.ports.playerPort, { method: 'GET', path: '/v1/events' })).text, 'GET /v1/events ', 'the player port is not the event endpoint');
  } finally { await b.sc.stop(); await closeServer(up); }
});
