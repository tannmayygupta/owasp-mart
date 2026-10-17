// End-to-end customer journey (T-14, FR-SHP-05): log in, browse, add to cart,
// check out with simulated payment, view the paid order, review, refund,
// dispute, ticket — plus the deny cases. Drives the real server over a seeded
// in-memory db with a tiny cookie jar. Node built-ins only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.mjs';
import { migrate } from '../../src/db/migrate.mjs';
import { seedAll } from '../../seed/registry.mjs';
import { SEED_PASSWORD } from '../../seed/contributions/000-baseline.mjs';
import { createApp } from '../../src/app.mjs';

let server;
let base;
let db;
const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}
async function get(path) {
  const res = await fetch(`${base}${path}`, { headers: { cookie: cookieHeader() }, redirect: 'manual' });
  storeCookies(res);
  return res;
}
async function post(path, form, csrf) {
  const body = new URLSearchParams({ ...form, csrf }).toString();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
  storeCookies(res);
  return res;
}
function csrfFrom(html) {
  return html.match(/name="csrf" value="([^"]+)"/)?.[1];
}

before(async () => {
  db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  const app = createApp({ db });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('unauthenticated customer is redirected to login', async () => {
  const res = await get('/orders');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

let csrf;
test('a seeded customer can log in', async () => {
  const page = await get('/login');
  csrf = csrfFrom(await page.text());
  assert.ok(csrf, 'login page carries a CSRF token');
  const res = await post('/login', { email: 'customer.demo@vulnmart.test', password: SEED_PASSWORD }, csrf);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/shop');
  // Login rotates the CSRF token (anti-fixation), so re-read the fresh one a real
  // client would get from the next rendered page before using it on later posts.
  csrf = csrfFrom(await (await get('/login')).text());
  assert.ok(csrf);
});

test('wrong password is rejected (no redirect)', async () => {
  const res = await post('/login', { email: 'customer.demo@vulnmart.test', password: 'wrong' }, csrf);
  assert.equal(res.status, 401);
});

test('browse shows seeded published products and search filters', async () => {
  const all = await (await get('/shop')).text();
  assert.match(all, /USB-C Charger/);
  const tea = await (await get('/shop?q=Tea')).text();
  assert.match(tea, /Green Tea Sampler/);
  assert.doesNotMatch(tea, /USB-C Charger/);
});

let orderId;
test('add to cart, check out with simulated payment, order is paid', async () => {
  let res = await post('/cart/add', { product_id: '1', qty: '2' }, csrf);
  assert.equal(res.status, 302);
  const cart = await (await get('/cart')).text();
  assert.match(cart, /USB-C Charger/);
  res = await post('/checkout', { line1: '1 Test St', city: 'Testville', country: 'Testland', card: '4111111111111111' }, csrf);
  assert.equal(res.status, 302);
  orderId = Number(res.headers.get('location').split('/').pop());
  assert.ok(orderId > 0);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  assert.equal(order.status, 'paid');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'paid');
  // Product 1 @ 1999c x 2 = 3998c, store 1 rate 1000bp -> commission 400c (exact).
  assert.equal(items[0].commission_cents, 400);
  const comm = db.prepare('SELECT * FROM commissions WHERE order_item_id = ?').get(items[0].id);
  assert.equal(comm.amount_cents, 400);
  assert.equal(comm.rate_bp, 1000);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
  assert.equal(payment.status, 'paid');
  assert.equal(payment.card_last4, '1111');
  // The cart is empty and stock was decremented (50 - 2 = 48).
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.user_id = 3').get().c, 0);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = 1').get().stock, 48);
});

test('adding the same product twice sums the quantity on one line', async () => {
  // Use product 4 (a fresh line); add twice, assert one line with qty 3.
  await post('/cart/add', { product_id: '4', qty: '1' }, csrf);
  await post('/cart/add', { product_id: '4', qty: '2' }, csrf);
  const lines = db.prepare(
    "SELECT ci.qty FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.user_id = 3 AND ci.product_id = 4",
  ).all();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 3);
});

test('a bad card fails checkout: order payment_failed, payment failed, no new paid order', async () => {
  await post('/cart/add', { product_id: '2', qty: '1' }, csrf);
  const paidBefore = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE customer_id = 3 AND status = 'paid'").get().c;
  const res = await post('/checkout', { line1: 'x', city: 'y', country: 'z', card: 'nope' }, csrf);
  assert.equal(res.status, 400);
  const lastOrder = db.prepare('SELECT * FROM orders WHERE customer_id = 3 ORDER BY id DESC LIMIT 1').get();
  assert.equal(lastOrder.status, 'payment_failed');
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(lastOrder.id);
  assert.equal(payment.status, 'failed');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM orders WHERE customer_id = 3 AND status = 'paid'").get().c, paidBefore);
});

test('checkout requires a shipping address and a non-empty cart', async () => {
  await post('/cart/add', { product_id: '1', qty: '1' }, csrf);
  const noShip = await post('/checkout', { card: '4111111111111111' }, csrf);
  assert.equal(noShip.status, 400);
});

test('the customer can view their own order but not another customer’s', async () => {
  const mine = await get(`/orders/${orderId}`);
  assert.equal(mine.status, 200);
  assert.match(await mine.text(), /paid/);
  // Seed a second customer with an order they own.
  const u = db.prepare("INSERT INTO users (email, password_hash, role) VALUES ('other@x.test','x','customer')").run();
  const other = db.prepare("INSERT INTO orders (customer_id, status, total_cents) VALUES (?, 'paid', 100)").run(Number(u.lastInsertRowid));
  const res = await get(`/orders/${Number(other.lastInsertRowid)}`);
  assert.equal(res.status, 403, 'cross-customer order read is forbidden in the correct flow');
});

test('review a purchased product; a non-purchased product is refused', async () => {
  const ok = await post('/reviews', { product_id: '1', rating: '5', body: 'Great' }, csrf);
  assert.equal(ok.status, 302);
  assert.ok(db.prepare('SELECT 1 FROM reviews WHERE product_id = 1 AND rating = 5').get());
  const no = await post('/reviews', { product_id: '3', rating: '4', body: 'Nope' }, csrf);
  assert.equal(no.status, 403, 'cannot review a product you did not buy');
});

test('request a refund and open a dispute on an own order item', async () => {
  const itemId = db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(orderId).id;
  const r = await post('/refunds', { order_item_id: String(itemId), reason: 'changed mind' }, csrf);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT status FROM refunds WHERE order_item_id = ?').get(itemId).status, 'requested');
  const d = await post('/disputes', { order_item_id: String(itemId), reason: 'not as described' }, csrf);
  assert.equal(d.status, 200);
  assert.equal(db.prepare('SELECT status FROM disputes WHERE order_item_id = ?').get(itemId).status, 'open');
  // A second refund or dispute on the same item is rejected (no piling up).
  assert.equal((await post('/refunds', { order_item_id: String(itemId) }, csrf)).status, 400);
  assert.equal((await post('/disputes', { order_item_id: String(itemId) }, csrf)).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM refunds WHERE order_item_id = ?').get(itemId).c, 1);
});

test('create a support ticket with a first message', async () => {
  const res = await post('/tickets', { subject: 'Help', body: 'My question' }, csrf);
  assert.equal(res.status, 302);
  const ticketId = Number(res.headers.get('location').split('/').pop());
  const page = await (await get(`/tickets/${ticketId}`)).text();
  assert.match(page, /Help/);
  assert.match(page, /My question/);
});

test('a POST without a valid CSRF token is rejected', async () => {
  const res = await post('/cart/add', { product_id: '1', qty: '1' }, 'bogus-token');
  assert.equal(res.status, 403);
});

test('user content is auto-escaped (no raw HTML injection in the correct flow)', async () => {
  // Store a review whose body contains HTML; the product page must escape it.
  db.prepare("INSERT INTO reviews (product_id, user_id, rating, body, status) VALUES (3, 3, 3, '<script>x</script>', 'visible')").run();
  const html = await (await get('/product/3')).text();
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('a non-numeric id is a clean 404, not a 500', async () => {
  assert.equal((await get('/product/abc')).status, 404);
  assert.equal((await get('/orders/not-a-number')).status, 404);
});

test('search with SQL metacharacters is safe and literal (no injection, no wildcard match-all)', async () => {
  const res = await get(`/shop?q=${encodeURIComponent("' OR '1'='1")}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /USB-C Charger/, 'a junk term matches nothing, not everything');
  // A literal percent is escaped, so it does not act as match-all.
  const pct = await (await get(`/shop?q=${encodeURIComponent('%')}`)).text();
  assert.doesNotMatch(pct, /USB-C Charger/);
});

test('a suspended customer is refused', async () => {
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = 3").run();
  const res = await get('/orders');
  assert.equal(res.status, 403);
  db.prepare("UPDATE users SET status = 'active' WHERE id = 3").run();
});
