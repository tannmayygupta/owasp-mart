// C07 — Authentication Failures (OWASP 2021 A07 / 2025 A07), CWE-307/640.
//
// The shop's password-reset flow. This module owns the two places the correct and
// the deliberately-weak behaviour diverge; the finance settlement page (where the
// flag sits) is a normal finance-only page, reachable only after taking over the
// finance account through this flow.
//
//   FIXED (default): a 128-bit single-use token (hashed at rest), a generic
//     response whether or not the account exists, and an attempt limit per token
//     (and the token dies when it is hit) — so the code cannot be guessed and the
//     flow does not reveal which addresses have accounts.
//   VULNERABLE (VM_CHALLENGE_C07=vulnerable): a 4-digit code, NO attempt limit, and
//     a response that differs for "no such account" vs "code sent" (user
//     enumeration) — so the code is brute-forced (10 000 tries) and the finance
//     account is taken over.
//
// The reset code is never returned by any route; the "email" goes to the internal
// mailbox, readable only by the test-only API under VM_TEST. Fix: 128-bit token,
// hashed at rest, attempt limits, generic responses, notify the owner, end
// sessions after reset. See the challenge spec.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash as hashPassword } from '../identity/password.mjs';
import { ValidationError } from '../domain/shop-service.mjs';
import { isVulnerable } from './mode.mjs';

const RESET_TTL_MS = 15 * 60 * 1000;
const FIXED_ATTEMPT_LIMIT = 5;

function codeHash(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}
function hashEq(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function accountRole(user) {
  return user ? user.role : null;
}

// Request a reset for `email`. Returns a response object; in the vulnerable build
// the response distinguishes a missing account (enumeration), in the fixed build
// it is always the same generic answer.
export function requestReset(db, email, { challenges = {}, emit = () => {} } = {}) {
  const e = String(email ?? '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(e);
  const vuln = isVulnerable('C07', challenges);

  if (user) {
    const code = vuln ? String(randomInt(0, 10000)).padStart(4, '0') : randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + RESET_TTL_MS).toISOString();
    db.prepare('INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, ?)').run(user.id, codeHash(code), expires);
    db.prepare('INSERT INTO mailbox (to_email, subject, body) VALUES (?, ?, ?)').run(e, 'Reset your VulnMart password', `Your reset ${vuln ? 'code' : 'token'} is: ${code}`);
    emit('auth.reset_requested', { account_role: accountRole(user), route: 'web' });
  }

  if (vuln) {
    // VULNERABLE: the response reveals whether the account exists.
    return user ? { sent: true, message: 'A 4-digit reset code was sent.' } : { sent: false, message: 'No account with that email.' };
  }
  // FIXED: identical generic response either way.
  return { sent: true, message: 'If that account exists, a reset link has been sent.' };
}

// Confirm a reset with the code/token and a new password. In the vulnerable build
// there is no attempt limit (the 4-digit code is brute-forceable); in the fixed
// build the token dies after FIXED_ATTEMPT_LIMIT wrong tries.
export function confirmReset(db, email, code, newPassword, { challenges = {}, emit = () => {} } = {}) {
  const e = String(email ?? '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(e);
  const vuln = isVulnerable('C07', challenges);
  // A generic failure that leaks nothing about which step failed.
  const fail = () => { throw new ValidationError('invalid or expired reset code'); };

  if (!user) return fail();
  const reset = db.prepare("SELECT * FROM password_resets WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1").get(user.id);
  if (!reset) return fail();
  if (Date.parse(reset.expires_at) < Date.now()) return fail();

  if (!vuln && reset.attempts >= FIXED_ATTEMPT_LIMIT) {
    // FIXED: the token is dead after too many tries.
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(reset.id);
    return fail();
  }

  const ok = hashEq(codeHash(code), reset.code_hash);
  if (!ok) {
    db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?').run(reset.id);
    // Failures are logged normally and batched (never the silent C09 signal).
    emit('auth.reset_confirm_batch', { account_role: accountRole(user), result: 'failed' });
    return fail();
  }

  if (!newPassword || String(newPassword).length < 8) throw new ValidationError('the new password is too short');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(newPassword)), user.id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(reset.id);
  // Fixed build also ends other sessions; the shop's session cookie is stateless,
  // so that is represented by the completion event the platform acts on.
  emit('auth.password_reset_completed', { account_role: accountRole(user) });
  return { reset: true };
}

// The settlement reference shown only on the finance settings page — the C07 flag
// (from the sentinel seed). Not gated: the challenge is getting a finance session.
export function financeSettlementReference(db) {
  return db.prepare("SELECT value FROM sentinel WHERE key = 'c07'").get()?.value ?? 'C07-SETTLEMENT-FLAG-MARKER';
}

// Test-only: the latest mail for an address (the sandbox mailbox). Guarded by the
// caller (VM_TEST); never mounted for players.
export function readMailbox(db, email) {
  return db.prepare('SELECT to_email, subject, body, created_at FROM mailbox WHERE lower(to_email) = ? ORDER BY id DESC LIMIT 1').get(String(email ?? '').toLowerCase()) ?? null;
}

// The anonymous reset endpoints + the test-only mailbox. Mounted before the CSRF
// middleware (pre-auth API, like a real password-reset flow). The mailbox route
// exists only when VM_TEST=1 and is never reachable by players.
export function registerAuthResetRoutes(app, db, { challenges = {}, emit = () => {} } = {}) {
  const bad = (res, err) => res.status(400).json({ error: err instanceof ValidationError ? err.message : 'bad request' });
  app.post('/auth/forgot', (req, res) => {
    try { res.json(requestReset(db, req.body?.email, { challenges, emit })); }
    catch (e) { bad(res, e); }
  });
  app.post('/auth/reset/confirm', (req, res) => {
    try { res.json(confirmReset(db, req.body?.email, req.body?.code, req.body?.password, { challenges, emit })); }
    catch (e) { bad(res, e); }
  });
  if (process.env.VM_TEST === '1') {
    app.get('/test/mailbox', (req, res) => res.json(readMailbox(db, req.query.email) ?? {}));
  }
}
