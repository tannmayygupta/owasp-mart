// C06 through the shop (story L-30): the seller's bulk import preview goes to the REAL isolated import service over a unix socket; the audit token comes back only through
// the prototype pollution, and only in an instance whose C06 flag was placed. A real service, a real worker process, no mocks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/index.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { seedAll } from '../../seed/registry.mjs';
import { createApp } from '../../src/app.mjs';
import { buildJob } from '../../src/domain/import-client.mjs';

const TOKEN = 'VM{' + 'ZYXWVUTS'.repeat(3) + '}';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c06-shop-'));
const placement = path.join(dir, 'C06.placement');
const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\vm-c06-${process.pid}` : path.join(dir, 'import.sock');
let shop; let base; let service;
const jar = new Map();
const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const take = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [p] = c.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); } };

async function login(email, password) {
  jar.clear();
  const page = await fetch(`${base}/login`); take(page);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password, csrf }), redirect: 'manual' });
  take(r);
  assert.equal(r.status, 302, `login ${email}`);
  const again = await fetch(`${base}/login`, { headers: { cookie: cookie() } }); take(again);
  return (await again.text()).match(/name="csrf" value="([^"]+)"/)[1];
}
const preview = (csrf, fields) => fetch(`${base}/seller/import-preview`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...fields }) });

before(async () => {
  fs.writeFileSync(placement, `${TOKEN}\n`);
  process.env.VM_C06_PLACEMENT = placement; // read when the service module loads
  process.env.VM_IMPORT_SOCKET = socketPath;
  const { createImportServer } = await import('../../../../services/import-service/src/server.mjs');
  service = createImportServer({ socketPath });
  await service.listen();
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  shop = createApp({ db });
  await new Promise((resolve) => { shop = shop.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${shop.address().port}`;
});
after(() => { shop?.close(); service?.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a seller previews a product: the merged result comes back and no audit token', { skip: process.platform === 'win32' ? 'unix-socket half-close differs on Windows named pipes (the service tests skip for the same reason); runs in CI' : false }, async () => {
  const csrf = await login('owner.harbor@vulnmart.test', 'vulnmart-seed-demo');
  const r = await preview(csrf, { title: 'Mug', description: 'blue', price_cents: '899', options: '{"tags":["gift"]}' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.preview, { title: 'Mug', description: 'blue', price_cents: 899, tags: ['gift'] });
  assert.equal(body.auditToken, null);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test('C06: the prototype-pollution options make the service return the audit token, through the shop, to a seller', { skip: process.platform === 'win32' ? 'unix-socket half-close differs on Windows named pipes (the service tests skip for the same reason); runs in CI' : false }, async () => {
  const csrf = await login('owner.harbor@vulnmart.test', 'vulnmart-seed-demo');
  const r = await preview(csrf, { title: 'x', options: '{"__proto__":{"internalAudit":true}}' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).auditToken, TOKEN);
  const other = await preview(csrf, { title: 'x', options: '{"__proto__":{"somethingElse":true}}' });
  assert.equal((await other.json()).auditToken, null, 'only the audit flag opens it');
  const direct = await preview(csrf, { title: 'x', options: '{"internalAudit":true}' });
  assert.equal((await direct.json()).auditToken, null, 'setting the field directly is not the weakness');
});

test('the preview needs a seller, a CSRF token and valid input; the service being away is a 503, not a crash', { skip: process.platform === 'win32' ? 'unix-socket half-close differs on Windows named pipes (the service tests skip for the same reason); runs in CI' : false }, async () => {
  const noLogin = await fetch(`${base}/seller/import-preview`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x', redirect: 'manual' });
  assert.ok([302, 401, 403].includes(noLogin.status), `anonymous got ${noLogin.status}`);
  const csrf = await login('player.customer@vulnmart.test', 'player-customer-demo-b2');
  assert.equal((await preview(csrf, { title: 'x' })).status, 403, 'a customer is not a seller');
  const sellerCsrf = await login('staff.harbor@vulnmart.test', 'harbor-staff-demo-a1');
  assert.equal((await fetch(`${base}/seller/import-preview`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ title: 'x', csrf: 'wrong' }) })).status, 403, 'no CSRF');
  assert.equal((await preview(sellerCsrf, { title: '' })).status, 400);
  assert.equal((await preview(sellerCsrf, { title: 'x', price_cents: '-5' })).status, 400);
  assert.equal((await preview(sellerCsrf, { title: 'x', options: '{not json' })).status, 400);
  assert.equal((await preview(sellerCsrf, { title: 'x', options: '[1]' })).status, 400);
  assert.equal((await preview(sellerCsrf, { title: 'x', options: 'x'.repeat(4001) })).status, 400);
  const saved = process.env.VM_IMPORT_SOCKET;
  process.env.VM_IMPORT_SOCKET = path.join(dir, 'nobody-home.sock');
  try { assert.equal((await preview(sellerCsrf, { title: 'x' })).status, 503); } finally { process.env.VM_IMPORT_SOCKET = saved; }
  assert.equal((await (await fetch(`${base}/seller/import`, { headers: { cookie: cookie() } })).text()).includes('name="options"'), true, 'the page has the form');
});

test('the job keeps an own __proto__ key as data, never as the shop\'s own prototype', () => {
  const job = buildJob({ title: 'x', options: '{"__proto__":{"internalAudit":true}}' });
  assert.equal(Object.keys(job.product).includes('__proto__'), true);
  assert.equal(({}).internalAudit, undefined, 'building the job pollutes nothing in the shop process');
  assert.equal(JSON.parse(JSON.stringify(job)).product.__proto__.internalAudit, true);
});