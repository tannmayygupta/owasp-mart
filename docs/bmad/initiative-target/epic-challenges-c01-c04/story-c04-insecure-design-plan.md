---
title: 'C04 Insecure Design (refund total beyond the amount paid)'
type: 'feature'
ticket: '4'
created: '2026-10-18'
status: 'built'
baseline_revision: 'b3673f3'
route: 'full'
risk: 'medium'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C04 (OWASP A04, CWE-840) is a design flaw: a second refund feature ("quick refund") added beside the correct T-18 model, with its own per-request limit but no cumulative check, so repeating it pushes an order's refunded total past the amount paid.

**Approach:** A quick-refund path `POST /api/orders/:id/refunds`. The fixed (default) build routes through the one shared order-level invariant (`money.orderRefundableRemaining`, which counts both item refunds and the quick-refund ledger); the vulnerable build checks only the per-request limit. When the total passes the amount paid (vulnerable only), a `goodwill_adjustment` row is written (its `reference` is the flag, read from the `sentinel` table) and `shop.refund_invariant_broken` fires. Quick refunds go to the non-spendable `refund_ledger`.

## Boundaries & Constraints

**Always:** Default to fixed. The item-refund path (T-18) also enforces the shared order-level invariant, so the rest of the money model stays correct. Only a delivered order (customers cannot self-deliver) can be quick-refunded. Idempotency keys stop a double-click from counting twice.

**Never:** No real flag committed (neutral marker in tests). No spendable credit. No change to the correct refund model other than adding the shared order-level check.

## I/O & Edge-Case Matrix

| Build | Input | Result |
|-------|-------|--------|
| vulnerable | two 1500 refunds on a 2500 order | both 200; refunded 3000 > paid; goodwill flag + `shop.refund_invariant_broken` |
| fixed | same | first 200, second 4xx (cumulative cap); no goodwill |
| either | amount ≤ 0 / non-integer | 400 |
| either | amount > per-request limit | 400 (`shop.refund_decision` refused) |
| either | order not delivered / not owned | 400 / 403 |
| either | item refund that would exceed order paid | refused (shared invariant) |

</frozen-after-approval>

## Code Map

- `apps/shop/migrations/0005_quick_refund_ledger.sql` — `refund_ledger`, `goodwill_adjustment`, `sentinel`.
- `apps/shop/src/domain/money-service.mjs` — `orderPaidCents`/`orderRefundedCents`/`orderRefundableRemaining`; `approveRefund` now also checks the order-level cap.
- `apps/shop/src/challenges/c04-quick-refund.mjs` — the quick path (both branches) + statement.
- `apps/shop/src/web/routes.mjs` — `POST /api/orders/:id/refunds`, `GET /api/orders/:id/refund-statement`.
- `challenges/tests/c04-quick-refund/{exploit.mjs,c04.test.mjs}`.

## Tasks & Acceptance

- [x] Migration, shared invariant, quick-refund module, routes, exploit + self-test.

**Acceptance:** two below-limit quick refunds over-refund on the vulnerable build (goodwill flag + event) and the second is refused on the fixed build; item refunds still refuse an overshoot; bad amounts refused.

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` — C04 3/3.
- `node --test "apps/shop/test/**/*.test.mjs"` — shop suite 134 pass.
