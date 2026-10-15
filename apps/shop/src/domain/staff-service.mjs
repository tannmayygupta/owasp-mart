// Staff-flow domain service (T-15, FR-SHP-07): support, finance and admin
// actions over the T-06 model, each gated by the RS-G 1.2 permission matrix via
// can(), each mutation audited. Correct flow only; C05/C09 weaknesses are later.
import { can, requiresRedaction } from './permissions.mjs';
import { assertTransition } from './state-machines.mjs';
import { ForbiddenError, NotFoundError, ValidationError } from './shop-service.mjs';

function parseId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('not found');
  return n;
}
function requireCan(actor, action, ctx = {}) {
  if (!can(actor.role, action, ctx)) throw new ForbiddenError();
}
// Record a staff action in the (deliberately thin) audit log.
function audit(db, actorId, action, target) {
  db.prepare('INSERT INTO audit_log (actor_id, action, target) VALUES (?, ?, ?)').run(actorId, action, target);
}
// Apply a state-machine transition, mapping an illegal one to a 400 (not a 500).
function transition(machine, from, to) {
  try {
    assertTransition(machine, from, to);
  } catch {
    throw new ValidationError(`cannot move ${machine} from "${from}" to "${to}"`);
  }
}

// ---- Orders (support full, finance amounts-only, admin full) ----------------

export function viewOrder(db, actor, orderId) {
  requireCan(actor, 'view_order', {});
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(parseId(orderId));
  if (!order) throw new NotFoundError('order not found');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  if (requiresRedaction(actor.role, 'view_order')) {
    // Finance sees amounts, never personal data (names/addresses).
    const { ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country, customer_id, ...safe } = order;
    void [ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country, customer_id];
    return { ...safe, items, redacted: true };
  }
  return { ...order, items, redacted: false };
}

// ---- Tickets (support, admin) ----------------------------------------------

export function listTickets(db, actor) {
  requireCan(actor, 'manage_tickets');
  return db.prepare('SELECT * FROM tickets ORDER BY id DESC').all();
}
export function replyTicket(db, actor, ticketId, body) {
  requireCan(actor, 'manage_tickets');
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(parseId(ticketId));
  if (!ticket) throw new NotFoundError('ticket not found');
  if (!body || !String(body).trim()) throw new ValidationError('a reply is required');
  db.prepare('INSERT INTO ticket_messages (ticket_id, author_id, body) VALUES (?, ?, ?)').run(ticket.id, actor.id, String(body));
  audit(db, actor.id, 'ticket.reply', `ticket:${ticket.id}`);
}
export function assignTicket(db, actor, ticketId, assigneeId) {
  requireCan(actor, 'manage_tickets');
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(parseId(ticketId));
  if (!ticket) throw new NotFoundError('ticket not found');
  // A resolved or closed ticket is not reopened by an assignment (that silently
  // undid a resolution); it must be reopened deliberately first.
  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    throw new ValidationError('a resolved or closed ticket cannot be assigned');
  }
  const assignee = db.prepare('SELECT id, role FROM users WHERE id = ?').get(parseId(assigneeId));
  if (!assignee) throw new ValidationError('unknown assignee');
  // A ticket may only be assigned to someone who can work it (support or admin),
  // never a customer or seller.
  if (assignee.role !== 'support_agent' && assignee.role !== 'admin') {
    throw new ValidationError('assignee must be a support agent or admin');
  }
  db.prepare("UPDATE tickets SET assignee_id = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(assignee.id, ticket.id);
  audit(db, actor.id, 'ticket.assign', `ticket:${ticket.id}`);
}
export function resolveTicket(db, actor, ticketId) {
  requireCan(actor, 'manage_tickets');
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(parseId(ticketId));
  if (!ticket) throw new NotFoundError('ticket not found');
  // Only an active ticket is resolved; re-resolving a resolved/closed one is a
  // no-op that still wrote an audit line and bumped updated_at.
  if (ticket.status !== 'open' && ticket.status !== 'pending') {
    throw new ValidationError('only an open or pending ticket can be resolved');
  }
  db.prepare("UPDATE tickets SET status = 'resolved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticket.id);
  audit(db, actor.id, 'ticket.resolve', `ticket:${ticket.id}`);
}

// ---- Disputes (support, admin) ---------------------------------------------

export function listDisputes(db, actor) {
  requireCan(actor, 'resolve_dispute');
  return db.prepare('SELECT * FROM disputes ORDER BY id DESC').all();
}
export function moveDispute(db, actor, disputeId, to) {
  requireCan(actor, 'resolve_dispute');
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(parseId(disputeId));
  if (!d) throw new NotFoundError('dispute not found');
  transition('dispute', d.status, to); // rejects an illegal transition
  const liable = to === 'resolved_customer' ? 'customer' : to === 'resolved_seller' ? 'seller' : null;
  db.prepare("UPDATE disputes SET status = ?, liable_party = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(to, liable, d.id);
  audit(db, actor.id, 'dispute.move', `dispute:${d.id}->${to}`);
}

// ---- Review moderation (support, admin) ------------------------------------

export function moderateReview(db, actor, reviewId, action) {
  requireCan(actor, 'moderate_review');
  const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(parseId(reviewId));
  if (!review) throw new NotFoundError('review not found');
  const status = action === 'remove' ? 'removed' : action === 'restore' ? 'visible' : null;
  if (!status) throw new ValidationError('action must be remove or restore');
  db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, review.id);
  audit(db, actor.id, `review.${action}`, `review:${review.id}`);
}

// ---- Payouts (finance view/approve, admin hold) ----------------------------

export function listPayouts(db, actor) {
  requireCan(actor, 'view_payouts');
  return db.prepare('SELECT * FROM payouts ORDER BY id DESC').all();
}
export function listCommissions(db, actor) {
  requireCan(actor, 'view_payouts');
  return db.prepare('SELECT * FROM commissions ORDER BY id DESC').all();
}
export function approvePayout(db, actor, payoutId) {
  requireCan(actor, 'approve_payout');
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(parseId(payoutId));
  if (!p) throw new NotFoundError('payout not found');
  transition('payout', p.status, 'approved_by_finance');
  db.prepare("UPDATE payouts SET status = 'approved_by_finance', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(p.id);
  audit(db, actor.id, 'payout.approve', `payout:${p.id}`);
}
export function holdPayout(db, actor, payoutId) {
  requireCan(actor, 'hold_payout');
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(parseId(payoutId));
  if (!p) throw new NotFoundError('payout not found');
  transition('payout', p.status, 'held');
  db.prepare("UPDATE payouts SET status = 'held', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(p.id);
  audit(db, actor.id, 'payout.hold', `payout:${p.id}`);
}

// ---- Admin: seller/product approval, users, audit, alerts ------------------

export function approveStore(db, actor, storeId, decision) {
  requireCan(actor, 'approve_seller');
  const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(parseId(storeId));
  if (!s) throw new NotFoundError('store not found');
  const to = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : null;
  if (!to) throw new ValidationError('decision must be approve or reject');
  transition('seller_approval', s.status, to);
  db.prepare('UPDATE stores SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(to, s.id);
  audit(db, actor.id, `store.${to}`, `store:${s.id}`);
}
export function approveProduct(db, actor, productId, decision) {
  requireCan(actor, 'approve_product');
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(parseId(productId));
  if (!p) throw new NotFoundError('product not found');
  const to = decision === 'approve' ? 'published' : decision === 'reject' ? 'rejected' : null;
  if (!to) throw new ValidationError('decision must be approve or reject');
  transition('product', p.status, to);
  db.prepare('UPDATE products SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(to, p.id);
  audit(db, actor.id, `product.${to}`, `product:${p.id}`);
}
export function listUsers(db, actor) {
  requireCan(actor, 'manage_users');
  return db.prepare('SELECT id, email, role, store_id, status FROM users ORDER BY id').all();
}
export function setUserStatus(db, actor, userId, status) {
  requireCan(actor, 'manage_users');
  if (status !== 'active' && status !== 'suspended') throw new ValidationError('status must be active or suspended');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(parseId(userId));
  if (!u) throw new NotFoundError('user not found');
  if (status === 'suspended') {
    // An admin cannot lock themselves out, and the platform must keep at least
    // one active admin (suspending the last one would leave no one who can undo it).
    if (u.id === actor.id) throw new ValidationError('you cannot suspend your own account');
    if (u.role === 'admin') {
      const otherActiveAdmins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active' AND id != ?").get(u.id).c;
      if (otherActiveAdmins === 0) throw new ValidationError('cannot suspend the last active admin');
    }
  }
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, u.id);
  audit(db, actor.id, `user.${status}`, `user:${u.id}`);
}
export function viewAuditLog(db, actor) {
  requireCan(actor, 'view_audit_log');
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
}
export function viewAlerts(db, actor) {
  requireCan(actor, 'view_audit_log');
  return db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 200').all();
}
