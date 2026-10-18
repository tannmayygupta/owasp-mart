---
title: 'C02 Cryptographic Failures (gift-card codes from a weak hash)'
type: 'feature'
ticket: '2'
created: '2026-10-18'
status: 'done'
baseline_revision: 'f5aecba'
route: 'full'
risk: 'medium'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C02 (OWASP A02/A04, CWE-328) needs a realistic weak-crypto flaw. Gift-card redemption codes that are a predictable function of a receipt-visible counter let an attacker forge any card's code.

**Approach:** A gift-card wallet (migration 0004). One isolated module holds both derivations: fixed (default) issues a CSPRNG random code and stores only its keyed HMAC; vulnerable (`VM_CHALLENGE_C02=vulnerable`) makes the code `VM-` + first 12 hex of an unsalted MD5 of the serial. Redeeming emits `shop.giftcard_attempt`; the flag lives in serial 1's message, returned only in the redeem response. Redeemed value goes to a separate, non-spendable `promo_credit` ledger (never a checkout wallet, never the C04 refund ledger).

## Boundaries & Constraints

**Always:** Default to the fixed (random-code) behaviour. Keep both derivations in the one module. Credit to `promo_credit` only. The weak hash is the only weak crypto in the shop (passwords stay on the strong adaptive hash, FR-SHP-09).

**Never:** No real flag committed (the exploit asserts a neutral marker). No spendable credit. No weakening of password hashing.

## I/O & Edge-Case Matrix

| Build | Action | Result |
|-------|--------|--------|
| either | buy a card | serial ≥ 1001 + its code |
| vulnerable | redeem `weakCode(1)` | 200 + serial-1 message (flag); `giftcard_attempt` flag_card |
| fixed | redeem a derived code | 404, no `redeemed` event |
| either | redeem an already-redeemed card | 400 |
| either | redeem a malformed code | 400 (vulnerable) / 404 (fixed) |

</frozen-after-approval>

## Code Map

- `apps/shop/migrations/0004_gift_cards.sql` — `gift_cards` + non-spendable `promo_credit`.
- `apps/shop/src/challenges/c02-gift-card-codes.mjs` — issue/buy/redeem; both derivations + the event.
- `apps/shop/src/web/routes.mjs` — `POST /api/wallet/buy`, `POST /api/wallet/redeem` (JSON adapters); `app.mjs` threads `challenges`.
- `challenges/tests/c02-gift-card-codes/{exploit.mjs,c02.test.mjs}` — exploit + self-test.

## Tasks & Acceptance

- [x] Migration, challenge module, wallet routes, exploit + self-test.

**Acceptance:** buying two cards reveals the weak pattern; the forged serial-1 code redeems the flag on the vulnerable build and is rejected on the fixed build; credit is non-spendable.

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` — C02 2/2.
- `node --test "apps/shop/test/**/*.test.mjs"` — shop suite 134 pass.
