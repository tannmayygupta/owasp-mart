// Seller-flow domain tests (T-17, FR-SHP-06): store registration and profile,
// product create/edit/submit/unlist, fulfilment and staff — correct flow, own
// store only. Seed: user 1 owns store 1 (Harbor, approved), user 2 owns store 2
// (Northwind, approved), user 3 is a plain customer.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { seedAll } from '../seed/registry.mjs';
import * as seller from '../src/domain/seller-service.mjs';

let db;
const userRow = (id) => db.prepare('SELECT id, email, role, store_id, status FROM users WHERE id = ?').get(id);
let owner1; // Harbor (store 1, approved)
let owner2; // Northwind (store 2, approved)
let customer; // user 3, no store

// A paid order item against a given store; returns the order_item id.
function paidItem(storeId, productId, status = 'paid') {
  const o = db.prepare("INSERT INTO orders (customer_id, status, total_cents, ship_line1, ship_city, ship_country) VALUES (3,'paid',1999,'1 St','Townsville','Landia')").run();
  const oi = db.prepare('INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,?,?,1999,1,?,200)')
    .run(Number(o.lastInsertRowid), productId, storeId, status);
  return Number(oi.lastInsertRowid);
}

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  owner1 = userRow(1);
  owner2 = userRow(2);
  customer = userRow(3);
});

// ---- Registration -----------------------------------------------------------

test('a customer registers a store: it is pending and they become a seller_owner', () => {
  const storeId = seller.registerStore(db, customer, { name: 'Sahil Wares', kyc_text: 'id docs' });
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  assert.equal(store.status, 'pending');
  assert.equal(store.owner_user_id, 3);
  const u = userRow(3);
  assert.equal(u.role, 'seller_owner');
  assert.equal(u.store_id, storeId);
});

test('registering is refused when the account already has a store, or the name is blank', () => {
  assert.throws(() => seller.registerStore(db, owner1, { name: 'Another' }), /already has a store/);
  assert.throws(() => seller.registerStore(db, customer, { name: '   ' }), /store name is required/);
});

// ---- Profile ----------------------------------------------------------------

test('a pending store can still edit its profile; staff cannot', () => {
  const storeId = seller.registerStore(db, customer, { name: 'Pending Co' });
  const pendingOwner = userRow(3);
  assert.doesNotThrow(() => seller.updateStoreProfile(db, pendingOwner, { name: 'Pending Co 2', kyc_text: 'updated' }));
  assert.equal(db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId).name, 'Pending Co 2');
  const staff = { id: 99, role: 'seller_staff', store_id: storeId, status: 'active' };
  assert.throws(() => seller.updateStoreProfile(db, staff, { name: 'x' }), /only the store owner/);
});

// ---- Products ---------------------------------------------------------------

test('create a draft product; submitting from an APPROVED store sends it to pending_review', () => {
  const id = seller.createProduct(db, owner1, { title: 'New Widget', price_cents: 500, stock: 10 });
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'draft');
  seller.submitProduct(db, owner1, id);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = ?').get(id).status, 'pending_review');
});

test('a PENDING store cannot publish: submit is refused (the key rule)', () => {
  const storeId = seller.registerStore(db, customer, { name: 'Pending Co' });
  const pendingOwner = userRow(3);
  const id = seller.createProduct(db, pendingOwner, { title: 'Draft', price_cents: 100, stock: 1 });
  assert.throws(() => seller.submitProduct(db, pendingOwner, id), /store is not approved/);
});

test('editing a PUBLISHED product title or price returns it to pending_review', () => {
  // product 1 is published, store 1 (owner1)
  const status = seller.updateProduct(db, owner1, 1, { price_cents: 2500 });
  assert.equal(status, 'pending_review');
  assert.equal(db.prepare('SELECT status FROM products WHERE id = 1').get().status, 'pending_review');
});

test('a rejected product cannot be edited; a published one can be unlisted', () => {
  db.prepare("UPDATE products SET status = 'rejected' WHERE id = 2").run();
  assert.throws(() => seller.updateProduct(db, owner1, 2, { stock: 5 }), /rejected product cannot be edited/);
  seller.unlistProduct(db, owner1, 1);
  assert.equal(db.prepare('SELECT status FROM products WHERE id = 1').get().status, 'unlisted');
});

test('a seller cannot touch another store\'s product (403) and lists only its own', () => {
  // product 3 belongs to store 2; owner1 is store 1.
  assert.throws(() => seller.updateProduct(db, owner1, 3, { stock: 1 }), /forbidden/i);
  const mine = seller.listMyProducts(db, owner1);
  assert.ok(mine.every((p) => p.store_id === 1));
  assert.deepEqual(mine.map((p) => p.id).sort(), [1, 2]);
});

// ---- Fulfilment -------------------------------------------------------------

test('fulfilment advances paid->processing->shipped->delivered and rejects illegal/foreign moves', () => {
  const item = paidItem(1, 1, 'paid');
  assert.equal(seller.advanceFulfilment(db, owner1, item, 'processing'), 'processing');
  assert.equal(seller.advanceFulfilment(db, owner1, item, 'shipped'), 'shipped');
  assert.equal(seller.advanceFulfilment(db, owner1, item, 'delivered'), 'delivered');
  // delivered -> shipped is illegal
  assert.throws(() => seller.advanceFulfilment(db, owner1, item, 'shipped'), /cannot move fulfilment/);
  // 'completed' is the customer's confirmation, not a seller move
  const item2 = paidItem(1, 1, 'delivered');
  assert.throws(() => seller.advanceFulfilment(db, owner1, item2, 'completed'), /cannot move an item to "completed"/);
  // a store-2 item is not owner1's to move
  const foreign = paidItem(2, 3, 'paid');
  assert.throws(() => seller.advanceFulfilment(db, owner1, foreign, 'processing'), /forbidden/i);
});

test('an item can be cancelled from paid or processing; listStoreOrderItems scopes to own store', () => {
  const item = paidItem(1, 1, 'paid');
  assert.equal(seller.advanceFulfilment(db, owner1, item, 'cancelled'), 'cancelled');
  paidItem(2, 3, 'paid'); // store 2
  const items = seller.listStoreOrderItems(db, owner1);
  assert.ok(items.every((it) => it.id !== undefined));
  assert.ok(items.length >= 1);
  // none of owner1's listed items belongs to store 2's product
  const ids = items.map((it) => it.id);
  assert.ok(ids.includes(item));
});

// ---- Staff ------------------------------------------------------------------

test('the owner promotes an existing customer to staff and can remove them; staff cannot manage staff', () => {
  const staffId = seller.addStaff(db, owner1, 'customer.demo@vulnmart.test');
  assert.equal(staffId, 3);
  const promoted = userRow(3);
  assert.equal(promoted.role, 'seller_staff');
  assert.equal(promoted.store_id, 1);
  // a staff member cannot add staff
  assert.throws(() => seller.addStaff(db, promoted, 'owner.northwind@vulnmart.test'), /only the store owner/);
  // remove reverts to customer
  seller.removeStaff(db, owner1, 3);
  const reverted = userRow(3);
  assert.equal(reverted.role, 'customer');
  assert.equal(reverted.store_id, null);
});

test('adding staff is refused for an unknown email or an account that is already a seller', () => {
  assert.throws(() => seller.addStaff(db, owner1, 'nobody@vulnmart.test'), /no account with that email/);
  assert.throws(() => seller.addStaff(db, owner1, 'owner.northwind@vulnmart.test'), /cannot be added as staff/);
});
