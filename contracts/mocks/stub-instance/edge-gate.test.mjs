// Unit tests of the stub edge and gate: pass-through only, plus the relay path filter and the ingest wrapper reading its key from standard input.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createEdge } from './edge.mjs';
import { createGate } from './gate.mjs';
import { runIngest } from './ingest.mjs';
import { main, COMMANDS } from './main.mjs';
import { signEvent } from '../fake-ingest/sign.mjs';
import { listen, closeServer } from './common.mjs';
import { freshValues, sidecarStartDocument } from './fixtures.mjs';

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(c), headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
}
const echo = () => http.createServer((req, res) => {
  const c = []; req.on('data', (x) => c.push(x));
  req.on('end', () => { res.writeHead(207, { 'x-seen-path': req.url, 'x-seen-method': req.method, 'x-seen-ct': req.headers['content-type'] || '' }); res.end(Buffer.concat(c)); });
});

test('gate always allows: method, path, headers and body bytes reach the sidecar and the answer comes back unchanged', async () => {
  const up = echo();
  const upPort = await listen(up, 0, '127.0.0.1');
  const gate = createGate({ upstreamUrl: `http://127.0.0.1:${upPort}` });
  const port = await gate.listen(0, '127.0.0.1');
  try {
    const body = Buffer.from([0, 1, 2, 255, 254]);
    const r = await request(port, { method: 'PUT', path: '/x/y?z=1', headers: { 'content-type': 'application/octet-stream' }, body });
    assert.equal(r.status, 207);
    assert.equal(r.headers['x-seen-path'], '/x/y?z=1');
    assert.equal(r.headers['x-seen-method'], 'PUT');
    assert.equal(r.headers['x-seen-ct'], 'application/octet-stream');
    assert.ok(r.buf.equals(body));
  } finally { await gate.stop(); await closeServer(up); }
});

test('edge: the player port passes everything to the gate; an unreachable gate answers 502', async () => {
  const up = echo();
  const upPort = await listen(up, 0, '127.0.0.1');
  const edge = createEdge({ gateUrl: `http://127.0.0.1:${upPort}`, ingestUrl: 'http://127.0.0.1:1' });
  const ports = await edge.listen({ playerPort: 0, relayPort: 0, host: '127.0.0.1' });
  try {
    assert.equal((await request(ports.playerPort, { path: '/anything' })).headers['x-seen-path'], '/anything');
  } finally { await edge.stop(); await closeServer(up); }
  const edge2 = createEdge({ gateUrl: 'http://127.0.0.1:1' });
  const p2 = await edge2.listen({ playerPort: 0, relayPort: 0, host: '127.0.0.1' });
  try { assert.equal((await request(p2.playerPort)).status, 502); } finally { await edge2.stop(); }
});

test('edge relay: only /internal/v1/events is forwarded, byte for byte; other ingest routes are not reachable', async () => {
  const up = echo();
  const upPort = await listen(up, 0, '127.0.0.1');
  const edge = createEdge({ gateUrl: 'http://127.0.0.1:1', ingestUrl: `http://127.0.0.1:${upPort}` });
  const ports = await edge.listen({ playerPort: 0, relayPort: 0, host: '127.0.0.1' });
  try {
    const body = Buffer.from('{"exact":"bytes"}  ');
    const r = await request(ports.relayPort, { method: 'POST', path: '/internal/v1/events', headers: { 'content-type': 'application/json' }, body });
    assert.equal(r.status, 207);
    assert.ok(r.buf.equals(body));
    assert.equal((await request(ports.relayPort, { path: '/_fake/events' })).status, 404);
    assert.equal((await request(ports.relayPort, { path: '/' })).status, 404);
  } finally { await edge.stop(); await closeServer(up); }
});

test('ingest wrapper: takes the key and instance from standard input only; a bad document starts nothing', async () => {
  const v = freshValues();
  assert.equal(await runIngest({ stdin: Readable.from(['{}']), port: 0, host: '127.0.0.1', log: () => {} }), null);
  const lines = [];
  const s = await runIngest({ stdin: Readable.from([JSON.stringify(sidecarStartDocument(v))]), port: 0, host: '127.0.0.1', log: (m) => lines.push(m) });
  try {
    const ev = { schema_version: '0.1', instance_id: v.instance_id, epoch: v.epoch, seq: 7, type: 'shop.catalog_query_error', source: 'shop', session_kind: 'player', user_id: null, ts: '2026-01-01T00:00:00Z', data: { route: '/a', error_class: 'x' } };
    const signed = signEvent(v.event_key, ev);
    const r = await request(s.port, { method: 'POST', path: '/internal/v1/events', headers: signed.headers, body: signed.body });
    assert.equal(r.status, 202);
    const bad = signEvent('FAKE-OTHER-KEY-0000000000000000000000000', ev);
    assert.equal((await request(s.port, { method: 'POST', path: '/internal/v1/events', headers: bad.headers, body: bad.body })).status, 401);
    assert.ok(!lines.join('\n').includes(v.event_key));
  } finally { await closeServer(s.server); }
});

test('main: unknown command exits 2 and names the commands; the five commands and the harness-only ingest exist', async () => {
  assert.deepEqual(COMMANDS, ['shop', 'inject', 'sidecar', 'edge', 'gate', 'ingest']);
  assert.equal(await main(['bogus'], {}), 2);
  assert.equal(await main([], {}), 2);
  assert.equal(await main(['gate', '--oops'], {}), 2);
});

// ---- exit 2 on a bad start document: no listener, nothing from the document printed ----
async function bad(cmd, input, deps = {}) {
  const v = freshValues();
  const doc = typeof input === 'function' ? input(v) : input;
  const out = [];
  const o = { log: console.log, err: console.error };
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  let code;
  try { code = await main([cmd], {}, { stdin: Readable.from([doc]), deps }); } finally { console.log = o.log; console.error = o.err; }
  return { code, out: out.join('\n'), v };
}
const spy = () => { const calls = []; return { calls, fn: (...a) => { calls.push(a); throw new Error('must not be called'); } }; };
const BADS = {
  'not JSON': () => 'not json',
  'a schema violation': (v) => JSON.stringify({ ...sidecarStartDocument(v), epoch: 0 }),
  'the removed first_seq': (v) => JSON.stringify({ ...sidecarStartDocument(v), first_seq: 1 }),
  'a repeated digest': (v) => { const d = sidecarStartDocument(v); d.flag_digests.push(d.flag_digests[0]); return JSON.stringify(d); },
  'trailing data': (v) => JSON.stringify(sidecarStartDocument(v)) + '{}',
  'an array': () => '[1]',
};

test('main sidecar: a bad start document exits 2, starts no sidecar and prints nothing from the document', async () => {
  for (const [name, make] of Object.entries(BADS)) {
    const s = spy();
    const r = await bad('sidecar', make, { createSidecar: s.fn });
    assert.equal(r.code, 2, name);
    assert.equal(s.calls.length, 0, `${name}: no listener`);
    assert.equal(r.out, 'sidecar: bad start document', name);
    assert.ok(!r.out.includes(r.v.event_key), name);
  }
});

test('main ingest: a bad start document exits 2 and starts no server; nothing from the document printed', async () => {
  for (const [name, make] of Object.entries(BADS)) {
    const r = await bad('ingest', make);
    assert.equal(r.code, 2, name);
    assert.equal(r.out, 'ingest: bad start document', name);
    assert.ok(!r.out.includes('listening'), name);
  }
});

test('main inject: a bad document exits 10 through main, prints one fixed line, writes nothing', async () => {
  for (const [name, make] of Object.entries({ 'not JSON': () => 'nope', 'an array': () => '[1]', 'a start document': (v) => JSON.stringify(sidecarStartDocument(v)) })) {
    const r = await bad('inject', make);
    assert.equal(r.code, 10, name);
    assert.equal(r.out, 'inject: exit 10 (bad document)', name);
    assert.ok(!r.out.includes(r.v.event_key), name);
  }
});

test('main sidecar: a good start document starts the sidecar (the control case)', async () => {
  const made = [];
  const code = await main(['sidecar', '--relay', 'http://x:1/y', '--upstream', 'http://x:2'], {}, {
    stdin: Readable.from([JSON.stringify(sidecarStartDocument(freshValues()))]),
    deps: { createSidecar: (o) => { made.push(o); return { nextSeq: () => 1, listen: async () => ({ playerPort: 1, eventsPort: 2 }) }; } },
  });
  assert.equal(code, null);
  assert.equal(made.length, 1);
  assert.equal(made[0].relayUrl, 'http://x:1/y');
  assert.equal(made[0].statePath, '/tmp/vm-sidecar-seq.json', 'the counter file is in the own /tmp of the sidecar');
});