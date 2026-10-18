// Money flows over HTTP (T-18, FR-SHP-10): support approves and processes a
// refund through the staff screens; finance accrues a payout. The arithmetic is
// covered by money-service.test.mjs; this proves the routes are wired and gated.
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
const PW = 'money-web-123';
let refundId;

function session() {
  const jar = new Map();
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [p] = c.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); } };
  const self = {
    csrf: null,
    async get(path) { const r = await fetch(`${base}${path}`, { headers: { cookie: cookie() }, redirect: 'manual' }); store(r); return r; },
    async post(path, form) { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form, csrf: self.csrf }).toString(), redirect: 'manual' }); store(r); return r; },
    async refresh() { self.csrf = (await (await self.get('/login')).text()).match(/name="csrf" value="([^"]+)"/)[1]; return self; },
    async login(email) { await self.refresh(); const r = await self.post('/login', { email, password: PW }); assert.equal(r.status, 302); await self.refresh(); return self; },
  };
  return self;
}

before(async () => {
  db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  createUser(db, { email: 'support@vm.test', password: PW, role: 'support_agent' });
  createUser(db, { email: 'finance@vm.test', password: PW, role: 'finance' });
  // A delivered store-1 item (paid 1000, commission 100) with a requested refund.
  const o = db.prepare("INSERT INTO orders (customer_id, status, total_cents, ship_line1, ship_city, ship_country) VALUES (3,'paid',1000,'1 St','Town','Land')").run();
  const oi = db.prepare("INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,1,1,1000,1,'delivered',100)").run(Number(o.lastInsertRowid));
  db.prepare('INSERT INTO commissions (order_item_id, amount_cents, rate_bp) VALUES (?,100,1000)').run(Number(oi.lastInsertRowid));
  refundId = Number(db.prepare("INSERT INTO refunds (order_item_id, amount_cents, status, requested_by) VALUES (?,1000,'requested',3)").run(Number(oi.lastInsertRowid)).lastInsertRowid);

  const app = createApp({ db });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('support approves a partial refund and processes it; commission is reversed in proportion', async () => {
  const sup = session();
  await sup.login('support@vm.test');
  assert.equal((await sup.get('/staff/refunds')).status, 200);
  assert.equal((await sup.post(`/staff/refunds/${refundId}/approve`, { amount: '400' })).status, 302);
  assert.equal(db.prepare('SELECT status, amount_cents FROM refunds WHERE id = ?').get(refundId).amount_cents, 400);
  assert.equal((await sup.post(`/staff/refunds/${refundId}/process`, {})).status, 302);
  assert.equal(db.prepare('SELECT status FROM refunds WHERE id = ?').get(refundId).status, 'processed');
  assert.equal(db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM commission_reversals').get().s, 40);
});

test('finance accrues the payout and the net matches the formula', async () => {
  const fin = session();
  await fin.login('finance@vm.test');
  assert.equal((await fin.post('/staff/payouts/accrue', { store_id: '1', period: '2026-10' })).status, 302);
  const p = db.prepare("SELECT * FROM payouts WHERE store_id = 1 AND period = '2026-10'").get();
  assert.equal(p.gross_cents, 1000);
  assert.equal(p.commission_cents, 60);
  assert.equal(p.refunds_deducted_cents, 400);
  assert.equal(p.net_cents, 540);
});

test('a seller cannot reach the staff refund screen (403)', async () => {
  createUser(db, { email: 'seller-web@vm.test', password: PW, role: 'seller_owner', store_id: 1 });
  const owner = session();
  await owner.login('seller-web@vm.test');
  assert.equal((await owner.get('/staff/refunds')).status, 403);
});
