---
title: 'C11 Mishandling of Exceptional Conditions (KYC check fails open)'
type: 'feature'
ticket: '3'
created: '2026-10-18'
status: 'done'
baseline_revision: '05f49d6'
route: 'full'
risk: 'medium'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C11 (OWASP 2025 A10, CWE-636/755) needs a fail-open flaw: a KYC verify call wrapped in a catch that returns success on any error, so a crash auto-approves a seller store.

**Approach:** KYC-gated seller registration (`POST /sell/register`). A valid tax id stays pending; a parseable-but-invalid one gets a 422 + verbose message (guidance); a malformed shape crashes the provider. The fixed (default) build fails CLOSED on a provider error (store stays pending); the vulnerable build returns "verified" and auto-approves with `approved_by = 'system:kyc-fallback'`. The flag is on the Payouts page, shown only for a fallback-approved store (sentinel rule). Events `kyc.result`, `store.approved`.

## Boundaries & Constraints

**Always:** Default to fail-closed. The flag shows only when `stores.approved_by = 'system:kyc-fallback'` — never for a seed- or admin-approved store. Migration backfills seed stores to `approved_by = 'seed'`.

**Never:** No real flag committed (neutral marker). No flag from an admin/seed approval. The C11 error code is separate from C05/C10.

## I/O & Edge-Case Matrix

| Build | Input | Result |
|-------|-------|--------|
| either | valid tax id | pending |
| either | parseable-but-invalid | pending + verbose message |
| vulnerable | malformed shape (crash) | approved, `system:kyc-fallback`, flag on Payouts |
| fixed | malformed shape (crash) | pending, no flag |
| either | admin/seed-approved store | no flag |

</frozen-after-approval>

## Code Map

- `apps/shop/migrations/0008_store_approved_by.sql` — `stores.approved_by` (seed backfill).
- `apps/shop/src/challenges/c11-kyc-failopen.mjs` — KYC mock, `registerStoreWithKyc` (both branches), Payouts view.
- `apps/shop/src/web/routes-seller.mjs` + `views/seller/payouts.njk` — `/sell/register`, `/seller/payouts`.
- `challenges/tests/c11-kyc-failopen/{exploit.mjs,c11.test.mjs}`.

## Tasks & Acceptance

- [x] Migration, KYC registration (both branches), Payouts page, exploit + self-test.

**Acceptance:** a malformed tax-id shape auto-approves the store and shows the flag on the vulnerable build (store.approved system:kyc-fallback); fails closed on the fixed build; a valid id stays pending; an admin/seed-approved store shows no flag.

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` -- C11 3/3.
- `node --test "apps/shop/test/**/*.test.mjs"` -- shop suite 134 pass.
