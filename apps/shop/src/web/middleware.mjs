// Web middleware for the shop (T-14): load the current user from the session,
// guard customer-only routes, and check a CSRF token on state-changing posts.
import { timingSafeEqual } from 'node:crypto';
import { getSession, setSession, newCsrfToken } from './session.mjs';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Attach req.user (the row, or null) and req.session, ensuring a CSRF token.
export function loadUser(db) {
  return (req, res, next) => {
    const session = getSession(req) ?? {};
    if (!session.csrf) {
      session.csrf = newCsrfToken();
      setSession(res, session);
    }
    req.session = session;
    req.user = session.uid
      ? db.prepare('SELECT id, email, role, store_id, status FROM users WHERE id = ?').get(session.uid) ?? null
      : null;
    res.locals = res.locals || {};
    res.locals.user = req.user;
    res.locals.csrf = session.csrf;
    next();
  };
}

// Require a logged-in, active customer; otherwise redirect or refuse.
export function requireCustomer(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.status !== 'active') {
    return res.status(403).render('message', { title: 'Account suspended', message: 'This account cannot be used.' });
  }
  if (req.user.role !== 'customer') {
    return res.status(403).render('message', { title: 'Forbidden', message: 'Customers only.' });
  }
  next();
}

// Reject a POST whose form CSRF token does not match the session token
// (constant-time compare, matching the cookie-signature check).
export function checkCsrf(req, res, next) {
  if (req.method === 'POST' && !safeEqual(req.body?.csrf, req.session?.csrf)) {
    return res.status(403).render('message', { title: 'Bad request', message: 'Invalid or missing form token.' });
  }
  next();
}
