// C08 — Software or Data Integrity Failures (OWASP 2021/2025 A08), CWE-345.
//
// The payment webhook the gateway calls to confirm a payment. The gateway signs
// each event with an HMAC. This module owns the one place the signature check is
// (or isn't) enforced.
//
//   FIXED (default): the HMAC signature is ALWAYS verified (constant-time); an
//     unsigned or badly-signed event is rejected (400), whatever headers it carries.
//   VULNERABLE (VM_CHALLENGE_C08=vulnerable): a test-mode bypass left in — the
//     signature check is skipped when the request carries `X-Gateway-Mode:
//     sandbox` — so a player replays an unsigned event and turns their own order
//     paid. The amount-equals-total and order-is-pending checks still run.
//
// A payment accepted through the bypass is stored unverified and its payment_ref
// is written from the sentinel (the C08 flag). An honest checkout or a correctly
// signed gateway event never produces it, and such an order is not refundable
// (verified=0), so it never feeds C04. Fix: always verify the HMAC (timestamp
// window + event-id idempotency), remove the bypass.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '../domain/shop-service.mjs';
import { isVulnerable } from './mode.mjs';
import { safeId } from './event-fields.mjs';

const GATEWAY_KEY = process.env.VM_GATEWAY_HMAC_KEY || 'dev-gateway-key';

export function signPayload(raw, key = GATEWAY_KEY) {
  return createHmac('sha256', key).update(raw).digest('hex');
}
function sigEq(a, b) {
  const ba = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Create a pending-payment order from the customer's cart and stop at "Pay"
// (the C08 start state). Returns the order number and the amount to confirm.
export function createPendingOrder(db, user, { ship = {} } = {}) {
  if (!ship.line1 || !ship.city || !ship.country) throw new ValidationError('a shipping address is required');
  const cart = db.prepare('SELECT * FROM carts WHERE user_id = ?').get(user.id);
  const rows = cart
    ? db.prepare('SELECT ci.qty, p.price_cents FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = ?').all(cart.id)
    : [];
  const total = rows.reduce((s, r) => s + r.price_cents * r.qty, 0);
  if (total <= 0) throw new ValidationError('the cart is empty');
  const info = db.prepare("INSERT INTO orders (customer_id, status, total_cents, ship_line1, ship_city, ship_country) VALUES (?, 'payment_pending', ?, ?, ?, ?)")
    .run(user.id, total, ship.line1, ship.city, ship.country);
  const orderId = Number(info.lastInsertRowid);
  const orderNo = `VM-1${String(orderId).padStart(5, '0')}`;
  db.prepare('UPDATE orders SET order_no = ? WHERE id = ?').run(orderNo, orderId);
  db.prepare("INSERT INTO payments (order_id, method, status, amount_cents, verified) VALUES (?, 'card', 'pending', ?, 0)").run(orderId, total);
  return { order_id: orderId, order_no: orderNo, amount_cents: total };
}

// Handle a payment webhook. `signature` is the X-Gateway-Signature header,
// `sandboxHeader` the X-Gateway-Mode header. Returns { accepted, ... } or throws
// a ValidationError (-> 400).
export function handlePaymentWebhook(db, rawBody, { signature, sandboxHeader } = {}, { challenges = {}, emit = () => {} } = {}) {
  let event;
  try { event = JSON.parse(rawBody || ''); } catch { throw new ValidationError('bad json'); }

  const signedOk = sigEq(signActual(rawBody), signature);
  const source = signedOk ? 'gateway' : 'non_gateway';

  // The ONE decision: is the signature required? Fixed always; vulnerable skips
  // it for a sandbox-mode request (the bypass).
  const bypass = isVulnerable('C08', challenges) && sandboxHeader === 'sandbox';
  const verified = signedOk; // only a valid signature is "verified"
  // The event of IF-4 (data_webhook_received, no other member): which order the call named, who it came from, whether the signature held, and whether it was accepted.
  const received = (accepted) => emit('webhook.received', { order_id: safeId(event?.order_no), source, verified, sandbox_header: Boolean(sandboxHeader), accepted });
  if (!signedOk && !bypass) {
    received(false);
    throw new ValidationError('invalid or missing gateway signature');
  }

  const order = event.order_no ? db.prepare('SELECT * FROM orders WHERE order_no = ?').get(String(event.order_no)) : null;
  if (!order || order.status !== 'payment_pending') {
    received(false);
    throw new ValidationError('no pending order for that number');
  }
  if (Number(event.amount_cents) !== order.total_cents) {
    received(false);
    throw new ValidationError('amount does not match the order total');
  }

  // Accept. A payment taken through the bypass is unverified and gets the sentinel
  // reference (the flag); a signed one is verified and gets a normal reference.
  const paymentRef = verified
    ? `ref_${event.event_id || order.id}`
    : (db.prepare("SELECT value FROM sentinel WHERE key = 'c08'").get()?.value ?? 'C08-WEBHOOK-FLAG-MARKER');
  db.prepare("UPDATE orders SET status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.id);
  db.prepare("UPDATE payments SET status = 'paid', verified = ?, payment_ref = ? WHERE order_id = ?").run(verified ? 1 : 0, paymentRef, order.id);
  received(true);
  emit('order.paid', { order_id: String(order.id), verified, via: 'webhook' });
  return { accepted: true, verified, payment_ref: paymentRef, order_no: order.order_no };
}

// Indirection so tests can import the signer; kept internal otherwise.
function signActual(raw) { return signPayload(raw); }

// Routes: the anonymous webhook (raw body for HMAC) is mounted before checkCsrf.
export function registerWebhookRoutes(app, db, express, { challenges = {}, emit = () => {} } = {}) {
  app.post('/webhooks/payments', express.text({ type: '*/*', limit: '16kb' }), (req, res) => {
    try {
      const out = handlePaymentWebhook(db, req.body, { signature: req.get('x-gateway-signature'), sandboxHeader: req.get('x-gateway-mode') }, { challenges, emit });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: e instanceof ValidationError ? e.message : 'bad request' });
    }
  });
}
