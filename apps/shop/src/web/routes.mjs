// Customer-flow routes for the shop (T-14, FR-SHP-05). Server-rendered pages
// over the shop service. Correct flow only; weaknesses are later challenge work.
import { authenticate } from '../identity/accounts.mjs';
import { setSession, clearSession, newCsrfToken } from './session.mjs';
import { requireCustomer } from './middleware.mjs';
import * as shop from '../domain/shop-service.mjs';
import * as giftcards from '../challenges/c02-gift-card-codes.mjs';
import { searchCatalog } from '../challenges/c03a-catalog-search.mjs';
import { noteTicketMarkup } from '../challenges/c03b-ticket-xss.mjs';
import { quickRefund, refundStatement } from '../challenges/c04-quick-refund.mjs';

// Map a service error to an HTTP response; rethrow anything unexpected.
function handleError(err, res) {
  if (err instanceof shop.ForbiddenError) return res.status(403).render('message', { title: 'Forbidden', message: err.message });
  if (err instanceof shop.NotFoundError) return res.status(404).render('message', { title: 'Not found', message: err.message });
  if (err instanceof shop.ValidationError) return res.status(400).render('message', { title: 'Cannot do that', message: err.message });
  throw err;
}
// Wrap a handler so service errors become pages, not crashes. async + try/catch
// so a SYNCHRONOUS throw (the db layer is synchronous) is caught too.
const h = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    try { handleError(e, res); } catch (unexpected) { next(unexpected); }
  }
};

// JSON error mapper for the /api endpoints (they must not render HTML pages).
function handleJsonError(err, res) {
  if (err instanceof shop.ForbiddenError) return res.status(403).json({ error: 'forbidden' });
  if (err instanceof shop.NotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof shop.ValidationError) return res.status(400).json({ error: err.message });
  throw err;
}
const hj = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { try { handleJsonError(e, res); } catch (u) { next(u); } }
};

export function registerRoutes(app, db, emit = () => {}, { challenges = {}, getCatalogDb = null } = {}) {
  app.get('/', (_req, res) => res.redirect('/shop'));

  // C03 part A (Injection): product search over the separate read-only catalog
  // store. Anonymous (no account needed). The store is built on first use (and
  // cached) so instance mode does not touch the db before the snapshot is ready.
  let catalogDb = null;
  const catalog = () => (catalogDb ??= (getCatalogDb ? getCatalogDb() : null));
  app.get('/api/products/search', hj((req, res) => {
    const store = catalog();
    const results = store ? searchCatalog(store, req.query.q ?? '', { challenges, emit }) : [];
    res.json({ results });
  }));

  // C02 (Cryptographic Failures): gift-card wallet. Buy a card (simulated
  // payment) and redeem a code. The code-derivation weakness lives entirely in
  // the challenge module; these are thin JSON adapters.
  app.post('/api/wallet/buy', requireCustomer, hj((req, res) => {
    const out = giftcards.buyCard(db, req.user, { amount_cents: req.body?.amount_cents ? Number(req.body.amount_cents) : undefined }, { challenges });
    res.json(out);
  }));
  app.post('/api/wallet/redeem', requireCustomer, hj((req, res) => {
    const out = giftcards.redeem(db, req.user, req.body?.code, { challenges, emit });
    res.json(out);
  }));

  // C04 (Insecure Design): the quick-refund path + its statement. The cumulative
  // invariant lives in the challenge module; these are thin JSON adapters.
  app.post('/api/orders/:id/refunds', requireCustomer, hj((req, res) => {
    const out = quickRefund(db, req.user, req.params.id, { amount: req.body?.amount ? Number(req.body.amount) : undefined, idempotencyKey: req.body?.idempotency_key || undefined }, { challenges, emit });
    res.json(out);
  }));
  app.get('/api/orders/:id/refund-statement', requireCustomer, hj((req, res) => {
    res.json(refundStatement(db, req.user, req.params.id));
  }));

  // Catalogue
  app.get('/shop', h((req, res) => {
    const q = req.query.q ?? '';
    res.render('index', { products: shop.listProducts(db, { q }), q });
  }));
  app.get('/product/:id', h((req, res) => {
    const product = shop.getPublishedProduct(db, req.params.id);
    const reviews = db.prepare("SELECT * FROM reviews WHERE product_id = ? AND status = 'visible' ORDER BY id DESC").all(product.id);
    res.render('product', { product, reviews });
  }));

  // Auth
  app.get('/login', (req, res) => res.render('login', {}));
  app.post('/login', h((req, res) => {
    // Any role may log in; route guards (requireCustomer / requireRole) enforce
    // what each role may reach. A suspended account cannot sign in.
    const user = authenticate(db, req.body.email, req.body.password);
    const active = !!user && user.status === 'active';
    // IF-4 auth.attempt: every login attempt. `result` keeps an unknown
    // credential ('unknown') from a found-but-refused account ('rejected') so the
    // event is not a user-enumeration oracle; no password or email is ever sent.
    emit(
      'auth.attempt',
      { route: 'web', account_id: user ? String(user.id) : 'unknown', result: active ? 'success' : user ? 'rejected' : 'unknown' },
      { user_id: user ? String(user.id) : null },
    );
    if (!active) {
      return res.status(401).render('login', { error: 'Wrong email or password.' });
    }
    // Rotate the CSRF token on login so a pre-auth token cannot be fixed and
    // reused against the authenticated session.
    setSession(res, { uid: user.id, csrf: newCsrfToken() });
    res.redirect('/shop');
  }));
  app.post('/logout', (req, res) => { clearSession(res); res.redirect('/shop'); });

  // Cart
  app.get('/cart', requireCustomer, h((req, res) => res.render('cart', { cart: shop.getCart(db, req.user) })));
  app.post('/cart/add', requireCustomer, h((req, res) => {
    shop.addToCart(db, req.user, req.body.product_id, req.body.qty);
    res.redirect('/cart');
  }));

  // Checkout
  app.post('/checkout', requireCustomer, h((req, res) => {
    const order = shop.checkout(db, req.user, {
      ship: { line1: req.body.line1, city: req.body.city, country: req.body.country },
      card: req.body.card,
    });
    // IF-4 order.paid: an order became paid on the correct checkout path.
    emit('order.paid', { order_id: String(order.id), verified: true, via: 'card' }, { user_id: String(req.user.id) });
    res.redirect(`/orders/${order.id}`);
  }));

  // Orders
  app.get('/orders', requireCustomer, h((req, res) => res.render('orders', { orders: shop.listOrders(db, req.user) })));
  app.get('/orders/:id', requireCustomer, h((req, res) => res.render('order', { order: shop.getOrder(db, req.user, req.params.id) })));

  // Reviews / refunds / disputes / tickets
  app.post('/reviews', requireCustomer, h((req, res) => {
    shop.addReview(db, req.user, req.body.product_id, req.body.rating, req.body.body);
    res.redirect(`/product/${Number(req.body.product_id)}`);
  }));
  app.post('/refunds', requireCustomer, h((req, res) => {
    shop.requestRefund(db, req.user, req.body.order_item_id, req.body.reason);
    res.render('message', { title: 'Refund requested', message: 'Your refund request was submitted.' });
  }));
  app.post('/disputes', requireCustomer, h((req, res) => {
    shop.openDispute(db, req.user, req.body.order_item_id, req.body.reason);
    res.render('message', { title: 'Dispute opened', message: 'Your dispute was opened.' });
  }));
  app.post('/tickets', requireCustomer, h((req, res) => {
    const id = shop.createTicket(db, req.user, req.body.subject, req.body.body);
    // C03 part B signal: a stored ticket message that carries an HTML tag. The
    // message is stored as data in both builds; only the support-console render
    // differs (see the challenge module + staff ticket-detail view).
    noteTicketMarkup(req.body.body, { challenges, emit, ticketId: id, userId: req.user.id });
    res.redirect(`/tickets/${id}`);
  }));
  app.get('/tickets/:id', requireCustomer, h((req, res) => res.render('ticket', { ticket: shop.getTicket(db, req.user, req.params.id) })));
}
