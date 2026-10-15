// Shop-service edge cases that are awkward over HTTP (refund/dispute state,
// quantity bounds). Correct flow only; the deliberate C04 refund path is later.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { seedAll } from '../seed/registry.mjs';
import { addToCart, requestRefund, openDispute, MAX_CART_QTY } from '../src/domain/shop-service.mjs';

const CUSTOMER = { id: 3, role: 'customer', status: 'active' }; // customer.demo (seed)
let db;

// A paid order + one order item owned by the demo customer; returns the item id.
function paidItem(status = 'paid') {
  const order = db.prepare("INSERT INTO orders (customer_id, status, total_cents, ship_line1, ship_city, ship_country) VALUES (3,'paid',1999,'1 St','Town','Land')").run();
  const oi = db.prepare('INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,1,1,1999,1,?,200)')
    .run(Number(order.lastInsertRowid), status);
  return Number(oi.lastInsertRowid);
}

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
});

test('A4: addToCart rejects out-of-range or unsafe quantities', () => {
  for (const bad of [0, -1, 1.5, 100, 1e15, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => addToCart(db, CUSTOMER, 1, bad), /quantity must be an integer from 1 to 99/, `qty ${bad}`);
  }
  // A valid quantity is accepted.
  assert.doesNotThrow(() => addToCart(db, CUSTOMER, 1, 2));
});

test('A4: the cart line is capped at MAX_CART_QTY even across repeated adds', () => {
  addToCart(db, CUSTOMER, 1, 90);
  const cart = addToCart(db, CUSTOMER, 1, 90); // 90 + 90 would be 180
  const line = cart.items.find((i) => i.product_id === 1);
  assert.equal(line.qty, MAX_CART_QTY, 'the merged line is capped at 99');
});

test('A3: a refund cannot be requested twice, even after the first is processed', () => {
  const itemId = paidItem();
  const refundId = requestRefund(db, CUSTOMER, itemId, 'changed mind');
  // A second request while the first is still requested is refused...
  assert.throws(() => requestRefund(db, CUSTOMER, itemId, 'again'), /a refund already exists/);
  // ...and still refused after the first is processed (the double-payout bug).
  db.prepare("UPDATE refunds SET status = 'processed' WHERE id = ?").run(refundId);
  assert.throws(() => requestRefund(db, CUSTOMER, itemId, 'again'), /a refund already exists/);
  // A rejected refund does NOT block a fresh request.
  db.prepare("UPDATE refunds SET status = 'rejected' WHERE id = ?").run(refundId);
  assert.doesNotThrow(() => requestRefund(db, CUSTOMER, itemId, 'retry'));
});

test('A3: a cancelled item cannot be refunded or disputed', () => {
  const itemId = paidItem('cancelled');
  assert.throws(() => requestRefund(db, CUSTOMER, itemId, 'x'), /cancelled item cannot be refunded/);
  assert.throws(() => openDispute(db, CUSTOMER, itemId, 'x'), /cancelled item cannot be disputed/);
});

test('A3: an item already refunded cannot also be disputed (double compensation)', () => {
  const itemId = paidItem();
  const refundId = requestRefund(db, CUSTOMER, itemId, 'refund');
  db.prepare("UPDATE refunds SET status = 'approved' WHERE id = ?").run(refundId);
  assert.throws(() => openDispute(db, CUSTOMER, itemId, 'also dispute'), /already has a refund and cannot also be disputed/);
});
