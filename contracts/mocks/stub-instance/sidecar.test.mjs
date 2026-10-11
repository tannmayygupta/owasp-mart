// Unit tests of the stub sidecar (IF-4 sections 3 to 6): answers to the shop, seq from 1 per epoch (write-ahead state file), signing, retry and drop rules, bounded buffer.
// The relay side is either the real fake ingest (contracts/mocks/fake-ingest) or a scripted server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createSidecar, readStartDocument, loadCounter, SEQ_MAX } from './sidecar.mjs';
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
  assert.equal(ok.start.epoch, v.epoch);
  assert.equal(ok.start.first_seq, undefined, 'first_seq is gone from the start document (D-42)');
  for (const bad of ['', '{', JSON.stringify({ ...sidecarStartDocument(v), first_seq: 1 }), JSON.stringify({ ...sidecarStartDocument(v), epoch: 0 }), JSON.stringify({ ...sidecarStartDocument(v), event_key: 'short' }), JSON.stringify({ ...sidecarStartDocument(v), seed: 'x' })]) {
    assert.equal((await readStartDocument(Readable.from([bad]))).ok, false, bad.slice(0, 20));
  }
});

test('an app event is accepted 202, gets instance_id, the epoch and seq 1, 2, is signed, and the fake ingest stores and verifies it', async () => {
  const v = freshValues();
  const ing = await startServer({ key: v.event_key, instance: v.instance_id, port: 0, host: '127.0.0.1', log: () => {} });
  const b = await boot({ relayPort: ing.port, v });
  try {
    const r1 = await b.post(postedEvent());
    assert.equal(r1.status, 202);
    const r2 = await b.post(postedEvent());
    assert.equal(r2.status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 2), 'delivered');
    assert.deepEqual(ing.ingest.stored.map((x) => [x.event.instance_id, x.event.epoch, x.event.seq]), [[v.instance_id, v.epoch, 1], [v.instance_id, v.epoch, 2]]);
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
    assert.equal(b.sc.nextSeq(), 1, 'a refused event does not use a seq');
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
    assert.equal(ing.ingest.stored[0].event.seq, 1);
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
      assert.match(b.alarms[0], new RegExp(`seq=1 .*${status}`));
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
    assert.deepEqual(b.sc.queue.map((x) => x.seq), [3, 4, 5]);
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

// ---- D-42: the counter restarts at 1 in every epoch and survives a restart inside one epoch ----
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-sidecar-')), 'seq.json');

test('D-42: a sidecar restart inside one epoch continues from the saved counter, with no collision at the ingest', async () => {
  const v = freshValues();
  const statePath = tmpState();
  const ing = await startServer({ key: v.event_key, instance: v.instance_id, epoch: v.epoch, port: 0, host: '127.0.0.1', log: () => {} });
  try {
    const b1 = await boot({ relayPort: ing.port, v, statePath });
    for (let i = 0; i < 3; i++) assert.equal((await b1.post(postedEvent())).status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 3));
    await b1.sc.stop(); // the first sidecar is gone
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(saved, { instance_id: v.instance_id, epoch: v.epoch, next_seq: 4 }, 'write-ahead: the next value is on disk');
    const b2 = await boot({ relayPort: ing.port, v, statePath }); // same start document: a restart
    assert.equal(b2.sc.nextSeq(), 4);
    for (let i = 0; i < 2; i++) assert.equal((await b2.post(postedEvent())).status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 5));
    assert.deepEqual(ing.ingest.stored.map((x) => x.event.seq), [1, 2, 3, 4, 5]);
    assert.equal(ing.ingest.security.length, 0);
    await b2.sc.stop();
  } finally { await closeServer(ing.server); }
});

test('D-42: write-ahead: the counter is saved before the event is queued, so a crash can leave a gap but never a reused seq', async () => {
  const v = freshValues();
  const statePath = tmpState();
  const port = await freePort(); // nothing listens: events stay queued
  const b = await boot({ relayPort: port, v, statePath });
  try {
    assert.equal((await b.post(postedEvent())).status, 202);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).next_seq, 2);
    assert.equal(b.sc.queue.length, 1, 'the event never left the sidecar; the buffer is lost with the process');
  } finally { await b.sc.stop(); }
  const again = await boot({ relayPort: port, v, statePath });
  try { assert.equal(again.sc.nextSeq(), 2, 'the lost buffered event leaves a gap at seq 1; it is not reused'); } finally { await again.sc.stop(); }
});

test('D-42: a new epoch restarts the counter at 1; a state file of a later epoch, another instance or garbage is refused', () => {
  const v = freshValues();
  const statePath = tmpState();
  fs.writeFileSync(statePath, JSON.stringify({ instance_id: v.instance_id, epoch: 1, next_seq: 900 }));
  assert.equal(loadCounter(statePath, { instance_id: v.instance_id, epoch: 1 }), 900);
  assert.equal(loadCounter(statePath, { instance_id: v.instance_id, epoch: 2 }), 1, 'every epoch restarts at 1');
  assert.throws(() => loadCounter(statePath, { instance_id: v.instance_id, epoch: 0 }), /later epoch/);
  assert.throws(() => loadCounter(statePath, { instance_id: 'i-ZZZZZZZZZZZZZZZZ', epoch: 1 }), /does not match/);
  fs.writeFileSync(statePath, '{nope');
  assert.throws(() => loadCounter(statePath, { instance_id: v.instance_id, epoch: 1 }), /not JSON/);
  assert.equal(loadCounter(path.join(path.dirname(statePath), 'absent.json'), { instance_id: v.instance_id, epoch: 1 }), 1, 'no file: a fresh start');
  assert.equal(loadCounter(null, { instance_id: v.instance_id, epoch: 1 }), 1);
});

test('D-42: events of a reset carry the new epoch with seq 1 and the old epoch stays history at the ingest', async () => {
  const v = freshValues();
  const ing = await startServer({ key: v.event_key, instance: v.instance_id, epoch: 1, port: 0, host: '127.0.0.1', log: () => {} });
  try {
    const b1 = await boot({ relayPort: ing.port, v });
    await b1.post(postedEvent()); await b1.post(postedEvent());
    assert.ok(await until(() => ing.ingest.stored.length === 2));
    await b1.sc.stop();
    ing.ingest.setEpoch(v.instance_id, 2); // the platform started epoch 2 (the harness keeps one fixed key, so only the epoch field changes)
    const b2 = await boot({ relayPort: ing.port, v: { ...v, epoch: 2 }, statePath: tmpState() });
    await b2.post(postedEvent());
    assert.ok(await until(() => ing.ingest.stored.length === 3));
    assert.deepEqual(ing.ingest.ordered().map((x) => [x.event.epoch, x.event.seq]), [[1, 1], [1, 2], [2, 1]]);
    await b2.sc.stop();
  } finally { await closeServer(ing.server); }
});

test('D-42: the sidecar lane ends at 2^40-1: the next event is refused with 503 and nothing is queued', async () => {
  const v = freshValues();
  const statePath = tmpState();
  fs.writeFileSync(statePath, JSON.stringify({ instance_id: v.instance_id, epoch: v.epoch, next_seq: SEQ_MAX + 1 }));
  const b = await boot({ relayPort: await freePort(), v, statePath });
  try {
    assert.equal((await b.post(postedEvent())).status, 503);
    assert.equal(b.sc.queue.length, 0);
  } finally { await b.sc.stop(); }
});

test('D-42: killed for real: a sidecar process killed with SIGKILL and started again continues without a collision', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const v = freshValues();
  const statePath = tmpState();
  const ing = await startServer({ key: v.event_key, instance: v.instance_id, epoch: v.epoch, port: 0, host: '127.0.0.1', log: () => {} });
  const eventsPort = await freePort();
  const playerPort = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
  const run = async () => {
    const child = spawn(process.execPath, [path.join(here, 'main.mjs'), 'sidecar', '--relay', `http://127.0.0.1:${ing.port}/internal/v1/events`, '--upstream', 'http://127.0.0.1:1', '--state', statePath, '--events-port', String(eventsPort), '--player-port', String(playerPort)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(JSON.stringify(sidecarStartDocument(v)));
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('sidecar did not start')), 10000); child.stdout.on('data', (c) => { if (/listening/.test(String(c))) { clearTimeout(t); resolve(); } }); child.once('exit', () => reject(new Error('sidecar exited'))); });
    return child;
  };
  const kill = (c) => new Promise((r) => { c.once('exit', r); c.kill('SIGKILL'); });
  try {
    const c1 = await run();
    for (let i = 0; i < 3; i++) assert.equal((await request(eventsPort, { body: JSON.stringify(postedEvent()) })).status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 3));
    await kill(c1);
    const c2 = await run();
    for (let i = 0; i < 2; i++) assert.equal((await request(eventsPort, { body: JSON.stringify(postedEvent()) })).status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 5));
    assert.deepEqual(ing.ingest.stored.map((x) => x.event.seq), [1, 2, 3, 4, 5]);
    assert.equal(ing.ingest.security.length, 0, 'no 401, no 409');
    await kill(c2);
  } finally { await closeServer(ing.server); }
});
