# Customer flows (T-14)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 2, customer experience (FR-SHP-05) |

## Requirements covered
FR-SHP-05 (customer: browse, search, cart, checkout with simulated payment, orders, reviews, refund/dispute requests, tickets). BMAD story 3.3 of `epic-shop-core-and-roles`.

## Summary (plain language, 3-5 lines)
Built the running customer experience for the shop: a customer logs in, browses and searches the catalogue, fills a cart, checks out with a simulated payment, tracks orders, reviews purchased items, requests refunds, opens disputes, and creates support tickets. Pages are server-rendered with Nunjucks (auto-escaped), sessions are a signed cookie, and every action is permission-checked, scoped to the acting customer, and drives the T-06 state machines. This is the correct flow only; the C01/C03/C04 weaknesses are added later by the challenge epics.

## Why
FR-SHP-05 is the heart of the shop — without it there is nothing to attack or defend. The seller and money flows (T-17/T-18) and the challenges build on this correct customer journey.

## What was built
- `src/web/session.mjs` — signed-cookie session (HMAC, Node crypto, no dep; HttpOnly, SameSite, Secure).
- `src/web/middleware.mjs` — current-user load, `requireCustomer` (active status), constant-time CSRF check.
- `src/web/views.mjs` + `src/views/*.njk` — Nunjucks (autoescape) and the neutral marketplace templates.
- `src/domain/shop-service.mjs` — cart, atomic checkout (simulated payment + product/stock re-validation + commission), orders, reviews (purchased only), refund/dispute (own item, duplicate-guarded), tickets.
- `src/web/routes.mjs` + `src/app.mjs` + `src/server.mjs` — routes, wiring, and db open/migrate/seed.
- `nunjucks` 3.2.4 dependency; CI app-tests glob widened to `apps/*/test/**`.
- `test/web/customer-flow.test.mjs` — 18 end-to-end cases.

## How it works
`createApp({ db })` mounts the session middleware, body parsing, CSRF check and routes. The service layer holds all correctness: `can()` + per-customer ownership, parameterised SQL, integer-cents money, and `assertTransition` for order status. Checkout runs in a transaction: it records the order and payment, re-validates each product (published + stock) at the current price, decrements stock, records commission, and empties the cart — or records a failed payment and refuses. Output is auto-escaped by Nunjucks.

## Files changed
- `apps/shop/src/web/{session,middleware,views,routes}.mjs`, `src/views/*.njk`, `src/domain/shop-service.mjs` — new.
- `apps/shop/src/app.mjs`, `src/server.mjs`, `package.json`, `pnpm-lock.yaml` — changed.
- `.github/workflows/ci.yml` — app-tests glob widened.
- `apps/shop/test/web/customer-flow.test.mjs` — new.

## Decisions made
Nunjucks (autoescape) for views and a signed-cookie session via Node crypto (both pure JS, no native build) — confirmed by Sahil. Payment is simulated in-process; the mock gateway is T-11. Customer scoping is per-customer ownership; store-scoping and C01's cross-store read are the seller surface (T-15/T-17).

## Tests
Real commands and results:
- `corepack pnpm --filter @vulnmart/shop test` → 72 passed, 0 failed (login, wrong password, browse/search, add-to-cart + merge, atomic checkout with exact commission/stock/cart-empty, failed-card DB state, shipping required, cross-customer 403, purchased-only reviews, duplicate-refund/dispute rejection, tickets, CSRF reject, bad-id 404, SQL-metachar-safe search, auto-escaping, suspended-user refused, unauth redirect).
- `node --test "scripts/*.test.mjs"` → 53 passed. `pnpm install --frozen-lockfile` consistent.
Traceability row FR-SHP-05 updated in `docs/traceability.md`.

## Evidence
Test output above; the e2e test drives the real server over HTTP with a cookie jar.

## Problems met and how they were fixed
A wrapper bug: `Promise.resolve(fn())` let a synchronous throw from the (sync) db layer escape the catch and hit Express's generic 500; fixed with an async try/catch wrapper. The four-lens review then found real correctness gaps — non-atomic checkout, no product/stock re-validation, unlimited refunds, suspended-status not enforced, missing Secure cookie — all fixed with tests. A CI gap (the web test sat below the app-tests glob) was fixed by widening the glob to `apps/*/test/**`.

## Security notes (vulnerable parts only)
This is the correct, hardened flow — no deliberate weakness. Sessions are signed (HttpOnly/SameSite/Secure), CSRF is enforced on every POST with a constant-time compare, output is auto-escaped, SQL is parameterised with LIKE wildcards escaped, money is server-computed, and only `card_last4` is stored. C01 (cross-store read), C03 (XSS/SQLi) and C04 (refund abuse) are added later as isolated paths.

## Limitations and follow-ups
- Login throttling/lockout and security-event emission are deferred to the C09 logging work (design entangled with what C09 logs); the `security_events`/`alerts` tables are ready. See `docs/bmad/initiative-target/deferred-work.md`.
- Payment is in-process; T-11 swaps in the mock gateway.
- Seller/support/finance/admin screens are T-15; seeded challenge accounts are T-16.
