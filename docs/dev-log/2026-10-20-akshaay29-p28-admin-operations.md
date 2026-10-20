# Admin operations: approval queue, users, force-stop, settings, quotas, capacity

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p28` |
| Status | Done (story `built`, awaiting the developer's confirmation to mark it done) |
| Report tag | platform, admin area, sprint 4 |

## Requirements covered
FR-ADM-01, FR-ADM-02, FR-ADM-04, FR-ADM-05, FR-ADM-06, FR-PRV-18 (the admin's view of the jobs), FR-ADM-08 (no candidate content in these views), FR-ACC-07 (admin powers only after the second factor), OI-21 (quota numbers stay placeholders). Story 1 of `epic-admin-and-operations` (task P-28).

## Summary (plain language, 3-5 lines)
An admin can now work through the API: see and decide the company approval queue, find users and lock, unlock, send a reset link to or delete them, force-stop an attempt's instance, change settings within ranges, set instance quotas per user, company or platform, and see capacity and the scheduler's last runs. Every change is audited. Anyone who is not an admin with a second factor gets the answer of a route that does not exist. Quotas are now stored in the database, so what the admin sets is what the lab enforces.

## Why
Before this, the company, account status and settings services had no routes (P-13, P-18, P-19), the quota port was an in-memory stub (nothing an admin set was enforced), and the scheduler status of P-24 had no reader. Task P-28 of `docs/dev/dev2-akshay.md`.

## What was built
- `admin/ops.py` (`AdminOps`): queue and decisions through `CompanyService`; user search (no password hash returned) and the four actions; force-stop through `LabRuntime.force_stop` with the mail `instance.force_stopped` to the owner; settings with ranges (candidate retention 30 to 365 days, audit log at least 12 months, and others); quotas; capacity (instances, memory, mails waiting and failed, events not relayed, failed jobs); jobs.
- `admin/api.py`: 13 routes under `/api/v1/admin/`, reads behind `requires(Role.ADMIN)`, changes also behind CSRF and Origin.
- `kernel/quota.py` (`DbQuotaPort`): user row beats company row beats global row, else one instance; the company and platform caps are the settings `instance_company_cap` (5) and `instance_total_cap` (20).
- `kernel/settings.py`: `set`, `clear`, `overrides` on `DbSettingsPort`.
- IF-1 1.2.0: the 13 operations, schemas, eight request examples; bundle and generated models regenerated.

## How it works
Route gate (session must hold the admin role, which needs the second factor) → `AdminOps` checks again against the database (`RoleService.require_admin`) → the existing service does the change → audit entry with the admin's pseudonym, never the reason text, an address or candidate content. Errors reuse existing codes: unknown thing or non-admin 404 `REQ-ROUTE-UNKNOWN`, wrong state 409 `ATT-INVALID-STATE`, out of range 422 `REQ-VALIDATION`.

## Files changed
- New: `apps/api/src/vulnmart/admin/{ops,api}.py`, `kernel/quota.py`, tests `test_admin_ops.py`, `test_admin_api.py`, `test_admin_postgres.py`, eight examples under `contracts/api/platform/examples/`, `docs/adr/0056-*.md`, the epic's `tickets.toml` and story plan, `docs/assets/p-28-admin-operations/`.
- Changed: `kernel/services.py` (the real quota port in `build_ports`), `kernel/settings.py`, `ports/fakes.py`, `ports/settings.py` (two caps), `lab/runtime.py` (`force_stop`), `privacy/deletion.py` (`delete_learner_account`), `notifications/templates.py` (`instance.force_stopped`), `main.py`, `platform.openapi.yaml`, the bundle, `packages/py-models/.../api.py`, `packages/ts-client/src/api.d.ts`, `contracts/CHANGELOG.md`, pins in `test_role_gates.py`, `test_notification_templates.py`, `test_platform_contract.py`, `scripts/e2e/platform-stack.e2e.test.mjs`, `CHANGELOG.md`, `docs/traceability.md`, `docs/dev/dev2-akshay.md`.

## Decisions made
By the developer: "continue automatically", "go with the recommended flow"; run, review, document and merge P-28 to main, and do not start the next task without asking (2026-10-20). By the builder, in ADR 0057 (Proposed, for confirmation): the attempt as the force-stop handle, participant deletion through the deletion service (locked instead when it holds assessment data), a recruiter marked deleted, no admin account changed through these routes, the setting ranges, the caps as settings, no new error codes.

## Tests
On the developer's Windows 11 PC with throwaway Postgres 18.6 and Valkey 9.0.6 containers (`VULNMART_TEST_POSTGRES_DSN`, `VULNMART_TEST_APP_DSN`, `VULNMART_TEST_VALKEY_URL` set).
- `pytest apps/api/tests/test_admin_ops.py test_admin_api.py test_admin_postgres.py`: **92 passed** (Postgres tests ran, none skipped).
- Full `pytest apps/api/tests`: **2787 passed, 0 failed, 1 skipped** in 743 s (the skip is the Windows file-mode check in the lab tests). `pytest-full-2026-10-20.txt`.
- After the review fix: admin files plus the pinned files (`test_role_gates.py`, `test_platform_contract.py`): **165 passed** (`pytest-admin-after-review-fix-2026-10-20.txt`). The full suite was not rerun after that one-function fix.
- `node scripts/check-contract-rules.mjs`: first **16 PASS, 2 FAIL** (no IF-1 entry in `contracts/CHANGELOG.md`, so also no "no mock change" line); after adding entry 1.2.0: **18 PASS, 0 FAIL, 1 not applicable**. `check_platform_contract.py` OK (42 operations); `check_api_models.py` OK (107 checks); `scripts/platform-mock.test.mjs` 20 of 20.
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: first full run **31 of 32**, the new P-28 test failed (401 at the admin login, see Problems). After the fix, the P-28 test with start-up and tear-down (`--test-name-pattern`): **4 of 4** (`stack-e2e-p28-rerun-2026-10-20.txt`). The full 32-test run was not repeated after the fix.
- After merging main (PR 49 to 53) into the branch: contract rules **18 PASS, 0 FAIL, 1 not applicable** (`contract-rules-after-main-merge-2026-10-20.txt`); CI of pull request 55 on the merged code: `api tests` **2757 passed, 37 skipped** (CI sets no Valkey address, so the Valkey tests skip there), and contract rules, app tests, end-to-end lab tests, exploit runner, compose, build matrix, lockfile and skills checks green. A local full run after the merge was started but is not counted: Docker Desktop had stopped (the PC restarted for a Windows update), so every Postgres test errored; it was stopped and its output deleted.
- NOT run: force-stop against a real orchestrator (the Compose stack has no lab in the API process; covered with a stand-in in unit and route tests), a browser, the VMs, CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-28-admin-operations/`: full pytest output, the post-fix admin run, contract rules, both stack runs, the image build log.

## Problems met and how they were fixed
- The new stack test seeded its admin with the same address as the P-13 test (`e2e-admin-<run>`). The seed returned False (address in use, other password), the test ignored that and printed True, and the login with the P-28 password got 401. Fixed: own address `e2e-ops-admin-<run>` and the test now checks the seed's real return value.
- Contract rules failed twice because IF-1 changed without a `contracts/CHANGELOG.md` entry; added 1.2.0 with the "no mock change" reason.
- Review (same session, not independent: the reviewer subagent was stopped twice by session restarts) found that a company quota given as an upper-case UUID passed validation but was stored as typed, while the lab looks it up by the lower-case id, so it would never apply. Fixed in `_check_quota_target` (returns the lower-case id) with a regression test.
- Merging main: L-29 (gVisor) had taken ADR 0056 on main, so this story's record became ADR 0057 and every P-28 reference was renumbered; `CHANGELOG.md` conflicted (both sides kept); one IF-1 1.2.0 entry had been written twice in `contracts/CHANGELOG.md` by an edit repeated after a session restart, removed.
- Several runs and edits were cut off when the Claude Code session restarted; each was checked and rerun, results above are from completed runs only.

## Security notes (vulnerable parts only)
None: this is the platform, not the vulnerable target. Hardening: non-admins and admins without a second factor cannot tell the admin routes exist (404); every change audited under a pseudonym; an admin never sees or sets a password and cannot change an admin account through these routes.

## Limitations and follow-ups
- Review notes not fixed (recorded for P-30/P-31 or later): deleting a recruiter who owns a company leaves the company with a deleted owner; `DELETE /api/v1/admin/quotas` without query parameters removes the global quota (scope defaults to `global`); two simultaneous first writes of the same quota could hit the unique key and answer 500; if the owner's mail cannot be queued after a force-stop the instance is already stopped and audited but the call answers 500.
- Quota and cap numbers are placeholders (OI-21). Break-glass, audit reading and the admin dashboard pages are P-31 and P-30. Handoffs H-122, H-128 and H-133 stay open (their P-28 parts: activity ownership is the lab's, the outbox requeue route and role grant routes are not built here).
