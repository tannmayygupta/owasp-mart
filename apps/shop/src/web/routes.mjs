// Customer-flow routes for the shop (T-14, FR-SHP-05). Server-rendered pages
// over the shop service. Correct flow only; weaknesses are later challenge work.
import { authenticate } from '../identity/accounts.mjs';
import { setSession, clearSession } from './session.mjs';
import { requireCustomer } from './middleware.mjs';
import * as shop from '../domain/shop-service.mjs';

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

export function registerRoutes(app, db, emit = () => {}) {
  app.get('/', (_req, res) => res.redirect('/shop'));

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
    setSession(res, { uid: user.id, csrf: req.session.csrf });
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
    res.redirect(`/tickets/${id}`);
  }));
  app.get('/tickets/:id', requireCustomer, h((req, res) => res.render('ticket', { ticket: shop.getTicket(db, req.user, req.params.id) })));
}
