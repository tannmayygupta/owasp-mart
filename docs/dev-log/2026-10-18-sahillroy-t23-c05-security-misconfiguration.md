# T-23 C05 Security Misconfiguration (unauthenticated diagnostics page)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-3-sahil |
| Status | Done |
| Report tag | Sprint 3, epic-challenges-c05-c08 story 6.1 |

## Requirements covered
FR-CHL-06 (C05). Challenge spec C05.

## Summary (plain language, 3-5 lines)
Built C05: in the vulnerable build the shop ships an operations console (`/_ops/`, `/_ops/diagnostics`) with no login and a verbose error handler. Breaking a request on purpose returns a stack trace that names an internal `_ops` file, and the unauthenticated diagnostics page prints a synthetic config object whose "support bridge token" is the flag. The fixed (default) build 404s the debug routes and returns a generic error with a correlation id. An exploit test proves both.

## Why
FR-CHL-06 / C05. Shipping debug routes and verbose errors is the classic misconfiguration; gating it keeps the default build hardened.

## What was built
- `registerOpsRoutes` (mounted before the CSRF middleware, since the console is anonymous and the verbose-error probe posts raw JSON): `GET /_ops/`, `GET /_ops/diagnostics`, and `POST /api/cart`.
- Vulnerable: `/_ops/*` serve a hand-built synthetic diagnostics object (the flag is its `support_bridge_token`), broken JSON on `/api/cart` returns a leaking stack trace. Events `shop.verbose_error` + `ops.page_served`.
- Fixed: `/_ops/*` 404; broken JSON returns `{ error, correlation_id }` with no internals.

## How it works
`buildDiagnostics` returns only synthetic constants plus the one injected flag value (from the `sentinel` table) — never `process.env`, a db URL, a session secret or the instance key, per the host-safety rule. The `isVulnerable('C05')` check is the only branch; the default is fixed.

## Files changed
- `apps/shop/src/challenges/c05-ops-console.mjs` — new.
- `apps/shop/src/app.mjs` — `registerOpsRoutes` before `checkCsrf`.
- `challenges/tests/c05-security-misconfig/{exploit.mjs,c05.test.mjs}` — new.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` — 19 pass (C05 2/2). `node --test "apps/shop/test/**/*.test.mjs"` — 134 pass.

## Security notes (vulnerable parts only)
The vulnerable build ships a debug console + verbose errors (CWE-489/209), isolated in `c05-ops-console.mjs`, off by default. The diagnostics object is synthetic — no real secret, no environment, no db URL — so it cannot hand another challenge its flag. Fix: no debug routes in the fixed build, generic errors with a correlation id.
