# T-18 Refunds, disputes, commissions and payouts

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-3-sahil |
| Status | Done |
| Report tag | Sprint 3, epic-shop-seller-and-money story 4.2 |

## Requirements covered
FR-SHP-10 (refunds, commissions, payouts). Epic Done-when 2 and 3.

## Summary (plain language, 3-5 lines)
Built the correct after-sale money model: a refund can be approved (by the store's seller up to a limit, or by support/admin for any amount), rejected, and then processed. Processing reverses the platform commission in proportion to the refunded amount. Payouts accrue per store with net = gross − commission (net of reversals) − refunds deducted, so the seller bears refunds. The invariant throughout: the refunded total for an item can never exceed what was paid for it.

## Why
FR-SHP-10 was unmet — checkout recorded commissions and finance could approve payouts, but nothing approved/processed refunds, reversed commission, or accrued payouts. C04 (a refund beyond the amount paid) also needs this correct baseline to break meaningfully.

## What was built
- `approveRefund(amount, idempotencyKey)` — requested→approved, amount clamped by "paid − already refunded"; seller only for own store and under `SELLER_REFUND_LIMIT_CENTS` ($500 default); an idempotency key makes a retry a no-op.
- `rejectRefund` — requested→rejected (frees the refundable amount again).
- `processRefund` — approved→processed; reverses commission `round(commission × amount / paid)` into the append-only `commission_reversals` ledger; idempotent.
- `accruePayout(store, period)` / `markPayoutReady` — net = gross − commission(net of reversals) − refunds_deducted; starts `accrued`, then the existing finance approve/hold flow applies.
- Web screens: staff refunds + payout accrual, seller own-store refund approval.

## How it works
Migration 0002 adds `refunds.idempotency_key` (partial unique index) and the append-only `commission_reversals` table (the `commissions` CHECK forbids a negative row, so a reversal is a separate additive entry that accrual nets out). The service enforces the refunded-total ≤ paid invariant in one place (`refundableRemaining`), used by both the customer request guard (T-14) and approval here.

## Files changed
- `apps/shop/migrations/0002_refund_money_model.sql` — new.
- `apps/shop/src/domain/money-service.mjs` — new.
- `apps/shop/src/web/routes-staff.mjs`, `routes-seller.mjs` — refund + payout routes.
- `apps/shop/src/views/staff/refunds.njk`, `views/staff/payouts.njk`, `views/seller/dashboard.njk`.
- `apps/shop/test/money-service.test.mjs`, `apps/shop/test/web/money-flow.test.mjs`, `apps/shop/test/db.test.mjs` (migration count).

## Decisions made
- Commission reversal is a separate append-only ledger, not a negative `commissions` row (keeps the non-negative CHECK and gives an audit trail).
- Processing (real payout movement) is staff/finance only; a seller can only approve within its limit. This separation is also what C04 later subverts.

## Tests
`node --test "apps/shop/test/**/*.test.mjs"` — 134 pass, 0 fail (123 before; +8 money-service, +3 money web, db migration-count test updated). Cases: partial reversal arithmetic (40 on 400/1000@10%), the paid-cap invariant, seller limit + cross-store 403, idempotent approve/process, reject frees the amount, payout net 540 = 1000 − 60 − 400, full refund nets 0.

## Evidence
Test output under `docs/assets/t18-money-model/` (with the sprint PR verification).

## Problems met and how they were fixed
The money-service tests first failed on a `audit_log` foreign key because the support/finance test actors were fake ids; fixed by creating real users with `createUser`.

## Security notes (vulnerable parts only)
None — correct flow only. The refunded-total ≤ paid invariant is exactly what C04 (Insecure Design, epic 5) will deliberately bypass in an isolated path; the baseline here must hold so that break is visible.
