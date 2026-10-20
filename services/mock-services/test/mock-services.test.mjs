// Mock-services correct-flow tests (T-11, FR-SHP-13). Each mock answers its
// endpoints correctly; the deliberate weaknesses live in the callers, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPayment, createKyc, createMetadata, createCollector } from '../src/server.mjs';

function start(server) {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });
}
const get = (base, p) => fetch(`${base}${p}`);
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('payment: charges a valid order, records a signed ledger entry; rejects bad input', async () => {
  const { server } = createPayment();
  const base = await start(server);
  try {
    assert.equal((await get(base, '/healthz')).status, 200);
    const r = await post(base, '/charge', { order_id: 'VM-1001', amount: 1999 });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.order_id, 'VM-1001');
    assert.equal(body.amount, 1999);
    assert.match(body.reference, /^gw-/);
    // The gateway always signs (the shop verifying this is C08; skipping it is the bug).
    const expect = crypto.createHmac('sha256', 'mock-gateway-dev-key')
      .update(JSON.stringify({ type: body.type, order_id: body.order_id, amount: body.amount, reference: body.reference })).digest('hex');
    assert.equal(body.signature, expect, 'the gateway signs its event');
    // Recorded in the ledger (the monitor reads this for C08 detection).
    const led = await (await get(base, '/ledger')).json();
    assert.equal(led.entries.length, 1);
    assert.equal(led.entries[0].order_id, 'VM-1001');
    // Bad input is refused.
    assert.equal((await post(base, '/charge', { order_id: 'x', amount: -1 })).status, 400);
    assert.equal((await post(base, '/charge', { amount: 100 })).status, 400);
  } finally { server.close(); }
});

test('kyc: fails CLOSED — malformed input is a 400, never a silent verified', async () => {
  const { server } = createKyc();
  const base = await start(server);
  try {
    assert.equal((await get(base, '/healthz')).status, 200);
    assert.equal((await (await post(base, '/verify', { tax_id: 'ABC123' })).json()).outcome, 'verified');
    assert.equal((await (await post(base, '/verify', { tax_id: 'ABC120' })).json()).outcome, 'rejected');
    // Malformed inputs the C11 challenge abuses: an array, a too-short/odd value.
    assert.equal((await post(base, '/verify', { tax_id: ['a'] })).status, 400);
    assert.equal((await post(base, '/verify', { tax_id: 'a' })).status, 400);
    assert.equal((await post(base, '/verify', {})).status, 400);
  } finally { server.close(); }
});

test('metadata: serves /rates and /latest/user-data with the placement flag when present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-meta-'));
  fs.writeFileSync(path.join(dir, 'C10.placement'), 'VM{AAAAAAAAAAAAAAAAAAAAAAAA}');
  const { server } = createMetadata({ placementDir: dir });
  const base = await start(server);
  try {
    assert.equal((await get(base, '/healthz')).status, 200);
    assert.equal((await (await get(base, '/rates')).json()).base, 'USD');
    const ud = await (await get(base, '/latest/user-data')).text();
    assert.match(ud, /vm-meta startup/);
    assert.match(ud, /VM\{AAAAAAAAAAAAAAAAAAAAAAAA\}/, 'serves the injected C10 placement flag');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('metadata: user-data has no flag when no placement file is injected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-meta-empty-'));
  const { server } = createMetadata({ placementDir: dir });
  const base = await start(server);
  try {
    const ud = await (await get(base, '/latest/user-data')).text();
    assert.doesNotMatch(ud, /VM\{/, 'no flag when none is injected');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an oversized request is refused (413) and the service stays up', async () => {
  const { server } = createCollector();
  const base = await start(server);
  try {
    const big = await fetch(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(20000) }) });
    assert.equal(big.status, 413);
    // The process did not crash: a normal request still works.
    assert.equal((await get(base, '/healthz')).status, 200);
    assert.equal((await post(base, '/', { ok: true })).status, 202);
  } finally { server.close(); }
});

test('collector: records what it is sent and counts hits', async () => {
  const { server } = createCollector();
  const base = await start(server);
  try {
    assert.equal((await get(base, '/healthz')).status, 200);
    assert.equal((await post(base, '/', { stolen: 'cookie=abc' })).status, 202);
    assert.equal((await post(base, '/collect', { more: 'data' })).status, 202);
    assert.equal((await (await get(base, '/hits')).json()).count, 2);
  } finally { server.close(); }
});

test('collector /c/<id>: a tagged hit from the bot and an untagged one are told apart, the id is checked, the sidecar hears ids and counts only', async () => {
  const sent = [];
  const { server } = createCollector({ instanceId: 'i-ABCDEFGHIJKLMNOP', eventsUrl: 'http://sidecar:9000', post: (url, event) => sent.push({ url, event }) });
  const base = await start(server);
  const flag = 'VM{ABCDEFGHIJKLMNOPQRSTUVWX}';
  try {
    const tagged = await fetch(`${base}/c/abcdefghijklmnop?d=${encodeURIComponent(`{"console_key":"${flag}"}`)}`, { headers: { 'x-vm-visit': `v-${crypto.randomUUID()}` } });
    assert.equal(tagged.status, 200);
    assert.equal(tagged.headers.get('content-type'), 'image/gif');
    assert.equal(tagged.headers.get('access-control-allow-origin'), '*');
    await fetch(`${base}/c/wrongid`, { method: 'POST', body: 'hello' });
    await fetch(`${base}/c/abcdefghijklmnop`, { headers: { 'x-vm-visit': 'forged' } });
    assert.equal((await fetch(`${base}/c/abcdefghijklmnop`, { method: 'OPTIONS' })).status, 204);
    assert.equal(sent.length, 3);
    assert.deepEqual(sent.map((s) => [s.event.data.collector_id_ok, s.event.data.bot_tagged]), [[true, true], [false, false], [true, false]]);
    assert.equal(sent[0].event.data.candidate_sha256, crypto.createHash('sha256').update(flag).digest('hex'));
    assert.equal(sent[1].event.data.candidate_sha256, undefined);
    for (const s of sent) {
      assert.equal(s.event.type, 'collector.hit');
      assert.equal(s.event.source, 'mock');
      assert.deepEqual(Object.keys(s.event.data).filter((k) => !['collector_id_ok', 'bot_tagged', 'size', 'candidate_sha256'].includes(k)), [], 'no content in the event');
      assert.doesNotMatch(JSON.stringify(s.event), /VM\{|console_key/);
    }
    const inbox = await (await get(base, '/inbox')).json();
    assert.equal(inbox.id, 'abcdefghijklmnop');
    assert.equal(inbox.hits.length, 3);
    assert.match(inbox.hits[0].data, /console_key/);
    assert.equal(inbox.hits[0].bot_tagged, true);
  } finally { server.close(); }
});

test('collector keeps the last 20 hits only', async () => {
  const { server } = createCollector({ instanceId: 'i-ABCDEFGHIJKLMNOP', eventsUrl: '' });
  const base = await start(server);
  try {
    for (let i = 0; i < 25; i++) await fetch(`${base}/c/abcdefghijklmnop?n=${i}`);
    const inbox = await (await get(base, '/inbox')).json();
    assert.equal(inbox.hits.length, 20);
    assert.match(inbox.hits.at(-1).data, /n=24/);
    assert.match(inbox.hits[0].data, /n=5/);
  } finally { server.close(); }
});
