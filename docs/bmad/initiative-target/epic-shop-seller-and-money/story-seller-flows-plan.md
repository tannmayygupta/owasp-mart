---
title: 'Seller flows'
type: 'feature'
ticket: '1'
created: '2026-10-18'
status: 'done'
baseline_revision: '276ac89'
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

**Problem:** The marketplace has customer flows (T-14) and staff flows (T-15: admin can approve a store/product, finance can pay out), but the seller's own side does not exist. A seller cannot register a store, create and submit products, fulfil the orders placed against their store, or manage their store staff. FR-SHP-06 is unmet and the later challenges that live in seller paths (C10 import, C11 KYC) have nothing to attach to.

**Approach:** Add a seller-flow domain service (`seller-service.mjs`) and its web screens (`/seller/...`), built on the existing T-06 schema (`stores`, `products`, `order_items`, the `seller_approval`, `product` and `fulfilment` state machines) and gated by the existing RS-G permission matrix (`create_edit_product`, `update_fulfilment`, `manage_staff`, all `own_store`). Correct flow only: the store starts `pending` and an admin (T-15) approves it; a pending store may edit its profile and draft products but may **not** submit a product for review or fulfil. No deliberate weaknesses — the C10/C11 seller-path challenges are isolated paths added in epic 6/7.

## Boundaries & Constraints

**Always:** Scope every seller action to the actor's own store via `can(role, 'action', { actor_store_id, resource_store_id })`; drive store/product/fulfilment status through the T-06 state machines; audit store/product/staff mutations; keep money (commission reversal, payouts, refund approval that debits a seller) for T-18.

**Never:** No cross-store read or write. No publishing from a pending/suspended store. No new password-hashing path (staff are promoted from existing accounts). No changes to the staff-side approval functions (T-15) or the permission matrix.

## I/O & Edge-Case Matrix

| Action | Who | Precondition | Result |
|--------|-----|--------------|--------|
| register store | logged-in user, no store | role customer or storeless seller_owner | store `pending`, actor becomes `seller_owner` with `store_id` |
| edit store profile | seller_owner | own store, any status | name/kyc updated |
| create product | seller_owner/staff | own store | product `draft` |
| edit product | seller_owner/staff | own store, not rejected | fields updated; a published product → `pending_review` |
| submit product | seller_owner/staff | own store **approved**, product draft | product `pending_review` |
| submit product | seller_owner/staff | own store **pending** | 400 "store is not approved" (pending cannot publish) |
| unlist product | seller_owner/staff | own store, product published | product `unlisted` |
| list store order items | seller_owner/staff | — | only own-store items |
| advance fulfilment | seller_owner/staff | own store, legal transition | paid→processing→shipped→delivered; cancel from paid/processing |
| add staff | seller_owner | existing active customer by email | that user becomes `seller_staff` of the store |
| remove staff | seller_owner | staff of own store | reverts to `customer`, store_id cleared |
| any of the above on another store | anyone | resource_store_id ≠ actor_store_id | 403 |

</frozen-after-approval>

## Code Map

- `apps/shop/src/domain/seller-service.mjs` — new; all seller actions above.
- `apps/shop/src/web/routes-seller.mjs` — new; `/seller/...` screens, thin adapters.
- `apps/shop/src/web/views/seller/*.njk` — new; dashboard, product form, orders, staff.
- `apps/shop/src/app.mjs` — register the seller routes (mounted like staff routes).
- `apps/shop/test/seller-service.test.mjs` — new; unit tests for every row above.
- `apps/shop/test/web/seller-flow.test.mjs` — new; the end-to-end seller journey over HTTP.

## Tasks & Acceptance

**Execution:**
- [ ] `seller-service.mjs` — register/profile, product CRUD + submit/unlist, fulfilment, staff.
- [ ] `routes-seller.mjs` + views; mount in `app.mjs`.
- [ ] Unit + web tests.

**Acceptance Criteria:**
- A seller registers a store (pending), an admin approves it (T-15), the seller creates a product, submits it, the admin publishes it, a customer buys it, and the seller fulfils the order item through to delivered.
- A pending seller can edit its profile and draft products but cannot submit a product for review (400) — "a pending seller cannot publish".
- Every seller action on another store is refused (403); every list shows only the own store's rows.

## Verification

**Commands:**
- `node --test "apps/shop/test/**/*.test.mjs"` — the whole shop suite passes, including the new seller tests.
