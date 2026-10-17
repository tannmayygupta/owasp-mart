---
title: 'Support, finance and admin flows'
type: 'feature'
ticket: '4'
created: '2026-10-11'
status: 'done'
baseline_revision: '38eaa45'
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

**Problem:** The customer flows exist (T-14) but the staff roles have no screens (FR-SHP-07): a support agent cannot handle tickets, disputes or moderate reviews; finance cannot approve payouts or see commissions; the admin cannot approve sellers/products, resolve escalated disputes, manage users, or read the audit log and alerts.

**Approach:** Add a staff service and server-rendered staff screens over the T-06 model, gated by the RS-G 1.2 permission matrix via `can()`, reusing T-14's session/Nunjucks/CSRF. Each staff mutation writes an `audit_log` row. The correct flow only, with each role scoped exactly as the matrix says; the deliberate weaknesses (C05 diagnostics, C09 logging gaps) are later challenge work.

## Boundaries & Constraints

**Always:** Every staff action goes through `can(role, action, ctx)` with the RS-G matrix; finance order/commission views are redacted (`requiresRedaction`); status changes use the T-06 state machines (`assertTransition`); mutations write an `audit_log` row. Reuse the T-14 web layer. Stay in `apps/shop/`.

**Never:** No seller/money business logic beyond reading payouts and approving/holding them (the payout/commission model is T-18); no diagnostics page (C05) or logging weaknesses (C09); no new deliberate gaps. No customer-flow changes.

## I/O & Edge-Case Matrix

| Scenario | Role | Expected |
|----------|------|----------|
| View any order | support | allowed (full) |
| View order (amounts only) | finance | allowed, personal data redacted |
| View a customer's order | admin | allowed |
| Reply/assign/resolve ticket | support, admin | allowed; customer/finance denied |
| Resolve dispute | support (open→resolved), admin (escalated) | allowed; others denied |
| Moderate review (remove/restore) | support, admin | allowed; customer may only report |
| Approve/hold payout | finance approves, admin holds | allowed; support/customer denied |
| Approve seller store / product | admin | allowed; others denied |
| Manage users (suspend/activate) | admin | allowed; others denied |
| Read audit log + alerts | admin | allowed; others denied |
| Any staff mutation | — | writes an audit_log row |

</frozen-after-approval>

## Code Map

- `apps/shop/src/domain/staff-service.mjs` -- new; the staff actions, each `can()`-checked, with an `audit()` helper writing `audit_log`, over orders/tickets/disputes/reviews/payouts/stores/products/users.
- `apps/shop/src/web/middleware.mjs` -- add `requireRole(...roles)` (active, role in the set).
- `apps/shop/src/web/routes-staff.mjs` -- new; the staff routes (`/staff/...`).
- `apps/shop/src/views/staff/*.njk` -- new; queue/list screens for tickets, disputes, reviews, orders, payouts, users, audit.
- `apps/shop/src/app.mjs` -- mount the staff routes.
- `apps/shop/test/web/staff-flow.test.mjs` -- new; each role's matrix behaviour (allow + deny) and the audit trail.

## Tasks & Acceptance

**Execution:**
- [ ] `staff-service.mjs` -- support (tickets/disputes/reviews + order read), finance (payouts/commissions redacted), admin (seller/product approval, escalated disputes, users, audit/alerts), each matrix-checked, writing audit rows.
- [ ] `middleware.mjs` `requireRole` + `routes-staff.mjs` + `src/views/staff/*.njk` + `app.mjs` wiring.
- [ ] `test/web/staff-flow.test.mjs` -- per-role allow/deny and audit assertions.

**Acceptance Criteria:**
- Given each staff role, when it performs a matrix-allowed action, then it succeeds; when it attempts an action the matrix denies, then it is refused (403) — proven per role.
- Given finance viewing an order, when rendered, then personal data (names/addresses) is redacted.
- Given any staff mutation, when done, then an `audit_log` row records actor, action and target.
- Given a dispute, when support resolves `open`/`under_review` and admin resolves `escalated`, then the dispute state machine advances; an illegal transition is rejected.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-11 — four-lens review (blind/authz, verification-gap, intent-alignment; Opus)

The review confirmed the authorization is sound: route `requireRole` guards and the service `can()` checks are mutually consistent for every endpoint, no role reaches a matrix-forbidden action, no IDOR (every staff cell is unscoped), finance redaction is real and complete (strips the shipping snapshot + `customer_id`), and mutations are audited and attributed. The diff faithfully implements the matrix-literal reading of the intent.

**Fixed:**
- `assignTicket` accepted **any** existing user id as assignee (a customer or suspended user), not just a ticket-worker. Now requires the assignee to be `support_agent` or `admin` (400 otherwise), with a test.
- Test surface was thin: every DENY was caught by the route guard (never the matrix), the suspended-account gates were unverified, redaction was tested only for finance, audit `actor_id`/`target` were never asserted, and the admin test's "resolve an escalated dispute" comment never actually did so. Added: support sees the un-redacted order; assign-to-customer rejected; support/finance denied admin-only areas; finance denied admin-only hold; admin escalates and resolves a dispute; a suspended staff user is refused mid-session; a suspended account cannot sign in; audit row attributed to the acting admin. Suite now 79 tests.

**Acknowledged, not fixed (intended / out of scope for "correct flow only"):**
- Service `can(role, action, {})` is called with an empty ctx, so scoped rules would resolve to deny; safe today because every staff-reachable matrix cell is unscoped `true`/`amounts_only`. Defence-in-depth behind `requireRole`; revisit if a staff action ever gains a scoped rule.
- Tickets/reviews have no T-06 state machine, so their status changes are plain updates (the intent says use machines where they exist); `transition()` maps any `assertTransition` throw to 400, and user-supplied ids map to 404 — both consistent with the T-14 shop-service choices.
- `setUserStatus` has no self-suspend / last-admin guard (availability, out of FR-SHP-07 scope) — tracked in `deferred-work.md`.
- `assignTicket`/`holdPayout` endpoints have no UI control yet (reachable by direct POST); the thin audit log (no IP/UA) is the deliberate C09 gap.

## Design Notes

The matrix decision stays in `permissions.can()`; staff-service is the enforcement + audit surface, and routes are thin (like T-14). Finance redaction uses `requiresRedaction('finance','view_order')`. Payout approval/hold moves `payouts.status` via the payout state machine; the amounts themselves come from T-18, so this story only transitions and reads them.

## Verification

**Commands:**
- `corepack pnpm --filter @vulnmart/shop test` -- expected: the staff-flow tests pass with the suite.
