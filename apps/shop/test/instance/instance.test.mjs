// Instance integration (T-04, TB-3): the shop skeleton meets the instance
// contract. Ready only after the injector marker (with the snapshot copied and
// opened), a planted flag read from the flags file, and one app event the
// sidecar accepts. This stands up the real shop against a real snapshot, a flags
// file and a marker in a temp dir, plus a fake sidecar that validates the posted
// body against the actual IF-4 posted schema. The live docker harness is T-09.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildSnapshot } from '../../seed/build-snapshot.mjs';
import { createApp } from '../../src/app.mjs';
import { makeReadiness, readFlag, shopEvent, postEvent, markerPath, isInjected } from '../../src/instance/instance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const POSTED_SCHEMA = path.join(ROOT, 'contracts', 'events', 'instance-events.posted.schema.json');

// A valid flags file (IF-6 flags-file.schema.json shape); fake per-run flags.
const INSTANCE_ID = 'i-ABCDEFGHIJKLMNOP';
const FLAGS = {
  schema_version: '0.1',
  instance_id: INSTANCE_ID,
  epoch: 1,
  flags: [
    { challenge_key: 'C01', flag: 'VM{AAAAAAAAAAAAAAAAAAAAAAAA}' },
    { challenge_key: 'C03', flag: 'VM{BBBBBBBBBBBBBBBBBBBBBBBB}' },
  ],
};

let dir;
let run;
let dataDir;
let snapshotPath;
let flagsPath;
let dbPath;
let validatePosted;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-t04-'));
  run = path.join(dir, 'run', 'vm');
  dataDir = path.join(dir, 'data');
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  snapshotPath = path.join(run, 'snapshot.db');
  flagsPath = path.join(run, 'flags.json');
  dbPath = path.join(dataDir, 'shop.db');
  // A real, seeded SQLite snapshot stands in for the injector's patched snapshot.
  // The injector writes it read-only (0444); reproduce that so the shop's copy
  // must be made writable (regression guard for the read-only-copy failure mode).
  await buildSnapshot(snapshotPath);
  fs.chmodSync(snapshotPath, 0o444);
  // Flags file as the injector writes it; the marker is NOT written yet.
  fs.writeFileSync(flagsPath, JSON.stringify(FLAGS));
  // Compile the real posted-event schema to prove conformance.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  validatePosted = ajv.compile(JSON.parse(fs.readFileSync(POSTED_SCHEMA, 'utf8')));
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

test('not ready before the injector marker, ready after (snapshot copied and opened)', () => {
  const { ready, getDb } = makeReadiness({ snapshotPath, flagsPath, dbPath });
  assert.equal(isInjected(flagsPath), false);
  assert.equal(ready(), false, 'no marker yet');
  assert.ok(!fs.existsSync(dbPath), 'the snapshot is not copied before the marker');
  // The injector writes the marker last.
  fs.writeFileSync(markerPath(flagsPath), '');
  assert.equal(ready(), true, 'ready once the marker exists and the snapshot opens');
  assert.ok(fs.existsSync(dbPath), 'the snapshot was copied to the writable db path');
  // The opened db is the real seeded world, not an empty file.
  const n = getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
  assert.ok(n >= 3, 'the copied snapshot opens and holds the seeded users');
  // The /data copy must be writable even though the injected snapshot is 0444,
  // or the shop opens read-only and can never write (the point of copying to /data).
  getDb().exec('CREATE TABLE _t04_write_probe (x INTEGER)');
  getDb().exec('DROP TABLE _t04_write_probe');
  getDb().close(); // release the handle so the temp dir can be removed on Windows
});

test('/readyz is 503 before the marker and 200 after; /healthz and /version never leak a flag', async () => {
  // A fresh run dir so the marker is absent at the start of this test.
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-t04b-'));
  const run2 = path.join(d2, 'run', 'vm');
  fs.mkdirSync(run2, { recursive: true });
  fs.mkdirSync(path.join(d2, 'data'), { recursive: true });
  const snap2 = path.join(run2, 'snapshot.db');
  const flags2 = path.join(run2, 'flags.json');
  const db2 = path.join(d2, 'data', 'shop.db');
  await buildSnapshot(snap2);
  fs.chmodSync(snap2, 0o444);
  fs.writeFileSync(flags2, JSON.stringify(FLAGS));

  const readiness = makeReadiness({ snapshotPath: snap2, flagsPath: flags2, dbPath: db2 });
  const app = createApp({ isReady: readiness.ready });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/readyz`)).status, 503, 'not ready before the marker');
    fs.writeFileSync(markerPath(flags2), '');
    const rd = await fetch(`${base}/readyz`);
    assert.equal(rd.status, 200, 'ready after the marker');

    const health = await fetch(`${base}/healthz`);
    const healthText = await health.text();
    assert.equal(health.status, 200);
    const ver = await fetch(`${base}/version`);
    const verText = await ver.text();
    assert.equal(ver.status, 200);
    for (const f of FLAGS.flags) {
      assert.ok(!verText.includes(f.flag), '/version must not leak a flag');
      assert.ok(!healthText.includes(f.flag), '/healthz must not leak a flag');
    }
  } finally {
    server.close();
    try { readiness.getDb()?.close(); } catch { /* already closed */ }
    try { fs.rmSync(d2, { recursive: true, force: true }); } catch { /* Windows may hold the handle briefly */ }
  }
});

test('a planted flag is read from the flags file by challenge key', () => {
  assert.equal(readFlag(flagsPath, 'C03'), 'VM{BBBBBBBBBBBBBBBBBBBBBBBB}');
  assert.equal(readFlag(flagsPath, 'C01'), 'VM{AAAAAAAAAAAAAAAAAAAAAAAA}');
  assert.equal(readFlag(flagsPath, 'C09'), null, 'a key not in this instance is null');
});

test('the shop posts one app event that validates against the posted schema and the sidecar accepts', async () => {
  // A fake sidecar: validates the posted body against the real IF-4 posted
  // schema, answers 202 when valid (as the real sidecar does) else 422.
  let received = null;
  const sidecar = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/events') { res.writeHead(404).end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { received = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
      res.writeHead(validatePosted(received) ? 202 : 422).end();
    });
  });
  sidecar.listen(0, '127.0.0.1');
  await new Promise((r) => sidecar.once('listening', r));
  const url = `http://127.0.0.1:${sidecar.address().port}`;
  try {
    const event = shopEvent('shop.catalog_query_error', { route: '/api/products/search', error_class: 'sql_syntax' }, { user_id: 'u-1001' });
    assert.ok(validatePosted(event), `the event must be schema-valid: ${JSON.stringify(validatePosted.errors)}`);
    // No instance_id/epoch/seq/signature in the posted body (the sidecar stamps them).
    for (const k of ['instance_id', 'epoch', 'seq']) assert.ok(!(k in event), `${k} must not be in the posted body`);
    const status = await postEvent(url, event);
    assert.equal(status, 202, 'the sidecar accepts the event');
    assert.deepEqual(received, event, 'the sidecar received exactly what the shop posted');
  } finally {
    sidecar.close();
  }
});

test('posting is best-effort: an unreachable sidecar resolves to 0, never throws', async () => {
  // Nothing is listening on this port; postEvent must resolve (not reject).
  const status = await postEvent('http://127.0.0.1:1', shopEvent('shop.catalog_query_error', { route: '/x', error_class: 'none' }, { user_id: 'u-1001' }), { timeoutMs: 500 });
  assert.equal(status, 0);
});

test('posting is best-effort: a hung sidecar hits the timeout and resolves to 0', async () => {
  // A server that accepts the socket but never answers, so the timeout->destroy
  // path fires (not the connection-refused path of the previous test).
  const hung = http.createServer(() => { /* never responds */ });
  hung.listen(0, '127.0.0.1');
  await new Promise((r) => hung.once('listening', r));
  const url = `http://127.0.0.1:${hung.address().port}`;
  try {
    const start = Date.now();
    const status = await postEvent(url, shopEvent('shop.catalog_query_error', { route: '/x', error_class: 'none' }, { user_id: 'u-1001' }), { timeoutMs: 300 });
    assert.equal(status, 0, 'a hung sidecar resolves to 0');
    assert.ok(Date.now() - start < 3000, 'it resolves promptly via the timeout, not a hang');
  } finally {
    hung.close();
  }
});
