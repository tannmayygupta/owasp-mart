// Seller-flow domain service (T-17, FR-SHP-06): the seller's own side of the
// marketplace over the T-06 schema — store registration and profile, product
// create/edit/submit/unlist, order-item fulfilment and store staff. Every action
// is scoped to the actor's OWN store through the RS-G matrix (can(), 'own_store')
// and status changes go through the T-06 state machines. Correct flow only; the
// seller-path weaknesses (C10 import, C11 KYC) are isolated paths in later epics.
import { can } from './permissions.mjs';
import { assertTransition } from './state-machines.mjs';
import { ForbiddenError, NotFoundError, ValidationError } from './shop-service.mjs';

function parseId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError('not found');
  return n;
}
function audit(db, actorId, action, target) {
  db.prepare('INSERT INTO audit_log (actor_id, action, target) VALUES (?, ?, ?)').run(actorId, action, target);
}
function transition(machine, from, to) {
  try {
    assertTransition(machine, from, to);
  } catch {
    throw new ValidationError(`cannot move ${machine} from "${from}" to "${to}"`);
  }
}

const MAX_TEXT = 2000;
const MAX_NAME = 120;
function cleanText(v, { max = MAX_TEXT, field = 'value', required = false } = {}) {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new ValidationError(`${field} is required`);
  if (s.length > max) throw new ValidationError(`${field} is too long (max ${max})`);
  return s;
}
function intInRange(v, { min, max, field }) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be an integer from ${min} to ${max}`);
  }
  return n;
}

// The store the actor owns/staffs, or a 403 — the single gate every product and
// fulfilment action passes through, so "own store only" is enforced in one place.
function ownStore(db, actor) {
  if (!actor || (actor.role !== 'seller_owner' && actor.role !== 'seller_staff')) throw new ForbiddenError();
  if (actor.status !== 'active') throw new ForbiddenError();
  const store = actor.store_id ? db.prepare('SELECT * FROM stores WHERE id = ?').get(actor.store_id) : null;
  if (!store) throw new ForbiddenError();
  return store;
}
// Resolve a product and assert it belongs to the actor's store (via can()).
function ownProduct(db, actor, productId) {
  const store = ownStore(db, actor);
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(parseId(productId));
  if (!p) throw new NotFoundError('product not found');
  if (!can(actor.role, 'create_edit_product', { actor_store_id: store.id, resource_store_id: p.store_id })) {
    throw new ForbiddenError();
  }
  return { store, product: p };
}

// ---- Store registration and profile ----------------------------------------

// A logged-in user with no store registers one. The store starts `pending`
// (an admin approves it, T-15) and the actor becomes a seller_owner bound to it.
export function registerStore(db, actor, { name, kyc_text } = {}) {
  if (!actor || actor.status !== 'active') throw new ForbiddenError();
  if (actor.store_id) throw new ValidationError('this account already has a store');
  if (actor.role !== 'customer' && actor.role !== 'seller_owner') {
    throw new ForbiddenError('only a customer without a store can register one');
  }
  const nm = cleanText(name, { max: MAX_NAME, field: 'store name', required: true });
  const kyc = cleanText(kyc_text, { field: 'KYC details' });
  const info = db.prepare("INSERT INTO stores (owner_user_id, name, status, kyc_text) VALUES (?, ?, 'pending', ?)").run(actor.id, nm, kyc || null);
  const storeId = Number(info.lastInsertRowid);
  db.prepare("UPDATE users SET role = 'seller_owner', store_id = ? WHERE id = ?").run(storeId, actor.id);
  audit(db, actor.id, 'store.registered', `store:${storeId}`);
  return storeId;
}

export function getMyStore(db, actor) {
  return ownStore(db, actor);
}

// A pending store may still edit its profile (epic Done-when); only the owner may.
export function updateStoreProfile(db, actor, { name, kyc_text } = {}) {
  const store = ownStore(db, actor);
  if (actor.role !== 'seller_owner') throw new ForbiddenError('only the store owner can edit the profile');
  const nm = cleanText(name, { max: MAX_NAME, field: 'store name', required: true });
  const kyc = cleanText(kyc_text, { field: 'KYC details' });
  db.prepare('UPDATE stores SET name = ?, kyc_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nm, kyc || null, store.id);
  audit(db, actor.id, 'store.profile_updated', `store:${store.id}`);
}

// ---- Products ---------------------------------------------------------------

export function listMyProducts(db, actor) {
  const store = ownStore(db, actor);
  return db.prepare('SELECT * FROM products WHERE store_id = ? ORDER BY id DESC').all(store.id);
}

export function createProduct(db, actor, { title, description, price_cents, stock, category_id } = {}) {
  const store = ownStore(db, actor);
  const t = cleanText(title, { max: MAX_NAME, field: 'title', required: true });
  const d = cleanText(description, { field: 'description' });
  const price = intInRange(price_cents, { min: 0, max: 100_000_000, field: 'price' });
  const qty = intInRange(stock ?? 0, { min: 0, max: 1_000_000, field: 'stock' });
  const cat = category_id ? parseId(category_id) : null;
  const info = db
    .prepare("INSERT INTO products (store_id, category_id, title, description, price_cents, stock, status) VALUES (?, ?, ?, ?, ?, ?, 'draft')")
    .run(store.id, cat, t, d || null, price, qty);
  const id = Number(info.lastInsertRowid);
  audit(db, actor.id, 'product.created', `product:${id}`);
  return id;
}

// Edit a product's fields. A rejected product is terminal (no edit). Editing a
// PUBLISHED product's title or price returns it to pending_review (RS-G): the
// change must be re-approved before it is live again.
export function updateProduct(db, actor, productId, { title, description, price_cents, stock } = {}) {
  const { product: p } = ownProduct(db, actor, productId);
  if (p.status === 'rejected') throw new ValidationError('a rejected product cannot be edited');
  const t = title === undefined ? p.title : cleanText(title, { max: MAX_NAME, field: 'title', required: true });
  const d = description === undefined ? p.description : (cleanText(description, { field: 'description' }) || null);
  const price = price_cents === undefined ? p.price_cents : intInRange(price_cents, { min: 0, max: 100_000_000, field: 'price' });
  const qty = stock === undefined ? p.stock : intInRange(stock, { min: 0, max: 1_000_000, field: 'stock' });
  const titleOrPriceChanged = t !== p.title || price !== p.price_cents;
  let status = p.status;
  if (p.status === 'published' && titleOrPriceChanged) {
    transition('product', 'published', 'pending_review');
    status = 'pending_review';
  }
  db.prepare('UPDATE products SET title = ?, description = ?, price_cents = ?, stock = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(t, d, price, qty, status, p.id);
  audit(db, actor.id, 'product.updated', `product:${p.id}`);
  return status;
}

// Submit a draft for admin review. A pending/suspended store CANNOT publish
// (the "pending seller cannot publish" rule) — this is where that is enforced.
export function submitProduct(db, actor, productId) {
  const { store, product: p } = ownProduct(db, actor, productId);
  if (store.status !== 'approved') throw new ValidationError('the store is not approved, so its products cannot be published');
  transition('product', p.status, 'pending_review');
  db.prepare("UPDATE products SET status = 'pending_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(p.id);
  audit(db, actor.id, 'product.submitted', `product:${p.id}`);
}

export function unlistProduct(db, actor, productId) {
  const { product: p } = ownProduct(db, actor, productId);
  transition('product', p.status, 'unlisted');
  db.prepare("UPDATE products SET status = 'unlisted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(p.id);
  audit(db, actor.id, 'product.unlisted', `product:${p.id}`);
}

// ---- Fulfilment (per order item; one order can span several stores) ---------

export function listStoreOrderItems(db, actor) {
  const store = ownStore(db, actor);
  return db
    .prepare(
      `SELECT oi.id, oi.order_id, oi.qty, oi.unit_price_cents, oi.status, p.title,
              o.ship_city, o.ship_country
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         JOIN orders o ON o.id = oi.order_id
        WHERE oi.store_id = ?
        ORDER BY oi.id DESC`,
    )
    .all(store.id);
}

// Move one of the store's order items forward (paid→processing→shipped→delivered)
// or cancel it (from paid/processing). `completed` is the customer's confirmation,
// not a seller action, so it is refused here.
export function advanceFulfilment(db, actor, orderItemId, to) {
  const store = ownStore(db, actor);
  const oi = db.prepare('SELECT * FROM order_items WHERE id = ?').get(parseId(orderItemId));
  if (!oi) throw new NotFoundError('order item not found');
  if (!can(actor.role, 'update_fulfilment', { actor_store_id: store.id, resource_store_id: oi.store_id })) {
    throw new ForbiddenError();
  }
  const SELLER_TARGETS = new Set(['processing', 'shipped', 'delivered', 'cancelled']);
  if (!SELLER_TARGETS.has(to)) throw new ValidationError(`a seller cannot move an item to "${to}"`);
  transition('fulfilment', oi.status, to);
  db.prepare('UPDATE order_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(to, oi.id);
  audit(db, actor.id, `order_item.${to}`, `order_item:${oi.id}`);
  return to;
}

// ---- Store staff ------------------------------------------------------------

export function listStaff(db, actor) {
  const store = ownStore(db, actor);
  return db.prepare("SELECT id, email, role, status FROM users WHERE store_id = ? ORDER BY id").all(store.id);
}

// Promote an existing active customer (by email) to seller_staff of the owner's
// store. No new credential is created — staff reuse their account.
export function addStaff(db, actor, email) {
  const store = ownStore(db, actor);
  if (actor.role !== 'seller_owner') throw new ForbiddenError('only the store owner can manage staff');
  if (!can(actor.role, 'manage_staff', { actor_store_id: store.id, resource_store_id: store.id })) throw new ForbiddenError();
  const e = cleanText(email, { max: 320, field: 'email', required: true }).toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(e);
  if (!u) throw new NotFoundError('no account with that email');
  if (u.status !== 'active') throw new ValidationError('that account is not active');
  if (u.role !== 'customer' || u.store_id) throw new ValidationError('that account cannot be added as staff');
  db.prepare("UPDATE users SET role = 'seller_staff', store_id = ? WHERE id = ?").run(store.id, u.id);
  audit(db, actor.id, 'staff.added', `user:${u.id}`);
  return u.id;
}

export function removeStaff(db, actor, userId) {
  const store = ownStore(db, actor);
  if (actor.role !== 'seller_owner') throw new ForbiddenError('only the store owner can manage staff');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(parseId(userId));
  if (!u || u.store_id !== store.id || u.role !== 'seller_staff') throw new NotFoundError('not a staff member of this store');
  db.prepare("UPDATE users SET role = 'customer', store_id = NULL WHERE id = ?").run(u.id);
  audit(db, actor.id, 'staff.removed', `user:${u.id}`);
}
