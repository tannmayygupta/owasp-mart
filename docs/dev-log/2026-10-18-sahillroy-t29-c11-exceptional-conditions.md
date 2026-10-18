# T-29 C11 Mishandling of Exceptional Conditions (KYC check fails open)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-4-sahil |
| Status | Done |
| Report tag | Sprint 4, epic-challenges-c09-c11 story 7.3 |

## Requirements covered
FR-CHL-12 (C11). Challenge spec C11.

## Summary (plain language, 3-5 lines)
Built KYC-gated seller registration with the C11 fail-open weakness build-gated. The shop sends the tax id to a KYC provider; a malformed shape crashes it. The fixed (default) build fails closed (store stays pending); the vulnerable build's catch returns "verified" and auto-approves the store with approved_by=system:kyc-fallback, and the Payouts page then shows the flag (shown only for a fallback-approved store). An exploit test proves both.

## What was built
- Migration 0008: stores.approved_by (seed stores backfilled to 'seed').
- c11-kyc-failopen.mjs: the KYC mock (valid/422/500 classes), registerStoreWithKyc (fail-closed vs fail-open), and the Payouts view (flag only for a fallback-approved store).
- POST /sell/register and GET /seller/payouts.
- Events kyc.result (outcome), store.approved (approved_by).

## How it works
A valid ascii tax id verifies (pending for admin review); a parseable-but-invalid one is a 422 with a verbose message; a malformed shape (non-string, e.g. tax_id[]=x) crashes the provider. The vulnerable catch returns success on any error and approves the store; the fixed build leaves it pending. The flag is keyed to approved_by='system:kyc-fallback', so only the fail-open path reveals it.

## Files changed
- `apps/shop/migrations/0008_store_approved_by.sql`, `apps/shop/src/challenges/c11-kyc-failopen.mjs` -- new.
- `apps/shop/src/web/routes-seller.mjs`, `apps/shop/src/views/seller/payouts.njk`.
- `challenges/tests/c11-kyc-failopen/{exploit.mjs,c11.test.mjs}` -- new.
- `apps/shop/test/db.test.mjs` -- migration count 8.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` -- 36 pass (C11 3/3). `node --test "apps/shop/test/**/*.test.mjs"` -- 134 pass.

## Security notes (vulnerable parts only)
The vulnerable branch is a generic catch that returns success on any provider error (CWE-636/755), isolated in `c11-kyc-failopen.mjs`, off by default. The fix is to fail closed (reject or queue for review), validate input before the call, and use narrow exception types. An admin/seed approval never yields the flag (sentinel rule keyed to the fallback approver).
