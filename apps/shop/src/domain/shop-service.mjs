// Customer-flow domain service (T-14, FR-SHP-05). The CORRECT marketplace
// behaviour over the T-06 schema: cart, checkout with simulated payment, orders,
// reviews, refund/dispute requests and tickets. Every action is scoped to the
// acting customer (per-customer ownership) via permissions.can(); status changes
// go through the T-06 state machines; writes that must not half-apply run in a
// transaction. No deliberate weaknesses here (those are the challenge epics).
import { can } from './permissions.mjs';
import { assertTransition } from './state-machines.mjs';

export class ForbiddenError extends Error {
  constructor(msg = 'forbidden') { super(msg); this.name = 'ForbiddenError'; }
}
export class NotFoundError extends Error {
  constructor(msg = 'not found') { super(msg); this.name = 'NotFoundError'; }
}
export class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; }
}

// A positive-integer id or a clean 404 (never NaN bound to a statement -> 500).
function parseId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('not found');
  return n;
}

// Run writes atomically; roll back on any error (unless already committed).
function inTransaction(db, fn) {
  db.exec('BEGIN');
  let committed = false;
  const commit = () => { db.exec('COMMIT'); committed = true; };
  try {
    const result = fn(commit);
    if (!committed) commit();
    return result;
  } catch (err) {
    if (!committed) { try { db.exec('ROLLBACK'); } catch { /* no active tx */ } }
    throw err;
  }
}

// ---- Catalogue (browse / search / product) --------------------------------

export function listProducts(db, { q = '' } = {}) {
  const term = String(q).trim();
  if (term) {
    // Parameterised search (correct flow; the C03 SQL-injection path is separate).
    // Escape LIKE wildcards so a literal "50%" is not a match-all.
    const safe = term.replace(/[\\%_]/g, (m) => `\\${m}`);
    return db
      .prepare("SELECT * FROM products WHERE status = 'published' AND title LIKE ? ESCAPE '\\' ORDER BY id")
      .all(`%${safe}%`);
  }
  return db.prepare("SELECT * FROM products WHERE status = 'published' ORDER BY id").all();
}

export function getPublishedProduct(db, productId) {
  const p = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'published'").get(parseId(productId));
  if (!p) throw new NotFoundError('product not found');
  return p;
}

// ---- Cart ------------------------------------------------------------------

function getOrCreateCart(db, userId) {
  let cart = db.prepare('SELECT * FROM carts WHERE user_id = ? ORDER BY id LIMIT 1').get(userId);
  if (!cart) {
    const info = db.prepare('INSERT INTO carts (user_id) VALUES (?)').run(userId);
    cart = { id: Number(info.lastInsertRowid), user_id: userId };
  }
  return cart;
}

export const MAX_CART_QTY = 99;

export function addToCart(db, user, productId, qty = 1) {
  if (!can('customer', 'cart_checkout', { actor_id: user.id, owner_id: user.id })) throw new ForbiddenError();
  const n = Number(qty);
  // A safe-integer upper bound stops a huge quantity overflowing the money maths.
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_CART_QTY) {
    throw new ValidationError(`quantity must be an integer from 1 to ${MAX_CART_QTY}`);
  }
  const product = getPublishedProduct(db, productId); // 404 if not published
  const cart = getOrCreateCart(db, user.id);
  const existing = db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ?').get(cart.id, product.id);
  if (existing) {
    // Merge but keep the line capped so repeated adds cannot exceed the cap.
    db.prepare('UPDATE cart_items SET qty = MIN(qty + ?, ?) WHERE id = ?').run(n, MAX_CART_QTY, existing.id);
  } else {
    db.prepare('INSERT INTO cart_items (cart_id, product_id, qty) VALUES (?, ?, ?)').run(cart.id, product.id, n);
  }
  return getCart(db, user);
}

export function getCart(db, user) {
  const cart = getOrCreateCart(db, user.id);
  const rows = db
    .prepare(
      `SELECT ci.id AS cart_item_id, ci.qty, p.id AS product_id, p.title, p.price_cents, p.store_id, p.status
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = ? ORDER BY ci.id`,
    )
    .all(cart.id);
  const items = rows.map((r) => ({ ...r, line_cents: r.price_cents * r.qty }));
  const total_cents = items.reduce((sum, i) => sum + i.line_cents, 0);
  return { cart_id: cart.id, items, total_cents };
}

// ---- Checkout (order + simulated payment) ----------------------------------

// Simulated payment. The real mock gateway is T-11; here a well-formed card
// "succeeds". No real card data is stored beyond the last four digits.
function simulatePayment({ card = '' }) {
  const digits = String(card).replace(/\D/g, '');
  const ok = digits.length >= 12 && digits.length <= 19;
  return { ok, last4: ok ? digits.slice(-4) : null };
}

export function checkout(db, user, { ship = {}, card = '', note = '' }) {
  if (!can('customer', 'cart_checkout', { actor_id: user.id, owner_id: user.id })) throw new ForbiddenError();
  if (!ship.line1 || !ship.city || !ship.country) throw new ValidationError('a shipping address is required');
  const buyerNote = note ? String(note).slice(0, 2000) : null;
  const cart = getOrCreateCart(db, user.id);
  const { items, total_cents } = getCart(db, user);
  if (items.length === 0) throw new ValidationError('the cart is empty');

  return inTransaction(db, (commit) => {
    const order = db
      .prepare(
        `INSERT INTO orders (customer_id, status, total_cents, ship_line1, ship_city, ship_country)
         VALUES (?, 'payment_pending', ?, ?, ?, ?)`,
      )
      .run(user.id, total_cents, ship.line1, ship.city, ship.country);
    const orderId = Number(order.lastInsertRowid);
    // Human-facing sequential order number, and the optional buyer note.
    db.prepare('UPDATE orders SET order_no = ?, buyer_note = ? WHERE id = ?')
      .run(`VM-1${String(orderId).padStart(5, '0')}`, buyerNote, orderId);

    const pay = simulatePayment({ card });
    db.prepare('INSERT INTO payments (order_id, method, status, amount_cents, card_last4) VALUES (?, ?, ?, ?, ?)')
      .run(orderId, 'card', pay.ok ? 'paid' : 'failed', total_cents, pay.last4);

    if (!pay.ok) {
      // Record the failed attempt (order + failed payment) and commit, then signal 400.
      assertTransition('checkout', 'payment_pending', 'payment_failed');
      db.prepare("UPDATE orders SET status = 'payment_failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
      commit();
      throw new ValidationError('payment failed: enter a valid card number');
    }

    // Payment succeeded. Re-validate each product (published + stock) at purchase
    // time, record the item at the CURRENT price, decrement stock, record commission.
    assertTransition('checkout', 'payment_pending', 'paid');
    for (const it of items) {
      const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'published'").get(it.product_id);
      if (!product) throw new ValidationError(`a product in your cart is no longer available`);
      if (product.stock < it.qty) throw new ValidationError(`not enough stock for "${product.title}"`);
      const rate = db.prepare('SELECT commission_rate_bp FROM stores WHERE id = ?').get(product.store_id)?.commission_rate_bp ?? 0;
      const commission = Math.round((product.price_cents * it.qty * rate) / 10000);
      const oi = db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents)
           VALUES (?, ?, ?, ?, ?, 'paid', ?)`,
        )
        .run(orderId, product.id, product.store_id, product.price_cents, it.qty, commission);
      db.prepare('INSERT INTO commissions (order_item_id, amount_cents, rate_bp) VALUES (?, ?, ?)')
        .run(Number(oi.lastInsertRowid), commission, rate);
      db.prepare('UPDATE products SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(it.qty, product.id);
    }
    db.prepare("UPDATE orders SET status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
    db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cart.id);
    commit();
    return getOrder(db, user, orderId);
  });
}

// ---- Orders ----------------------------------------------------------------

export function listOrders(db, user) {
  return db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC').all(user.id);
}

export function getOrder(db, user, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(parseId(orderId));
  if (!order) throw new NotFoundError('order not found');
  // Correct flow: a customer sees only their own order (the C01 gap is separate).
  if (!can('customer', 'view_order', { actor_id: user.id, owner_id: order.customer_id })) throw new ForbiddenError();
  const items = db
    .prepare(
      `SELECT oi.*, p.title FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ? ORDER BY oi.id`,
    )
    .all(order.id);
  return { ...order, items };
}

function ownOrderItem(db, user, orderItemId) {
  const row = db
    .prepare(
      `SELECT oi.*, o.customer_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ?`,
    )
    .get(parseId(orderItemId));
  if (!row) throw new NotFoundError('order item not found');
  if (row.customer_id !== user.id) throw new ForbiddenError();
  return row;
}

// ---- Reviews (only purchased items) ----------------------------------------

export function addReview(db, user, productId, rating, body) {
  if (!can('customer', 'write_review', { actor_id: user.id, owner_id: user.id })) throw new ForbiddenError();
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) throw new ValidationError('rating must be 1 to 5');
  const pid = parseId(productId);
  const purchased = db
    .prepare(
      `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.customer_id = ? AND oi.product_id = ? AND o.status = 'paid' LIMIT 1`,
    )
    .get(user.id, pid);
  if (!purchased) throw new ForbiddenError('you can only review a product you purchased');
  try {
    db.prepare("INSERT INTO reviews (product_id, user_id, rating, body, status) VALUES (?, ?, ?, ?, 'visible')")
      .run(pid, user.id, r, body ?? null);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new ValidationError('you have already reviewed this product');
    throw err;
  }
}

// ---- Refunds and disputes (own order items) --------------------------------

export function requestRefund(db, user, orderItemId, reason) {
  if (!can('customer', 'request_refund', { actor_id: user.id, owner_id: user.id })) throw new ForbiddenError();
  const item = ownOrderItem(db, user, orderItemId);
  if (item.status === 'cancelled') throw new ValidationError('a cancelled item cannot be refunded');
  // Any refund that is not rejected blocks a new one — including a `processed`
  // refund, so an item cannot be paid out twice (correct flow; C04 is a later path).
  const existing = db
    .prepare("SELECT 1 FROM refunds WHERE order_item_id = ? AND status != 'rejected' LIMIT 1")
    .get(item.id);
  if (existing) throw new ValidationError('a refund already exists for this item');
  // The reverse order of the dispute-side guard: an active dispute may still end
  // in compensation, and one resolved in the customer's favour already compensated
  // them — either way a refund on top would be a second payout. Only a dispute
  // resolved for the seller (no compensation) leaves the refund path open.
  const dispute = db
    .prepare("SELECT 1 FROM disputes WHERE order_item_id = ? AND status IN ('open','under_review','escalated','resolved_customer') LIMIT 1")
    .get(item.id);
  if (dispute) throw new ValidationError('this item has a dispute and cannot also be refunded');
  const info = db
    .prepare("INSERT INTO refunds (order_item_id, amount_cents, reason, status, requested_by) VALUES (?, ?, ?, 'requested', ?)")
    .run(item.id, item.unit_price_cents * item.qty, reason ?? null, user.id);
  return Number(info.lastInsertRowid);
}

export function openDispute(db, user, orderItemId, reason) {
  if (!can('customer', 'open_dispute', { actor_id: user.id, owner_id: user.id })) throw new ForbiddenError();
  const item = ownOrderItem(db, user, orderItemId);
  if (item.status === 'cancelled') throw new ValidationError('a cancelled item cannot be disputed');
  const open = db
    .prepare("SELECT 1 FROM disputes WHERE order_item_id = ? AND status IN ('open','under_review','escalated') LIMIT 1")
    .get(item.id);
  if (open) throw new ValidationError('a dispute is already open for this item');
  // The same double-compensation rule: an item already refunded (approved or paid)
  // cannot also be disputed for a second payout.
  const settledRefund = db
    .prepare("SELECT 1 FROM refunds WHERE order_item_id = ? AND status IN ('approved','processed') LIMIT 1")
    .get(item.id);
  if (settledRefund) throw new ValidationError('this item already has a refund and cannot also be disputed');
  const info = db
    .prepare("INSERT INTO disputes (order_item_id, opened_by, reason, status) VALUES (?, ?, ?, 'open')")
    .run(item.id, user.id, reason ?? null);
  return Number(info.lastInsertRowid);
}

// ---- Tickets ---------------------------------------------------------------

export function createTicket(db, user, subject, body) {
  if (!can('customer', 'create_ticket', { actor_id: user.id })) throw new ForbiddenError();
  if (!subject || !String(subject).trim()) throw new ValidationError('a subject is required');
  const t = db.prepare("INSERT INTO tickets (requester_id, subject, status) VALUES (?, ?, 'open')").run(user.id, String(subject));
  const ticketId = Number(t.lastInsertRowid);
  db.prepare('INSERT INTO ticket_messages (ticket_id, author_id, body) VALUES (?, ?, ?)').run(ticketId, user.id, String(body ?? ''));
  return ticketId;
}

export function getTicket(db, user, ticketId) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(parseId(ticketId));
  if (!ticket) throw new NotFoundError('ticket not found');
  if (ticket.requester_id !== user.id) throw new ForbiddenError();
  const messages = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id').all(ticket.id);
  return { ...ticket, messages };
}
