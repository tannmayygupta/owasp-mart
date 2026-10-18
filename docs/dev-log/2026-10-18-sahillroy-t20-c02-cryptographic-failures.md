# T-20 C02 Cryptographic Failures (gift-card codes from a weak hash)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-3-sahil |
| Status | Done |
| Report tag | Sprint 3, epic-challenges-c01-c04 story 5.2 |

## Requirements covered
FR-CHL-03 (C02). Challenge spec C02.

## Summary (plain language, 3-5 lines)
Built a gift-card wallet where, in the vulnerable build, a card's redemption code is a predictable function of its serial (unsalted MD5 of the serial, first 12 hex). A player who buys two cards sees the pattern and can forge the code of the seeded flag card and redeem it. The fix — the default build — uses random codes from a CSPRNG and stores only a keyed HMAC, so a derived code is rejected. An exploit test proves both.

## Why
FR-CHL-03 / C02 (weak crypto). Codes derived from a counter are a classic cryptographic failure; isolating it behind a build flag keeps the rest of the shop (and all passwords, FR-SHP-09) on strong crypto.

## What was built
- Migration 0004: `gift_cards` (serial, message, amount, code_hash, owner, status) and a separate non-spendable `promo_credit` ledger.
- Challenge module with `issueCard`/`buyCard`/`redeem`: vulnerable derives the code from the serial (MD5); fixed issues a random code and stores its keyed HMAC.
- `POST /api/wallet/buy` and `POST /api/wallet/redeem` JSON routes.
- Redeeming emits `shop.giftcard_attempt` (result + card_class); the flag is in serial 1's message, returned only in the redeem response.

## How it works
The weakness is "a bare unkeyed hash of a counter used as a secret". Fixed: random 24-hex code, lookup by `HMAC(code)`. Vulnerable: the code is `VM-` + `md5(serial)[:12]`, so redemption recovers the serial by matching the derivation — a forged code for a serial the player never bought still matches. Redeemed amount goes to `promo_credit`, which nothing at checkout can spend.

## Files changed
- `apps/shop/migrations/0004_gift_cards.sql`, `apps/shop/src/challenges/c02-gift-card-codes.mjs` — new.
- `apps/shop/src/web/routes.mjs`, `apps/shop/src/app.mjs` — wallet routes + challenge threading.
- `challenges/tests/c02-gift-card-codes/{exploit.mjs,c02.test.mjs}` — new.
- `apps/shop/test/db.test.mjs` — migration count 4.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` — 11 pass (C02 2/2: forged code redeems the flag on vulnerable, rejected on fixed). `node --test "apps/shop/test/**/*.test.mjs"` — 134 pass.

## Security notes (vulnerable parts only)
The vulnerable branch uses an unsalted MD5 of a predictable serial as a secret code (CWE-328/338) — deliberate, isolated in `c02-gift-card-codes.mjs`, off by default. The fix is random codes + keyed hash at rest. This is the only weak-crypto path in the shop; passwords remain on the strong adaptive hash. Redeemed credit is non-spendable (`promo_credit`), so it cannot feed C04.
