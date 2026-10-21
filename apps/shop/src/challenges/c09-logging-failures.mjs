// C09 — Logging and Alerting Failures (OWASP 2021/2025 A09), CWE-778/223/307.
//
// The shop has a web login that logs every attempt and locks an account after a
// threshold, and a LEGACY mobile login that — in the vulnerable build — is missing
// from that pipeline entirely: no security event, no lockout, no rate limit. So a
// slow brute force against the dormant support agent on the legacy route is
// invisible to the shop's security log and never locks the account; the obtained
// session then reads the break-glass reference (the flag) in the support case notes.
//
//   FIXED (default): the legacy route uses the SAME auth pipeline as the web login
//     (every attempt written as a security event, lockout after the threshold).
//   VULNERABLE (VM_CHALLENGE_C09=vulnerable): the legacy route skips the pipeline.
//
// Fix: one shared auth service for all channels, log every authentication event,
// alert on thresholds, a test that every route emits events, retire legacy APIs.
import { authenticate } from '../identity/accounts.mjs';
import { setSession, newCsrfToken } from '../web/session.mjs';
import { isVulnerable } from './mode.mjs';

const LOCK_THRESHOLD = 5;

function recentFailures(db, userId) {
  return db.prepare("SELECT COUNT(*) AS c FROM security_events WHERE account_id = ? AND kind = 'login_failed' AND created_at >= datetime('now', '-5 minutes')").get(userId).c;
}
export function isLocked(db, userId) {
  return userId != null && recentFailures(db, userId) >= LOCK_THRESHOLD;
}

// Write the security event for an auth attempt to the shop's OWN security log
// (the `security_events` table), raise an alert on the threshold, and post the
// matching IF-4 platform event `shop.security_event_written` (account_id and
// kind only). That event is what the platform's C09 M2 rule (a negative
// observation) counts: the vulnerable legacy route never reaches this function, so
// "attack happened, nothing logged" shows as zero of these events for the account,
// while the fixed build (and the web login) post one per attempt.
export function recordSecurityEvent(db, { userId = null, kind, route, emit = () => {} }) {
  const info = db.prepare('INSERT INTO security_events (account_id, kind, detail) VALUES (?, ?, ?)').run(userId, kind, `route:${route}`);
  // account_id is the account the attempt named, or `unknown` for an email that has no account (the platform event has no null)
  emit('shop.security_event_written', { account_id: userId == null ? 'unknown' : String(userId), kind }, { user_id: userId == null ? null : String(userId) });
  return Number(info.lastInsertRowid);
}

// One authentication attempt: `login_success` or `login_failed` (an attempt at an unknown email is a failure with no account). The threshold alert is raised on the failure
// that reaches it.
export function recordAuth(db, { userId, success, route, emit = () => {} }) {
  const eventId = recordSecurityEvent(db, { userId, kind: success ? 'login_success' : 'login_failed', route, emit });
  if (!success && userId != null && recentFailures(db, userId) >= LOCK_THRESHOLD) {
    db.prepare("INSERT INTO alerts (security_event_id, kind) VALUES (?, 'brute_force')").run(eventId);
  }
}
// The break-glass reference in the support case notes — the C09 flag (sentinel).
export function caseNoteReference(db) {
  return db.prepare("SELECT value FROM sentinel WHERE key = 'c09'").get()?.value ?? 'C09-CASENOTE-FLAG-MARKER';
}

// The legacy mobile login route. Mounted before checkCsrf (an API the app calls).
// `express` is passed so the route can parse its JSON body (the global middleware
// is urlencoded only).
export function registerLegacyLoginRoute(app, db, express, { challenges = {}, emit = () => {} } = {}) {
  app.post('/m/api/v1/login', express.json({ type: '*/*', limit: '8kb' }), (req, res) => {
    const email = req.body?.email;
    const found = email ? db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(String(email).toLowerCase()) : null;
    const vuln = isVulnerable('C09', challenges);

    // FIXED only: the lockout applies to the legacy route too.
    if (!vuln && isLocked(db, found?.id)) {
      emit('auth.attempt', { route: 'legacy', account_id: found ? String(found.id) : 'unknown', result: 'locked' });
      recordSecurityEvent(db, { userId: found?.id, kind: 'login_locked', route: 'legacy', emit });
      return res.status(429).json({ error: 'account temporarily locked' });
    }
    const user = authenticate(db, email, req.body?.password);
    const active = !!user && user.status === 'active';
    emit('auth.attempt', { route: 'legacy', account_id: found ? String(found.id) : 'unknown', result: active ? 'success' : 'failure' }); // the platform's rule for C09 reads `failure` and `success` on the legacy route
    // The ONE difference: the vulnerable build skips the security pipeline here.
    if (!vuln) recordAuth(db, { userId: found?.id, success: active, route: 'legacy', emit });

    if (!active) return res.status(401).json({ error: 'invalid credentials' });
    setSession(res, { uid: user.id, csrf: newCsrfToken() });
    return res.json({ ok: true });
  });
}
