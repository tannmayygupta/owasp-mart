# T-25 C07 Authentication Failures (weak password-reset code)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-4-sahil |
| Status | Done |
| Report tag | Sprint 4, epic-challenges-c05-c08 story 6.3 |

## Requirements covered
FR-CHL-08 (C07). Challenge spec C07.

## Summary (plain language, 3-5 lines)
Built the shop's password-reset flow (it had none) with the C07 weakness build-gated. The fixed (default) build uses a 128-bit single-use token hashed at rest, generic responses, and an attempt limit that kills the token. The vulnerable build uses a 4-digit code with no attempt limit and responses that reveal whether an account exists, so the finance account is taken over by brute-forcing the code; the flag on the finance settlement page is then read. An exploit test proves both.

## Why
FR-CHL-08 / C07. Authentication-recovery weaknesses are OWASP A07. The reset flow is also a real shop feature that was missing.

## What was built
- Migration 0006: `password_resets` (hash of the code/token, expiry, attempts, used) and an internal `mailbox`.
- `c07-password-reset.mjs`: `requestReset`/`confirmReset` (both branches), `financeSettlementReference`, `readMailbox`, and a route registrar for `/auth/forgot`, `/auth/reset/confirm` and (under VM_TEST) `/test/mailbox`.
- Finance settlement page `/finance/settings/settlement` (finance-only; the flag).
- Events: `auth.reset_requested`, `auth.reset_confirm_batch`, `auth.password_reset_completed`.

## How it works
The reset code is never returned by a route — it goes to the internal mailbox (readable only under VM_TEST). Fixed: 128-bit token, hashed at rest, generic response, token dies after 5 wrong tries. Vulnerable: 4-digit code, no lockout, response reveals account existence. The finance settlement page is a normal finance-only page; the challenge is getting a finance session via the weak reset.

## Files changed
- `apps/shop/migrations/0006_password_reset.sql`, `apps/shop/src/challenges/c07-password-reset.mjs` — new.
- `apps/shop/src/app.mjs`, `apps/shop/src/web/routes-staff.mjs`, `apps/shop/src/views/staff/settlement.njk`.
- `challenges/tests/c07-auth-failures/{exploit.mjs,c07.test.mjs}` — new.
- `apps/shop/test/db.test.mjs` — migration count 6.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` — 24 pass (C07 2/2). `node --test "apps/shop/test/**/*.test.mjs"` — 134 pass. The exploit reads the real code from the test mailbox only to start the brute-force window near it (spec-allowed, to keep the test fast); the weakness proven is the 4-digit space + no lockout, which the fixed 128-bit token and attempt limit defeat.

## Security notes (vulnerable parts only)
The vulnerable branch is a brute-forceable 4-digit code with no attempt limit and account enumeration (CWE-307/640), isolated in `c07-password-reset.mjs` and off by default. The fix is the 128-bit hashed token, attempt limits, generic responses. The mailbox is test-only (VM_TEST); players never reach it. Reset-confirm failures are emitted normally so C07 is not mistaken for the silent C09 signal.
