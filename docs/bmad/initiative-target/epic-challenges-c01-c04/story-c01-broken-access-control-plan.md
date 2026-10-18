---
title: 'C01 Broken Access Control (cross-store order read)'
type: 'feature'
ticket: '1'
created: '2026-10-18'
status: 'built'
baseline_revision: 'f38d135'
route: 'full'
risk: 'medium'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C01 (OWASP A01, CWE-639) needs a realistic broken-access-control weakness in the shop: a seller can read another store's order. The correct baseline (T-17 seller flows) scopes everything to the caller's store, so the weakness has to be an isolated, build-gated path — present only in the vulnerable build, absent (correct) by default — with an exploit test that proves both.

**Approach:** Add a seller order-detail API `GET /api/seller/orders/:orderNo` keyed by a sequential order number (VM-1NNNNN, migration 0003). One isolated module (`challenges/c01-cross-store-order.mjs`) holds both branches: the fixed branch scopes the lookup to the caller's store (a foreign order is a 404, deny-by-default); the vulnerable branch drops the store check (IDOR) and, on reading a foreign order, emits `shop.cross_store_order_read` (the detection signal). The flag lives in a competitor order's `buyer_note`, a field the support/finance order views never expose (so a C09 solve cannot read it).

## Boundaries & Constraints

**Always:** Default to the fixed (safe) behaviour; activate the weakness only when `VM_CHALLENGE_C01=vulnerable` (or the override map). Keep both branches in the one challenge module. Keep `buyer_note` out of the staff order view.

**Never:** No weakening of the correct seller flow (T-17). No flag value committed to the repo (the exploit asserts a neutral marker; the real flag is injected per instance). No cross-challenge leakage of `buyer_note`.

## I/O & Edge-Case Matrix

| Build | Caller | Request | Result |
|-------|--------|---------|--------|
| fixed | staff.harbor (store 1) | own-store order no | 200 + detail |
| fixed | staff.harbor | Northwind (store 2) order no | 404, no event |
| vulnerable | staff.harbor | Northwind order no | 200 + buyer_note + `shop.cross_store_order_read` |
| either | any | unknown order no | 404 |
| either | support/finance | own order view | never contains buyer_note |

</frozen-after-approval>

## Code Map

- `apps/shop/migrations/0003_order_no_and_buyer_note.sql` — `orders.order_no` (sequential, unique) + `orders.buyer_note`; checkout sets both.
- `apps/shop/src/challenges/mode.mjs` — `isVulnerable(key, overrides, env)`; default fixed.
- `apps/shop/src/challenges/c01-cross-store-order.mjs` — the two branches + the event.
- `apps/shop/src/web/routes-seller.mjs` — `GET /api/seller/orders/:orderNo`; `app.mjs` threads `challenges`/`emit`.
- `apps/shop/src/domain/staff-service.mjs` — `viewOrder` strips `buyer_note`.
- `challenges/tests/c01-cross-store-order/{exploit.mjs,c01.test.mjs}` — exploit + self-test.

## Tasks & Acceptance

- [x] Migration, challenge-mode helper, challenge module, endpoint, buyer_note hiding.
- [x] Exploit test + self-test (pass on vulnerable, fail on fixed, event only on vulnerable).

**Acceptance:** the exploit passes on the vulnerable build and fails (404) on the fixed build; `shop.cross_store_order_read` fires only on the vulnerable build; the support order view never exposes `buyer_note`.

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` — C01 self-test 3/3.
- `node --test "apps/shop/test/**/*.test.mjs"` — whole shop suite 134 pass.
