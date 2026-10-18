// C04 — Insecure Design (OWASP 2021 A04 / 2025 A06), CWE-840.
//
// A "Quick refund" feature added beside the correct refund model (T-18). It has
// its own per-request limit check but — in the vulnerable build — no CUMULATIVE
// check, so repeating it pushes an order's refunded total past the amount paid.
// This is a design flaw: a second feature written without the shared invariant.
//
//   FIXED (default): the quick path routes through the same order-level invariant
//     (money.orderRefundableRemaining), so the second refund that would exceed the
//     amount paid is refused.
//   VULNERABLE (VM_CHALLENGE_C04=vulnerable): the quick path checks only the
//     per-request limit, never the running total, so two 1500 refunds on a 2500
//     order both auto-approve; when the total passes the paid amount a
//     goodwill_adjustment (the flag) is written and shop.refund_invariant_broken
//     fires.
//
// Refunded value goes to the non-spendable refund_ledger. The fix: one
// assertRefundable on every path, cumulative balance in a transaction, a count
// cap, idempotency keys, an abuse-case review. See the challenge spec, Section 4.
import { ValidationError, NotFoundError, ForbiddenError } from '../domain/shop-service.mjs';
import { orderPaidCents, orderRefundedCents } from '../domain/money-service.mjs';
import { isVulnerable } from './mode.mjs';

// The instant-refund per-request limit (each single quick refund must be <= this).
export const QUICK_REFUND_LIMIT_CENTS = Number(process.env.VM_QUICK_REFUND_LIMIT_CENTS) || 2000;

function loadOwnDeliveredOrder(db, user, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) throw new NotFoundError('order not found');
  if (order.customer_id !== user.id) throw new ForbiddenError();
  // Only a delivered order can be quick-refunded (customers cannot mark delivery).
  const delivered = db.prepare("SELECT 1 FROM order_items WHERE order_id = ? AND status IN ('delivered','completed') LIMIT 1").get(order.id);
  if (!delivered) throw new ValidationError('only a delivered order can be quick-refunded');
  return order;
}

export function quickRefund(db, user, orderId, { amount, idempotencyKey } = {}, { challenges = {}, emit = () => {} } = {}) {
  const order = loadOwnDeliveredOrder(db, user, orderId);
  const amt = Number(amount);
  const decide = (decision, extra = {}) => emit('shop.refund_decision', { path: 'quick', order_id: String(order.id), decision, ...extra });

  if (!Number.isInteger(amt) || amt <= 0) { decide('refused', { reason: 'bad_amount' }); throw new ValidationError('the amount must be a positive integer'); }
  if (amt > QUICK_REFUND_LIMIT_CENTS) { decide('refused', { reason: 'over_limit' }); throw new ValidationError(`above the instant-refund limit (${QUICK_REFUND_LIMIT_CENTS})`); }

  if (idempotencyKey) {
    const prior = db.prepare('SELECT * FROM refund_ledger WHERE idempotency_key = ?').get(idempotencyKey);
    if (prior) return { refunded_cents: prior.amount_cents, idempotent: true };
  }

  if (!isVulnerable('C04', challenges)) {
    // FIXED: the shared cumulative invariant — the whole reason C04 exists.
    const remaining = orderPaidCents(db, order.id) - orderRefundedCents(db, order.id);
    if (amt > remaining) { decide('refused', { reason: 'cumulative_cap' }); throw new ValidationError('the cumulative refund would exceed the amount paid'); }
  }

  db.prepare('INSERT INTO refund_ledger (order_id, amount_cents, path, idempotency_key) VALUES (?, ?, \'quick\', ?)').run(order.id, amt, idempotencyKey ?? null);
  decide('auto_approved');

  // Sentinel reconcile: once the refunded total passes the amount paid, the
  // goodwill row (the flag) appears. This only ever happens on the vulnerable
  // build (the fixed path refused the overshoot above).
  const paid = orderPaidCents(db, order.id);
  const refunded = orderRefundedCents(db, order.id);
  if (refunded > paid && !db.prepare('SELECT 1 FROM goodwill_adjustment WHERE order_id = ?').get(order.id)) {
    const ref = db.prepare("SELECT value FROM sentinel WHERE key = 'c04'").get()?.value ?? 'C04-GOODWILL-FLAG-MARKER';
    db.prepare('INSERT INTO goodwill_adjustment (order_id, reference, amount_cents) VALUES (?, ?, ?)').run(order.id, ref, refunded - paid);
    emit('shop.refund_invariant_broken', { order_id: String(order.id), refunded_cents: refunded, paid_cents: paid });
  }
  return { refunded_cents: amt };
}

// The refund statement for an order — the route C04's flag is read on (the
// goodwill line's reference appears once the invariant has been broken).
export function refundStatement(db, user, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) throw new NotFoundError('order not found');
  if (order.customer_id !== user.id) throw new ForbiddenError();
  const quick = db.prepare('SELECT amount_cents, path, created_at FROM refund_ledger WHERE order_id = ? ORDER BY id').all(order.id);
  const goodwill = db.prepare('SELECT reference, amount_cents FROM goodwill_adjustment WHERE order_id = ?').all(order.id);
  return {
    order_id: order.id,
    paid_cents: orderPaidCents(db, order.id),
    refunded_cents: orderRefundedCents(db, order.id),
    quick_refunds: quick,
    goodwill, // carries the flag reference once the invariant is broken
  };
}
