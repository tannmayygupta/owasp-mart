# T-17 Seller flows

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-3-sahil |
| Status | Done |
| Report tag | Sprint 3, epic-shop-seller-and-money story 4.1 |

## Requirements covered
FR-SHP-06 (seller flows). Epic Done-when 1 ("a seller registers a store, waits for approval, creates products and fulfils orders; a pending seller can edit the profile but not publish").

## Summary (plain language, 3-5 lines)
Built the seller's own side of the marketplace: a logged-in customer registers a store (it starts pending), an admin approves it (T-15), and the seller then creates products, submits them for review, fulfils the orders placed against the store, and manages store staff. A pending store can edit its profile and draft products but cannot submit anything for publishing. Everything is scoped to the seller's own store.

## Why
FR-SHP-06 was the only unmet shop requirement with customer (T-14) and staff (T-15) already done. The seller side is also the host for later seller-path challenges (C10 import, C11 KYC), so the correct flow has to exist first for those weaknesses to stand out as weaknesses.

## What was built
- Store registration: a customer becomes a `seller_owner` with a `pending` store.
- Store profile edit (owner only; allowed while pending).
- Products: create draft, edit (editing a published title/price returns it to `pending_review`), submit for review (refused unless the store is approved), unlist.
- Fulfilment: advance an own-store order item paid→processing→shipped→delivered, or cancel from paid/processing. `completed` is the customer's confirmation, not a seller move.
- Staff: the owner promotes an existing customer (by email) to `seller_staff` and can remove them.

## How it works
A new domain service `seller-service.mjs` over the existing T-06 schema (`stores`, `products`, `order_items`) and state machines (`seller_approval`, `product`, `fulfilment`). Every action goes through one `ownStore(db, actor)` gate and the RS-G permission matrix (`create_edit_product`, `update_fulfilment`, `manage_staff`, all `own_store`), so "own store only" is enforced in one place. Web screens in `routes-seller.mjs` + `views/seller/*` are thin adapters; `requireRole` keeps the whole `/seller` area to the two seller roles, and the registration screen is open to a logged-in customer.

## Files changed
- `apps/shop/src/domain/seller-service.mjs` — new; the service.
- `apps/shop/src/web/routes-seller.mjs` — new; `/seller/...` screens.
- `apps/shop/src/views/seller/{register,dashboard,staff}.njk` — new.
- `apps/shop/src/app.mjs` — register the seller routes.
- `apps/shop/test/seller-service.test.mjs`, `apps/shop/test/web/seller-flow.test.mjs` — new.

## Decisions made
- Staff are promoted from existing accounts rather than created with a new password, so this story adds no password-hashing path (that is identity's, P-12/T-07).
- "Pending cannot publish" is enforced at `submitProduct` (store must be `approved`), not by blocking draft creation — matching the epic Done-when ("can edit the profile but not publish").

## Tests
`node --test "apps/shop/test/**/*.test.mjs"` — 123 pass, 0 fail (108 before; +12 seller-service, +3 seller web journey). The web test drives the whole journey register→approve→create→submit→publish→buy→fulfil and asserts the item reaches `delivered`; a pending store's submit returns 400; `/seller` is 403 for a plain customer.

## Evidence
Test output under `docs/assets/t17-seller-flows/` (added with the sprint PR verification).

## Problems met and how they were fixed
`registerStore` first hit the role gate for an existing owner, returning a confusing 403; reordered so an account that already has a store gets the clear "already has a store" 400.

## Security notes (vulnerable parts only)
None — correct flow only. The seller-path weaknesses (C10 import SSRF, C11 KYC fail-open) are isolated paths in epics 6/7.
