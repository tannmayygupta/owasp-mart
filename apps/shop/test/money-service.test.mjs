// Money-model tests (T-18, FR-SHP-10): refund approval/rejection/processing with
// proportional commission reversal, the "refunded total <= amount paid" guard,
// idempotency, own-store/limit scoping, and the payout net formula. Seed: store 1
// (Harbor, 10% commission), owner1 = user 1; customer = user 3.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { seedAll } from '../seed/registry.mjs';
import { requestRefund } from '../src/domain/shop-service.mjs';
import { createUser } from '../src/identity/accounts.mjs';
import * as money from '../src/domain/money-service.mjs';

let db;
const userRow = (id) => db.prepare('SELECT id, email, role, store_id, status FROM users WHERE id = ?').get(id);
let owner1;
let support;
let finance;
const customer = { id: 3, role: 'customer', status: 'active' };

// A delivered item for store 1 with unit_price 1000, qty 1 (paid 1000) and a 10%
// commission (100) recorded, plus a customer refund REQUEST for the full amount.
function itemWithRequest({ unit = 1000, qty = 1, commission = 100 } = {}) {
  const o = db.prepare("INSERT INTO orders (customer_id, status, total_cents, ship_line1, ship_city, ship_country) VALUES (3,'paid',?,'1 St','Town','Land')").run(unit * qty);
  const oi = db.prepare("INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents) VALUES (?,1,1,?,?,'delivered',?)")
    .run(Number(o.lastInsertRowid), unit, qty, commission);
  const itemId = Number(oi.lastInsertRowid);
  db.prepare('INSERT INTO commissions (order_item_id, amount_cents, rate_bp) VALUES (?, ?, 1000)').run(itemId, commission);
  const refundId = requestRefund(db, customer, itemId, 'changed mind');
  return { itemId, refundId };
}

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  owner1 = userRow(1);
  support = userRow(createUser(db, { email: 'support@vm.test', password: 'money-pass-123', role: 'support_agent' }).id);
  finance = userRow(createUser(db, { email: 'finance@vm.test', password: 'money-pass-123', role: 'finance' }).id);
});

test('a seller approves a PARTIAL refund on its own store and processing reverses commission in proportion', () => {
  const { itemId, refundId } = itemWithRequest();
  const approved = money.approveRefund(db, owner1, refundId, { amount: 400 });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.amount_cents, 400);
  money.processRefund(db, support, refundId);
  // reversed = round(100 * 400 / 1000) = 40
  const rev = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM commission_reversals WHERE order_item_id = ?').get(itemId).s;
  assert.equal(rev, 40);
});

test('the refunded total can never exceed the amount paid', () => {
  const { refundId } = itemWithRequest();
  assert.throws(() => money.approveRefund(db, owner1, refundId, { amount: 1001 }), /exceed the amount paid/);
  // the exact paid amount is allowed
  assert.doesNotThrow(() => money.approveRefund(db, owner1, refundId, { amount: 1000 }));
});

test('a seller cannot approve above its limit, or approve another store\'s refund', () => {
  const big = money.SELLER_REFUND_LIMIT_CENTS + 1;
  const { refundId } = itemWithRequest({ unit: big, qty: 1, commission: 0 });
  // over the seller limit -> forbidden for the seller...
  assert.throws(() => money.approveRefund(db, owner1, refundId, { amount: big }), /forbidden/i);
  // ...but support may approve it.
  assert.doesNotThrow(() => money.approveRefund(db, support, refundId, { amount: big }));

  // owner2 (store 2) cannot approve a store-1 refund.
  const { refundId: r2 } = itemWithRequest();
  const owner2 = userRow(2);
  assert.throws(() => money.approveRefund(db, owner2, r2, { amount: 100 }), /forbidden/i);
});

test('approval is idempotent under a repeated idempotency key; processing does not reverse twice', () => {
  const { itemId, refundId } = itemWithRequest();
  const a1 = money.approveRefund(db, owner1, refundId, { amount: 300, idempotencyKey: 'k-1' });
  const a2 = money.approveRefund(db, owner1, refundId, { amount: 300, idempotencyKey: 'k-1' });
  assert.equal(a1.id, a2.id);
  assert.equal(a2.status, 'approved');
  money.processRefund(db, support, refundId);
  money.processRefund(db, support, refundId); // second call is a no-op
  const rows = db.prepare('SELECT COUNT(*) AS c FROM commission_reversals WHERE order_item_id = ?').get(itemId).c;
  assert.equal(rows, 1, 'commission reversed exactly once');
});

test('reusing an idempotency key for a different refund is refused', () => {
  const a = itemWithRequest();
  const b = itemWithRequest();
  money.approveRefund(db, owner1, a.refundId, { amount: 100, idempotencyKey: 'dup' });
  assert.throws(() => money.approveRefund(db, owner1, b.refundId, { amount: 100, idempotencyKey: 'dup' }), /already used/);
});

test('a refund can be rejected, and then it frees the refundable amount again', () => {
  const { itemId, refundId } = itemWithRequest();
  money.rejectRefund(db, support, refundId);
  assert.equal(db.prepare('SELECT status FROM refunds WHERE id = ?').get(refundId).status, 'rejected');
  assert.equal(money.refundableRemaining(db, itemId), 1000, 'a rejected refund commits nothing');
});

test('payout accrual: net = gross - commission(net of reversals) - refunds_deducted', () => {
  const { refundId } = itemWithRequest(); // paid 1000, commission 100
  money.approveRefund(db, owner1, refundId, { amount: 400 });
  money.processRefund(db, support, refundId); // reversed 40, processed refund 400
  const payout = money.accruePayout(db, finance, 1, '2026-10');
  assert.equal(payout.gross_cents, 1000);
  assert.equal(payout.commission_cents, 60, 'commission 100 - 40 reversed');
  assert.equal(payout.refunds_deducted_cents, 400);
  assert.equal(payout.net_cents, 540, '1000 - 60 - 400');
  assert.equal(payout.status, 'accrued');
  // re-accrual refreshes the same row, and markPayoutReady advances it.
  const again = money.accruePayout(db, finance, 1, '2026-10');
  assert.equal(again.id, payout.id);
  money.markPayoutReady(db, finance, payout.id);
  assert.equal(db.prepare('SELECT status FROM payouts WHERE id = ?').get(payout.id).status, 'ready');
});

test('a full refund zeroes the seller net for that item (seller bears the refund)', () => {
  const { refundId } = itemWithRequest();
  money.approveRefund(db, support, refundId, { amount: 1000 });
  money.processRefund(db, support, refundId);
  const payout = money.accruePayout(db, finance, 1, '2026-11');
  assert.equal(payout.commission_cents, 0);
  assert.equal(payout.refunds_deducted_cents, 1000);
  assert.equal(payout.net_cents, 0);
});
