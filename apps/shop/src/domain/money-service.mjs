// Money-model domain service (T-18, FR-SHP-10): the CORRECT after-sale money
// flow over the T-06 schema — refund approval/rejection/processing with
// proportional commission reversal, an append-only reversal ledger, idempotency
// keys, and per-store payout accrual. The invariant this story defends is
// "refunded total never exceeds the amount paid for an item"; the C04 challenge
// (epic 5) later plants a path that breaks it, so the baseline must be correct.
import { can } from './permissions.mjs';
import { assertTransition } from './state-machines.mjs';
import { ForbiddenError, NotFoundError, ValidationError } from './shop-service.mjs';

// A seller may self-approve refunds only up to this per-refund amount (RS-G
// 'own_store_under_limit'); above it, support or admin must approve.
export const SELLER_REFUND_LIMIT_CENTS = Number(process.env.VM_SELLER_REFUND_LIMIT_CENTS) || 50_000;

function parseId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('not found');
  return n;
}
function audit(db, actorId, action, target) {
  db.prepare('INSERT INTO audit_log (actor_id, action, target) VALUES (?, ?, ?)').run(actorId, action, target);
}
function transition(machine, from, to) {
  try { assertTransition(machine, from, to); } catch { throw new ValidationError(`cannot move ${machine} from "${from}" to "${to}"`); }
}
function inTransaction(db, fn) {
  db.exec('BEGIN');
  let committed = false;
  const commit = () => { db.exec('COMMIT'); committed = true; };
  try {
    const r = fn(commit);
    if (!committed) commit();
    return r;
  } catch (e) {
    if (!committed) { try { db.exec('ROLLBACK'); } catch { /* none */ } }
    throw e;
  }
}

// What a paid item was worth, and how much of it is already committed to refunds
// (approved or processed — a rejected refund frees nothing because it paid out
// nothing). The guard everywhere: a new refund amount <= paid - alreadyRefunded.
function itemPaidCents(oi) {
  return oi.unit_price_cents * oi.qty;
}
function refundedCents(db, orderItemId, { excludeRefundId = 0 } = {}) {
  return db
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM refunds WHERE order_item_id = ? AND status IN ('approved','processed') AND id != ?")
    .get(orderItemId, excludeRefundId).s;
}
// The largest refund still allowed on an item (never let the total exceed paid).
export function refundableRemaining(db, orderItemId) {
  const oi = db.prepare('SELECT * FROM order_items WHERE id = ?').get(parseId(orderItemId));
  if (!oi) throw new NotFoundError('order item not found');
  return Math.max(0, itemPaidCents(oi) - refundedCents(db, oi.id));
}

// Order-level refund accounting — the SINGLE invariant every refund path shares
// (item refunds + the C04 quick-refund ledger). The C04 fix routes through this;
// the vulnerable quick path deliberately skips it.
export function orderPaidCents(db, orderId) {
  return db.prepare('SELECT total_cents FROM orders WHERE id = ?').get(parseId(orderId))?.total_cents ?? 0;
}
export function orderRefundedCents(db, orderId) {
  const id = parseId(orderId);
  const itemRefunds = db
    .prepare("SELECT COALESCE(SUM(r.amount_cents),0) AS s FROM refunds r JOIN order_items oi ON oi.id = r.order_item_id WHERE oi.order_id = ? AND r.status IN ('approved','processed')")
    .get(id).s;
  const ledger = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM refund_ledger WHERE order_id = ?').get(id).s;
  return itemRefunds + ledger;
}
export function orderRefundableRemaining(db, orderId) {
  return Math.max(0, orderPaidCents(db, orderId) - orderRefundedCents(db, orderId));
}

// Refund rows a staff member (all) or a seller (own store only) may act on.
export function listRefunds(db, actor) {
  if (['support_agent', 'finance', 'admin'].includes(actor?.role)) {
    return db.prepare('SELECT r.*, oi.store_id FROM refunds r JOIN order_items oi ON oi.id = r.order_item_id ORDER BY r.id DESC LIMIT 200').all();
  }
  if ((actor?.role === 'seller_owner' || actor?.role === 'seller_staff') && actor.store_id) {
    return db.prepare('SELECT r.*, oi.store_id FROM refunds r JOIN order_items oi ON oi.id = r.order_item_id WHERE oi.store_id = ? ORDER BY r.id DESC LIMIT 200').all(actor.store_id);
  }
  throw new ForbiddenError();
}

function loadRefund(db, refundId) {
  const r = db.prepare('SELECT * FROM refunds WHERE id = ?').get(parseId(refundId));
  if (!r) throw new NotFoundError('refund not found');
  const oi = db.prepare('SELECT * FROM order_items WHERE id = ?').get(r.order_item_id);
  if (!oi) throw new NotFoundError('order item not found');
  return { refund: r, item: oi };
}

// Approve a requested refund, for a chosen amount (defaults to what was
// requested). Gated by the permission matrix: a seller only for its own store
// and only up to SELLER_REFUND_LIMIT_CENTS; support and admin without a cap.
// The amount is clamped by the invariant (<= paid - already refunded). An
// idempotency key makes a retried approval return the same refund untouched.
export function approveRefund(db, actor, refundId, { amount, idempotencyKey } = {}) {
  const { refund, item } = loadRefund(db, refundId);
  if (idempotencyKey) {
    const prior = db.prepare('SELECT * FROM refunds WHERE idempotency_key = ?').get(idempotencyKey);
    if (prior && prior.id !== refund.id) throw new ValidationError('idempotency key already used by another refund');
    if (refund.idempotency_key === idempotencyKey && refund.status !== 'requested') return refund; // retried
  }
  if (refund.status !== 'requested') throw new ValidationError(`a refund that is "${refund.status}" cannot be approved`);
  const amt = amount == null ? refund.amount_cents : Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) throw new ValidationError('the refund amount must be a positive integer');
  const remaining = itemPaidCents(item) - refundedCents(db, item.id, { excludeRefundId: refund.id });
  if (amt > remaining) throw new ValidationError(`the refund (${amt}) would exceed the amount paid still refundable (${remaining})`);
  // The shared order-level invariant (also counts C04 quick refunds): no path may
  // push the order's refunded total past what was paid for the order.
  if (amt > orderRefundableRemaining(db, item.order_id)) {
    throw new ValidationError('the refund would exceed the order amount paid');
  }
  // Permission: seller is 'own_store_under_limit' (needs amount + limit); support/admin unscoped.
  if (!can(actor.role, 'approve_refund', { actor_store_id: actor.store_id, resource_store_id: item.store_id, amount: amt, limit: SELLER_REFUND_LIMIT_CENTS })) {
    throw new ForbiddenError();
  }
  transition('refund', refund.status, 'approved');
  db.prepare("UPDATE refunds SET status = 'approved', amount_cents = ?, decided_by = ?, idempotency_key = COALESCE(?, idempotency_key), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(amt, actor.id, idempotencyKey ?? null, refund.id);
  audit(db, actor.id, 'refund.approved', `refund:${refund.id}`);
  return db.prepare('SELECT * FROM refunds WHERE id = ?').get(refund.id);
}

export function rejectRefund(db, actor, refundId) {
  const { refund, item } = loadRefund(db, refundId);
  if (!can(actor.role, 'approve_refund', { actor_store_id: actor.store_id, resource_store_id: item.store_id, amount: 0, limit: SELLER_REFUND_LIMIT_CENTS })) {
    throw new ForbiddenError();
  }
  if (refund.status !== 'requested') throw new ValidationError(`a refund that is "${refund.status}" cannot be rejected`);
  transition('refund', refund.status, 'rejected');
  db.prepare("UPDATE refunds SET status = 'rejected', decided_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(actor.id, refund.id);
  audit(db, actor.id, 'refund.rejected', `refund:${refund.id}`);
}

// Process an approved refund: the buyer is repaid `amount`, and the platform's
// commission on the refunded fraction is reversed in proportion
// (reversed = round(commission * amount / item_paid)) into the append-only
// ledger. Idempotent: a refund already processed is a no-op.
export function processRefund(db, actor, refundId) {
  // Processing moves platform money, so it is a staff/finance action — never a
  // seller self-serve step (a seller only approves, up to its limit).
  if (!['support_agent', 'finance', 'admin'].includes(actor?.role)) throw new ForbiddenError();
  return inTransaction(db, () => {
    const { refund, item } = loadRefund(db, refundId);
    if (refund.status === 'processed') return refund; // idempotent
    if (refund.status !== 'approved') throw new ValidationError(`a refund that is "${refund.status}" cannot be processed`);
    transition('refund', refund.status, 'processed');
    const commission = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS c FROM commissions WHERE order_item_id = ?').get(item.id).c;
    const paid = itemPaidCents(item);
    const reversed = paid > 0 ? Math.round((commission * refund.amount_cents) / paid) : 0;
    if (reversed > 0) {
      db.prepare('INSERT INTO commission_reversals (order_item_id, refund_id, amount_cents) VALUES (?, ?, ?)').run(item.id, refund.id, reversed);
    }
    db.prepare("UPDATE refunds SET status = 'processed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(refund.id);
    audit(db, actor.id, 'refund.processed', `refund:${refund.id}`);
    return db.prepare('SELECT * FROM refunds WHERE id = ?').get(refund.id);
  });
}

// Accrue (or refresh) a store's payout for a period from realised sales: gross
// from delivered/completed items, commission net of reversals, refunds deducted
// (seller bears refunds). net = gross - commission - refunds_deducted (may be
// negative). Finance/admin only; the row starts 'accrued' for the payout flow.
export function accruePayout(db, actor, storeId, period) {
  if (actor.role !== 'finance' && actor.role !== 'admin') throw new ForbiddenError();
  const sid = parseId(storeId);
  if (!period || !/^\d{4}-\d{2}$/.test(String(period))) throw new ValidationError('period must be YYYY-MM');
  const store = db.prepare('SELECT id FROM stores WHERE id = ?').get(sid);
  if (!store) throw new NotFoundError('store not found');
  const items = db.prepare("SELECT * FROM order_items WHERE store_id = ? AND status IN ('delivered','completed')").all(sid);
  let gross = 0;
  let commission = 0;
  let refunds = 0;
  for (const oi of items) {
    gross += itemPaidCents(oi);
    const c = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM commissions WHERE order_item_id = ?').get(oi.id).s;
    const rev = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM commission_reversals WHERE order_item_id = ?').get(oi.id).s;
    commission += Math.max(0, c - rev);
    refunds += db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE order_item_id = ? AND status = 'processed'").get(oi.id).s;
  }
  const net = gross - commission - refunds;
  const existing = db.prepare('SELECT * FROM payouts WHERE store_id = ? AND period = ?').get(sid, period);
  if (existing) {
    if (existing.status !== 'accrued' && existing.status !== 'ready') throw new ValidationError(`payout for ${period} is already ${existing.status}`);
    db.prepare('UPDATE payouts SET gross_cents=?, commission_cents=?, refunds_deducted_cents=?, net_cents=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(gross, commission, refunds, net, existing.id);
    audit(db, actor.id, 'payout.accrued', `payout:${existing.id}`);
    return db.prepare('SELECT * FROM payouts WHERE id = ?').get(existing.id);
  }
  const info = db.prepare("INSERT INTO payouts (store_id, period, gross_cents, commission_cents, refunds_deducted_cents, net_cents, status) VALUES (?, ?, ?, ?, ?, ?, 'accrued')")
    .run(sid, period, gross, commission, refunds, net);
  const id = Number(info.lastInsertRowid);
  audit(db, actor.id, 'payout.accrued', `payout:${id}`);
  return db.prepare('SELECT * FROM payouts WHERE id = ?').get(id);
}

// Move an accrued payout to 'ready' (finance/admin), the state approvePayout needs.
export function markPayoutReady(db, actor, payoutId) {
  if (actor.role !== 'finance' && actor.role !== 'admin') throw new ForbiddenError();
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(parseId(payoutId));
  if (!p) throw new NotFoundError('payout not found');
  transition('payout', p.status, 'ready');
  db.prepare("UPDATE payouts SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(p.id);
  audit(db, actor.id, 'payout.ready', `payout:${p.id}`);
}
