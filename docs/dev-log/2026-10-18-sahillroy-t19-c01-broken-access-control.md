# T-19 C01 Broken Access Control (cross-store order read)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-3-sahil |
| Status | Done |
| Report tag | Sprint 3, epic-challenges-c01-c04 story 5.1 |

## Requirements covered
FR-CHL-02 (C01). Challenge spec C01 (docs/design/challenge-specs.md).

## Summary (plain language, 3-5 lines)
Built the first OWASP challenge: a seller order-detail API where, in the vulnerable build, the "does this order belong to my store?" check is missing, so a seller can read a competitor's order by its number (a classic IDOR). The fix — the default build — scopes the lookup to the caller's store, so a foreign order is a 404. An exploit test proves both: it reads the competitor order on the vulnerable build and is refused on the fixed one.

## Why
FR-CHL-02 / C01. The correct seller flow (T-17) scopes everything to the own store, so the weakness is an isolated, build-gated path, matching the challenge framework (vulnerable vs fixed builds, exploit test).

## What was built
- `GET /api/seller/orders/:orderNo` — seller order detail by a sequential number (VM-1NNNNN).
- A challenge-mode helper (`isVulnerable`, default fixed).
- The C01 module with both branches: fixed scopes to the caller's store (404 otherwise); vulnerable drops the check and emits `shop.cross_store_order_read` on a foreign read.
- Migration 0003: `orders.order_no` + `orders.buyer_note`; checkout sets them.
- `viewOrder` (support/finance) now strips `buyer_note` so the flag cannot leak there.

## How it works
The weakness is one WHERE clause. Fixed: `the order must contain an item of the caller's store`, else 404 (deny by default). Vulnerable: look up by order number only. The flag lives in a competitor order's `buyer_note`; only the seller order detail carries that field, and only the vulnerable build serves a foreign one. Default build (no env) is fixed = safe.

## Files changed
- `apps/shop/migrations/0003_order_no_and_buyer_note.sql`, `apps/shop/src/challenges/mode.mjs`, `apps/shop/src/challenges/c01-cross-store-order.mjs` — new.
- `apps/shop/src/web/routes-seller.mjs`, `apps/shop/src/app.mjs` — endpoint + challenge/emit threading.
- `apps/shop/src/domain/shop-service.mjs` — checkout sets order_no/buyer_note.
- `apps/shop/src/domain/staff-service.mjs` — viewOrder strips buyer_note.
- `challenges/tests/c01-cross-store-order/{exploit.mjs,c01.test.mjs}` — new.
- `apps/shop/test/db.test.mjs` — migration count 3.

## Decisions made
- Build-gating via `VM_CHALLENGE_C01` / an override map, default fixed, so a shop run without a challenge setting is always the correct build.
- The flag is never in the repo: the exploit asserts a neutral marker (`C01-FOREIGN-ORDER-MARKER`); the real per-instance flag is injected.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` — 9 pass (C01 3/3: exploit passes vulnerable, fails fixed, event only on vulnerable). `node --test "apps/shop/test/**/*.test.mjs"` — 134 pass.

## Security notes (vulnerable parts only)
The vulnerable branch is a deliberate IDOR (CWE-639), isolated in `c01-cross-store-order.mjs` and off by default. The fix is the scoped lookup. `buyer_note` is kept out of the support/finance views so C09/support cannot read the C01 flag (challenge-spec requirement).
