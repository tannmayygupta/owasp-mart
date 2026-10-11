// Unit tests of the stub shop (IF-6 section 3): health, readiness only after the marker AND an open database, version, planted flag, emit routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createShop, emitRequest } from './shop.mjs';
import { listen, closeServer } from './common.mjs';
import { freshValues } from './fixtures.mjs';

async function boot({ eventsUrl = 'http://127.0.0.1:1' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-shop-'));
  const run = path.join(root, 'run');
  const data = path.join(root, 'data');
  fs.mkdirSync(run); fs.mkdirSync(data);
  const paths = { flagsPath: path.join(run, 'flags.json'), snapshotPath: path.join(run, 'snapshot.db'), dbPath: path.join(data, 'shop.db') };
  const lines = [];
  const { server } = createShop({ ...paths, eventsUrl, log: (m) => lines.push(m) });
  const port = await listen(server, 0, '127.0.0.1');
  const get = (p, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject); req.end(body);
  });
  return { root, run, paths, lines, get, port, close: async () => { await closeServer(server); fs.rmSync(root, { recursive: true, force: true }); } };
}
const inject = (s, v) => {
  fs.writeFileSync(s.paths.snapshotPath, JSON.stringify({ stub_snapshot: true }));
  fs.writeFileSync(s.paths.flagsPath, JSON.stringify({ schema_version: '0.1', instance_id: v.instance_id, epoch: 1, flags: v.flags }));
  fs.writeFileSync(path.join(s.run, 'injected'), '');
};

test('before the marker: healthz 200, readyz 503, planted flag refused', async () => {
  const s = await boot();
  try {
    assert.equal((await s.get('/healthz')).status, 200);
    assert.equal((await s.get('/readyz')).status, 503);
    assert.equal((await s.get('/_stub/planted-flag?key=C01')).status, 503);
  } finally { await s.close(); }
});

test('after the marker with an open database: readyz 200; the snapshot was copied to /data', async () => {
  const s = await boot();
  try {
    inject(s, freshValues());
    assert.equal((await s.get('/readyz')).status, 200);
    assert.ok(fs.existsSync(s.paths.dbPath));
  } finally { await s.close(); }
});

test('marker present but the database cannot be opened: readyz stays 503; it recovers when the snapshot appears', async () => {
  const s = await boot();
  try {
    fs.writeFileSync(path.join(s.run, 'injected'), '');
    assert.equal((await s.get('/readyz')).status, 503, 'no snapshot');
    fs.writeFileSync(s.paths.snapshotPath, 'this is not a database');
    assert.equal((await s.get('/readyz')).status, 503, 'corrupt snapshot');
    fs.writeFileSync(s.paths.snapshotPath, JSON.stringify({ stub_snapshot: true }));
    assert.equal((await s.get('/readyz')).status, 200);
  } finally { await s.close(); }
});

test('database open but no marker: readyz 503', async () => {
  const s = await boot();
  try {
    fs.writeFileSync(s.paths.snapshotPath, JSON.stringify({ stub_snapshot: true }));
    assert.equal((await s.get('/readyz')).status, 503);
  } finally { await s.close(); }
});

test('version has the build id and no secret', async () => {
  const s = await boot();
  try {
    const v = freshValues();
    inject(s, v);
    const r = await s.get('/version');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.deepEqual(Object.keys(body).sort(), ['build_id', 'catalogue_version']);
    for (const f of v.flags) assert.ok(!r.text.includes(f.flag));
  } finally { await s.close(); }
});

test('planted flag: served by the test route, equals the flags file, never in the log', async () => {
  const s = await boot();
  try {
    const v = freshValues();
    inject(s, v);
    const want = v.flags.find((f) => f.challenge_key === 'C03').flag;
    const r = await s.get('/_stub/planted-flag?key=C03');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).flag, want);
    assert.equal((await s.get('/_stub/planted-flag?key=C99')).status, 404);
    await new Promise((r2) => setTimeout(r2, 20));
    assert.ok(s.lines.length >= 2);
    for (const l of s.lines) { assert.ok(!l.includes(want), 'flag in log'); assert.ok(!l.includes('C03'), 'query in log'); }
  } finally { await s.close(); }
});

test('emit: the shop relays each kind to the sidecar and returns its status; unknown kind 422; bad body 400', async () => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], size: Buffer.concat(chunks).length }); res.writeHead(202); res.end(); });
  });
  const fp = await listen(fake, 0, '127.0.0.1');
  const s = await boot({ eventsUrl: `http://127.0.0.1:${fp}` });
  try {
    for (const kind of ['valid', 'too-big', 'wrong-type', 'bad-json', 'forbidden-source', 'get']) {
      const r = await s.get('/_stub/emit', 'POST', JSON.stringify({ kind }));
      assert.equal(r.status, 200, kind);
      assert.equal(JSON.parse(r.text).sidecar_status, 202, kind);
    }
    assert.deepEqual(seen.map((x) => x.method), ['POST', 'POST', 'POST', 'POST', 'POST', 'GET']);
    assert.ok(seen.every((x) => x.url === '/v1/events'));
    assert.ok(seen[0].size < 4096 && seen[1].size > 4096, 'valid is under 4 KiB, too-big is over');
    assert.equal(seen[2].type, 'text/plain');
    assert.equal((await s.get('/_stub/emit', 'POST', JSON.stringify({ kind: 'nope' }))).status, 422);
    assert.equal((await s.get('/_stub/emit', 'POST', '{nope')).status, 400);
    assert.equal(emitRequest('nope'), null);
  } finally { await s.close(); await closeServer(fake); }
});

test('emit when the sidecar is unreachable answers status 0, not a crash', async () => {
  const s = await boot();
  try {
    const r = await s.get('/_stub/emit', 'POST', JSON.stringify({ kind: 'valid' }));
    assert.equal(JSON.parse(r.text).sidecar_status, 0);
  } finally { await s.close(); }
});

test('a request target that cannot be parsed answers 400 and the process keeps serving', async () => {
  const s = await boot();
  try {
    const raw = await new Promise((resolve) => {
      const sock = net.connect(s.port, '127.0.0.1', () => sock.write('GET // HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n'));
      let t = ''; sock.on('data', (c) => (t += c)); sock.on('close', () => resolve(t)); sock.on('error', () => resolve(t));
    });
    assert.match(raw, /^HTTP\/1\.1 400 /);
    assert.equal((await s.get('/healthz')).status, 200, 'still alive');
  } finally { await s.close(); }
});

test('a partial read-only copy of a bad snapshot does not block the retry (the snapshot is 0444)', async () => {
  const s = await boot();
  try {
    fs.writeFileSync(path.join(s.run, 'injected'), '');
    fs.writeFileSync(s.paths.snapshotPath, 'not json', { mode: 0o444 });
    fs.chmodSync(s.paths.snapshotPath, 0o444);
    assert.equal((await s.get('/readyz')).status, 503);
    fs.rmSync(s.paths.snapshotPath, { force: true });
    fs.writeFileSync(s.paths.snapshotPath, JSON.stringify({ stub_snapshot: true }), { mode: 0o444 });
    fs.chmodSync(s.paths.snapshotPath, 0o444);
    assert.equal((await s.get('/readyz')).status, 200);
  } finally { await s.close(); }
});