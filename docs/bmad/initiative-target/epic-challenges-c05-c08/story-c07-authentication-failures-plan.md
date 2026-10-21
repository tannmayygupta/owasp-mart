---
title: 'C07 Authentication Failures (weak password-reset code)'
type: 'feature'
ticket: '3'
created: '2026-10-18'
status: 'done'
baseline_revision: 'a087ae2'
route: 'full'
risk: 'high'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C07 (OWASP A07, CWE-307/640) needs a weak authentication-recovery flow. The shop had no password-reset flow at all; this story builds it, with the deliberate weakness build-gated.

**Approach:** Add `/auth/forgot` and `/auth/reset/confirm`, a finance settlement settings page (`/finance/settings/settlement`, the flag), and a test-only sandbox mailbox (`/test/mailbox`, VM_TEST only). The fixed (default) build issues a 128-bit single-use token hashed at rest, answers generically, and kills the token after an attempt limit. The vulnerable build issues a 4-digit code with no attempt limit and a response that reveals whether the account exists (enumeration), so the finance account is taken over by brute force and the flag on its settings page is read. Events `auth.reset_requested`, `auth.reset_confirm_batch`, `auth.password_reset_completed`.

## Boundaries & Constraints

**Always:** Default to fixed. The reset code is never returned by a route — it goes to the internal mailbox (readable only under VM_TEST). The finance settlement page is finance-only (not gated); the challenge is obtaining a finance session. Reset-confirm failures are logged/emitted normally (never the silent C09 signal).

**Never:** No real flag committed (neutral marker). No mailbox route for players (VM_TEST only). No weakening of the normal login or the password hash.

## I/O & Edge-Case Matrix

| Build | Action | Result |
|-------|--------|--------|
| vulnerable | forgot(finance) | 4-digit code mailed; response reveals the account exists; `auth.reset_requested` |
| vulnerable | confirm brute force | no lockout → takeover; `auth.password_reset_completed` |
| fixed | forgot(any) | generic response either way; 128-bit token |
| fixed | confirm brute force | token never matches a guess; dies after the attempt limit |
| either | forgot(unknown) | vulnerable: "no account"; fixed: generic |
| either | finance settlement page | finance session only; shows the flag |

</frozen-after-approval>

## Code Map

- `apps/shop/migrations/0006_password_reset.sql` — `password_resets`, `mailbox`.
- `apps/shop/src/challenges/c07-password-reset.mjs` — reset request/confirm (both branches), finance reference, mailbox, route registrar.
- `apps/shop/src/app.mjs` — `registerAuthResetRoutes` before `checkCsrf`.
- `apps/shop/src/web/routes-staff.mjs` + `views/staff/settlement.njk` — finance settlement page.
- `challenges/tests/c07-auth-failures/{exploit.mjs,c07.test.mjs}`.

## Tasks & Acceptance

- [x] Migration, reset flow (both branches), finance page, mailbox, exploit + self-test.

**Acceptance:** the brute force takes over finance and reads the flag on the vulnerable build (with the reset events) and fails on the fixed build (128-bit token + attempt limit).

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` — C07 2/2.
- `node --test "apps/shop/test/**/*.test.mjs"` — shop suite 134 pass.
