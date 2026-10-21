// Staff flows (T-15, FR-SHP-07): each role (support, finance, admin) can do its
// permission-matrix actions and is denied the others, and mutations are audited.
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
const PW = 'staff-pass-123';
const fixtures = {};

// A session helper bound to its own cookie jar (one per role).
function session() {
  const jar = new Map();
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [p] = c.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); } };
  const self = {
    csrf: null,
    async get(path) { const r = await fetch(`${base}${path}`, { headers: { cookie: cookie() }, redirect: 'manual' }); store(r); return r; },
    async post(path, form) { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...form, csrf: self.csrf }).toString(), redirect: 'manual' }); store(r); return r; },
    async login(email) { const page = await self.get('/login'); self.csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1]; const r = await self.post('/login', { email, password: PW }); assert.equal(r.status, 302, `login ${email}`); self.csrf = (await (await self.get('/login')).text()).match(/name="csrf" value="([^"]+)"/)[1]; return self; },
  };
  return self;
}

before(async () => {
  db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  fixtures.supportId = createUser(db, { email: 'support@vm.test', password: PW, role: 'support_agent' }).id;
  fixtures.financeId = createUser(db, { email: 'finance@vm.test', password: PW, role: 'finance' }).id;
  fixtures.adminId = createUser(db, { email: 'admin@vm.test', password: PW, role: 'admin' }).id;
  fixtures.custId = createUser(db, { email: 'cust@vm.test', password: PW, role: 'customer' }).id;
  // Data to act on.
  const order = db.prepare("INSERT INTO orders (customer_id, status, total_cents, ship_line1, ship_city, ship_country) VALUES (3,'paid',1999,'1 St','Town','Land')").run();
  const oi = db.prepare("INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,1,1,1999,1,'paid',200)").run(Number(order.lastInsertRowid));
  fixtures.orderId = Number(order.lastInsertRowid);
  fixtures.ticketId = Number(db.prepare("INSERT INTO tickets (requester_id, subject, status) VALUES (3,'Help','open')").run().lastInsertRowid);
  db.prepare('INSERT INTO ticket_messages (ticket_id, author_id, body) VALUES (?,3,?)').run(fixtures.ticketId, 'first');
  fixtures.disputeId = Number(db.prepare("INSERT INTO disputes (order_item_id, opened_by, reason, status) VALUES (?,3,'x','open')").run(Number(oi.lastInsertRowid)).lastInsertRowid);
  fixtures.reviewId = Number(db.prepare("INSERT INTO reviews (product_id, user_id, rating, body, status) VALUES (1,3,5,'ok','visible')").run().lastInsertRowid);
  fixtures.payoutId = Number(db.prepare("INSERT INTO payouts (store_id, period, net_cents, status) VALUES (1,'2026-01',500,'ready')").run().lastInsertRowid);
  // A pending store + product for admin approval.
  const u = db.prepare("INSERT INTO users (email, password_hash, role) VALUES ('pend@vm.test','x','seller_owner')").run();
  fixtures.storeId = Number(db.prepare("INSERT INTO stores (owner_user_id, name, status) VALUES (?, 'Pending Store','pending')").run(Number(u.lastInsertRowid)).lastInsertRowid);
  fixtures.productId = Number(db.prepare("INSERT INTO products (store_id, title, price_cents, status) VALUES (?, 'Pending Product', 500, 'pending_review')").run(fixtures.storeId).lastInsertRowid);

  const app = createApp({ db });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('support can handle tickets, disputes and moderate reviews; a customer cannot', async () => {
  const s = await session().login('support@vm.test');
  assert.equal((await s.get('/staff/tickets')).status, 200);
  assert.equal((await s.post(`/staff/tickets/${fixtures.ticketId}/reply`, { body: 'on it' })).status, 302);
  assert.equal((await s.post(`/staff/disputes/${fixtures.disputeId}/move`, { to: 'under_review' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM disputes WHERE id = ?').get(fixtures.disputeId).status, 'under_review');
  assert.equal((await s.post(`/staff/reviews/${fixtures.reviewId}/moderate`, { action: 'remove' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM reviews WHERE id = ?').get(fixtures.reviewId).status, 'removed');
  // Support sees the full order, including the shipping address (unlike finance).
  const sOrder = await (await s.get(`/staff/order/${fixtures.orderId}`)).text();
  assert.match(sOrder, /1 St/, 'support sees the unredacted shipping address');
  // A ticket may be assigned to another staff member, never to a customer.
  assert.equal((await s.post(`/staff/tickets/${fixtures.ticketId}/assign`, { assignee_id: fixtures.adminId })).status, 302);
  assert.equal((await s.post(`/staff/tickets/${fixtures.ticketId}/assign`, { assignee_id: fixtures.custId })).status, 400);
  // A customer is denied the staff area.
  const c = await session().login('cust@vm.test');
  assert.equal((await c.get('/staff/tickets')).status, 403);
  // Support cannot approve payouts (finance/admin only)...
  assert.equal((await s.post(`/staff/payouts/${fixtures.payoutId}/approve`, {})).status, 403);
  // ...nor reach the admin-only areas.
  assert.equal((await s.get('/staff/users')).status, 403);
  assert.equal((await s.get('/staff/audit')).status, 403);
  assert.equal((await s.post(`/staff/stores/${fixtures.storeId}/decision`, { decision: 'approve' })).status, 403);
});

test('finance approves payouts and sees commissions, with amounts-only order views', async () => {
  const f = await session().login('finance@vm.test');
  assert.equal((await f.get('/staff/payouts')).status, 200);
  assert.equal((await f.post(`/staff/payouts/${fixtures.payoutId}/approve`, {})).status, 302);
  assert.equal(db.prepare('SELECT status FROM payouts WHERE id = ?').get(fixtures.payoutId).status, 'approved_by_finance');
  // Finance order view is redacted (no shipping address).
  const page = await (await f.get(`/staff/order/${fixtures.orderId}`)).text();
  assert.match(page, /amounts only/);
  assert.doesNotMatch(page, /1 St/, 'shipping address is redacted for finance');
  // Finance cannot approve a seller, moderate reviews, or hold a payout (admin-only).
  assert.equal((await f.post(`/staff/stores/${fixtures.storeId}/decision`, { decision: 'approve' })).status, 403);
  assert.equal((await f.post(`/staff/reviews/${fixtures.reviewId}/moderate`, { action: 'restore' })).status, 403);
  assert.equal((await f.post(`/staff/payouts/${fixtures.payoutId}/hold`, {})).status, 403);
});

test('admin approves sellers and products, manages users, and reads the audit log', async () => {
  const a = await session().login('admin@vm.test');
  assert.equal((await a.post(`/staff/stores/${fixtures.storeId}/decision`, { decision: 'approve' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM stores WHERE id = ?').get(fixtures.storeId).status, 'approved');
  assert.equal((await a.post(`/staff/products/${fixtures.productId}/decision`, { decision: 'approve' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(fixtures.productId).status, 'published');
  assert.equal((await a.get('/staff/users')).status, 200);
  assert.equal((await a.post(`/staff/users/3/status`, { status: 'suspended' })).status, 302);
  assert.equal(db.prepare('SELECT status FROM users WHERE id = 3').get().status, 'suspended');
  db.prepare("UPDATE users SET status='active' WHERE id=3").run();
  // Admin resolves an escalated dispute (support triages -> escalate -> resolve).
  assert.equal((await a.post(`/staff/disputes/${fixtures.disputeId}/move`, { to: 'escalated' })).status, 200);
  assert.equal((await a.post(`/staff/disputes/${fixtures.disputeId}/move`, { to: 'resolved_customer' })).status, 200);
  const resolved = db.prepare('SELECT status, liable_party FROM disputes WHERE id = ?').get(fixtures.disputeId);
  assert.equal(resolved.status, 'resolved_customer');
  assert.equal(resolved.liable_party, 'customer');
  // The audit log shows the admin's actions.
  const audit = await (await a.get('/staff/audit')).text();
  assert.match(audit, /store\.approved/);
  assert.match(audit, /product\.published/);
  assert.match(audit, /dispute\.move/);
});

test('staff mutations are audited and attributed to the acting staff user', () => {
  const n = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
  assert.ok(n >= 6, `expected several audit rows, got ${n}`);
  // The row is attributed to the admin who approved the store, with the target.
  const row = db.prepare("SELECT * FROM audit_log WHERE action = 'store.approved' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.actor_id, fixtures.adminId, 'audit row attributed to the acting admin');
  assert.equal(row.target, `store:${fixtures.storeId}`);
});

test('an illegal dispute transition is rejected', async () => {
  const s = await session().login('support@vm.test');
  // The dispute is terminal (resolved) now; moving it back to 'open' is illegal.
  const res = await s.post(`/staff/disputes/${fixtures.disputeId}/move`, { to: 'open' });
  assert.equal(res.status, 400);
});

test('a suspended staff user is refused the staff area mid-session', async () => {
  const s = await session().login('support@vm.test');
  assert.equal((await s.get('/staff/tickets')).status, 200);
  // Suspend the account; loadUser re-reads status each request, so the live
  // session is cut off on the next request (requireRole's active check).
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(fixtures.supportId);
  assert.equal((await s.get('/staff/tickets')).status, 403);
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(fixtures.supportId);
});

test('a suspended account cannot sign in', async () => {
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(fixtures.custId);
  const c = session();
  const page = await c.get('/login');
  c.csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const r = await c.post('/login', { email: 'cust@vm.test', password: PW });
  assert.equal(r.status, 401, 'a suspended account is refused a session');
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(fixtures.custId);
});

test('the staff screens carry the Assign and Hold controls (WP-D), reachable by the roles that may use them', async () => {
  const s = await session().login('support@vm.test');
  const tickets = await (await s.get('/staff/tickets')).text();
  assert.match(tickets, new RegExp(`/staff/tickets/${fixtures.ticketId}/assign`), 'the Assign form is on the ticket row');
  assert.match(tickets, /name="assignee_id"/);
  assert.match(tickets, /support@vm\.test/, 'the agents to assign to are listed');
  assert.doesNotMatch(tickets, /cust@vm\.test/, 'a customer is not offered as an assignee');
  // using the control: assign to the support agent through the page's own form fields
  const a = await s.post(`/staff/tickets/${fixtures.ticketId}/assign`, { assignee_id: String(fixtures.supportId) });
  assert.equal(a.status, 302);
  assert.equal(db.prepare('SELECT assignee_id FROM tickets WHERE id = ?').get(fixtures.ticketId).assignee_id, fixtures.supportId);
  const admin = await session().login('admin@vm.test');
  const adminPayouts = await (await admin.get('/staff/payouts')).text();
  assert.match(adminPayouts, new RegExp(`/staff/payouts/${fixtures.payoutId}/hold`), 'admin sees the Hold control');
  const fin = await session().login('finance@vm.test');
  const finPayouts = await (await fin.get('/staff/payouts')).text();
  assert.doesNotMatch(finPayouts, /\/hold/, 'finance may not hold a payout and is not shown the button');
  assert.equal((await admin.post(`/staff/payouts/${fixtures.payoutId}/hold`, {})).status, 302);
  assert.equal(db.prepare('SELECT status FROM payouts WHERE id = ?').get(fixtures.payoutId).status, 'held');
  assert.equal((await fin.post(`/staff/payouts/${fixtures.payoutId}/hold`, {})).status, 403, 'finance cannot hold even by a direct POST');
});

test('the staff lists page: ?page=2 shows the next rows and a Previous link', async () => {
  const admin = await session().login('admin@vm.test');
  for (let i = 0; i < 52; i++) db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'customer')").run(`pager${i}@vm.test`);
  const one = await (await admin.get('/staff/users')).text();
  assert.match(one, /href="\/staff\/users\?page=2"/, 'page 1 links to page 2');
  assert.doesNotMatch(one, /Previous/);
  const two = await (await admin.get('/staff/users?page=2')).text();
  assert.match(two, /href="\/staff\/users\?page=1"/, 'page 2 links back');
  assert.notEqual(one, two);
  assert.equal((await admin.get('/staff/users?page=abc')).status, 200, 'a bad page number is page 1, not an error');
});
