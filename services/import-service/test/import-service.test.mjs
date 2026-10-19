// Isolated import service tests (T-12, FR-SHP-13): each job runs in a fresh
// process, the preview merge is safe (no prototype pollution), a slow job times
// out, and a job round-trips over the unix socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// Enable the worker's test-only `__delay_ms` hook (forked workers inherit this).
process.env.VM_IMPORT_TEST_HOOKS = '1';
import { runJob, createImportServer } from '../src/server.mjs';

test('a job returns a preview merging the product over the defaults', async () => {
  const r = await runJob({ product: { title: 'Mug', price_cents: 899 } });
  assert.equal(r.ok, true);
  assert.equal(r.preview.title, 'Mug');
  assert.equal(r.preview.price_cents, 899);
  assert.deepEqual(r.preview.tags, []); // default kept
  assert.ok(Number.isInteger(r.worker_pid));
});

test('each job runs in a FRESH process (different worker pid)', async () => {
  // Overlap two jobs so both workers are alive at once — the OS cannot reuse the
  // first pid for the second, so the assertion cannot flake on pid reuse.
  const [a, b] = await Promise.all([
    runJob({ __delay_ms: 300, product: { title: 'A' } }),
    runJob({ __delay_ms: 300, product: { title: 'B' } }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.ok(Number.isInteger(a.worker_pid) && Number.isInteger(b.worker_pid));
  assert.notEqual(a.worker_pid, b.worker_pid, 'a new process per job');
});

test('the preview merge is safe: a __proto__ payload does not pollute, in the job or here', async () => {
  const r = await runJob({ product: JSON.parse('{"title":"X","__proto__":{"polluted":"yes"}}') });
  assert.equal(r.ok, true);
  assert.equal(r.preview.title, 'X');
  assert.equal(r.preview.polluted, undefined, 'the polluting key is dropped from the preview');
  // The worker reports its OWN prototype was not polluted (the parent process is
  // never at risk, so the proof must come from inside the worker).
  assert.equal(r.proto_check, 'clean', 'the worker process Object.prototype is not polluted');
  // And a nested attempt.
  const n = await runJob({ product: JSON.parse('{"meta":{"__proto__":{"x":1}}}') });
  assert.equal(n.ok, true);
  assert.equal(n.proto_check, 'clean', 'still no pollution in the worker, nested case');
});

test('a slow job is killed by the timeout', async () => {
  const r = await runJob({ __delay_ms: 2000 }, { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
});

test('non-object input yields the safe default preview', async () => {
  const r = await runJob({ product: 'not-an-object' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.preview, { title: '', description: '', price_cents: 0, tags: [] });
});

// Windows named pipes do not support the half-close (client sends FIN, server
// then writes the reply) that the one-job-per-connection protocol uses; the real
// deployment and CI are Linux (unix sockets), and the Docker harness proves the
// socket there. So run this only off Windows.
test('a job round-trips over the unix socket', { skip: process.platform === 'win32' ? 'unix-socket half-close differs on Windows named pipes' : false }, async () => {
  const socketPath = path.join(os.tmpdir(), `vm-import-${process.pid}-${Date.now()}.sock`);
  const { server, listen } = createImportServer({ socketPath });
  await listen();
  try {
    const result = await new Promise((resolve, reject) => {
      const conn = net.connect(socketPath, () => { conn.end(JSON.stringify({ product: { title: 'Sock' } })); });
      let data = '';
      conn.on('data', (c) => { data += c; });
      conn.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      conn.on('error', reject);
    });
    assert.equal(result.ok, true);
    assert.equal(result.preview.title, 'Sock');
    // Invalid JSON over the socket is refused (and the server stays up).
    const bad = await new Promise((resolve, reject) => {
      const conn = net.connect(socketPath, () => conn.end('{not json'));
      let data = '';
      conn.on('data', (c) => { data += c; });
      conn.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      conn.on('error', reject);
    });
    assert.deepEqual(bad, { ok: false, error: 'bad_json' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// A slowloris: send one byte and never finish. The idle timeout resets on each
// byte, so only the absolute per-connection deadline drops it and frees the slot.
test('the absolute deadline drops a connection that never finishes', { skip: process.platform === 'win32' ? 'unix-socket behaviour differs on Windows named pipes' : false }, async () => {
  const socketPath = path.join(os.tmpdir(), `vm-import-slow-${process.pid}-${Date.now()}.sock`);
  const { server, listen } = createImportServer({ socketPath, connDeadlineMs: 200 });
  await listen();
  try {
    const ms = await new Promise((resolve, reject) => {
      const conn = net.connect(socketPath, () => conn.write('{')); // one byte, no FIN
      const t0 = Date.now();
      const guard = setTimeout(() => reject(new Error('the connection was not dropped by the deadline')), 3000);
      conn.on('close', () => { clearTimeout(guard); resolve(Date.now() - t0); });
      conn.on('error', () => {}); // a reset when the server destroys the socket is expected
    });
    assert.ok(ms < 2000, `dropped in ${ms}ms, well under the 3 s guard`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});


// ---- C06 in a deployed lab (story L-30): the audit token only comes back through the pollution ----
const TOKEN = 'VM{' + 'ABCDEFGH'.repeat(3) + '}';
const poll = () => JSON.parse('{"product":{"title":"widget","__proto__":{"internalAudit":true}}}');

test('C06: with the audit token placed, the pollution makes the preview return it; a plain job and a job with other keys do not', async () => {
  const hit = await runJob(poll(), { auditToken: TOKEN });
  assert.equal(hit.ok, true);
  assert.equal(hit.auditToken, TOKEN);
  assert.equal(hit.proto_check, 'polluted');
  for (const job of [{ product: { title: 'Mug' } }, JSON.parse('{"product":{"title":"x","__proto__":{"somethingElse":1}}}'), { product: { internalAudit: true } }, { internalAudit: true }]) {
    const r = await runJob(job, { auditToken: TOKEN });
    assert.equal(r.auditToken, null, JSON.stringify(job));
  }
  assert.ok(!JSON.stringify(await runJob({ product: { title: 'Mug' } }, { auditToken: TOKEN })).includes(TOKEN), 'the token is nowhere in an ordinary answer');
});

test('C06: without a placed token the merge is the safe one: the same pollution does nothing and returns no token', async () => {
  const r = await runJob(poll(), { auditToken: null });
  assert.equal(r.ok, true);
  assert.equal(r.auditToken, null);
  assert.equal(r.proto_check, 'clean');
  assert.equal(r.preview.internalAudit, undefined);
});

test('C06: the token is read from the placement file, only a plain one-word value, and a missing or odd file gives none', async () => {
  const { readAuditToken } = await import('../src/server.mjs');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c06-'));
  const f = path.join(dir, 'C06.placement');
  fs.writeFileSync(f, `${TOKEN}\n`);
  assert.equal(readAuditToken(f), TOKEN);
  fs.writeFileSync(f, 'two words');
  assert.equal(readAuditToken(f), null);
  fs.writeFileSync(f, '');
  assert.equal(readAuditToken(f), null);
  assert.equal(readAuditToken(path.join(dir, 'nope')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});