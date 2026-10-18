---
title: 'Refunds, disputes, commissions and payouts'
type: 'feature'
ticket: '2'
created: '2026-10-18'
status: 'done'
baseline_revision: 'eb12043'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/prd/PRD.md'
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Checkout records commissions (T-14) and finance can approve/hold payouts (T-15), but the after-sale money model does not exist: there is no path to approve/reject/process a refund, no proportional commission reversal, no payout accrual, and nothing enforcing that refunds cannot exceed what was paid. FR-SHP-10 is unmet, and C04 (Insecure Design — a refund beyond the amount paid) has no correct baseline to break.

**Approach:** A money-model domain service (`money-service.mjs`) implementing the CORRECT flow: a refund is approved (by a seller for its own store up to a limit, or by support/admin without a cap) for an amount capped by the invariant **refunded total ≤ amount paid**; processing an approved refund reverses the platform commission **in proportion** (`reversed = round(commission × amount / item_paid)`) into an append-only `commission_reversals` ledger; payouts accrue per store and period with `net = gross − commission(net of reversals) − refunds_deducted` (the seller bears refunds). Refunds carry an optional idempotency key so a retried approval/processing never pays out or reverses twice.

## Boundaries & Constraints

**Always:** Enforce refunded-total ≤ paid on every approval; reverse commission strictly in proportion; keep the reversal ledger append-only; gate seller refund approval to own store and under `SELLER_REFUND_LIMIT_CENTS`; keep processing (real payout movement) to support/finance/admin.

**Never:** No negative commission rows (the CHECK forbids it — reversals are a separate ledger). No refund that makes the running total exceed the amount paid (that is the C04 weakness, a later isolated path). No change to the customer's `requestRefund` guards (T-14) or the finance approve/hold flow (T-15) beyond adding accrual and the ready transition.

## I/O & Edge-Case Matrix

| Action | Who | Rule |
|--------|-----|------|
| approveRefund(amount) | seller_owner/staff own store, support, admin | requested→approved; amount ≤ paid − already refunded; seller only ≤ limit; idempotency key makes a retry a no-op |
| rejectRefund | same | requested→rejected; frees the refundable amount |
| processRefund | support, finance, admin | approved→processed; reverse commission in proportion; idempotent |
| accruePayout(store, period) | finance, admin | net = gross − commission(net of reversals) − refunds_deducted; refresh while accrued/ready |
| markPayoutReady | finance, admin | accrued→ready |
| approve above paid | anyone | refused |
| approve above limit | seller | refused (support/admin may) |
| approve/reject another store's refund | seller | 403 |

</frozen-after-approval>

## Code Map

- `apps/shop/migrations/0002_refund_money_model.sql` — new; `refunds.idempotency_key` (+ partial unique index) and the append-only `commission_reversals` ledger.
- `apps/shop/src/domain/money-service.mjs` — new; the money model above.
- `apps/shop/src/web/routes-staff.mjs` — refund approve/reject/process, payout accrue/ready (finance/support).
- `apps/shop/src/web/routes-seller.mjs` — own-store refund approve/reject (under limit).
- `apps/shop/src/views/staff/refunds.njk`, `views/staff/payouts.njk`, `views/seller/dashboard.njk` — screens.
- `apps/shop/test/money-service.test.mjs`, `apps/shop/test/web/money-flow.test.mjs` — new.

## Tasks & Acceptance

**Execution:**
- [ ] Migration 0002.
- [ ] `money-service.mjs` (approve/reject/process, accrual, listRefunds, refundableRemaining).
- [ ] Routes + views; unit + web tests.

**Acceptance Criteria:**
- A partial refund reverses commission in proportion and the payout net matches `gross − commission − refunds_deducted`.
- The refunded total for an item can never exceed the amount paid.
- A retried approval/processing under one idempotency key does not pay out or reverse twice.

## Verification

**Commands:**
- `node --test "apps/shop/test/**/*.test.mjs"` — whole shop suite passes (134), including money-service (8) and money web flow (3).
