// C01 — Broken Access Control (OWASP 2021 A01 / 2025 A01), CWE-639.
//
// Seller order detail is looked up by a sequential, human-facing order number
// (VM-1NNNNN). The authorization question is "does this order belong to the
// caller's store?". This module is the single isolated place where the correct
// and the deliberately-weak answer diverge; the rest of the shop is unaffected.
//
//   FIXED (default): the lookup is scoped to the caller's store — an order with
//     no item of the caller's store is a 404 (deny by default). The flag, which
//     lives in a competitor order's buyer_note, is never reachable.
//
//   VULNERABLE (VM_CHALLENGE_C01=vulnerable): the store check is dropped, so any
//     order number is served to any seller — a classic IDOR. Reading a foreign
//     order emits shop.cross_store_order_read (the C01 detection signal).
//
// The fix is one WHERE clause; see the write-up in the challenge spec.
import { NotFoundError } from '../domain/shop-service.mjs';
import { isVulnerable } from './mode.mjs';

// The stores an order touches (one order can span several sellers).
function orderStoreIds(db, orderId) {
  return db.prepare('SELECT DISTINCT store_id FROM order_items WHERE order_id = ?').all(orderId).map((r) => r.store_id);
}

function orderDetail(db, order) {
  const items = db
    .prepare('SELECT oi.id, oi.store_id, oi.qty, oi.unit_price_cents, oi.status, p.title FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?')
    .all(order.id);
  // buyer_note is part of the seller order detail (it is where C01's flag sits);
  // it is deliberately NOT in the support/finance order views (so C09 cannot read it).
  return { order_no: order.order_no, status: order.status, buyer_note: order.buyer_note, items };
}

// Look up a seller order by its order number for `actor`. `actor.store_id` is the
// caller's store. Throws NotFoundError (-> 404) when the order is not the
// caller's, in the fixed build.
export function getSellerOrderByNo(db, actor, orderNo, { challenges = {}, emit = () => {} } = {}) {
  const no = String(orderNo ?? '').trim();
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(no);
  if (!order) throw new NotFoundError('order not found');
  const stores = orderStoreIds(db, order.id);
  const callerOwns = actor.store_id != null && stores.includes(actor.store_id);

  if (isVulnerable('C01', challenges)) {
    // VULNERABLE: no store scoping. Serve the order to any seller.
    if (!callerOwns) {
      // The detection signal: the caller read an order of a store that is not theirs.
      emit('shop.cross_store_order_read', {
        order_id: String(order.id),
        order_store: stores.length ? String(stores[0]) : null,
        caller_store: actor.store_id != null ? String(actor.store_id) : null,
      });
    }
    return orderDetail(db, order);
  }

  // FIXED: deny by default — only an order containing an item of the caller's
  // store is visible. A foreign order is indistinguishable from a missing one.
  if (!callerOwns) throw new NotFoundError('order not found');
  return orderDetail(db, order);
}
