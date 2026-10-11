// Unit tests for the shop skeleton's I/O matrix (T-01).
// Uses an ephemeral listen on port 0 and the global fetch; no extra deps.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

let server;
let base;

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('GET /healthz returns 200 {status:"ok"} as JSON', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('responses do not advertise the framework (x-powered-by disabled)', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('GET /readyz returns 200 {status:"ready"}', async () => {
  const res = await fetch(`${base}/readyz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ready' });
});

test('GET /version returns 200 with build and catalogue_version, no secrets', async () => {
  const res = await fetch(`${base}/version`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.build === 'string');
  assert.ok(typeof body.catalogue_version === 'string');
  // Guard against leaking anything flag- or secret-shaped.
  assert.deepEqual(Object.keys(body).sort(), ['build', 'catalogue_version']);
});

test('unknown route returns 404 JSON without a stack trace', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 'SHOP-NOT-FOUND');
  assert.ok(!('stack' in body));
});
