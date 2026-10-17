// Instance-mode marketplace + event emission (T-09, review A2a). Proves, without
// Docker, that in instance mode the shop mounts the marketplace on the lazy
// snapshot handle (gated by /readyz) and that a REAL player HTTP action posts a
// schema-valid app event to the sidecar:
//   - /readyz is 503 until the injector marker, then 200;
//   - a real POST /login posts auth.attempt (success / unknown) the sidecar accepts;
//   - a real checkout posts order.paid.
// The sidecar is a stand-in that validates the posted body against the actual
// IF-4 posted schema, so a body the real sidecar would 422 fails the test.
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
import { seedAll } from '../../seed/registry.mjs';
import { SEED_PASSWORD } from '../../seed/contributions/000-baseline.mjs';
import { createApp } from '../../src/app.mjs';
import { makeReadiness, makeEmitter, lazyDb, markerPath } from '../../src/instance/instance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const POSTED_SCHEMA = path.join(ROOT, 'contracts', 'events', 'instance-events.posted.schema.json');

let dir, server, sidecar, base, readiness;
let flagsPath;
const received = []; // { body, ok } per posted event
let validatePosted;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Emission is fire-and-forget; wait for the matching event to land at the sidecar.
async function waitForEvent(pred, { tries = 40, delayMs = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    const hit = received.find((r) => pred(r.body));
    if (hit) return hit.body;
    await sleep(delayMs);
  }
  return null;
}

// Minimal cookie jar + CSRF, as in the customer-flow e2e test.
const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
function store(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}
async function get(p) {
  const res = await fetch(`${base}${p}`, { headers: { cookie: cookieHeader() }, redirect: 'manual' });
  store(res);
  return res;
}
async function post(p, form, csrf) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form, csrf }).toString(),
    redirect: 'manual',
  });
  store(res);
  return res;
}
const csrfFrom = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-t09w-'));
  const run = path.join(dir, 'run', 'vm');
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const snapshotPath = path.join(run, 'snapshot.db');
  flagsPath = path.join(run, 'flags.json');
  const dbPath = path.join(dir, 'data', 'shop.db');
  await buildSnapshot(snapshotPath);
  fs.chmodSync(snapshotPath, 0o444);
  fs.writeFileSync(flagsPath, JSON.stringify({ schema_version: '0.1', instance_id: 'i-ABCDEFGHIJKLMNOP', epoch: 1, flags: [] }));

  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  validatePosted = ajv.compile(JSON.parse(fs.readFileSync(POSTED_SCHEMA, 'utf8')));

  // A sidecar stand-in: validates each posted body against the real posted schema.
  sidecar = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/events') { res.writeHead(404).end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
      const ok = validatePosted(body);
      received.push({ body, ok });
      res.writeHead(ok ? 202 : 422).end();
    });
  });
  await new Promise((r) => sidecar.listen(0, '127.0.0.1', r));
  const sidecarUrl = `http://127.0.0.1:${sidecar.address().port}`;

  // Instance mode: lazy db on the readiness gate, emitter bound to the sidecar.
  readiness = makeReadiness({ snapshotPath, flagsPath, dbPath });
  const app = createApp({
    db: lazyDb(readiness.getDb),
    isReady: readiness.ready,
    emit: makeEmitter(sidecarUrl),
  });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  sidecar?.close();
  try { readiness?.getDb()?.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the handle briefly */ }
});

test('/readyz is 503 before the injector marker (the marketplace is gated)', async () => {
  assert.equal((await get('/readyz')).status, 503);
});

test('after the marker the shop serves the marketplace and a real login posts auth.attempt', async () => {
  fs.writeFileSync(markerPath(flagsPath), ''); // injector finished
  assert.equal((await get('/readyz')).status, 200, 'ready after the marker');

  const csrf = csrfFrom(await (await get('/login')).text());
  assert.ok(csrf, 'the login page rendered from the snapshot db');

  // A real, successful login (seeded customer from the snapshot).
  const ok = await post('/login', { email: 'customer.demo@vulnmart.test', password: SEED_PASSWORD }, csrf);
  assert.equal(ok.status, 302, 'login succeeded');
  const success = await waitForEvent((e) => e.type === 'auth.attempt' && e.data.result === 'success');
  assert.ok(success, 'a success auth.attempt reached the sidecar');
  assert.ok(validatePosted(success), 'the auth.attempt body is schema-valid');
  assert.equal(success.data.route, 'web');
  assert.equal(success.data.account_id, '3', 'the seeded customer id');
  assert.equal(success.source, 'shop');
});

test('a failed login posts auth.attempt with result "unknown" and no account id', async () => {
  const csrf = csrfFrom(await (await get('/login')).text());
  const bad = await post('/login', { email: 'nobody@vulnmart.test', password: 'wrong' }, csrf);
  assert.equal(bad.status, 401);
  const miss = await waitForEvent((e) => e.type === 'auth.attempt' && e.data.result === 'unknown');
  assert.ok(miss, 'a failed-login auth.attempt reached the sidecar');
  assert.ok(validatePosted(miss), 'schema-valid');
  assert.equal(miss.data.account_id, 'unknown');
  assert.equal(miss.user_id, null, 'no user id for an unknown credential');
});

test('a real checkout posts a schema-valid order.paid', async () => {
  // Log in, add to cart, check out — the full player flow over the snapshot db.
  const loginCsrf = csrfFrom(await (await get('/login')).text());
  await post('/login', { email: 'customer.demo@vulnmart.test', password: SEED_PASSWORD }, loginCsrf);
  // Login rotates the CSRF token; re-read the fresh one for the authenticated posts.
  const csrf = csrfFrom(await (await get('/login')).text());
  assert.equal((await post('/cart/add', { product_id: '1', qty: '1' }, csrf)).status, 302);
  const done = await post('/checkout', { line1: '1 Test St', city: 'Testville', country: 'Testland', card: '4111111111111111' }, csrf);
  assert.equal(done.status, 302, 'checkout succeeded');
  const orderId = done.headers.get('location').split('/').pop();

  const paid = await waitForEvent((e) => e.type === 'order.paid');
  assert.ok(paid, 'an order.paid reached the sidecar');
  assert.ok(validatePosted(paid), 'the order.paid body is schema-valid');
  assert.equal(paid.data.order_id, orderId);
  assert.equal(paid.data.verified, true);
  assert.equal(paid.data.via, 'card');
});

test('every event the sidecar received validated against the real posted schema', () => {
  assert.ok(received.length >= 3, 'at least the three events above were posted');
  for (const r of received) assert.ok(r.ok, `a posted event failed the posted schema: ${JSON.stringify(r.body)}`);
});
