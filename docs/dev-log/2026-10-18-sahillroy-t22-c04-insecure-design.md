# T-22 C04 Insecure Design (refund total beyond the amount paid)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-3-sahil |
| Status | Done |
| Report tag | Sprint 3, epic-challenges-c01-c04 story 5.4 |

## Requirements covered
FR-CHL-05 (C04). Challenge spec C04 + Section 4 (OI-19 resolution).

## Summary (plain language, 3-5 lines)
Built C04: a "quick refund" feature added next to the correct refund model. It checks each request against a per-request limit but, in the vulnerable build, never the running total, so two below-limit refunds on one order sum to more than was paid. When the total passes the amount paid, a goodwill-adjustment ledger row (the flag) appears. The fixed build routes the quick path through the one shared order-level invariant, so the second refund is refused. An exploit test proves both.

## Why
FR-CHL-05 / C04 (insecure design). The flaw is architectural — a second feature written without the shared invariant — which is exactly what the T-18 money model makes visible.

## What was built
- Migration 0005: `refund_ledger` (quick refunds, non-spendable), `goodwill_adjustment` (the sentinel flag row), `sentinel` (the flag reference).
- Shared order-level invariant in money-service (`orderPaidCents`/`orderRefundedCents`/`orderRefundableRemaining`), counting both item refunds and the quick-refund ledger; `approveRefund` now also enforces it.
- `c04-quick-refund.mjs`: the quick path (fixed uses the shared invariant; vulnerable checks only the per-request limit) and the refund statement; `shop.refund_decision` and `shop.refund_invariant_broken` events.
- `POST /api/orders/:id/refunds` and `GET /api/orders/:id/refund-statement`.

## How it works
Quick refunds go to `refund_ledger`. Fixed: `amount <= orderPaid - orderRefunded` (shared with the item path). Vulnerable: only `amount <= per-request limit`. Once `refunded > paid`, the goodwill row is written once with the sentinel reference and the invariant-broken event fires. Idempotency keys stop a double-click from counting twice.

## Files changed
- `apps/shop/migrations/0005_quick_refund_ledger.sql`, `apps/shop/src/challenges/c04-quick-refund.mjs` — new.
- `apps/shop/src/domain/money-service.mjs` — shared order-level invariant + order cap in `approveRefund`.
- `apps/shop/src/web/routes.mjs` — quick-refund + statement routes.
- `challenges/tests/c04-quick-refund/{exploit.mjs,c04.test.mjs}` — new.
- `apps/shop/test/db.test.mjs` — migration count 5.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` — 17 pass (C04 3/3). `node --test "apps/shop/test/**/*.test.mjs"` — 134 pass. The item-refund path still refuses an overshoot (shared invariant), proving the rest of the model stays correct.

## Security notes (vulnerable parts only)
The vulnerable quick path omits the cumulative check (CWE-840), isolated in `c04-quick-refund.mjs`, off by default. The fix is the one shared `orderRefundableRemaining` used by every path. Money goes to the non-spendable `refund_ledger`; the flag only exists once the invariant is broken, and the `sentinel` table is in the shop db (unreadable by C03's separate catalog store).
