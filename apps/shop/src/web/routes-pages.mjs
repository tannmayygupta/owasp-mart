// The pages a learner works from. The shop's weaknesses are reached through what a shopper, a seller or a visitor can actually see and click: a wallet for gift cards,
// the order list and order detail of a seller, a pay step that waits for the payment provider, a forgotten-password flow, a contact page, a note on the mobile app,
// and customer sign-up. Each page is a thin view; the behaviour (and the weakness) stays in the challenge modules and the services.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUser, DuplicateEmailError } from '../identity/accounts.mjs';
import { setSession, newCsrfToken } from './session.mjs';
import { requireCustomer, requireRole } from './middleware.mjs';
import { NotFoundError, ValidationError, ForbiddenError } from '../domain/shop-service.mjs';
import * as seller from '../domain/seller-service.mjs';
import { createPendingOrder } from '../challenges/c08-payment-webhook.mjs';

const SELLER = requireRole('seller_owner', 'seller_staff');
const SCRIPT = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'shop.js'), 'utf8');

const page = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof ForbiddenError) return res.status(403).render('message', { title: 'Forbidden', message: e.message });
    if (e instanceof NotFoundError) return res.status(404).render('message', { title: 'Not found', message: e.message });
    if (e instanceof ValidationError) return res.status(400).render('message', { title: 'Cannot do that', message: e.message });
    next(e);
  }
};

export function registerPageRoutes(app, db) {
  app.get('/assets/shop.js', (_req, res) => res.type('application/javascript').send(SCRIPT));

  // ---- customer sign-up (a shopper makes their own account) ----
  app.get('/register', (req, res) => res.render('register', {}));
  app.post('/register', page((req, res) => {
    const email = String(req.body.email ?? '').trim();
    const password = String(req.body.password ?? '');
    const fail = (error) => res.status(400).render('register', { error, email });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter a valid email address.');
    if (password.length < 8) return fail('Use a password of at least 8 characters.');
    let user;
    try { user = createUser(db, { email, password, role: 'customer' }); } catch (e) {
      if (e instanceof DuplicateEmailError) return fail('That email already has an account. Log in instead.');
      throw e;
    }
    setSession(res, { uid: user.id, csrf: newCsrfToken() });
    res.redirect('/shop');
  }));

  // ---- C02: the gift-card wallet ----
  app.get('/wallet', requireCustomer, page((req, res) => {
    const credit = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM promo_credit WHERE user_id = ?').get(req.user.id).c;
    const cards = db.prepare('SELECT serial, amount_cents, status FROM gift_cards WHERE owner_user_id = ? ORDER BY serial').all(req.user.id);
    res.render('wallet', { credit, cards });
  }));

  // ---- C01: a seller's orders, and one order ----
  app.get('/seller/orders', SELLER, page((req, res) => res.render('seller/orders', { orders: seller.listStoreOrders(db, req.user) })));
  app.get('/seller/orders/:orderNo', SELLER, page((req, res) => res.render('seller/order', { orderNo: String(req.params.orderNo).slice(0, 40) })));

  // ---- C08: pay through the payment provider. The order waits for the provider's notification. ----
  app.post('/pay/start', requireCustomer, page((req, res) => {
    const order = createPendingOrder(db, req.user, { ship: { line1: req.body.line1, city: req.body.city, country: req.body.country } });
    res.redirect(`/pay/${order.order_id}`);
  }));
  app.get('/pay/:id', requireCustomer, page((req, res) => {
    const order = db.prepare('SELECT id, order_no, status, total_cents, customer_id FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) throw new NotFoundError('order not found');
    if (order.customer_id !== req.user.id) throw new ForbiddenError('not your order');
    res.render('pay', { order });
  }));

  // ---- C07: forgotten password; public pages ----
  app.get('/forgot', (req, res) => res.render('forgot', {}));
  app.get('/contact', (req, res) => res.render('contact', {}));
  // ---- C09: the mobile app note ----
  app.get('/app', (req, res) => res.render('app', {}));
}
