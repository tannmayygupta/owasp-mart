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