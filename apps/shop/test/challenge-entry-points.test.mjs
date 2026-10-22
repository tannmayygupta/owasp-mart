// A learner reaches every weakness from the shop's own pages: a link, a form, a button, or a request the page makes. This walks the vulnerable build the way a person would
// (log in, follow what the pages offer) and checks that each challenge has its entry point and that the entry point leads to the weakness. The exploit tests of
// challenges/tests prove the weakness works; these prove a player can find it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { seedAll } from '../seed/registry.mjs';
import { createApp } from '../src/app.mjs';
import { plantDatabase } from '../src/instance/placements.mjs';

const ALL_VULNERABLE = Object.fromEntries(['C01', 'C02', 'C03A', 'C03B', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11'].map((k) => [k, 'vulnerable']));

async function boot() {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  // what an instance places in the database: the competitor order and its neighbours (C01), the flag gift card (C02), the player's delivered order (C04)
  plantDatabase(db, { C01: 'C01-FOREIGN-NOTE', C02: 'C02-CARD-MESSAGE', C04: 'C04-SENTINEL' });
  const app = createApp({ db, challenges: ALL_VULNERABLE });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}

/** A browser with a cookie jar: follows nothing by itself, returns the text. */
function browser(base) {
  const jar = new Map();
  const take = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const b = {
    async get(path, opts = {}) { const res = await fetch(base + path, { redirect: 'manual', headers: { cookie: cookie() }, ...opts }); take(res); return { status: res.status, location: res.headers.get('location'), text: await res.text() }; },
    async post(path, fields, opts = {}) {
      const res = await fetch(base + path, { method: 'POST', redirect: 'manual', headers: { cookie: cookie(), 'content-type': opts.type ?? 'application/x-www-form-urlencoded' }, body: opts.raw ?? new URLSearchParams(fields).toString() });
      take(res); return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
    async csrf(path = '/login') { return (await b.get(path)).text.match(/name="csrf-token" content="([^"]+)"|name="csrf" value="([^"]+)"/)?.slice(1).find(Boolean); },
    async login(email, password) {
      const csrf = await b.csrf('/login');
      const r = await b.post('/login', { email, password, csrf });
      assert.equal(r.status, 302, `login of ${email}`);
      return b;
    },
  };
  return b;
}

test('C01: a seller opens an order from the order list, and the page asks the order API for it', async () => {
  const { server, base } = await boot();
  try {
    const b = await browser(base).login('staff.harbor@vulnmart.test', 'harbor-staff-demo-a1');
    const nav = await b.get('/seller');
    assert.match(nav.text, /href="\/seller\/orders"/, 'the seller area links to the orders');
    const list = await b.get('/seller/orders');
    assert.equal(list.status, 200);
    const link = list.text.match(/href="\/seller\/orders\/(VM-\d+)"/);
    assert.ok(link, 'the list shows order numbers and links to each order');
    const page = await b.get(`/seller/orders/${link[1]}`);
    assert.match(page.text, /data-widget="seller-order"/);
    assert.match(page.text, /\/assets\/shop\.js/);
    const script = await b.get('/assets/shop.js');
    assert.match(script.text, /\/api\/seller\/orders\//, 'the page script calls the order API by number');
    const own = await b.get(`/api/seller/orders/${link[1]}`); assert.equal(own.status, 200);
    const foreign = await b.get('/api/seller/orders/VM-100777');
    assert.equal(foreign.status, 200, 'the same request for another store\'s number is answered in the vulnerable build');
    assert.match(foreign.text, /C01-FOREIGN-NOTE/);
  } finally { server.close(); }
});

test('C02: a customer can sign up, finds Gift cards in the menu, buys two cards, and forges the code of card 1', async () => {
  const { server, base } = await boot();
  try {
    const b = browser(base);
    const reg = await b.get('/register'); assert.equal(reg.status, 200);
    const csrf = reg.text.match(/name="csrf" value="([^"]+)"/)[1];
    const made = await b.post('/register', { email: 'new.learner@example.test', password: 'a-long-password', csrf });
    assert.equal(made.status, 302, 'sign-up logs the new customer in');
    const shop = await b.get('/shop');
    assert.match(shop.text, /href="\/wallet"/, 'the menu has the gift cards');
    const wallet = await b.get('/wallet');
    assert.match(wallet.text, /id="buy-form"/); assert.match(wallet.text, /id="redeem-form"/);
    const token = (await b.csrf('/wallet'));
    const buy = async () => JSON.parse((await b.post('/api/wallet/buy', { amount_cents: '2000', csrf: token })).text);
    const [c1, c2] = [await buy(), await buy()];
    assert.equal(c2.serial, c1.serial + 1);
    const md5 = (await import('node:crypto')).createHash('md5');
    const forged = `VM-${md5.update('1').digest('hex').slice(0, 12)}`;
    const won = JSON.parse((await b.post('/api/wallet/redeem', { code: forged, csrf: token })).text);
    assert.equal(won.serial, 1);
    assert.ok(won.message, 'the seeded card carries its message');
  } finally { server.close(); }
});

test('C03: the search box is the injectable search: a quote makes it fail visibly, a UNION reads the notes table', async () => {
  const { server, base } = await boot();
  try {
    const b = browser(base);
    const home = await b.get('/shop');
    assert.match(home.text, /<form class="search" method="get" action="\/shop"/);
    const broken = await b.get(`/shop?q=${encodeURIComponent("'")}`);
    assert.match(broken.text, /Search failed/);
    const union = await b.get(`/shop?q=${encodeURIComponent("zzz' UNION SELECT id,body,0,'notes' FROM ops_notes--")}`);
    assert.match(union.text, /C03A-OPS-NOTE-MARKER|C03A-FLAG-MARKER|notes/);
  } finally { server.close(); }
});

test('C03B: a customer finds Support, and the listener page the challenge points to answers', async () => {
  const { server, base } = await boot();
  try {
    const b = await browser(base).login('player.customer@vulnmart.test', 'player-customer-demo-b2');
    const shop = await b.get('/shop');
    assert.match(shop.text, /href="\/tickets"/);
    assert.equal((await b.get('/tickets')).status, 200);
    assert.equal((await b.get('/lab/listener')).status, 200);
  } finally { server.close(); }
});

test('C04: the delivered order has a quick refund and a refund statement, and the statement answers', async () => {
  const { server, base } = await boot();
  try {
    const b = await browser(base).login('player.customer@vulnmart.test', 'player-customer-demo-b2');
    const orders = await b.get('/orders');
    const link = orders.text.match(/href="\/orders\/(\d+)"/);
    assert.ok(link, 'the customer sees their orders');
    const order = await b.get(`/orders/${link[1]}`);
    assert.match(order.text, /data-widget="refund"/); assert.match(order.text, /id="quick-refund"/);
    const stmt = await b.get(`/api/orders/${link[1]}/refund-statement`);
    assert.equal(stmt.status, 200);
  } finally { server.close(); }
});

test('C05: the product page sends the cart preview to /api/cart, and a broken request answers with a trace that names the ops area', async () => {
  const { server, base } = await boot();
  try {
    const b = await browser(base).login('player.customer@vulnmart.test', 'player-customer-demo-b2');
    const product = await b.get('/product/1');
    assert.match(product.text, /data-widget="add-to-cart"/);
    assert.match((await b.get('/assets/shop.js')).text, /fetch\('\/api\/cart'/);
    const broken = await b.post('/api/cart', {}, { raw: '{"items": [', type: 'application/json' });
    assert.match(broken.text, /_ops/);
    assert.equal((await b.get('/_ops/diagnostics')).status, 200);
  } finally { server.close(); }
});

test('C06: the seller dashboard links to the bulk import preview', async () => {
  const { server, base } = await boot();
  try {
    const b = await browser(base).login('owner.harbor@vulnmart.test', 'vulnmart-seed-demo');
    assert.match((await b.get('/seller')).text, /href="\/seller\/import"/);
    assert.match((await b.get('/seller/import')).text, /name="options"/);
  } finally { server.close(); }
});

test('C07: the login page offers a forgotten-password flow, and the contact page names the finance mailbox', async () => {
  const { server, base } = await boot();
  try {
    const b = browser(base);
    assert.match((await b.get('/login')).text, /href="\/forgot"/);
    const forgot = await b.get('/forgot');
    assert.match(forgot.text, /id="reset-request"/); assert.match(forgot.text, /id="reset-confirm"/);
    assert.match((await b.get('/contact')).text, /finance\.ops@vulnmart\.test/);
    assert.match((await b.get('/shop')).text, /href="\/contact"/, 'the footer links to the contact page');
    const asked = await b.post('/auth/forgot', { email: 'finance.ops@vulnmart.test' });
    assert.equal(asked.status, 200);
  } finally { server.close(); }
});

test('C08: the cart offers to pay through PayGate, and the pay page waits for the provider and names the webhook', async () => {
  const { server, base } = await boot();
  try {
    const b = await browser(base).login('player.customer@vulnmart.test', 'player-customer-demo-b2');
    const csrf = await b.csrf('/shop');
    assert.equal((await b.post('/cart/add', { product_id: '1', qty: '1', csrf })).status, 302);
    const cart = await b.get('/cart');
    assert.match(cart.text, /formaction="\/pay\/start"/);
    const started = await b.post('/pay/start', { line1: '1 Test St', city: 'Testville', country: 'TT', card: '4242', csrf });
    assert.equal(started.status, 302);
    const pay = await b.get(started.location);
    assert.match(pay.text, /Waiting for the payment provider/);
    assert.match(pay.text, /\/webhooks\/payments/);
  } finally { server.close(); }
});

test('C09: the contact page names the support agent and the mobile app page names the old login route', async () => {
  const { server, base } = await boot();
  try {
    const b = browser(base);
    assert.match((await b.get('/contact')).text, /s\.iyer@vulnmart\.test/);
    const app = await b.get('/app');
    assert.match(app.text, /\/m\/api\/v1\/login/);
    assert.match((await b.get('/shop')).text, /href="\/app"/, 'the footer links to the app page');
  } finally { server.close(); }
});

test('C10: the seller dashboard has the Import image from URL form', async () => {
  const { server, base } = await boot();
  try {
    const b = await browser(base).login('owner.harbor@vulnmart.test', 'vulnmart-seed-demo');
    const dash = await b.get('/seller');
    assert.match(dash.text, /data-widget="import-image"/); assert.match(dash.text, /id="import-form"/);
    assert.match((await b.get('/assets/shop.js')).text, /\/seller\/import-image/);
  } finally { server.close(); }
});

test('C11: a new customer finds Sell with us, and the store form sends the tax id to the KYC route', async () => {
  const { server, base } = await boot();
  try {
    const b = browser(base);
    const csrf = (await b.get('/register')).text.match(/name="csrf" value="([^"]+)"/)[1];
    assert.equal((await b.post('/register', { email: 'future.seller@example.test', password: 'a-long-password', csrf })).status, 302);
    assert.match((await b.get('/shop')).text, /href="\/seller\/register"/, 'the menu offers selling');
    const form = await b.get('/seller/register');
    assert.match(form.text, /action="\/sell\/register"/); assert.match(form.text, /name="tax_id"/);
  } finally { server.close(); }
});

test('a visitor can create an account, a wrong or duplicate sign-up says why', async () => {
  const { server, base } = await boot();
  try {
    const b = browser(base);
    const csrf = (await b.get('/register')).text.match(/name="csrf" value="([^"]+)"/)[1];
    assert.match((await b.post('/register', { email: 'bad', password: 'a-long-password', csrf })).text, /valid email/);
    assert.match((await b.post('/register', { email: 'a@example.test', password: 'short', csrf })).text, /at least 8/);
    assert.match((await b.post('/register', { email: 'player.customer@vulnmart.test', password: 'a-long-password', csrf })).text, /already has an account/);
  } finally { server.close(); }
});
