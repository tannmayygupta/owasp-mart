// Tests of the event relay (relay.mjs): real sockets on 127.0.0.1, a capturing fake ingest. No Docker.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createRateLimiter, createRelay, MAX_EVENT_BYTES, parseIngestUrl, PROBLEMS, RELAY_PATH } from '../src/relay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SIG = `v1=${'a'.repeat(64)}`;
const EVENT = JSON.stringify({ schema_version: '0.1', type: 'shop.catalog_query_error', seq: 1 });

let ingest; let seen; let answer; let relay; let relayPort; let ingestPort;
const startRelay = async (opts = {}) => {
  const r = createRelay({ ingestUrl: `http://127.0.0.1:${ingestPort}`, ...opts });
  await new Promise((resolve) => r.server.listen(0, '127.0.0.1', resolve));
  return { ...r, port: r.server.address().port, stop: () => new Promise((resolve) => { r.server.closeAllConnections(); r.server.close(resolve); }) };
};
const call = (port, { method = 'POST', p = RELAY_PATH, headers, body } = {}) => new Promise((resolve, reject) => {
  const h = headers ?? { 'content-type': 'application/json', 'x-vm-signature': SIG };
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
    const c = [];
    res.on('data', (x) => c.push(x));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8') }));
  });
  r.on('error', reject);
  r.end(body);
});

before(async () => {
  seen = [];
  answer = { status: 202, body: '{"status":"accepted"}' };
  ingest = http.createServer((req, res) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(c) });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve));
  ingestPort = ingest.address().port;
  relay = await startRelay();
  relayPort = relay.port;
});
after(async () => { await relay.stop(); ingest.closeAllConnections(); ingest.close(); });

test('one good event is forwarded byte for byte with its signature, and the ingest answer comes back', async () => {
  seen.length = 0;
  const body = '{"b":1,\n "a":[1, 2]}'; // spacing and order are kept: the bytes are not re-serialised
  const r = await call(relayPort, { body });
  assert.equal(r.status, 202);
  assert.equal(r.text, '{"status":"accepted"}');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, RELAY_PATH);
  assert.equal(seen[0].body.toString('utf8'), body);
  assert.equal(seen[0].headers['x-vm-signature'], SIG);
  assert.equal(seen[0].headers['content-type'], 'application/json');
});

test('an answer of the ingest (409, 401, 413) is passed on unchanged so the sidecar can drop or retry', async () => {
  for (const status of [200, 401, 409, 413, 422, 503]) {
    answer = { status, body: JSON.stringify({ status }) };
    const r = await call(relayPort, { body: EVENT });
    assert.equal(r.status, status);
  }
  answer = { status: 202, body: '{"status":"accepted"}' };
});

test('the instance side hears only a status word or a registry code of the ingest answer, never the rest of its body', async () => {
  answer = { status: 422, body: JSON.stringify({ code: 'EVT-SCHEMA', title: 'x', errors: [{ pointer: '/a', detail: 'leaky'.repeat(1000) }] }) };
  const r = await call(relayPort, { body: EVENT });
  assert.equal(r.status, 422);
  assert.deepEqual(JSON.parse(r.text), { code: 'EVT-SCHEMA' });
  assert.equal(r.headers['content-type'], 'application/problem+json');
  answer = { status: 202, body: JSON.stringify({ status: 'accepted', instance_id: 'i-X', seq: 1, note: 'more' }) };
  assert.deepEqual(JSON.parse((await call(relayPort, { body: EVENT })).text), { status: 'accepted' });
  answer = { status: 409, body: 'not json at all' };
  assert.equal((await call(relayPort, { body: EVENT })).text, '{}');
  answer = { status: 202, body: '{"status":"accepted"}' };
});

test('refusals never reach the ingest: path, method, content type, signature header, size, shape', async () => {
  seen.length = 0;
  const json = { 'content-type': 'application/json', 'x-vm-signature': SIG };
  const cases = [
    [{ p: '/internal/v1/events/x', body: EVENT }, 404, 'REQ-ROUTE-UNKNOWN'],
    [{ p: '/_fake/events', method: 'GET' }, 404, 'REQ-ROUTE-UNKNOWN'],
    [{ p: `${RELAY_PATH}?a=1`, body: EVENT }, 404, 'REQ-ROUTE-UNKNOWN'],
    [{ method: 'GET' }, 405, 'REQ-METHOD-NOT-ALLOWED'],
    [{ method: 'PUT', body: EVENT }, 405, 'REQ-METHOD-NOT-ALLOWED'],
    [{ headers: { 'content-type': 'text/plain', 'x-vm-signature': SIG }, body: EVENT }, 415, 'REQ-UNSUPPORTED-MEDIA-TYPE'],
    [{ headers: { 'x-vm-signature': SIG }, body: EVENT }, 415, 'REQ-UNSUPPORTED-MEDIA-TYPE'],
    [{ headers: { 'content-type': 'application/json' }, body: EVENT }, 401, 'EVT-BAD-SIGNATURE'],
    [{ headers: { 'content-type': 'application/json', 'x-vm-signature': 'v1=short' }, body: EVENT }, 401, 'EVT-BAD-SIGNATURE'],
    [{ headers: { 'content-type': 'application/json', 'x-vm-signature': `v1=${'A'.repeat(64)}` }, body: EVENT }, 401, 'EVT-BAD-SIGNATURE'],
    [{ headers: json, body: `[${EVENT},${EVENT}]` }, 422, 'EVT-SCHEMA'],
    [{ headers: json, body: '[]' }, 422, 'EVT-SCHEMA'],
    [{ headers: json, body: 'null' }, 422, 'EVT-SCHEMA'],
    [{ headers: json, body: '"text"' }, 422, 'EVT-SCHEMA'],
    [{ headers: json, body: '{"a":' }, 422, 'EVT-SCHEMA'],
    [{ headers: json, body: Buffer.from([0x7b, 0xff, 0x7d]) }, 422, 'EVT-SCHEMA'],
    [{ headers: json, body: '' }, 422, 'EVT-SCHEMA'],
    [{ headers: json, body: JSON.stringify({ pad: 'x'.repeat(MAX_EVENT_BYTES) }) }, 413, 'EVT-TOO-LARGE'],
  ];
  for (const [req, status, code] of cases) {
    const r = await call(relayPort, req);
    assert.equal(r.status, status, `${req.method ?? 'POST'} ${req.p ?? ''} ${code}`);
    assert.equal(r.headers['content-type'], 'application/problem+json');
    const b = JSON.parse(r.text);
    assert.equal(b.code, code);
    assert.equal(b.status, status);
    assert.equal(b.type, `urn:vulnmart:error:${code}`);
    assert.match(b.request_id, /^[A-Za-z0-9-]{8,64}$/);
  }
  assert.equal(seen.length, 0, 'the ingest saw nothing');
});

test('the size limit is exact: 16384 bytes pass, 16385 are refused; a chunked body is counted too', async () => {
  seen.length = 0;
  const make = (n) => { const pad = n - JSON.stringify({ p: '' }).length; return JSON.stringify({ p: 'x'.repeat(pad) }); };
  const ok = make(MAX_EVENT_BYTES);
  assert.equal(Buffer.byteLength(ok), MAX_EVENT_BYTES);
  assert.equal((await call(relayPort, { body: ok })).status, 202);
  assert.equal((await call(relayPort, { body: make(MAX_EVENT_BYTES + 1) })).status, 413);
  assert.equal(seen.length, 1);
  // chunked: no Content-Length, 20 KiB sent in pieces
  const status = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: relayPort, path: RELAY_PATH, method: 'POST', headers: { 'content-type': 'application/json', 'x-vm-signature': SIG, 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', (e) => (e.code === 'ECONNRESET' ? resolve(413) : reject(e)));
    r.write('{"p":"');
    for (let i = 0; i < 20; i++) r.write('x'.repeat(1024));
    r.end('"}');
  });
  assert.equal(status, 413);
  assert.equal(seen.length, 1, 'the oversize chunked body never reached the ingest');
});

test('the ingest cannot be reached: 500 problem body, and a slow ingest ends at the time limit', async () => {
  const dead = await startRelay({ ingestUrl: 'http://127.0.0.1:9' });
  const r = await call(dead.port, { body: EVENT });
  assert.equal(r.status, 500);
  assert.equal(JSON.parse(r.text).code, 'REQ-INTERNAL');
  await dead.stop();
  const slow = http.createServer(() => {}); // never answers
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const limited = await startRelay({ ingestUrl: `http://127.0.0.1:${slow.address().port}`, timeoutMs: 300 });
  const t0 = Date.now();
  const r2 = await call(limited.port, { body: EVENT });
  assert.equal(r2.status, 500);
  assert.ok(Date.now() - t0 < 3000);
  await limited.stop();
  slow.closeAllConnections(); slow.close();
});

test('rate limit per peer: the fourth call in the window is 429 with Retry-After and never forwarded; a new window resets it', async () => {
  const clock = { ms: 1_000_000 };
  const r = await startRelay({ rateMax: 3, rateWindowMs: 10000, now: () => clock.ms });
  seen.length = 0;
  for (let i = 0; i < 3; i++) assert.equal((await call(r.port, { body: EVENT })).status, 202);
  const blocked = await call(r.port, { body: EVENT });
  assert.equal(blocked.status, 429);
  assert.equal(JSON.parse(blocked.text).code, 'REQ-RATE-LIMITED');
  assert.equal(blocked.headers['retry-after'], '10');
  assert.equal(seen.length, 3);
  clock.ms += 10001;
  assert.equal((await call(r.port, { body: EVENT })).status, 202);
  await r.stop();
});

test('rate limiter: bounded table, windows are per key', () => {
  let t = 0;
  const l = createRateLimiter({ max: 1, windowMs: 100, now: () => t });
  assert.equal(l.allow('a'), true);
  assert.equal(l.allow('a'), false);
  assert.equal(l.allow('b'), true);
  t = 100;
  assert.equal(l.allow('a'), true);
  const big = createRateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
  for (let i = 0; i < 5000; i++) big.allow(`k${i}`);
  assert.equal(big.allow('new-peer'), false, 'a full table of live peers refuses a new one');
  assert.equal(big.size(), 5000);
});

test('the ingest URL must be an http origin; https and paths are refused', () => {
  assert.equal(parseIngestUrl('http://ingest:8081').hostname, 'ingest');
  for (const bad of ['nonsense', 'ftp://x:1', 'http://u:p@x:1', 'http://x:1/path', 'http://x:1/?q=1', 'http://x:1/#f']) assert.throws(() => parseIngestUrl(bad), /ingest URL/, bad);
  assert.throws(() => createRelay({ ingestUrl: 'https://ingest:8081' }), /needs the CA/);
});

test('the problem titles equal the IF-8 registry (contracts/errors/error-codes.yaml)', () => {
  const reg = new Map(yaml.load(fs.readFileSync(path.join(ROOT, 'contracts', 'errors', 'error-codes.yaml'), 'utf8')).codes.map((c) => [c.code, c]));
  for (const [code, [status, title]] of Object.entries(PROBLEMS)) {
    assert.ok(reg.has(code), code);
    assert.equal(reg.get(code).status, status, code);
    assert.equal(reg.get(code).title, title, code);
  }
});

test('the relay holds no key and reads no environment', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps', 'edge', 'src', 'relay.mjs'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/process\.env|readFileSync|createHmac|event_key/.test(src));
});

// A real TLS round trip with a throwaway certificate (skipped where the openssl program is missing). One listener on vm-p carries the relayed
// events and the orchestrator's state reports, so the relay must be able to verify a private CA.
const opensslOk = spawnSync('openssl', ['version']).status === 0;
test('an https ingest with the CA of its certificate receives the event; the wrong CA is refused and answered as an internal error', { skip: !opensslOk }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tls-'));
  const make = (name) => {
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`), '-days', '1',
      '-subj', '/CN=ingest.test', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { key: fs.readFileSync(path.join(dir, `${name}.key`)), cert: fs.readFileSync(path.join(dir, `${name}.crt`), 'utf8') };
  };
  const good = make('good');
  const other = make('other');
  const got = [];
  const tlsIngest = https.createServer({ key: good.key, cert: good.cert }, (req, res) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => { got.push({ url: req.url, sig: req.headers['x-vm-signature'], body: Buffer.concat(c).toString('utf8') }); res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"status":"accepted"}'); });
  });
  await new Promise((resolve) => tlsIngest.listen(0, '127.0.0.1', resolve));
  const url = `https://127.0.0.1:${tlsIngest.address().port}`;
  const ok = await startRelay({ ingestUrl: url, ingestCa: good.cert });
  const bad = await startRelay({ ingestUrl: url, ingestCa: other.cert });
  try {
    const r = await call(ok.port, { body: EVENT });
    assert.equal(r.status, 202);
    assert.deepEqual(got.map((g) => [g.url, g.sig, g.body]), [[RELAY_PATH, SIG, EVENT]]);
    const refused = await call(bad.port, { body: EVENT });
    assert.equal(refused.status, 500);
    assert.equal(JSON.parse(refused.text).code, 'REQ-INTERNAL');
    assert.equal(got.length, 1, 'nothing reached the ingest through the relay that does not trust its certificate');
  } finally {
    await ok.stop();
    await bad.stop();
    tlsIngest.closeAllConnections();
    tlsIngest.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});