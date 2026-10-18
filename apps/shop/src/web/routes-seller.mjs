// Seller routes (T-17, FR-SHP-06): the seller's own screens. Thin adapters over
// seller-service; the permission matrix (own_store, via can()) is the real gate,
// and requireRole keeps the whole /seller area to the two seller roles. The
// registration screen is open to a logged-in customer (becoming a seller).
import { requireRole } from './middleware.mjs';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/shop-service.mjs';
import * as seller from '../domain/seller-service.mjs';
import * as money from '../domain/money-service.mjs';

function handleError(err, res) {
  if (err instanceof ForbiddenError) return res.status(403).render('message', { title: 'Forbidden', message: err.message });
  if (err instanceof NotFoundError) return res.status(404).render('message', { title: 'Not found', message: err.message });
  if (err instanceof ValidationError) return res.status(400).render('message', { title: 'Cannot do that', message: err.message });
  throw err;
}
const h = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { try { handleError(e, res); } catch (u) { next(u); } }
};
const SELLER = requireRole('seller_owner', 'seller_staff');
const OWNER = requireRole('seller_owner');
const back = (res, title, message) => res.render('message', { title, message });

export function registerSellerRoutes(app, db) {
  // Registration: a logged-in customer (or storeless user) becomes a seller.
  app.get('/seller/register', requireRole('customer', 'seller_owner'), h((req, res) => res.render('seller/register', {})));
  app.post('/seller/register', requireRole('customer', 'seller_owner'), h((req, res) => {
    seller.registerStore(db, req.user, { name: req.body.name, kyc_text: req.body.kyc_text });
    back(res, 'Store registered', 'Your store is pending admin approval. You can edit its profile and draft products while you wait, but cannot publish until it is approved.');
  }));

  // Dashboard: the store, its products, its order items and its refund requests.
  app.get('/seller', SELLER, h((req, res) => res.render('seller/dashboard', {
    store: seller.getMyStore(db, req.user),
    products: seller.listMyProducts(db, req.user),
    items: seller.listStoreOrderItems(db, req.user),
    refunds: money.listRefunds(db, req.user),
  })));

  // Refunds: a seller may approve (up to its limit) or reject refunds on its own
  // store (T-18). Processing the payout is staff/finance only.
  app.post('/seller/refunds/:id/approve', SELLER, h((req, res) => {
    money.approveRefund(db, req.user, req.params.id, { amount: req.body.amount ? Number(req.body.amount) : undefined });
    res.redirect('/seller');
  }));
  app.post('/seller/refunds/:id/reject', SELLER, h((req, res) => { money.rejectRefund(db, req.user, req.params.id); res.redirect('/seller'); }));

  // Store profile (owner only).
  app.post('/seller/store', OWNER, h((req, res) => {
    seller.updateStoreProfile(db, req.user, { name: req.body.name, kyc_text: req.body.kyc_text });
    res.redirect('/seller');
  }));

  // Products.
  app.post('/seller/products', SELLER, h((req, res) => {
    seller.createProduct(db, req.user, req.body);
    res.redirect('/seller');
  }));
  app.post('/seller/products/:id', SELLER, h((req, res) => {
    seller.updateProduct(db, req.user, req.params.id, req.body);
    res.redirect('/seller');
  }));
  app.post('/seller/products/:id/submit', SELLER, h((req, res) => {
    seller.submitProduct(db, req.user, req.params.id);
    back(res, 'Submitted', 'The product is pending admin review.');
  }));
  app.post('/seller/products/:id/unlist', SELLER, h((req, res) => {
    seller.unlistProduct(db, req.user, req.params.id);
    res.redirect('/seller');
  }));

  // Fulfilment.
  app.post('/seller/items/:id/fulfil', SELLER, h((req, res) => {
    seller.advanceFulfilment(db, req.user, req.params.id, req.body.to);
    res.redirect('/seller');
  }));

  // Staff (owner only).
  app.get('/seller/staff', OWNER, h((req, res) => res.render('seller/staff', { staff: seller.listStaff(db, req.user) })));
  app.post('/seller/staff', OWNER, h((req, res) => { seller.addStaff(db, req.user, req.body.email); res.redirect('/seller/staff'); }));
  app.post('/seller/staff/:id/remove', OWNER, h((req, res) => { seller.removeStaff(db, req.user, req.params.id); res.redirect('/seller/staff'); }));
}
