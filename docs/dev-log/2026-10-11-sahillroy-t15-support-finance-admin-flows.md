# Support, finance and admin flows (T-15)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 2, staff experience (FR-SHP-07) |

## Requirements covered
FR-SHP-07 (staff: support handles tickets/disputes/review moderation, finance approves payouts and sees commissions with amounts-only order views, admin approves sellers/products, manages users, resolves escalated disputes, reads the audit log and alerts). BMAD story 3.4 of `epic-shop-core-and-roles`.

## Summary (plain language, 3-5 lines)
Built the running staff experience over the T-06 model, reusing the T-14 session/Nunjucks/CSRF layer. A support agent handles tickets (reply/assign/resolve), moves disputes through their state machine and moderates reviews; finance approves payouts, sees commissions and reads orders with personal data redacted (amounts only); an admin approves sellers and products, manages user status, resolves escalated disputes and reads the audit log and alerts. Every screen is gated by the RS-G 1.2 permission matrix via `can()`, every whole area is role-scoped by `requireRole`, every mutation writes an audit row, and status changes drive the T-06 state machines. Correct flow only; the C05 diagnostics and C09 logging-gap weaknesses are later challenge work.

## Why
FR-SHP-07 completes the role coverage the shop needs: the customer journey (T-14) has no counterpart staff until support/finance/admin can act. The money and seller flows and several challenges (C02/C05/C08/C09) build on these correct staff screens and the audit log they populate.

## What was built
- `src/domain/staff-service.mjs` — the staff domain layer: `requireCan` (matrix via `can()`), `audit`, a `transition` helper that maps an illegal T-06 move to a 400; order view (finance redacted), tickets, disputes, review moderation, payouts/commissions, seller/product approval, user status, audit log and alerts.
- `src/web/routes-staff.mjs` — thin adapters; `requireRole` area guards (`SUPPORT`, `FINANCE`, `ADMIN`) ahead of the service-layer `can()` gate; errors become pages.
- `src/web/middleware.mjs` — new `requireRole(...roles)` (active status + role in set).
- `src/web/routes.mjs` — `/login` now admits any **active** account (route guards enforce role); a suspended account is refused a session.
- `src/views/staff/*.njk` — tickets, disputes, order, payouts, users, audit templates.
- `src/app.mjs` — mounts `registerStaffRoutes`.
- `test/web/staff-flow.test.mjs` — end-to-end staff cases.

## How it works
`requireRole` rejects a request unless `req.user` is active and in the allowed set, so a whole `/staff/*` area is role-scoped before the handler runs; `loadUser` re-reads the row each request, so suspending an account cuts off a live session on its next request. The service layer re-checks the matrix with `can(role, action)` and performs the action: reads/writes are parameterised, money stays integer-cents, and status changes go through `assertTransition` on the correct T-06 machine (dispute, payout, seller_approval, product), mapped to a 400 on an illegal move. Finance order views key off `requiresRedaction` and strip the shipping snapshot and `customer_id`; support/admin see the full row. Each mutation writes an `audit_log` row attributed to the acting staff user.

## Files changed
- `apps/shop/src/domain/staff-service.mjs`, `src/web/routes-staff.mjs`, `src/views/staff/*.njk`, `test/web/staff-flow.test.mjs` — new.
- `apps/shop/src/web/middleware.mjs` (`requireRole`), `src/web/routes.mjs` (`/login` active-status gate), `src/app.mjs` (mount staff routes) — changed.

## Decisions made
Enforcement is defence-in-depth: `requireRole` area guards in front of the matrix `can()` check in the service. The matrix is applied exactly as RS-G 1.2 states (e.g. support resolves any dispute, including escalated — the matrix encodes no escalated/non-escalated split; the admin simply also can). Tickets and reviews have no T-06 machine, so their status changes are plain updates; the five statuses that do have machines go through `assertTransition`. The thin audit log (no IP/UA) is deliberate — enriching it is the C09 challenge.

## Tests
Real commands and results:
- `node --test "apps/shop/test/**/*.test.mjs"` → **79 passed, 0 failed** (72 prior + the staff suite). Staff cases cover: support handles tickets/disputes/reviews and sees the un-redacted order; a ticket assigns to staff but **not** to a customer (400); finance approves a payout, sees commissions and gets an amounts-only order (address redacted); admin approves a seller and product, manages user status, and **resolves an escalated dispute**; a customer, and support/finance reaching admin-only areas, are 403; an illegal dispute transition is 400; a **suspended staff user is refused mid-session** and a **suspended account cannot sign in**; audit rows are written and attributed to the acting admin.
- Traceability row FR-SHP-07 updated in `docs/traceability.md`.

## Evidence
Test output above; the e2e tests drive the real server over HTTP with a per-role cookie jar and assert both DB state and rendered pages.

## Problems met and how they were fixed
Two failures surfaced during the build: an illegal dispute transition threw a plain `Error` → 500 instead of 400 (fixed with the `transition()` helper mapping `assertTransition` errors to `ValidationError`); and the staff suite logged a seeded customer in with the wrong password (fixed with a dedicated `cust@vm.test` fixture). The four-lens review then converged on one correctness gap and a thin test surface: `assignTicket` accepted **any** user id as assignee (a customer or suspended user) — fixed to require a support/admin assignee with a test; and every DENY in the suite was caught by the route guard, never the matrix, with the suspended-account gates, the redaction complement and audit attribution all unverified and the admin test's "resolve an escalated dispute" comment never actually exercised — all closed with new assertions and tests.

## Security notes (vulnerable parts only)
This is the correct, hardened staff flow — no deliberate weakness. Role areas are guarded twice (route + matrix), sessions remain signed and CSRF-protected, suspension takes effect on the next request, personal data is redacted for finance, and every mutation is audited. The review's defence-in-depth notes (the service `can()` is called with an empty ctx — safe only because every staff matrix cell in scope is unscoped `true`/`amounts_only`) and the deliberate omissions (thin audit log = C09; no self/last-admin suspend guard; tickets without a state machine) are recorded in the story's Code Review section and `deferred-work.md`, not fixed here. C05 (diagnostic over-sharing) and C09 (logging gaps) are added later as isolated paths.

## Limitations and follow-ups
- `assignTicket` and `holdPayout` endpoints exist and are gated but have no UI control yet (reachable by direct POST); the UI buttons arrive with the richer staff screens.
- No self-suspend / last-admin guard on `setUserStatus` — out of FR-SHP-07 scope; tracked in `docs/bmad/initiative-target/deferred-work.md`.
- Seeded challenge accounts are T-16.
