// Staff routes (T-15, FR-SHP-07): support, finance and admin screens. Thin
// adapters over staff-service; the permission matrix (via can()) is the gate,
// and requireRole keeps whole areas role-scoped. Errors become pages.
import { requireRole } from './middleware.mjs';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/shop-service.mjs';
import * as staff from '../domain/staff-service.mjs';
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
const SUPPORT = requireRole('support_agent', 'admin');
const FINANCE = requireRole('finance', 'admin');
const ADMIN = requireRole('admin');
const back = (res, title, message) => res.render('message', { title, message });

export function registerStaffRoutes(app, db) {
  // Support: tickets, disputes, review moderation, order read.
  app.get('/staff/tickets', SUPPORT, h((req, res) => res.render('staff/tickets', { tickets: staff.listTickets(db, req.user) })));
  app.post('/staff/tickets/:id/reply', SUPPORT, h((req, res) => { staff.replyTicket(db, req.user, req.params.id, req.body.body); res.redirect('/staff/tickets'); }));
  app.post('/staff/tickets/:id/assign', SUPPORT, h((req, res) => { staff.assignTicket(db, req.user, req.params.id, req.body.assignee_id); res.redirect('/staff/tickets'); }));
  app.post('/staff/tickets/:id/resolve', SUPPORT, h((req, res) => { staff.resolveTicket(db, req.user, req.params.id); res.redirect('/staff/tickets'); }));

  app.get('/staff/disputes', SUPPORT, h((req, res) => res.render('staff/disputes', { disputes: staff.listDisputes(db, req.user) })));
  app.post('/staff/disputes/:id/move', SUPPORT, h((req, res) => { staff.moveDispute(db, req.user, req.params.id, req.body.to); back(res, 'Dispute updated', `Dispute moved to ${req.body.to}.`); }));

  app.post('/staff/reviews/:id/moderate', SUPPORT, h((req, res) => { staff.moderateReview(db, req.user, req.params.id, req.body.action); back(res, 'Review moderated', `Review ${req.body.action}d.`); }));

  app.get('/staff/order/:id', requireRole('support_agent', 'finance', 'admin'), h((req, res) => res.render('staff/order', { order: staff.viewOrder(db, req.user, req.params.id) })));

  // Support/admin: refund decisions (T-18). Approve (optionally a partial amount),
  // reject, or process an approved refund (which reverses commission in proportion).
  app.get('/staff/refunds', SUPPORT, h((req, res) => res.render('staff/refunds', { refunds: money.listRefunds(db, req.user) })));
  app.post('/staff/refunds/:id/approve', SUPPORT, h((req, res) => { money.approveRefund(db, req.user, req.params.id, { amount: req.body.amount ? Number(req.body.amount) : undefined, idempotencyKey: req.body.idempotency_key || undefined }); res.redirect('/staff/refunds'); }));
  app.post('/staff/refunds/:id/reject', SUPPORT, h((req, res) => { money.rejectRefund(db, req.user, req.params.id); res.redirect('/staff/refunds'); }));
  app.post('/staff/refunds/:id/process', SUPPORT, h((req, res) => { money.processRefund(db, req.user, req.params.id); res.redirect('/staff/refunds'); }));

  // Finance: payouts + commissions, and payout accrual (T-18).
  app.get('/staff/payouts', FINANCE, h((req, res) => res.render('staff/payouts', { payouts: staff.listPayouts(db, req.user), commissions: staff.listCommissions(db, req.user) })));
  app.post('/staff/payouts/accrue', FINANCE, h((req, res) => { money.accruePayout(db, req.user, req.body.store_id, req.body.period); res.redirect('/staff/payouts'); }));
  app.post('/staff/payouts/:id/ready', FINANCE, h((req, res) => { money.markPayoutReady(db, req.user, req.params.id); res.redirect('/staff/payouts'); }));
  app.post('/staff/payouts/:id/approve', FINANCE, h((req, res) => { staff.approvePayout(db, req.user, req.params.id); res.redirect('/staff/payouts'); }));
  app.post('/staff/payouts/:id/hold', ADMIN, h((req, res) => { staff.holdPayout(db, req.user, req.params.id); res.redirect('/staff/payouts'); }));

  // Admin: seller/product approval, users, audit, alerts.
  app.post('/staff/stores/:id/decision', ADMIN, h((req, res) => { staff.approveStore(db, req.user, req.params.id, req.body.decision); back(res, 'Store updated', `Store ${req.body.decision}d.`); }));
  app.post('/staff/products/:id/decision', ADMIN, h((req, res) => { staff.approveProduct(db, req.user, req.params.id, req.body.decision); back(res, 'Product updated', `Product ${req.body.decision}d.`); }));
  app.get('/staff/users', ADMIN, h((req, res) => res.render('staff/users', { users: staff.listUsers(db, req.user) })));
  app.post('/staff/users/:id/status', ADMIN, h((req, res) => { staff.setUserStatus(db, req.user, req.params.id, req.body.status); res.redirect('/staff/users'); }));
  app.get('/staff/audit', ADMIN, h((req, res) => res.render('staff/audit', { rows: staff.viewAuditLog(db, req.user), alerts: staff.viewAlerts(db, req.user) })));
}
