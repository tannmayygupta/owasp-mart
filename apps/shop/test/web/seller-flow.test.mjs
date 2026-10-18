// Seller flows over HTTP (T-17, FR-SHP-06): the whole journey — register a store,
// admin approves, create and submit a product, admin publishes, a customer buys,
// the seller fulfils — plus the "pending cannot publish" and area guards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { seedAll } from '../../seed/registry.mjs';
import { createUser } from '../../src/identity/accounts.mjs';
import { createApp } from '../../src/app.mjs';

let server;
let base;
let db;
const PW = 'seller-pass-123';

function session() {
  const jar = new Map();
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [p] = c.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); } };
  const self = {
    csrf: null,
    async get(path) { const r = await fetch(`${base}${path}`, { headers: { cookie: cookie() }, redirect: 'manual' }); store(r); return r; },
    async post(path, form) { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form, csrf: self.csrf }).toString(), redirect: 'manual' }); store(r); return r; },
    async refresh() { self.csrf = (await (await self.get('/login')).text()).match(/name="csrf" value="([^"]+)"/)[1]; return self; },
    async login(email) { await self.refresh(); const r = await self.post('/login', { email, password: PW }); assert.equal(r.status, 302, `login ${email}`); await self.refresh(); return self; },
  };
  return self;
}

before(async () => {
  db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  createUser(db, { email: 'admin@vm.test', password: PW, role: 'admin' });
  createUser(db, { email: 'wannabe@vm.test', password: PW, role: 'customer' });
  createUser(db, { email: 'buyer@vm.test', password: PW, role: 'customer' });
  const app = createApp({ db });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('full seller journey: register -> approve -> create -> submit -> publish -> buy -> fulfil', async () => {
  // 1. A customer registers a store (becomes a pending seller_owner).
  const s = session();
  await s.login('wannabe@vm.test');
  assert.equal((await s.post('/seller/register', { name: 'Journey Store', kyc_text: 'docs' })).status, 200);
  const storeId = db.prepare("SELECT id FROM stores WHERE name = 'Journey Store'").get().id;
  assert.equal(db.prepare('SELECT status FROM stores WHERE id = ?').get(storeId).status, 'pending');

  // 2. Admin approves the store.
  const admin = session();
  await admin.login('admin@vm.test');
  assert.equal((await admin.post(`/staff/stores/${storeId}/decision`, { decision: 'approve' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM stores WHERE id = ?').get(storeId).status, 'approved');

  // 3. Seller creates a product (draft) and submits it.
  await s.refresh();
  assert.equal((await s.post('/seller/products', { title: 'Journey Widget', description: 'nice', price_cents: '1500', stock: '5' })).status, 302);
  const productId = db.prepare('SELECT id FROM products WHERE store_id = ? ORDER BY id DESC LIMIT 1').get(storeId).id;
  assert.equal((await s.post(`/seller/products/${productId}/submit`, {})).status, 200);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(productId).status, 'pending_review');

  // 4. Admin publishes it.
  await admin.refresh();
  assert.equal((await admin.post(`/staff/products/${productId}/decision`, { decision: 'approve' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(productId).status, 'published');

  // 5. A customer buys it.
  const buyer = session();
  await buyer.login('buyer@vm.test');
  assert.equal((await buyer.post('/cart/add', { product_id: String(productId), qty: '1' })).status, 302);
  const paid = await buyer.post('/checkout', { line1: '1 Test St', city: 'Testville', country: 'Testland', card: '4111111111111111' });
  assert.equal(paid.status, 302, 'checkout redirects on success');
  const item = db.prepare('SELECT id, status FROM order_items WHERE store_id = ? ORDER BY id DESC LIMIT 1').get(storeId);
  assert.equal(item.status, 'paid');

  // 6. The seller fulfils the order item through to delivered.
  await s.refresh();
  for (const to of ['processing', 'shipped', 'delivered']) {
    assert.equal((await s.post(`/seller/items/${item.id}/fulfil`, { to })).status, 302, `move to ${to}`);
  }
  assert.equal(db.prepare('SELECT status FROM order_items WHERE id = ?').get(item.id).status, 'delivered');
});

test('a pending store cannot publish over HTTP (submit returns 400)', async () => {
  createUser(db, { email: 'pend2@vm.test', password: PW, role: 'customer' });
  const p = session();
  await p.login('pend2@vm.test');
  assert.equal((await p.post('/seller/register', { name: 'Pending HTTP Store' })).status, 200);
  const storeId = db.prepare("SELECT id FROM stores WHERE name = 'Pending HTTP Store'").get().id;
  await p.refresh();
  assert.equal((await p.post('/seller/products', { title: 'Draft', price_cents: '100', stock: '1' })).status, 302);
  const productId = db.prepare('SELECT id FROM products WHERE store_id = ? ORDER BY id DESC LIMIT 1').get(storeId).id;
  const res = await p.post(`/seller/products/${productId}/submit`, {});
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not approved/);
});

test('the /seller area is refused to a plain customer (403)', async () => {
  createUser(db, { email: 'plain@vm.test', password: PW, role: 'customer' });
  const c = session();
  await c.login('plain@vm.test');
  const res = await c.get('/seller');
  assert.equal(res.status, 403);
});
