// The baseline hardening of the non-challenge shop (WP-D, 2026-10-21; the "deferred work" of the shop reviews): field length limits, list paging, BEGIN IMMEDIATE at checkout,
// password rehash on login, login throttling with the security events wired, the build id of /version, the staff decision context. None of it may touch a challenge weakness;
// the release gate (node scripts/release-gate.mjs) is what proves that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { seedAll } from '../seed/registry.mjs';
import { createApp } from '../src/app.mjs';
import * as shop from '../src/domain/shop-service.mjs';
import * as staff from '../src/domain/staff-service.mjs';
import * as money from '../src/domain/money-service.mjs';
import { LIMITS, capShip, capText, pageArgs } from '../src/domain/limits.mjs';
import { actorContext } from '../src/domain/staff-service.mjs';
import { createUser, authenticate } from '../src/identity/accounts.mjs';
import { hash, verify, needsRehash } from '../src/identity/password.mjs';
import { createLoginThrottle } from '../src/web/login-throttle.mjs';
import { pageOf, slicePage } from '../src/web/paging.mjs';
import { resolveStamp } from '../src/build-id.mjs';

async function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  return db;
}
const customer = (db, email = 'hard@vm.test') => ({ id: createUser(db, { email, password: 'hardening-pass-1', role: 'customer' }).id, role: 'customer' });
const SHIP = { line1: '1 Street', city: 'Town', country: 'Land' };

// ---- field length limits ----------------------------------------------------

test('capText: required, exact limit allowed, one over refused, never truncates', () => {
  assert.equal(capText('x', 'a'.repeat(10), 10), 'a'.repeat(10));
  assert.throws(() => capText('x', 'a'.repeat(11), 10), shop.ValidationError);
  assert.throws(() => capText('x', '   ', 10, { required: true }), /required/);
  assert.equal(capText('x', undefined, 10), '');
  assert.throws(() => capShip({ line1: 'a', city: 'b', country: 'c'.repeat(LIMITS.address_line + 1) }), /country is too long/);
});

test('the customer flows refuse oversized text: address, ticket, review, refund and dispute reasons', async () => {
  const db = await freshDb();
  const u = customer(db);
  shop.addToCart(db, u, 1, 1);
  assert.throws(() => shop.checkout(db, u, { ship: { ...SHIP, line1: 'x'.repeat(LIMITS.address_line + 1) }, card: '4242424242424242' }), /address is too long/);
  assert.throws(() => shop.checkout(db, u, { ship: SHIP, card: '4242424242424242', note: 'n'.repeat(LIMITS.order_note + 1) }), /note is too long/);
  assert.throws(() => shop.createTicket(db, u, 's'.repeat(LIMITS.ticket_subject + 1), 'body'), /subject is too long/);
  assert.throws(() => shop.createTicket(db, u, 'subject', 'b'.repeat(LIMITS.ticket_body + 1)), /message is too long/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tickets').get().c, 0, 'a refused ticket leaves nothing behind');
  const id = shop.createTicket(db, u, 's'.repeat(LIMITS.ticket_subject), 'b'.repeat(LIMITS.ticket_body));
  assert.ok(id > 0, 'exactly the limit is fine');
  assert.throws(() => shop.addReview(db, u, 1, 5, 'r'.repeat(LIMITS.review_body + 1)), /review is too long/);
  assert.throws(() => shop.requestRefund(db, u, 1, 'r'.repeat(LIMITS.reason + 1)), /reason is too long/);
  assert.throws(() => shop.openDispute(db, u, 1, 'r'.repeat(LIMITS.reason + 1)), /reason is too long/);
  const support = createUser(db, { email: 'sup-hard@vm.test', password: 'hardening-pass-1', role: 'support_agent' });
  assert.throws(() => staff.replyTicket(db, { id: support.id, role: 'support_agent' }, id, 'r'.repeat(LIMITS.reply_body + 1)), /reply is too long/);
  assert.throws(() => staff.replyTicket(db, { id: support.id, role: 'support_agent' }, id, '  '), /reply is required/);
});

test('a cart holds a bounded number of lines', async () => {
  const db = await freshDb();
  const u = customer(db);
  const ids = db.prepare("SELECT id FROM products WHERE status = 'published'").all().map((r) => r.id);
  for (let n = shop.MAX_CART_LINES + 1 - ids.length; n > 0; n--) { // fill up to the cap with extra published products
    db.prepare("INSERT INTO products (store_id, title, price_cents, status, stock) VALUES (1, ?, 100, 'published', 5)").run(`Extra ${n}`);
  }
  const all = db.prepare("SELECT id FROM products WHERE status = 'published' ORDER BY id").all().map((r) => r.id);
  for (const id of all.slice(0, shop.MAX_CART_LINES)) shop.addToCart(db, u, id, 1);
  assert.throws(() => shop.addToCart(db, u, all[shop.MAX_CART_LINES], 1), /at most/);
  shop.addToCart(db, u, all[0], 1); // raising the quantity of a line already there is still fine
});

// ---- paging -----------------------------------------------------------------

test('pageArgs clamps and the list services page', async () => {
  assert.deepEqual(pageArgs({}), { limit: 100, offset: 0 });
  assert.deepEqual(pageArgs({ limit: 0, offset: -5 }), { limit: 100, offset: 0 });
  assert.deepEqual(pageArgs({ limit: 99999, offset: 2 }), { limit: 500, offset: 2 });
  assert.deepEqual(pageArgs({ limit: '7', offset: '3' }), { limit: 7, offset: 3 });
  const db = await freshDb();
  const all = shop.listProducts(db, {});
  assert.ok(all.length >= 3);
  assert.deepEqual(shop.listProducts(db, { limit: 2 }).map((p) => p.id), all.slice(0, 2).map((p) => p.id));
  assert.deepEqual(shop.listProducts(db, { limit: 2, offset: 1 }).map((p) => p.id), all.slice(1, 3).map((p) => p.id));
  const u = customer(db);
  for (let i = 0; i < 5; i++) shop.createTicket(db, u, `t${i}`, 'x');
  assert.equal(shop.listTickets(db, u).length, 5);
  assert.deepEqual(shop.listTickets(db, u, { limit: 2, offset: 2 }).map((t) => t.subject), ['t2', 't1']);
  const admin = { id: createUser(db, { email: 'adm-hard@vm.test', password: 'hardening-pass-1', role: 'admin' }).id, role: 'admin' };
  const users = staff.listUsers(db, admin);
  assert.equal(staff.listUsers(db, admin, { limit: 3 }).length, 3);
  assert.deepEqual(staff.listUsers(db, admin, { limit: 2, offset: 1 }).map((x) => x.id), users.slice(1, 3).map((x) => x.id));
  assert.equal(money.listRefunds(db, admin, { limit: 1 }).length <= 1, true);
});

test('pageOf and slicePage: a look-ahead row decides the Next link', () => {
  assert.deepEqual(pageOf({}), { page: 1, size: 50, limit: 51, offset: 0 });
  assert.deepEqual(pageOf({ page: '3' }, 10), { page: 3, size: 10, limit: 11, offset: 20 });
  for (const bad of ['0', '-1', 'abc', '1e9', '999999', undefined]) assert.equal(pageOf({ page: bad }).page, 1, String(bad));
  const rows = Array.from({ length: 11 }, (_, i) => i);
  const first = slicePage(rows, pageOf({}, 10), '/x');
  assert.equal(first.rows.length, 10);
  assert.deepEqual(first.pager, { page: 1, prev: null, next: '/x?page=2' });
  const last = slicePage(rows.slice(0, 4), pageOf({ page: 2 }, 10), '/x', '&q=a');
  assert.deepEqual(last.pager, { page: 2, prev: '/x?page=1&q=a', next: null });
});

// ---- BEGIN IMMEDIATE at checkout ---------------------------------------------

test('checkout takes the write lock up front (BEGIN IMMEDIATE) and the last unit is sold once', async () => {
  const db = await freshDb();
  const statements = [];
  const spy = new Proxy(db, { get: (t, k) => (k === 'exec' ? (sql) => { statements.push(sql); return t.exec(sql); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const a = customer(db, 'a-hard@vm.test');
  const b = customer(db, 'b-hard@vm.test');
  db.prepare('UPDATE products SET stock = 1 WHERE id = 1').run();
  shop.addToCart(db, a, 1, 1);
  shop.addToCart(db, b, 1, 1);
  shop.checkout(spy, a, { ship: SHIP, card: '4242424242424242' });
  assert.ok(statements.includes('BEGIN IMMEDIATE'), `checkout began with ${statements[0]}`);
  assert.ok(!statements.includes('BEGIN'), 'no deferred BEGIN at checkout');
  assert.throws(() => shop.checkout(spy, b, { ship: SHIP, card: '4242424242424242' }), /not enough stock/);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = 1').get().stock, 0, 'sold exactly once');
});

test('two connections: while one holds the immediate lock the other cannot start a checkout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-imm-'));
  const file = path.join(dir, 's.db');
  const one = openDb(file);
  migrate(one);
  await seedAll(one);
  const two = openDb(file);
  try {
    one.prepare('PRAGMA busy_timeout = 0').run?.();
    two.exec('PRAGMA busy_timeout = 0');
    const u = customer(one);
    shop.addToCart(one, u, 1, 1);
    one.exec('BEGIN IMMEDIATE'); // the first writer holds the lock
    assert.throws(() => shop.checkout(two, { id: u.id, role: 'customer' }, { ship: SHIP, card: '4242424242424242' }), /locked|busy/i);
    one.exec('ROLLBACK');
  } finally { one.close(); two.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- rehash on login ----------------------------------------------------------

test('a correct login replaces a hash made with weaker parameters; a wrong password changes nothing', async () => {
  const db = await freshDb();
  const weak = hash('rehash-me-please', { N: 1024, r: 8, p: 1, keylen: 32, saltBytes: 16 });
  assert.equal(needsRehash(weak), true);
  const id = createUser(db, { email: 'rh@vm.test', password: 'tmp-pass-123456', role: 'customer' }).id;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(weak, id);
  assert.equal(authenticate(db, 'rh@vm.test', 'wrong-password'), null);
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash, weak, 'a failed login does not rehash');
  assert.ok(authenticate(db, 'rh@vm.test', 'rehash-me-please'));
  const after = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash;
  assert.notEqual(after, weak);
  assert.equal(needsRehash(after), false);
  assert.ok(verify('rehash-me-please', after), 'the same password still opens the account');
  assert.ok(authenticate(db, 'rh@vm.test', 'rehash-me-please'));
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash, after, 'a current hash is left alone');
});

// ---- login throttle and the security events ------------------------------------

test('createLoginThrottle: counts failures per source inside the window, forgets them after it, stays bounded', () => {
  let t = 0;
  const th = createLoginThrottle({ max: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 2; i++) th.fail('a');
  assert.equal(th.blocked('a'), false);
  th.fail('a');
  assert.equal(th.blocked('a'), true);
  assert.equal(th.blocked('b'), false, 'another source is not held');
  t = 1500;
  assert.equal(th.blocked('a'), false, 'the window passed');
  for (let i = 0; i < 6000; i++) th.fail(`s${i}`);
  assert.ok(th.size <= 5000);
});

async function appWith(db, throttle) {
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), loginThrottle: throttle });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/login`);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const login = (email, password) => fetch(`${base}/login`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password, csrf }).toString(), redirect: 'manual' });
  return { server, events, login };
}

test('the web login: failures from one source are throttled across accounts, and every attempt is a security event', async () => {
  const db = await freshDb();
  const { server, events, login } = await appWith(db, createLoginThrottle({ max: 4, windowMs: 60000 }));
  try {
    for (let i = 0; i < 4; i++) assert.equal((await login(`nobody${i}@vm.test`, 'guess-guess-1')).status, 401);
    // an unknown email has no account to lock, but it is still written to the security log, with no account
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM security_events WHERE account_id IS NULL AND kind = 'login_failed'").get().c, 4);
    const unknown = events.filter((e) => e.type === 'shop.security_event_written' && e.data.account_id === 'unknown');
    assert.equal(unknown.length, 4);
    // the fifth attempt, even with a CORRECT password for a real account, is refused: the source is held
    const held = await login('customer.demo@vulnmart.test', 'vulnmart-seed-demo');
    assert.equal(held.status, 429);
    assert.ok(events.some((e) => e.type === 'auth.attempt' && e.data.route === 'web' && e.data.result === 'locked'));
    assert.ok(events.some((e) => e.type === 'shop.security_event_written' && e.data.kind === 'login_locked'));
    assert.equal(events.filter((e) => e.type === 'auth.attempt' && e.data.result === 'failure').every((e) => e.data.account_id === 'unknown'), true);
  } finally { server.close(); }
});

test('the web login: a source that signs in correctly is never throttled (only failures count)', async () => {
  const db = await freshDb();
  const { server, events, login } = await appWith(db, createLoginThrottle({ max: 3, windowMs: 60000 }));
  try {
    for (let i = 0; i < 10; i++) assert.equal((await login('customer.demo@vulnmart.test', 'vulnmart-seed-demo')).status, 302);
    assert.equal(events.filter((e) => e.type === 'auth.attempt' && e.data.result === 'success').length, 10);
  } finally { server.close(); }
});

test('a failed login for a real account names that account in auth.attempt and writes login_failed', async () => {
  const db = await freshDb();
  const { server, events, login } = await appWith(db, createLoginThrottle({ max: 50, windowMs: 60000 }));
  try {
    const id = db.prepare("SELECT id FROM users WHERE email = 'customer.demo@vulnmart.test'").get().id;
    assert.equal((await login('customer.demo@vulnmart.test', 'not-the-password')).status, 401);
    assert.ok(events.some((e) => e.type === 'auth.attempt' && e.data.route === 'web' && e.data.result === 'failure' && e.data.account_id === String(id)));
    assert.ok(events.some((e) => e.type === 'shop.security_event_written' && e.data.account_id === String(id) && e.data.kind === 'login_failed'));
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM security_events WHERE account_id = ?').get(id).c, 1);
  } finally { server.close(); }
});

// ---- /version build id ---------------------------------------------------------

test('resolveStamp: environment wins, then the stamped file, else dev; only a plain token is believed', () => {
  const files = { '/app/BUILD_ID': 'abc1234\n' };
  const read = (f) => { if (f in files) return files[f]; throw new Error('ENOENT'); };
  const opts = (env) => ({ env, readFile: read, root: '/app' });
  const at = (p) => p.replace(/\\/g, '/');
  const readNorm = (f) => read(at(f));
  assert.equal(resolveStamp('VM_BUILD_ID', 'BUILD_ID', { env: {}, readFile: readNorm, root: '/app' }), 'abc1234');
  assert.equal(resolveStamp('VM_BUILD_ID', 'BUILD_ID', { env: { VM_BUILD_ID: 'from-env' }, readFile: readNorm, root: '/app' }), 'from-env');
  assert.equal(resolveStamp('VM_BUILD_ID', 'BUILD_ID', { env: { VM_BUILD_ID: 'bad value; rm' }, readFile: readNorm, root: '/app' }), 'abc1234', 'an odd env value is ignored');
  assert.equal(resolveStamp('VM_CATALOG_VERSION', 'CATALOG_VERSION', opts({})), 'dev', 'no file: dev');
  files['/app/BUILD_ID'] = '<script>';
  assert.equal(resolveStamp('VM_BUILD_ID', 'BUILD_ID', { env: {}, readFile: readNorm, root: '/app' }), 'dev', 'an odd file is ignored');
});

test('GET /version answers with a build and a catalogue version and never a secret', async () => {
  const db = await freshDb();
  const app = createApp({ db });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/version`)).json();
    assert.deepEqual(Object.keys(body).sort(), ['build', 'catalogue_version']);
    assert.match(body.build, /^[A-Za-z0-9._-]{1,64}$/);
  } finally { server.close(); }
});

// ---- the decision context of the staff service ----------------------------------

test('actorContext: who is acting is always part of the decision; a given resource context wins', () => {
  assert.deepEqual(actorContext({ id: 7, role: 'admin' }), { actor_id: 7, actor_store_id: null });
  assert.deepEqual(actorContext({ id: 7, store_id: 2, role: 'seller_owner' }, { resource_store_id: 2 }), { actor_id: 7, actor_store_id: 2, resource_store_id: 2 });
  assert.deepEqual(actorContext({ id: 7 }, { actor_id: 9 }).actor_id, 9);
});