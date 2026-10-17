// The product sidecar. Part 1 carries over the cases of the stub sidecar's own tests (contracts/mocks/stub-instance/sidecar.test.mjs): the
// answers to the shop, seq counting, signing, retry and drop rules, the bounded buffer, the restart rules. Part 2 is new: flags seen on
// the player port, the S-9 channels end to end, the events, and the never-block rule (each part broken in turn).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { readStartDocument, loadCounter, SEQ_MAX, inspectRequest } from '../src/sidecar.mjs';
import { createOutbox } from '../src/outbox.mjs';
import { closeServer, listen } from '../src/common.mjs';
import { startServer } from '../../../contracts/mocks/fake-ingest/server.mjs';
import { freshValues, startDoc, flagOf, fakeFlag, sha256, postedEvent, until, wait, request, freePort, shop, scripted, boot, gzip, LB } from './helpers.mjs';
import { CHANNELS } from './s9-channels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const quietIngest = (v, extra = {}) => startServer({ key: v.event_key, instance: v.instance_id, epoch: v.epoch, port: 0, host: '127.0.0.1', log: () => {}, ...extra });
const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- part 1: parity with the stub sidecar

test('start document: a valid one is read once; a bad one is refused', async () => {
  const v = freshValues();
  const ok = await readStartDocument(Readable.from([JSON.stringify(startDoc(v))]));
  assert.equal(ok.ok, true);
  assert.equal(ok.start.epoch, v.epoch);
  assert.equal(ok.start.first_seq, undefined, 'first_seq is gone from the start document (D-42)');
  const dupe = startDoc(v); dupe.flag_digests.push({ ...dupe.flag_digests[0] });
  const twoReal = startDoc(v); twoReal.flag_digests.push({ challenge_key: 'C01', kind: 'real', sha256: sha256('other') });
  for (const bad of ['', '{', JSON.stringify({ ...startDoc(v), first_seq: 1 }), JSON.stringify({ ...startDoc(v), epoch: 0 }), JSON.stringify({ ...startDoc(v), event_key: 'short' }), JSON.stringify({ ...startDoc(v), seed: 'x' }), JSON.stringify(dupe), JSON.stringify(twoReal)]) {
    assert.equal((await readStartDocument(Readable.from([bad]))).ok, false, bad.slice(0, 20));
  }
});

test('an app event is accepted 202, gets instance_id, the epoch and seq 1, 2, is signed, and the fake ingest stores and verifies it', async () => {
  const v = freshValues();
  const ing = await quietIngest(v);
  const b = await boot({ relayPort: ing.port, v });
  try {
    assert.equal((await b.post(postedEvent())).status, 202);
    assert.equal((await b.post(postedEvent())).status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 2), 'delivered');
    assert.deepEqual(ing.ingest.stored.map((x) => [x.event.instance_id, x.event.epoch, x.event.seq]), [[v.instance_id, v.epoch, 1], [v.instance_id, v.epoch, 2]]);
    assert.equal(ing.ingest.security.length, 0, 'no signature problem');
    assert.equal(b.sc.queue.length, 0);
  } finally { await b.sc.stop(); await closeServer(ing.server); }
});

test('IF-4 answers: 405 GET, 415 wrong type, 413 over 4 KiB, 400 not JSON, 422 for a forbidden source, an extra field and an unknown type; nothing forwarded', async () => {
  const v = freshValues();
  const ing = await quietIngest(v);
  const b = await boot({ relayPort: ing.port, v });
  try {
    const ev = postedEvent();
    assert.equal((await request(b.ports.eventsPort, { method: 'GET', path: '/v1/events' })).status, 405);
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
    assert.equal((await request(b.ports.eventsPort, { path: '/healthz' })).status, 200);
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
    ing = await quietIngest(v, { port });
    assert.ok(await until(() => ing.ingest.stored.length === 1), 'delivered once the ingest is back');
    assert.equal(ing.ingest.stored[0].event.seq, 1);
    assert.equal(b.sc.queue.length, 0);
  } finally { await b.sc.stop(); if (ing) await closeServer(ing.server); }
});

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
  const up = await shop((req, body) => ({ status: 201, headers: { 'x-up': '1' }, body: `${req.method} ${req.url} ${body}` }));
  const b = await boot({ relayPort: await freePort(), upstreamPort: up.port });
  try {
    const r = await request(b.ports.playerPort, { method: 'POST', path: '/a/b?x=1', body: 'payload' });
    assert.equal(r.status, 201);
    assert.equal(r.text, 'POST /a/b?x=1 payload');
    assert.equal(r.headers['x-up'], '1');
    assert.equal((await request(b.ports.playerPort, { method: 'GET', path: '/v1/events' })).text, 'GET /v1/events ', 'the player port is not the event endpoint');
  } finally { await b.sc.stop(); await closeServer(up.server); }
});

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-sidecar-')), 'seq.json');

test('D-42: a sidecar restart inside one epoch continues from the saved counter, with no collision at the ingest', async () => {
  const v = freshValues();
  const statePath = tmpState();
  const ing = await quietIngest(v);
  try {
    const b1 = await boot({ relayPort: ing.port, v, statePath });
    for (let i = 0; i < 3; i++) assert.equal((await b1.post(postedEvent())).status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 3));
    await b1.sc.stop();
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), { instance_id: v.instance_id, epoch: v.epoch, next_seq: 4 }, 'write-ahead: the next value is on disk');
    const b2 = await boot({ relayPort: ing.port, v, statePath });
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
  const port = await freePort();
  const b = await boot({ relayPort: port, v, statePath });
  try {
    assert.equal((await b.post(postedEvent())).status, 202);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).next_seq, 2);
    assert.equal(b.sc.queue.length, 1);
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
  const ing = await quietIngest(v, { epoch: 1 });
  try {
    const b1 = await boot({ relayPort: ing.port, v });
    await b1.post(postedEvent()); await b1.post(postedEvent());
    assert.ok(await until(() => ing.ingest.stored.length === 2));
    await b1.sc.stop();
    ing.ingest.setEpoch(v.instance_id, 2);
    const b2 = await boot({ relayPort: ing.port, v: { ...v, epoch: 2 }, startOverride: { ...startDoc(v), epoch: 2 }, statePath: tmpState() });
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
  const v = freshValues();
  const statePath = tmpState();
  const ing = await quietIngest(v);
  const eventsPort = await freePort();
  const playerPort = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
  const run = async () => {
    const child = spawn(process.execPath, [path.join(HERE, '..', 'src', 'main.mjs'), 'sidecar', '--relay', `http://127.0.0.1:${ing.port}/internal/v1/events`, '--upstream', 'http://127.0.0.1:1', '--state', statePath, '--events-port', String(eventsPort), '--player-port', String(playerPort)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(JSON.stringify(startDoc(v)));
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('sidecar did not start')), 10000); child.stdout.on('data', (c) => { if (/listening/.test(String(c))) { clearTimeout(t); resolve(); } }); child.once('exit', () => reject(new Error('sidecar exited'))); });
    return child;
  };
  const kill = (c) => new Promise((r) => { c.once('exit', r); c.kill('SIGKILL'); });
  const post = () => request(eventsPort, { method: 'POST', path: '/v1/events', headers: { 'content-type': 'application/json' }, body: JSON.stringify(postedEvent()) });
  try {
    const c1 = await run();
    for (let i = 0; i < 3; i++) assert.equal((await post()).status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 3));
    await kill(c1);
    const c2 = await run();
    for (let i = 0; i < 2; i++) assert.equal((await post()).status, 202);
    assert.ok(await until(() => ing.ingest.stored.length === 5));
    assert.deepEqual(ing.ingest.stored.map((x) => x.event.seq), [1, 2, 3, 4, 5]);
    assert.equal(ing.ingest.security.length, 0, 'no 401, no 409');
    await kill(c2);
  } finally { await closeServer(ing.server); }
});

// ---------------------------------------------------------------- part 2: flags on the player port

const flagBodies = (v) => ({ plain: `<p>${flagOf(v, 'C05')}</p>` });
const eventsOf = (ing, type) => ing.ingest.stored.map((x) => x.event).filter((e) => e.type === type);
const noFlagValue = (ing, v) => {
  const all = JSON.stringify(ing.ingest.stored.map((x) => x.event));
  for (const s of [...v.flags.map((f) => f.flag), ...v.decoys.map((d) => d.value)]) assert.ok(!all.includes(s), 'an event holds a flag value');
};

test('real flag, plain: identical bytes to the player; proxy.flag_seen real C05, then evidence.capture C05 with the same request_ref; signed; no flag value in any event', async () => {
  const v = freshValues();
  const ing = await quietIngest(v);
  const body = flagBodies(v).plain;
  const up = await shop(() => ({ status: 200, headers: { 'content-type': 'text/html', 'x-keep': 'yes' }, body }));
  const b = await boot({ relayPort: ing.port, upstreamPort: up.port, v });
  try {
    const r = await request(b.ports.playerPort, { method: 'POST', path: '/api/search?q=a', headers: { 'content-type': 'application/json', 'user-agent': 'tester/1', cookie: 'sid=secretcookie', authorization: 'Bearer nope' }, body: JSON.stringify({ q: 'x', password: 'hunter2' }) });
    assert.equal(r.text, body);
    assert.equal(r.headers['x-keep'], 'yes');
    assert.ok(await until(() => ing.ingest.stored.length >= 2));
    const [seen] = eventsOf(ing, 'proxy.flag_seen');
    const [cap] = eventsOf(ing, 'evidence.capture');
    assert.equal(seen.data.kind, 'real'); assert.equal(seen.data.challenge_key, 'C05'); assert.equal(seen.challenge_key, 'C05');
    assert.equal(seen.data.candidate_sha256, sha256(flagOf(v, 'C05')));
    assert.equal(seen.data.route_template, '/api/search');
    assert.equal(cap.challenge_key, 'C05');
    assert.equal(cap.data.request_ref, seen.data.request_ref);
    assert.equal(cap.seq, seen.seq + 1);
    assert.match(cap.data.body, /^POST \/api\/search\?q=a\n\n/);
    assert.ok(!cap.data.body.includes('hunter2') && !cap.data.body.includes('secretcookie'));
    assert.deepEqual(Object.keys(cap.data.headers_redacted).sort(), ['content-type', 'user-agent']);
    for (const e of [seen, cap]) { assert.equal(e.source, 'sidecar'); assert.equal(e.session_kind, 'player'); assert.equal(e.user_id, null); }
    assert.equal(ing.ingest.security.length, 0, 'every event verified at the ingest (signature and schema)');
    noFlagValue(ing, v);
  } finally { await b.sc.stop(); await closeServer(ing.server); await closeServer(up.server); }
});

test('S-9 end to end: every channel row, bytes identical to the player, events only for the rows the table calls seen', async () => {
  const v = freshValues();
  const flag = flagOf(v, 'C05');
  const ing = await quietIngest(v);
  const rows = CHANNELS.map((ch) => ({ ch, r: ch.build(flag) }));
  const up = await shop((req) => {
    const row = rows.find((x) => req.url === `/ch/${x.ch.id.replace(/[0-9]/g, 'n')}`);
    return { status: 200, headers: { 'content-type': 'text/html', ...(row.r.encoding ? { 'content-encoding': row.r.encoding } : {}) }, body: row.r.body, chunks: row.r.chunks };
  });
  const b = await boot({ relayPort: ing.port, upstreamPort: up.port, v });
  try {
    const route = (id) => `/ch/${id.replace(/[0-9]/g, 'n')}`;
    for (const { ch, r } of rows) {
      const before = b.sc.stats.scanned + b.sc.stats.scan_skipped;
      const got = await request(b.ports.playerPort, { path: route(ch.id) });
      assert.equal(hashOf(got.body), hashOf(Buffer.from(r.body)), `${ch.id}: identical bytes`);
      assert.ok(await until(() => b.sc.stats.scanned + b.sc.stats.scan_skipped > before), `${ch.id}: scan finished`);
      const wantSeen = rows.filter((x) => x.ch.seen && rows.indexOf(x) <= rows.findIndex((y) => y.ch.id === ch.id)).length;
      assert.ok(await until(() => eventsOf(ing, 'proxy.flag_seen').length === wantSeen && eventsOf(ing, 'evidence.capture').length === wantSeen), `${ch.id}: ${ch.seen ? 'seen' : 'not seen'} (flag_seen events: ${eventsOf(ing, 'proxy.flag_seen').length}, want ${wantSeen})`);
    }
    // the same flag came on many routes; each seen row reported once
    assert.equal(b.sc.stats.scan_skipped, CHANNELS.filter((c) => ['unsupported-encoding', 'above-cap'].includes(c.id)).length);
    assert.equal(ing.ingest.security.length, 0);
    noFlagValue(ing, v);
  } finally { await b.sc.stop(); await closeServer(ing.server); await closeServer(up.server); }
});

test('decoy and foreign: kind decoy with its challenge key, kind foreign with none; no evidence.capture for either', async () => {
  const v = freshValues();
  const foreign = fakeFlag();
  const ing = await quietIngest(v);
  const up = await shop((req) => ({ body: req.url.startsWith('/decoy') ? `x ${v.decoys[0].value} y` : `x ${foreign} y` }));
  const b = await boot({ relayPort: ing.port, upstreamPort: up.port, v });
  try {
    await request(b.ports.playerPort, { path: '/decoy' });
    await request(b.ports.playerPort, { path: '/foreign' });
    assert.ok(await until(() => eventsOf(ing, 'proxy.flag_seen').length === 2));
    const [d, f] = eventsOf(ing, 'proxy.flag_seen');
    assert.deepEqual([d.data.kind, d.data.challenge_key, d.challenge_key], ['decoy', v.decoys[0].challenge_key, v.decoys[0].challenge_key]);
    assert.equal(f.data.kind, 'foreign'); assert.equal('challenge_key' in f.data, false); assert.equal('challenge_key' in f, false);
    assert.equal(f.data.candidate_sha256, sha256(foreign));
    await wait(100);
    assert.equal(eventsOf(ing, 'evidence.capture').length, 0);
    assert.equal(ing.ingest.security.length, 0);
    noFlagValue(ing, v);
    assert.ok(!JSON.stringify(ing.ingest.stored).includes(foreign));
  } finally { await b.sc.stop(); await closeServer(ing.server); await closeServer(up.server); }
});

test('reload: the same candidate on the same route within 60 s is one event and a counter; another route, or after the window, is a new event', async () => {
  const v = freshValues();
  let clock = 1_000_000;
  const ing = await quietIngest(v);
  const up = await shop(() => ({ body: flagOf(v, 'C01') }));
  const b = await boot({ relayPort: ing.port, upstreamPort: up.port, v, now: () => clock });
  const hit = async (p, want) => { await request(b.ports.playerPort, { path: p }); assert.ok(await until(() => b.sc.stats.scanned >= want)); };
  try {
    await hit('/page', 1); await hit('/page', 2); await hit('/page', 3);
    assert.ok(await until(() => eventsOf(ing, 'proxy.flag_seen').length === 1));
    assert.equal(b.sc.stats.flag_repeats, 2);
    await hit('/other', 4);
    assert.ok(await until(() => eventsOf(ing, 'proxy.flag_seen').length === 2), 'another route is a new event');
    clock += 61_000;
    await hit('/page', 5);
    assert.ok(await until(() => eventsOf(ing, 'proxy.flag_seen').length === 3), 'after the window it is reported again');
    assert.equal(eventsOf(ing, 'evidence.capture').length, 3);
  } finally { await b.sc.stop(); await closeServer(ing.server); await closeServer(up.server); }
});

test('too big: a 2 MiB response is not scanned (scan_skipped counted), the player gets identical bytes, no event', async () => {
  const v = freshValues();
  const ing = await quietIngest(v);
  const big = Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0x61), Buffer.from(flagOf(v, 'C01'))]);
  const up = await shop(() => ({ body: big }));
  const b = await boot({ relayPort: ing.port, upstreamPort: up.port, v });
  try {
    const r = await request(b.ports.playerPort, { path: '/big' });
    assert.equal(hashOf(r.body), hashOf(big));
    assert.ok(await until(() => b.sc.stats.scan_skipped === 1));
    assert.equal(b.sc.stats.scanned, 0);
    b.sc.flushAggregate();
    assert.ok(await until(() => eventsOf(ing, 'proxy.request').length === 1), 'it is still in the proxy.request summary');
    assert.equal(eventsOf(ing, 'proxy.request')[0].data.resp_len, big.length);
    assert.equal(eventsOf(ing, 'proxy.flag_seen').length, 0);
  } finally { await b.sc.stop(); await closeServer(ing.server); await closeServer(up.server); }
});

test('proxy.request: one aggregated event per (method, route template, status) with a count, ids and classes only', async () => {
  const v = freshValues();
  const ing = await quietIngest(v);
  const up = await shop((req) => ({ status: req.url.startsWith('/missing') ? 404 : 200, body: 'ok' }));
  const b = await boot({ relayPort: ing.port, upstreamPort: up.port, v });
  try {
    for (const p of ['/orders/1', '/orders/22', '/orders/333?x=secret', '/missing', '/']) await request(b.ports.playerPort, { path: p });
    await request(b.ports.playerPort, { method: 'POST', path: '/orders/9', body: 'a' });
    assert.ok(await until(() => b.sc.stats.requests === 6));
    await wait(50);
    b.sc.flushAggregate();
    assert.ok(await until(() => eventsOf(ing, 'proxy.request').length === 4));
    const got = Object.fromEntries(eventsOf(ing, 'proxy.request').map((e) => [`${e.data.method} ${e.data.route_template} ${e.data.status}`, e.data]));
    assert.equal(got['GET /orders/{id} 200'].count, 3);
    assert.equal(got['POST /orders/{id} 200'].count, 1);
    assert.equal(got['GET /missing 404'].client_class, 'player');
    assert.equal(got['GET / 200'].resp_len, 2);
    assert.ok(!JSON.stringify(ing.ingest.stored).includes('secret'));
    assert.equal(ing.ingest.security.length, 0);
  } finally { await b.sc.stop(); await closeServer(ing.server); await closeServer(up.server); }
});

test('spoof: a player-sent x-vm-* header is removed before the shop and none goes back out; the events still say player', async () => {
  const v = freshValues();
  const ing = await quietIngest(v);
  const up = await shop(() => ({ headers: { 'x-vm-session-kind': 'bot', 'x-vm-extra': '1', 'x-fine': '1' }, body: flagOf(v, 'C05') }));
  const b = await boot({ relayPort: ing.port, upstreamPort: up.port, v });
  try {
    const r = await request(b.ports.playerPort, { path: '/s', headers: { 'x-vm-session-kind': 'bot', 'X-VM-Ticket': 't', 'x-other': 'kept' } });
    assert.equal(up.seen[0].headers['x-vm-session-kind'], undefined);
    assert.equal(up.seen[0].headers['x-vm-ticket'], undefined);
    assert.equal(up.seen[0].headers['x-other'], 'kept');
    assert.equal(r.headers['x-vm-session-kind'], undefined); assert.equal(r.headers['x-vm-extra'], undefined); assert.equal(r.headers['x-fine'], '1');
    assert.ok(await until(() => eventsOf(ing, 'proxy.flag_seen').length === 1));
    assert.ok(eventsOf(ing, 'proxy.flag_seen').every((e) => e.session_kind === 'player'));
  } finally { await b.sc.stop(); await closeServer(ing.server); await closeServer(up.server); }
});

test('the upstream status, a 502 when the shop is down, and the inspectRequest hook that does nothing', async () => {
  assert.equal(inspectRequest({}), undefined);
  const up = await shop((req) => ({ status: Number(req.url.slice(1)), body: 'x' }));
  const b = await boot({ relayPort: await freePort(), upstreamPort: up.port });
  try {
    for (const s of [200, 201, 301, 404, 500]) assert.equal((await request(b.ports.playerPort, { path: `/${s}` })).status, s);
  } finally { await b.sc.stop(); await closeServer(up.server); }
  const down = await boot({ relayPort: await freePort(), upstreamPort: await freePort() });
  try { assert.equal((await request(down.ports.playerPort, { path: '/x' })).status, 502); } finally { await down.sc.stop(); }
});

// ---------------------------------------------------------------- never blocks: break each part in turn, compare the bytes

async function playerGets(b, up, v, expectBody) {
  const t0 = Date.now();
  const r = await request(b.ports.playerPort, { method: 'POST', path: '/never?x=1', headers: { 'content-type': 'text/plain', 'x-case': 'a' }, body: 'req-body' });
  assert.equal(r.status, 200);
  assert.equal(hashOf(r.body), hashOf(Buffer.from(expectBody)), 'the exact bytes');
  assert.ok(Date.now() - t0 < 1500, 'no delay');
  assert.equal(up.seen.at(-1).body.toString(), 'req-body');
  void v;
}

test('never blocks: a bad digest set (the matcher cannot be built): bytes identical, one alarm line with a fixed word', async () => {
  const v = freshValues();
  const body = `<p>${flagOf(v, 'C05')}</p>`;
  const up = await shop(() => ({ body }));
  const b = await boot({ relayPort: await freePort(), upstreamPort: up.port, v, startOverride: { ...startDoc(v), flag_digests: 'junk' } });
  try {
    await playerGets(b, up, v, body);
    await wait(50);
    assert.equal(b.sc.queue.length, 0, 'no flag event without a matcher');
    assert.ok(b.alarms.some((a) => /^alarm: flag digest set unusable, matcher off count=1$/.test(a)), b.alarms.join('|'));
  } finally { await b.sc.stop(); await closeServer(up.server); }
});

test('never blocks: the decoder or matcher throws (sync and async): bytes identical, scan_errors counted, alarm has a word and a counter only', async () => {
  const v = freshValues();
  const body = `<p>${flagOf(v, 'C05')}</p>`;
  for (const matcher of [{ scanResponse: () => { throw new Error(`boom ${flagOf(v, 'C05')}`); } }, { scanResponse: async () => { throw new Error('boom async'); } }]) {
    const up = await shop(() => ({ body }));
    const b = await boot({ relayPort: await freePort(), upstreamPort: up.port, v, matcher });
    try {
      await playerGets(b, up, v, body);
      assert.ok(await until(() => b.sc.stats.scan_errors === 1));
      assert.deepEqual(b.alarms, ['alarm: scan failed count=1']);
    } finally { await b.sc.stop(); await closeServer(up.server); }
  }
});

test('never blocks: the ingest is down: bytes identical, flag and evidence events stay buffered, nothing is lost', async () => {
  const v = freshValues();
  const body = `<p>${flagOf(v, 'C05')}</p>`;
  const up = await shop(() => ({ body }));
  const b = await boot({ relayPort: await freePort(), upstreamPort: up.port, v });
  try {
    await playerGets(b, up, v, body);
    assert.ok(await until(() => b.sc.queue.length === 2));
    assert.ok(await until(() => b.sc.stats.retries >= 2));
    assert.deepEqual(b.sc.queue.map((x) => JSON.parse(x.body).type), ['proxy.flag_seen', 'evidence.capture']);
  } finally { await b.sc.stop(); await closeServer(up.server); }
});

test('never blocks: the relay accepts and never answers (timeout): bytes identical for many requests', async () => {
  const v = freshValues();
  const body = `<p>${flagOf(v, 'C05')}</p>`;
  const hang = http.createServer(() => {});
  const hangPort = await listen(hang, 0, '127.0.0.1');
  const up = await shop(() => ({ body }));
  const b = await boot({ relayPort: hangPort, upstreamPort: up.port, v, requestTimeoutMs: 200 });
  try {
    for (let i = 0; i < 3; i++) await playerGets(b, up, v, body);
    assert.ok(await until(() => b.sc.stats.retries >= 1));
  } finally { await b.sc.stop(); await closeServer(hang); await closeServer(up.server); }
});

test('never blocks: an event cannot get a seq (lane full): bytes identical, emit_errors counted, alarm has a word and a counter', async () => {
  const v = freshValues();
  const body = `<p>${flagOf(v, 'C05')}</p>`;
  const statePath = tmpState();
  fs.writeFileSync(statePath, JSON.stringify({ instance_id: v.instance_id, epoch: v.epoch, next_seq: SEQ_MAX + 1 }));
  const up = await shop(() => ({ body }));
  const b = await boot({ relayPort: await freePort(), upstreamPort: up.port, v, statePath });
  try {
    await playerGets(b, up, v, body);
    assert.ok(await until(() => b.sc.stats.emit_errors >= 2));
    assert.ok(b.alarms.every((a) => /^alarm: event could not be queued count=\d+$/.test(a)), b.alarms.join('|'));
  } finally { await b.sc.stop(); await closeServer(up.server); }
});

test('never blocks: the state file cannot be written (write-ahead fails): bytes identical, nothing thrown to the player', async () => {
  const v = freshValues();
  const body = `<p>${flagOf(v, 'C05')}</p>`;
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-sidecar-')), 'seq.json');
  const up = await shop(() => ({ body }));
  const b = await boot({ relayPort: await freePort(), upstreamPort: up.port, v, statePath });
  try {
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true }); // the directory is gone: every save fails
    await playerGets(b, up, v, body);
    assert.ok(await until(() => b.sc.stats.emit_errors >= 2));
  } finally { await b.sc.stop(); await closeServer(up.server); }
});

test('never blocks: a gzip response with a broken body is passed on as received; the scan skips it', async () => {
  const v = freshValues();
  const broken = Buffer.concat([gzip('<p>hello</p>').subarray(0, 12), Buffer.from('garbage')]);
  const up = await shop(() => ({ headers: { 'content-encoding': 'gzip' }, body: broken }));
  const b = await boot({ relayPort: await freePort(), upstreamPort: up.port, v });
  try {
    const r = await request(b.ports.playerPort, { path: '/broken' });
    assert.equal(hashOf(r.body), hashOf(broken));
    assert.ok(await until(() => b.sc.stats.scan_skipped === 1));
  } finally { await b.sc.stop(); await closeServer(up.server); }
});

test('bounded buffer: the oldest proxy.request summary goes first; a flag or evidence event is never dropped for a summary', async () => {
  const v = freshValues();
  const up = await shop((req) => ({ body: req.url === '/flag' ? flagOf(v, 'C05') : 'plain' }));
  const b = await boot({ relayPort: await freePort(), upstreamPort: up.port, v, bufferMax: 3 });
  try {
    await request(b.ports.playerPort, { path: '/flag' });
    assert.ok(await until(() => b.sc.queue.length === 2));
    for (const p of ['/a', '/b', '/c', '/d']) { await request(b.ports.playerPort, { path: p }); }
    await wait(60);
    b.sc.flushAggregate(); // four summaries plus the one of /flag: 5 low events into 1 free slot
    const types = () => b.sc.queue.map((x) => JSON.parse(x.body).type);
    assert.deepEqual(types(), ['proxy.flag_seen', 'evidence.capture', 'proxy.request']);
    assert.equal(JSON.parse(b.sc.queue[2].body).data.route_template, '/d', 'the newest summary stays');
    assert.ok(b.sc.stats.overflowed >= 4);
    assert.ok(b.alarms.every((a) => !/VM/.test(a)));
  } finally { await b.sc.stop(); await closeServer(up.server); }
});

test('bounded buffer (outbox): when it holds only flag or state events a summary is the one dropped, and it takes no seq', () => {
  const v = freshValues();
  const alarms = [];
  const ob = createOutbox({ start: startDoc(v), relayUrl: 'http://127.0.0.1:1/x', bufferMax: 2, retryMinMs: 1000, retryMaxMs: 1000, alarm: (m) => alarms.push(m) });
  try {
    const ev = (type) => ({ ...postedEvent(), type, source: 'sidecar', user_id: null });
    assert.equal(ob.submit(ev('proxy.flag_seen'), { check: false }), true);
    assert.equal(ob.submit(ev('evidence.capture'), { check: false }), true);
    const next = ob.nextSeq();
    assert.equal(ob.submit(ev('proxy.request'), { low: true, check: false }), false, 'the summary is dropped');
    assert.equal(ob.nextSeq(), next, 'and takes no seq');
    assert.deepEqual(ob.queue.map((x) => JSON.parse(x.body).type), ['proxy.flag_seen', 'evidence.capture']);
    assert.equal(ob.stats.overflowed, 1);
    // a state event with no low event to give way drops the oldest event overall (the rule of the stub), with an alarm
    assert.equal(ob.submit(ev('shop.verbose_error'), { check: false }), true);
    assert.deepEqual(ob.queue.map((x) => JSON.parse(x.body).type), ['evidence.capture', 'shop.verbose_error']);
    assert.ok(alarms.every((a) => !/VM/.test(a)));
  } finally { ob.stop(); }
});