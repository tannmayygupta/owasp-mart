// Unit tests of the shared helpers: reading the one start document from standard input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import http from 'node:http';
import { readDocument, passThrough, listen, closeServer } from './common.mjs';

test('readDocument: a complete document ends the read even when the input is never closed (Compose containers have no stdin-once flag)', async () => {
  const s = new PassThrough();
  const p = readDocument(s);
  s.write('{"a":');
  s.write('1}\n'); // no end() call
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('hung'), 1500))]);
  assert.deepEqual(r, { ok: true, value: { a: 1 } });
});

test('readDocument: input closed after a document, split over chunks, is read whole', async () => {
  const r = await readDocument(Readable.from(['{"a"', ':[1,2,', '3]}']));
  assert.deepEqual(r, { ok: true, value: { a: [1, 2, 3] } });
});

test('readDocument: fixed reasons, never part of the input', async () => {
  assert.deepEqual(await readDocument(Readable.from([''])), { ok: false, reason: 'empty' });
  assert.deepEqual(await readDocument(Readable.from(['{"a": '])), { ok: false, reason: 'not-json' });
  assert.deepEqual(await readDocument(Readable.from([Buffer.from([0x7b, 0xc3, 0x28, 0x7d])])), { ok: false, reason: 'not-utf8' });
  assert.deepEqual(await readDocument(Readable.from(['x'.repeat(50)]), 10), { ok: false, reason: 'too-large' });
});

test('readDocument: data after the first complete object is a bad document (same chunk, later chunk, garbage)', async () => {
  assert.deepEqual(await readDocument(Readable.from(['{"a":1}{"b":2}'])), { ok: false, reason: 'trailing-data' });
  assert.deepEqual(await readDocument(Readable.from(['{"a":1}garbage'])), { ok: false, reason: 'trailing-data' });
  const s = new PassThrough();
  const p = readDocument(s, 65536, { graceMs: 300 });
  s.write('{"a":1}');
  setTimeout(() => s.write('{"b":2}'), 30);
  assert.deepEqual(await p, { ok: false, reason: 'trailing-data' });
  assert.deepEqual(await readDocument(Readable.from(['{"a":1}  \n\t'])), { ok: true, value: { a: 1 } }, 'white space after the object is fine');
  assert.deepEqual(await readDocument(Readable.from(['{"s":"}{\\"}"}'])), { ok: true, value: { s: '}{"}' } }, 'braces inside strings do not end the object');
});

test('readDocument: input that never completes is a bad document after the deadline', async () => {
  const s = new PassThrough();
  const p = readDocument(s, 65536, { deadlineMs: 80 });
  s.write('{"a": ');
  assert.deepEqual(await p, { ok: false, reason: 'timeout' });
  assert.deepEqual(await readDocument(new PassThrough(), 65536, { deadlineMs: 50 }), { ok: false, reason: 'timeout' }, 'nothing at all');
});

test('readDocument: a top-level value that is not an object is rejected at once, without waiting', async () => {
  for (const input of ['[1,2,3]', '123', '"text"', 'null', 'true', 'plain text']) {
    const s = new PassThrough(); // never ended: must not hang
    const p = readDocument(s, 65536, { deadlineMs: 5000 });
    s.write(input);
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('hung'), 1000))]);
    assert.deepEqual(r, { ok: false, reason: 'not-object' }, input);
  }
});

test('passThrough: an upstream that breaks off after the headers destroys the client connection; before the headers it answers 502', async () => {
  const up = http.createServer((req, res) => {
    if (req.url === '/half') { res.writeHead(200, { 'content-length': '100' }); res.write('partial'); setTimeout(() => res.destroy(), 20); } else res.destroy();
  });
  const upPort = await listen(up, 0, '127.0.0.1');
  const front = http.createServer(passThrough(`http://127.0.0.1:${upPort}`));
  const port = await listen(front, 0, '127.0.0.1');
  const get = (p) => new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: p, timeout: 2000 }, (res) => {
      res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode, ended: 'clean' }));
      res.on('error', () => resolve({ status: res.statusCode, ended: 'destroyed' })); res.on('aborted', () => resolve({ status: res.statusCode, ended: 'destroyed' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ended: 'hung' }); });
    req.on('error', () => resolve({ ended: 'error' }));
  });
  try {
    assert.equal((await get('/half')).ended, 'destroyed');
    assert.equal((await get('/nothing')).status, 502);
  } finally { await closeServer(front); await closeServer(up); }
});

test('listen: resolves with the port and leaves no error listener behind; a busy port rejects', async () => {
  const s = http.createServer();
  const port = await listen(s, 0, '127.0.0.1');
  assert.ok(port > 0);
  assert.equal(s.listenerCount('error'), 0);
  const t = http.createServer();
  await assert.rejects(listen(t, port, '127.0.0.1'));
  await closeServer(s);
});