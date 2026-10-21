// Unit tests of the fake lab (contracts/mocks/fake-lab/server.mjs) that need to reach into its state, so the service runs in this process.
// The black-box tests are apps/api/tests/test_lab_contract.py and scripts/e2e/lab.e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createFakeLab } from '../contracts/mocks/fake-lab/server.mjs';

const ORIGIN = 'https://dashboard.example.invalid';
const CSRF = 'UNIT-CSRF-TOKEN-0123456789';
const A_CAND = 'a-BBBBBBBBBBBBBBBB';

async function withLab(fn, options) {
  const lab = createFakeLab(options);
  const port = await lab.listen();
  const call = (method, path, user, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { cookie: `__Host-vm_session=FAKE-SESSION-${user}; __Host-vm_csrf=${CSRF}` };
    if (method === 'POST') { headers.origin = ORIGIN; headers['x-csrf-token'] = CSRF; }
    if (data !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
  try { await fn({ lab, call, port }); } finally { await lab.close(); }
}

const heldFlag = (id) => ({ id, type: 'activity', challenge: 'C11', explanation: 'held for review (unit test)', status: 'open', held: true,
  createdAt: '2026-10-09T00:00:00Z', decidedAt: null, note: null });
const challengeRow = async (call, key) => (await call('GET', `/api/v1/attempts/${A_CAND}/challenges`, 'REX')).json.items.find((r) => r.challenge_key === key);

test('a challenge with two open held flags stays held until both are decided', async () => {
  await withLab(async ({ lab, call }) => {
    lab.attempts.get(A_CAND).integrity.push(heldFlag('g-CCCCCCCCCCCCCCCC')); // the seed already holds C11 with g-BBBB...
    assert.equal((await challengeRow(call, 'C11')).held, true);
    const first = await call('POST', `/api/v1/attempts/${A_CAND}/integrity-flags/g-BBBBBBBBBBBBBBBB/decision`, 'REX', { decision: 'reject', note: 'one' });
    assert.equal(first.status, 200);
    assert.equal((await challengeRow(call, 'C11')).held, true, 'the second held flag is still open');
    const second = await call('POST', `/api/v1/attempts/${A_CAND}/integrity-flags/g-CCCCCCCCCCCCCCCC/decision`, 'REX', { decision: 'reject', note: 'two' });
    assert.equal(second.status, 200);
    assert.equal((await challengeRow(call, 'C11')).held, false, 'no held flag is open now');
  });
});

test('the reason of an incorrect flag stays on the server; the owner of a learner attempt is not shown the integrity flag it raises', async () => {
  await withLab(async ({ lab, call }) => {
    const A = 'a-AAAAAAAAAAAAAAAA';
    const fake = (c) => 'VM{' + c.repeat(24) + '}';
    for (const c of ['B', 'C', 'D', 'Z']) {
      const r = await call('POST', `/api/v1/attempts/${A}/flags`, 'ADA', { challenge_key: 'C04', flag: c === 'Z' ? 'nothing' : fake(c) });
      assert.deepEqual(r.json, { challenge_key: 'C04', result: 'incorrect', credit: 'none' });
    }
    assert.deepEqual(lab.reasonLog.map((e) => e.reason), ['decoy', 'other_instance', 'stale_epoch', 'wrong']);
    assert.deepEqual(lab.attempts.get(A).integrity.map((f) => f.type), ['decoy', 'sharing']); // kept for a human
    const own = await call('GET', `/api/v1/attempts/${A}/integrity-flags`, 'ADA');
    assert.deepEqual(own.json, { items: [], has_more: false });
    const id = lab.attempts.get(A).integrity[0].id;
    assert.equal((await call('POST', `/api/v1/attempts/${A}/integrity-flags/${id}/decision`, 'ADA', { decision: 'accept', note: 'x' })).status, 404);
    assert.equal(lab.attempts.get(A).integrity[0].status, 'open');
    assert.ok(!JSON.stringify(lab.reasonLog).includes('VM{'), 'no flag text in the log');
  });
});

test('listen rejects when the port is in use', async () => {
  const taken = net.createServer();
  await new Promise((r) => taken.listen(0, '127.0.0.1', r));
  const lab = createFakeLab({ port: taken.address().port });
  try { await assert.rejects(lab.listen(), (e) => e.code === 'EADDRINUSE'); } finally { await new Promise((r) => taken.close(r)); }
});

// ---- oversize bodies: answered with 413 and Connection: close, drained, then the socket is destroyed ----
const MAX = 64 * 1024;
const oversizeHead = (length) => `POST /api/v1/attempts/${A_CAND}/flags HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`;

// Opens a socket, lets `script(sock)` write, and resolves { text, closedAfterMs, closed } when the socket closes or `waitMs` passes.
function rawSession(port, script, waitMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const started = Date.now();
    let text = '';
    let done = false;
    const finish = (closed) => { if (done) return; done = true; clearTimeout(timer); const ms = Date.now() - started; sock.destroy(); resolve({ text, closed, ms }); };
    const timer = setTimeout(() => finish(false), waitMs);
    sock.on('data', (c) => { text += c; });
    sock.on('close', () => finish(true));
    sock.on('error', () => {});
    sock.on('connect', () => script(sock));
  });
}

test('after a 413 the answer carries Connection: close and the connection is closed', async () => {
  await withLab(async ({ port }) => {
    const r = await rawSession(port, (s) => { s.write(oversizeHead(MAX + 1000)); s.write(Buffer.alloc(MAX + 1000, 0x20)); });
    assert.match(r.text, /^HTTP\/1\.1 413 /);
    assert.match(r.text, /connection: close/i);
    assert.equal(r.closed, true, 'the socket was closed by the service');
  });
});

test('a body over the drain cap gets the connection dropped, and the service goes on', async () => {
  await withLab(async ({ port, call }) => {
    const total = 3 * 1024 * 1024;
    const r = await rawSession(port, (s) => {
      s.write(oversizeHead(total));
      const chunk = Buffer.alloc(256 * 1024, 0x20);
      let sent = 0;
      const pump = () => { while (sent < total) { sent += chunk.length; if (!s.write(chunk)) return s.once('drain', pump); } };
      pump();
    }, 8000);
    assert.equal(r.closed, true);
    assert.equal((await call('GET', `/api/v1/attempts/${A_CAND}`, 'CAM')).status, 200);
  });
});

test('a stalled oversize body is dropped after the stall time', async () => {
  await withLab(async ({ port }) => {
    const r = await rawSession(port, (s) => { s.write(oversizeHead(500000)); s.write(Buffer.alloc(MAX + 1000, 0x20)); }, 4000); // then nothing more
    assert.equal(r.closed, true, 'the socket was dropped');
    assert.ok(r.ms < 3000, `dropped after ${r.ms} ms`);
  }, { drainStallMs: 300 });
});

test('the drain timer of a finished oversize request does not kill a keep-alive socket or a later request', async () => {
  await withLab(async ({ port, call }) => {
    const get = `GET /api/v1/attempts/${A_CAND} HTTP/1.1\r\nHost: x\r\nCookie: __Host-vm_session=FAKE-SESSION-CAM\r\n\r\n`;
    const r = await rawSession(port, (s) => {
      s.write(get);
      setTimeout(() => s.write(get), 700); // after the stall time of 300 ms, on the same socket
    }, 1500);
    assert.equal((r.text.match(/HTTP\/1\.1 200 /g) ?? []).length, 2, r.text);
    await rawSession(port, (s) => { s.write(oversizeHead(MAX + 10)); s.write(Buffer.alloc(MAX + 10, 0x20)); }, 1500);
    await new Promise((res) => setTimeout(res, 600));
    assert.equal((await call('GET', `/api/v1/attempts/${A_CAND}`, 'CAM')).status, 200);
  }, { drainStallMs: 300 });
});

test('withdraw and undo: a candidate withdraws (deletion scheduled), repeats it, undoes it; a learner, a missing confirm and a wrong state are refused', async () => {
  await withLab(async ({ call }) => {
    const C = 'a-CCCCCCCCCCCCCCCC'; // a candidate attempt of CAM in state ready
    assert.equal((await call('POST', `/api/v1/attempts/${C}/withdraw`, 'CAM', { confirm: false })).status, 422);
    assert.equal((await call('POST', `/api/v1/attempts/a-AAAAAAAAAAAAAAAA/withdraw`, 'ADA', { confirm: true })).status, 409, 'a learner attempt is not withdrawn');
    assert.equal((await call('POST', `/api/v1/attempts/${C}/withdraw`, 'REX', { confirm: true })).status, 404, 'only the owner');
    assert.equal((await call('POST', `/api/v1/attempts/${C}/withdraw/undo`, 'CAM')).status, 409, 'not withdrawn yet');
    const first = await call('POST', `/api/v1/attempts/${C}/withdraw`, 'CAM', { confirm: true });
    assert.equal(first.status, 200);
    assert.equal(first.json.state, 'withdrawn');
    assert.match(first.json.delete_after, /^\d{4}-\d\d-\d\dT/);
    const again = await call('POST', `/api/v1/attempts/${C}/withdraw`, 'CAM', { confirm: true });
    assert.deepEqual([again.status, again.json.delete_after], [200, first.json.delete_after], 'idempotent, the first deletion date stays');
    const undone = await call('POST', `/api/v1/attempts/${C}/withdraw/undo`, 'CAM');
    assert.deepEqual([undone.status, undone.json.state, undone.json.delete_after], [200, 'withdrawn', null]);
  });
});
test('a sequenced run shows one challenge at a time, begin starts its countdown, a correct flag brings the next, and the account keeps the best points', async () => {
  await withLab(async ({ lab, call }) => {
    const H = 'a-HHHHHHHHHHHHHHHH';
    const list = async () => (await call('GET', `/api/v1/attempts/${H}/challenges`, 'ADA')).json;
    let body = await list();
    assert.deepEqual(body.items.map((i) => [i.challenge_key, i.state]), [['C01', 'ready']]);
    assert.equal(body.total, 11); assert.equal(body.current_key, 'C01');
    assert.equal((await call('POST', `/api/v1/attempts/${H}/challenges/C02/begin`, 'ADA')).status, 404, 'C02 is not reached');
    assert.equal((await call('POST', `/api/v1/attempts/${H}/flags`, 'ADA', { challenge_key: 'C01', flag: 'VM{' + 'A'.repeat(24) + '}' })).status, 409, 'not begun');
    const begun = await call('POST', `/api/v1/attempts/${H}/challenges/C01/begin`, 'ADA');
    assert.equal(begun.status, 200); assert.equal(begun.json.state, 'active'); assert.equal(begun.json.time_limit_seconds, 1200);
    assert.ok(begun.json.seconds_left > 1190 && begun.json.seconds_left <= 1200);
    assert.equal((await call('POST', `/api/v1/attempts/${H}/challenges/C01/begin`, 'ADA')).json.opened_at, begun.json.opened_at, 'a repeat changes nothing');
    const right = await call('POST', `/api/v1/attempts/${H}/flags`, 'ADA', { challenge_key: 'C01', flag: 'VM{' + 'A'.repeat(24) + '}' });
    assert.deepEqual(right.json, { challenge_key: 'C01', result: 'correct', credit: 'credited' });
    body = await list();
    assert.deepEqual(body.items.map((i) => [i.challenge_key, i.state]), [['C01', 'solved'], ['C02', 'ready']]);
    assert.equal(body.items[1].tier, 'Medium'); assert.equal(body.items[1].time_limit_seconds, 2400);
    lab.attempts.get(H).opened.set('C02', Date.now() - 41 * 60 * 1000); // the 40 minutes of C02 are over
    body = await list();
    assert.deepEqual(body.items.map((i) => [i.challenge_key, i.state]), [['C01', 'solved'], ['C02', 'expired'], ['C03', 'ready']]);
    assert.equal((await call('POST', `/api/v1/attempts/${H}/challenges/C02/hints/1/unlock`, 'ADA')).status, 409, 'no hint after the time');
    const acc = await call('GET', '/api/v1/me/progress', 'ADA');
    assert.equal(acc.status, 200); assert.ok(acc.json.total_points > 0 && acc.json.runs >= 2);
    assert.equal(acc.json.per_challenge.find((r) => r.challenge_key === 'C01').best_points, 90); // the mock weighs every challenge 90
  });
});