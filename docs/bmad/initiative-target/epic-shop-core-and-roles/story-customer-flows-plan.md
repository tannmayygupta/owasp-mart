---
title: 'Customer flows'
type: 'feature'
ticket: '3'
created: '2026-10-11'
status: built
baseline_revision: '65b162f'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/docs/research/RS-G-shop-domain.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The shop has a data model, identity/permissions and a seeded world, but no running customer experience (FR-SHP-05). A customer must be able to complete the whole journey in a fresh instance: log in, browse and search, fill a cart, check out with simulated payment, track orders, review purchased items, request a refund, open a dispute, and create a support ticket.

**Approach:** Add server-rendered pages and routes to the Express app over the T-06 model, T-07 identity/permissions and T-08 seed. Introduce the session layer here (deferred from T-07): a signed cookie session and login/logout. Build the customer routes as the CORRECT flow (store-scoped, permission-checked, auto-escaped output); the deliberate weaknesses (C01 cross-store read, C03 XSS/SQLi, C04 refund abuse, etc.) are added later by the challenge epics as isolated paths, not here. Payment is simulated in-process now; the real mock-gateway container is T-11.

## Boundaries & Constraints

**Always:** Every customer action goes through `permissions.can()` and is scoped to the acting customer (own cart, own orders). Output is auto-escaped (correct flow — no stored/reflected XSS here). Money stays integer cents. State changes use the T-06 state machines (`assertTransition`). Reviews allowed only on purchased items; refund/dispute only on own orders. Keep everything in `apps/shop/`.

**Never:** No deliberate vulnerabilities (cross-store reads, injection, refund-beyond-paid, verbose errors) — those are the challenge epics. No seller/finance/admin screens (T-15) or seller/money flows (epic-shop-seller-and-money). No real card data (AC: simulated). No real mock-services container (T-11). No password-reset flow (that is C07).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Login | seeded customer email + password | session cookie set; redirect to the shop | bad creds → 401 page, no enumeration |
| Browse / search | query string | published products only, store-scoped visibility | empty query → all published |
| Add to cart | product id, qty | own cart updated (one line per product) | unknown/ unpublished product → 404 |
| Checkout | own cart with items | order created `payment_pending`, payment simulated → `paid`, items `paid` | empty cart → blocked |
| View order | own order id | the order and its items | another customer's order → 403/404 (correct flow) |
| Review | purchased product | review stored (one per product per user) | not purchased → blocked |
| Request refund | own order item | refund `requested` via the refund machine | not own → blocked |
| Open dispute | own order item | dispute `open` | not own → blocked |
| Create ticket | subject + body | ticket `open` + first message | unauthenticated → login |


## Decision (Sahil, 2026-10-11)

Views render with **Nunjucks** (autoescape on) — RS-G's recommendation, pure JS (no native build). Sessions are a **signed cookie** using Node's `crypto` HMAC (no dependency). Payment is simulated in-process (the mock-services gateway is T-11).

## Code Map

- `apps/shop/package.json` -- add `nunjucks` (pinned); `express` already present.
- `apps/shop/src/web/session.mjs` -- new; signed-cookie session (HMAC), `getSession`/`setSession`/`clearSession`, CSRF token helper.
- `apps/shop/src/web/views.mjs` -- new; configure the Nunjucks environment (autoescape, templates dir, `BRANDING`).
- `apps/shop/src/views/*.njk` -- new; `layout.njk`, `index.njk` (browse+search), `product.njk`, `cart.njk`, `checkout.njk`, `order.njk`, `orders.njk`, `login.njk`, `ticket.njk`, `message.njk`.
- `apps/shop/src/web/middleware.mjs` -- new; load the session user, a `requireCustomer` guard, CSRF check on POST.
- `apps/shop/src/web/routes/{auth,catalog,cart,checkout,orders,support}.mjs` -- new; the customer routes.
- `apps/shop/src/domain/shop-service.mjs` -- new; cart, checkout (order + simulated payment + commission + fulfilment state), reviews, refund/dispute requests, tickets, over the T-06 db using `state-machines` and `permissions`.
- `apps/shop/src/app.mjs` -- mount session, views and the customer routes alongside the health endpoints.
- `apps/shop/src/server.mjs` -- open the db (migrate + seed in dev) and pass it to `createApp`.
- `apps/shop/test/web/customer-flow.test.mjs` -- new; the whole-flow test over a seeded in-memory db.

## Tasks & Acceptance

**Execution:**
- [ ] `session.mjs` + `middleware.mjs` -- signed-cookie session, current-user load, `requireCustomer`, CSRF.
- [ ] `views.mjs` + `src/views/*.njk` -- Nunjucks env and the neutral templates.
- [ ] `shop-service.mjs` -- cart/checkout/review/refund/dispute/ticket logic on the db, scoped by `can()` and driven by the state machines.
- [ ] `routes/*.mjs` + `app.mjs` + `server.mjs` -- wire routes, session, views; open the db.
- [ ] `nunjucks` dep in package.json.
- [ ] `test/web/customer-flow.test.mjs` -- end-to-end customer journey + the deny cases.

**Acceptance Criteria:**
- Given a seeded customer, when they log in, browse/search, add a product, check out with simulated payment, then view the order, then it is `paid` with items `paid` and a commission recorded.
- Given a purchased product, when the customer reviews it, then the review is stored; a non-purchaser is refused.
- Given an own order item, when the customer requests a refund or opens a dispute, then it is created via the refund/dispute state machine; another customer's item is refused (403/404).
- Given a customer, when they create a ticket, then it and its first message exist; an unauthenticated request is redirected to login.
- Given any rendered page, when inspected, then user content is auto-escaped (no raw injection in the correct flow) and `x-powered-by` is absent.

## Implementation Notes

- 2026-10-11: Added the customer web layer over T-06/T-07/T-08 — signed-cookie session (`web/session.mjs`, Node crypto, Secure+HttpOnly+SameSite), middleware (user load, `requireCustomer` with active-status + CSRF constant-time), Nunjucks views (autoescape) with neutral templates, the `shop-service` domain layer (cart, atomic checkout with product/stock re-validation + simulated payment + commission, orders, reviews, refund/dispute with duplicate guards, tickets), routes, and `app.mjs`/`server.mjs` wiring. `nunjucks` 3.2.4 pinned; the CI app-tests glob widened to `apps/*/test/**` to run the web test.
- Results: `corepack pnpm --filter @vulnmart/shop test` → 72 passed, 0 failed; scripts 53; frozen installs consistent.

## Plan Change Log

- 2026-10-11 (review loop): applied 12 patches, 1 defer, 1 clarify. The big ones: checkout is now atomic (transaction) with product-publish/price and stock re-validation + stock decrement, server-side shipping requirement, and duplicate-refund/dispute guards; suspended customers are refused; non-numeric ids give 404 not 500; LIKE wildcards escaped; session cookie `Secure` + constant-time CSRF. Tests grew to 72 (exact commission, cart-empty, add-twice, bad-card DB state, stock, dup-refund, bad-id 404, SQL-metachar-safe search, suspended-blocked). Deferred login throttling/lockout to the C09 logging work. Clarified that customer scoping is per-customer ownership; store-scoping + C01 cross-store read are the seller surface (T-15/T-17).

## Code Review

### 2026-10-11 — 12 patch, 1 defer, 1 clarify

- [x] [Review][Patch] Checkout is not atomic — a throw mid-sequence leaves a half-order (payment recorded, items partial, cart not cleared); wrap the order→payment→items→commissions→stock→cart-clear in one transaction (failed-card path commits the failed record then throws) [shop-service.mjs]
- [x] [Review][Patch] Products are not re-validated at checkout — an unpublished or repriced product is still bought at the stale price; re-fetch each product in the transaction, require `published`, and use the current price [shop-service.mjs]
- [x] [Review][Patch] Stock is never checked or decremented — unlimited oversell; verify `stock >= qty` and decrement in the transaction [shop-service.mjs]
- [x] [Review][Patch] Shipping address is not required server-side — an order can reach `paid` with null shipping; require line1/city/country [shop-service.mjs]
- [x] [Review][Patch] No duplicate guard on refunds/disputes — a customer can pile up unlimited rows per item; reject when an active refund/open dispute already exists [shop-service.mjs]
- [x] [Review][Patch] `user.status` is loaded but never enforced — a suspended customer keeps full access; `requireCustomer` must require `status === 'active'` [middleware.mjs]
- [x] [Review][Patch] Non-numeric path/body ids throw a 500 (NaN bound to a statement); validate ids to positive integers → 404/400 [shop-service.mjs]
- [x] [Review][Patch] LIKE wildcards in search are not escaped (`%`/`_` act as wildcards); add an ESCAPE clause and escape them [shop-service.mjs]
- [x] [Review][Patch] Cart-clear uses an unbounded scalar subquery; delete by the `cart.id` checkout already has [shop-service.mjs]
- [x] [Review][Patch] Session cookie is missing `Secure`; set it (env-gated for local HTTP dev) [session.mjs]
- [x] [Review][Patch] CSRF compare is not constant-time; use `timingSafeEqual` [middleware.mjs]
- [x] [Review][Patch] Strengthen the e2e tests: exact commission (400c) + a commissions row; cart empty after checkout; add-same-product-twice sums qty; bad-card leaves `payment_failed` + failed payment; stock decremented; duplicate refund rejected; unpublished-at-checkout rejected; shipping required; bad id → 404; search with SQL metacharacters is safe; suspended user blocked [test/web/customer-flow.test.mjs]
- [x] [Review][Defer] No login throttling/lockout or security-event emission on `/login` [routes.mjs] — deferred: the attempt-logging and lockout model is entangled with C09 (what gets logged) and C07 (reset); design it alongside the C09 logging story. The `security_events`/`alerts` tables are ready.
- [x] [Review][Clarify] "store-scoped" in the boundary — for the CUSTOMER experience the correct baseline is per-customer ownership (own cart/orders/items/tickets), which is what the code does; store-scoping is the SELLER surface (T-15/T-17), and C01's cross-store read is a seller-surface weakness added there. No code change; the boundary wording is clarified here.

## Review Triage Log

## Design Notes

The correct flow only: every action is `can()`-checked and scoped to the acting customer, output is auto-escaped, money is integer cents, and status changes go through `assertTransition`. The deliberate weaknesses (C01 cross-store read, C03 XSS/SQLi, C04 refund abuse) are added later by the challenge epics as isolated paths. The simulated payment always succeeds for a well-formed card and records a `payments` row + per-item `commission`; T-11 swaps in the mock gateway. Sessions are signed (tamper-evident) but not encrypted; they carry only the user id.

## Verification

**Commands:**
- `corepack pnpm --filter @vulnmart/shop test` -- expected: the customer-flow tests pass with the suite.
- `corepack pnpm --filter @vulnmart/shop run snapshot` then start the shop and click the flow -- manual smoke (optional).
