// The durable outbox (ADR 0059): the journal survives a restart, the tiers decide who is evicted, every drop is counted, and only what can never succeed is dropped.
// A real relay on 127.0.0.1 answers from a script; the "restart" is a second createOutbox on the same files. No Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOutbox, tierOf, TIER } from '../src/outbox.mjs';
import { freshValues, postedEvent, scripted, startDoc, until } from './helpers.mjs';
import { listen } from '../src/common.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vm-outbox-'));
const DEAD = 'http://127.0.0.1:1/internal/v1/events'; // nothing listens: every try is "no answer"
const ev = (type, extra = {}) => ({ ...postedEvent(), type, source: type.startsWith('proxy.') || type === 'evidence.capture' ? 'sidecar' : 'shop', user_id: null, ...extra });
const types = (ob) => ob.queue.map((x) => JSON.parse(x.body).type);
const closeServer = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });
const mk = (over = {}) => {
  const v = over.v ?? freshValues();
  const alarms = [];
  const ob = createOutbox({ start: startDoc(v), relayUrl: DEAD, retryMinMs: 20, retryMaxMs: 40, requestTimeoutMs: 200, alarm: (m) => alarms.push(m), ...over });
  return { ob, v, alarms };
};

test('tiers: summaries are low, flag sightings, evidence and every shop or milestone event are critical, other sidecar facts are normal', () => {
  assert.equal(tierOf(ev('proxy.request'), true), TIER.low);
  assert.equal(tierOf(ev('proxy.flag_seen')), TIER.critical);
  assert.equal(tierOf(ev('evidence.capture')), TIER.critical);
  assert.equal(tierOf(ev('shop.refund_decision')), TIER.critical);
  assert.equal(tierOf(ev('order.paid', { source: 'internal' })), TIER.critical);
  assert.equal(tierOf(ev('proxy.crs_match')), TIER.normal);
});

test('durable: a restart loads the journal and delivers what was not delivered, in order, with the same seq and bytes', async () => {
  const d = dir();
  const state = path.join(d, 'seq.json');
  const journal = path.join(d, 'outbox.jsonl');
  const v = freshValues();
  const first = mk({ v, statePath: state, outboxPath: journal });
  assert.equal(first.ob.submit(ev('proxy.flag_seen'), { check: false }), true);
  assert.equal(first.ob.submit(ev('shop.refund_decision'), { check: false }), true);
  assert.equal(first.ob.submit(ev('proxy.request'), { low: true, check: false }), true);
  const bodies = first.ob.queue.map((x) => x.body);
  first.ob.stop(); // the sidecar process ends with the relay unreachable: nothing was delivered
  const rel = await scripted([202]);
  const second = mk({ v, statePath: state, outboxPath: journal, relayUrl: `http://127.0.0.1:${rel.port}/internal/v1/events` });
  try {
    assert.equal(second.ob.stats.restored, 3);
    assert.equal(second.ob.nextSeq(), 4, 'the counter continues, no seq is reused');
    assert.ok(await until(() => second.ob.stats.delivered === 3));
    assert.deepEqual(rel.calls.map((c) => c.body), bodies, 'the same bytes, in the same order');
    assert.equal(second.ob.queue.length, 0);
    // and once delivered they are struck off: a third start has nothing to send
    second.ob.stop();
    const third = mk({ v, statePath: state, outboxPath: journal });
    assert.equal(third.ob.stats.restored, 0);
    third.ob.stop();
  } finally { second.ob.stop(); await closeServer(rel.server); fs.rmSync(d, { recursive: true, force: true }); }
});

test('durable: an event is on disk before submit returns (the shop gets its 202 only after)', () => {
  const d = dir();
  const journal = path.join(d, 'outbox.jsonl');
  const { ob } = mk({ outboxPath: journal });
  ob.submit(ev('proxy.flag_seen'), { check: false });
  const lines = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].o, lines[0].s, lines[0].t], ['a', 1, TIER.critical]);
  ob.stop(); fs.rmSync(d, { recursive: true, force: true });
});

test('durable: a torn last line (a crash in the middle of a write) and a journal of another instance or epoch are not replayed', () => {
  const d = dir();
  const journal = path.join(d, 'outbox.jsonl');
  const v = freshValues();
  const a = mk({ v, outboxPath: journal });
  a.ob.submit(ev('proxy.flag_seen'), { check: false });
  a.ob.stop();
  fs.appendFileSync(journal, '{"o":"a","s":2,"t":2,"b":"{\\"tor'); // killed while writing
  const other = JSON.parse(JSON.parse(fs.readFileSync(journal, 'utf8').split('\n')[0]).b);
  const foreign = JSON.stringify({ ...other, instance_id: 'i-AAAAAAAAAAAAAAAA', seq: 9 });
  fs.appendFileSync(journal, `\n${JSON.stringify({ o: 'a', s: 9, t: 2, b: foreign })}\n`);
  const b = mk({ v, outboxPath: journal });
  assert.equal(b.ob.stats.restored, 1, 'only the first, whole, own event');
  assert.equal(b.ob.stats.discarded_at_start, 1, 'the foreign one is counted, not sent');
  b.ob.stop(); fs.rmSync(d, { recursive: true, force: true });
});

test('durable: if the state file is older than the journal the counter goes past the journal, never reusing a seq', () => {
  const d = dir();
  const journal = path.join(d, 'outbox.jsonl');
  const v = freshValues();
  const a = mk({ v, outboxPath: journal });
  for (let i = 0; i < 4; i += 1) a.ob.submit(ev('shop.refund_decision'), { check: false });
  a.ob.stop();
  const b = mk({ v, outboxPath: journal }); // no state file at all
  assert.equal(b.ob.nextSeq(), 5);
  b.ob.stop(); fs.rmSync(d, { recursive: true, force: true });
});

test('durable: a journal that cannot be opened does not stop the sidecar: memory only, with an alarm', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'file'), 'x');
  const { ob, alarms } = mk({ outboxPath: path.join(d, 'file', 'outbox.jsonl') }); // a folder under a file: cannot be created
  assert.ok(alarms.some((m) => /journal unavailable/.test(m)));
  assert.equal(ob.submit(ev('proxy.flag_seen'), { check: false }), true);
  ob.stop(); fs.rmSync(d, { recursive: true, force: true });
});

test('eviction by tier: summaries go first, then normal, a flag or milestone only when nothing else is left, each counted apart', () => {
  const { ob, alarms } = mk({ bufferMax: 4 });
  assert.equal(ob.submit(ev('proxy.flag_seen'), { check: false }), true); // critical, oldest
  assert.equal(ob.submit(ev('proxy.request'), { low: true, check: false }), true); // low
  assert.equal(ob.submit(ev('proxy.crs_match'), { check: false }), true); // normal
  assert.equal(ob.submit(ev('shop.refund_decision'), { check: false }), true); // critical
  // full: a critical newcomer evicts the LOW one, not the older critical one
  assert.equal(ob.submit(ev('shop.verbose_error'), { check: false }), true);
  assert.deepEqual(types(ob), ['proxy.flag_seen', 'proxy.crs_match', 'shop.refund_decision', 'shop.verbose_error']);
  assert.equal(ob.stats.dropped_overflow_low, 1);
  // next critical evicts the normal one
  assert.equal(ob.submit(ev('shop.giftcard_attempt'), { check: false }), true);
  assert.deepEqual(types(ob), ['proxy.flag_seen', 'shop.refund_decision', 'shop.verbose_error', 'shop.giftcard_attempt']);
  assert.equal(ob.stats.dropped_overflow_normal, 1);
  // a summary or a normal event cannot push out a critical one: the newcomer is the one refused, and it takes no seq
  const next = ob.nextSeq();
  assert.equal(ob.submit(ev('proxy.request'), { low: true, check: false }), false);
  assert.equal(ob.submit(ev('proxy.crs_match'), { check: false }), false);
  assert.equal(ob.nextSeq(), next);
  assert.equal(ob.stats.dropped_overflow_critical, 0, 'no critical event has been lost so far');
  // only a queue of nothing but critical events loses the oldest critical one, with an alarm and its own counter
  assert.equal(ob.submit(ev('shop.cross_store_order_read'), { check: false }), true);
  assert.deepEqual(types(ob), ['shop.refund_decision', 'shop.verbose_error', 'shop.giftcard_attempt', 'shop.cross_store_order_read']);
  assert.equal(ob.stats.dropped_overflow_critical, 1);
  assert.ok(alarms.some((m) => /event seq=1 dropped/.test(m)));
  const m = ob.metrics();
  // the two refused newcomers (a summary and a normal event) are counted too: 1 evicted + 1 refused each for low and normal
  assert.deepEqual([m.dropped_overflow_low, m.dropped_overflow_normal, m.dropped_overflow_critical, m.queued], [2, 2, 1, 4]);
  ob.stop();
});

test('size bound: the queue is also bounded in bytes, by the same tier rule', () => {
  const big = (n) => ev('shop.refund_decision', { data: { route: '/x', error_class: 'e'.repeat(n) } });
  const one = JSON.stringify(big(300)).length;
  const { ob } = mk({ bufferMax: 100, maxBytes: one * 3 });
  assert.equal(ob.submit(ev('proxy.request', { data: { route: '/s', error_class: 's'.repeat(300) } }), { low: true, check: false }), true);
  assert.equal(ob.submit(big(300), { check: false }), true);
  assert.equal(ob.submit(big(300), { check: false }), true);
  assert.equal(ob.submit(big(300), { check: false }), true); // over the byte budget: the summary gives way
  assert.equal(ob.stats.dropped_overflow_low, 1);
  assert.ok(ob.metrics().queued_bytes <= one * 3 + 200);
  ob.stop();
});

test('delivery: 409, 413 and 422 are dropped at once and counted as never-succeed; 5xx and silence are never dropped', async () => {
  for (const status of [409, 413, 422]) {
    const rel = await scripted([status, 202]);
    const { ob } = mk({ relayUrl: `http://127.0.0.1:${rel.port}/internal/v1/events` });
    ob.submit(ev('proxy.flag_seen'), { check: false });
    ob.submit(ev('shop.refund_decision'), { check: false });
    assert.ok(await until(() => ob.stats.delivered === 1 && ob.stats.dropped === 1), String(status));
    assert.equal(ob.stats.dropped_never_succeed, 1);
    assert.equal(ob.stats.dropped_auth, 0);
    ob.stop(); await closeServer(rel.server);
  }
  const rel = await scripted([503, 503, 503, 503, 202]);
  const { ob } = mk({ relayUrl: `http://127.0.0.1:${rel.port}/internal/v1/events` });
  ob.submit(ev('proxy.flag_seen'), { check: false });
  assert.ok(await until(() => ob.stats.delivered === 1));
  assert.equal(ob.stats.dropped, 0);
  assert.ok(ob.stats.retries >= 4);
  ob.stop(); await closeServer(rel.server);
});

test('401 is retried with backoff (the platform may not know the instance yet) and dropped only after authRetryMax tries in a row', async () => {
  // late key: 401 twice, then accepted: nothing lost
  let rel = await scripted([401, 401, 202]);
  let { ob } = mk({ relayUrl: `http://127.0.0.1:${rel.port}/internal/v1/events`, authRetryMax: 5 });
  ob.submit(ev('proxy.flag_seen'), { check: false });
  assert.ok(await until(() => ob.stats.delivered === 1));
  assert.equal(ob.stats.dropped, 0);
  assert.equal(rel.calls.length, 3);
  ob.stop(); await closeServer(rel.server);
  // a wrong key: refused for good, dropped after authRetryMax retries (that is authRetryMax + 1 tries), counted as dropped_auth
  rel = await scripted([401]);
  ({ ob } = mk({ relayUrl: `http://127.0.0.1:${rel.port}/internal/v1/events`, authRetryMax: 2 }));
  ob.submit(ev('proxy.flag_seen'), { check: false });
  assert.ok(await until(() => ob.stats.dropped === 1));
  assert.equal(rel.calls.length, 3);
  assert.equal(ob.stats.dropped_auth, 1);
  assert.equal(ob.stats.dropped_never_succeed, 0);
  ob.stop(); await closeServer(rel.server);
});

test('the journal is compacted when most of it is struck off, and the live events survive the compaction', async () => {
  const d = dir();
  const journal = path.join(d, 'outbox.jsonl');
  const rel = await scripted([202]);
  const v = freshValues();
  const big = 'x'.repeat(2000);
  const { ob } = mk({ v, outboxPath: journal, relayUrl: `http://127.0.0.1:${rel.port}/internal/v1/events` });
  for (let i = 0; i < 80; i += 1) ob.submit(ev('shop.refund_decision', { data: { route: '/r', error_class: big } }), { check: false });
  assert.ok(await until(() => ob.stats.delivered === 80));
  assert.ok(fs.statSync(journal).size < 160 * 1000, 'the 80 adds and 80 strikes were compacted, not kept');
  ob.stop(); await closeServer(rel.server);
  const again = mk({ v, outboxPath: journal });
  assert.equal(again.ob.stats.restored, 0);
  again.ob.stop(); fs.rmSync(d, { recursive: true, force: true });
});

test('end to end with the real relay port: the restart of a sidecar outbox mid-flight loses nothing and sends nothing twice that the ingest would count twice', async () => {
  const d = dir();
  const v = freshValues();
  const calls = [];
  const http = await import('node:http');
  const server = http.createServer((req, res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { calls.push(Buffer.concat(c).toString('utf8')); res.writeHead(calls.length === 1 ? 503 : 202); res.end('{}'); }); });
  const port = await listen(server, 0, '127.0.0.1');
  const url = `http://127.0.0.1:${port}/internal/v1/events`;
  const a = mk({ v, statePath: path.join(d, 's.json'), outboxPath: path.join(d, 'o.jsonl'), relayUrl: url, retryMinMs: 5000, retryMaxMs: 5000 });
  a.ob.submit(ev('proxy.flag_seen'), { check: false });
  a.ob.submit(ev('shop.refund_decision'), { check: false });
  assert.ok(await until(() => calls.length === 1), 'the first try got a 503');
  a.ob.stop(); // killed while it waits to retry
  const b = mk({ v, statePath: path.join(d, 's.json'), outboxPath: path.join(d, 'o.jsonl'), relayUrl: url });
  assert.ok(await until(() => b.ob.stats.delivered === 2));
  const seqs = calls.map((c) => JSON.parse(c).seq);
  assert.deepEqual(seqs, [1, 1, 2], 'seq 1 was sent again (identical bytes: the ingest answers 200 for a duplicate), seq 2 once');
  assert.equal(calls[0], calls[1]);
  b.ob.stop(); await closeServer(server); fs.rmSync(d, { recursive: true, force: true });
});
