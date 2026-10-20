# Refactor sweep: deferred findings closed or recorded (story 1.9)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-1-9-refactor-sweep` |
| Status | Done (story `done`, merged in pull request 72) |
| Report tag | platform, quality |

## Requirements covered
Story 1.9 of `epic-platform-baseline` (no requirement of its own); touches FR-PRV-01 (consent screen), FR-ACC-07 and FR-ACC-11 (MFA enrolment, seed admin), FR-ASM-03 (invite resend), FR-LIV-05 (company stream); D-98 to D-101 recorded.

## Summary (plain language, 3-5 lines)
Every one of the 156 deferred review findings of the platform stream now has a recorded outcome in `deferred-work.md`: fixed here, closed earlier (with evidence), accepted, another stream's, or an open decision. The small ones were fixed: CI now typechecks and tests the dashboards, the two lockfiles are checked against each other, the injector exit codes are checked against the error registry, two placeholder rate limits were added, the seed command's audit entry is durable, the consent screen has the unticked agree box with Start and Decline, and four answered open questions are written down as D-98 to D-101. Asked by the developer: "if anything is pending then continue"; scope chosen by the developer.

## Why
The story's check: deferred review findings are closed or recorded and CI is green.

## What was built
- `package.json`: `web:check`, run by `api:check` in CI.
- `scripts/web-lockfile-sync.test.mjs`; `exitCodeProblems` in `scripts/validate-errors.mjs` with a test.
- `accounts/mfa_api.py`: per-account limit `rate_mfa_enrol_per_user_per_hour` (10, placeholder). `orgs/company_api.py`: `rate_invite_resend_per_user_per_hour` (30, placeholder) for resends.
- `accounts/seed_admin.py`: the durable, pseudonymised audit log instead of an in-memory stand-in.
- `apps/web/app/assessment/[attemptId]/page.tsx`: the agree box (unticked), Start (disabled until ticked), Decline.
- Tests: `test_mfa_api.py`, `test_company_api.py`, `test_roles_and_admins.py`, `test_accounts_postgres.py`, `test_companies_postgres.py`.
- Docs: `docs/runbooks/seed-admin.md` (lost second factor), `docs/architecture/04-data-and-state.md` (decline), `initial.md` (D-98 to D-101), `deferred-work.md` (the triage).
- Removed: the unused `check_password` and `PASSWORD_MAX` in `accounts/service.py`.

## How it works
`web:check` runs `tsc --noEmit` on the dashboards and the Node tests in `apps/web/test`; CI already runs `api:check` in its script job, so no workflow changed. The lockfile test compares the `apps/web` importer and every package key of the web lockfile with the root lockfile (pnpm writes its own environment document first; the lockfile proper is the last document). The exit-code check reads the rows of the injector table in `contracts/instance/instance-contract.md` and compares them with the registry both ways; `main` runs it only when that file sits next to the errors folder.

## Files changed
See "What was built".

## Decisions made
- Scope: the developer's choice (small fixes, record the rest, accept the listed limitations).
- Moved to "recorded" after a closer look: K2 (sealing the link in `email_outbox.params` touches 16 test files), P5 and Q6 (choosing a third-party domain list), D4 (an IF-3 contract file), E2 (IF-1's mock, optional).
- A re-invite already counts against the daily cap, so only a resend got the new limit.
- The decline in the diagram follows the code: the invite becomes declined and no attempt record is made.

## Tests
- Full API suite with Postgres and Valkey: 2893 passed, 1 skipped (`docs/assets/story-1-9-refactor-sweep/full-suite-2026-10-20.txt`).
- New or changed: the MFA enrolment limit (`test_mfa_api.py`), the resend limit (`test_company_api.py`), the seed command (`test_roles_and_admins.py`, and on Postgres `test_accounts_postgres.py`), the company stream under row-level security (`test_companies_postgres.py`, 14 passed), the exit codes (`validate-errors.test.mjs`, 27 pass), the lockfiles (2 pass).
- `node --test "scripts/*.test.mjs" "apps/*/test/**/*.test.mjs"`: 1219 pass, 3 fail (the generator tests; the tool is not installed locally, CI has it).
- `pnpm run web:check`: clean, 18 pass. `npm run build` (apps/web): compiled.

## Evidence
`docs/assets/story-1-9-refactor-sweep/`.

## Problems met and how they were fixed
- The root `pnpm-lock.yaml` holds two documents, and the first (pnpm's environment) has `importers` too: the test reads the last one.
- The seed command's durable audit write commits on a connection of its own while the seed's transaction is open (deferred O8). The SQLite test has one shared connection, so the command's audit there is a recording stand-in, and the real row is tested on Postgres.

## Security notes (vulnerable parts only)
None (platform code).

## Limitations and follow-ups
- The consent screen change is not browser-tested.
- The open decisions and the other streams' items are listed at the end of `deferred-work.md`.
- Excel: there is no row for story 1.9 (it is not a P-task).
