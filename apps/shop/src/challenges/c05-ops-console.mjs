// C05 — Security Misconfiguration (OWASP 2021 A05 / 2025 A02), CWE-489/209.
//
// Two misconfigurations shipped to the vulnerable build:
//   (1) an operations console left mounted with NO login — `/_ops/` and
//       `/_ops/diagnostics` — whose diagnostics page prints a hand-built
//       synthetic config object containing a "support bridge token" (the flag);
//   (2) a verbose error handler on `POST /api/cart`: broken JSON yields a stack
//       trace that names an internal route file under `_ops`.
//
//   FIXED (default): `/_ops/*` is 404, and a broken request gets a GENERIC error
//     with a correlation id and no internals.
//
// The diagnostics object is HAND-BUILT from synthetic values only — never
// process.env, a database URL, a session secret, the instance key or dependency
// versions (host-safety rule; no overlap with C06/C10/C11). Fix: don't ship debug
// routes; management endpoints on a separate port; generic errors; no secrets in
// dumps; a release hardening checklist.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { isVulnerable } from './mode.mjs';

// A hand-built, synthetic diagnostics object. The only sensitive-looking value is
// the support-bridge token, which is the C05 flag (from the sentinel seed); the
// rest are harmless constants. Nothing is read from the environment or the db
// beyond that one injected flag value.
function buildDiagnostics(db) {
  const token = db.prepare("SELECT value FROM sentinel WHERE key = 'c05'").get()?.value ?? 'C05-OPS-FLAG-MARKER';
  return {
    service: 'vulnmart-shop',
    status: 'ok',
    uptime_s: 1234,
    feature_flags: { seasonal_banner: true, new_checkout: false },
    cache: { backend: 'in-memory', entries: 0 },
    support_bridge_token: token, // the flag — synthetic, injected
  };
}

export function registerOpsRoutes(app, db, { challenges = {}, emit = () => {} } = {}) {
  const vulnerable = () => isVulnerable('C05', challenges);
  const clientClass = (req) => (req.user ? 'authenticated' : 'anonymous'); // never "internal" from the player side

  // The verbose-error endpoint. Raw JSON body; broken JSON triggers the handler.
  app.post('/api/cart', express.text({ type: '*/*', limit: '16kb' }), (req, res) => {
    let parsed;
    try {
      parsed = JSON.parse(req.body || '');
    } catch {
      if (vulnerable()) {
        emit('shop.verbose_error', { route: '/api/cart', handler: 'c05_api' });
        // Verbose trace that leaks an internal route file path under _ops.
        return res.status(500).json({
          error: 'SyntaxError: Unexpected token in JSON',
          stack: [
            'SyntaxError: Unexpected token in JSON at position 0',
            '    at JSON.parse (<anonymous>)',
            '    at /app/apps/shop/src/challenges/c05-ops-console.mjs:1:1',
            '    at /app/apps/shop/src/_ops/diagnostics-route.mjs:1:1',
          ].join('\n'),
        });
      }
      // FIXED: a generic error with a correlation id, no internals.
      return res.status(400).json({ error: 'invalid request', correlation_id: randomUUID() });
    }
    return res.json({ ok: true, items: Array.isArray(parsed?.items) ? parsed.items.length : 0 });
  });

  // The ops console. Present only in the vulnerable build; 404 otherwise.
  const opsPage = (path, body) => (req, res) => {
    if (!vulnerable()) return res.status(404).json({ error: 'not found' });
    emit('ops.page_served', { path, client_class: clientClass(req) });
    res.json(body(req, res));
  };
  app.get('/_ops/', opsPage('/_ops/', () => ({ console: 'operations', links: ['/_ops/diagnostics'] })));
  app.get('/_ops/diagnostics', opsPage('/_ops/diagnostics', () => buildDiagnostics(db)));
}
