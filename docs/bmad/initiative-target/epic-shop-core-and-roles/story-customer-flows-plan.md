---
title: 'Customer flows'
type: 'feature'
ticket: '3'
created: '2026-10-11'
status: 'draft'
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

