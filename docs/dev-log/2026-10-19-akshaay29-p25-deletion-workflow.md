# Deletion workflow, 7-day undo and who viewed me (P-25, story 4.4)

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-4-akshay-p25 / see the pull request |
| Status | Built and tested at service level, through four real routes and on the local stack. Not built: the company's routes (the decision and the direct deletion are service methods until the recruiter routes of story 5.3), an email to the parties (FR-PRV-08 asks for one, OI-12), the legal review of the 7- and 14-day periods (OI-33). Story 4.4 is `built`, awaiting the developer's confirmation |
| Report tag | deletion, undo window, who viewed me, data subject requests, BMAD cycle |

## Requirements covered
FR-PRV-08 (deletion workflow), FR-PRV-09 (7-day undo), FR-PRV-11 (the candidate sees who viewed). Related: ADR 0055 (new), ADR 0054, 0050, 0051; handoff H-145 (new). Builds on P-24 (the scheduler, the lab's erase, the consent schedule, the invite delete, the pseudonym forget).

## Summary (plain language, 3-5 lines)
A learner can ask for their practice data and account to be deleted; it waits 7 days, can be undone any time before, and then the platform deletes it. A candidate can ask the company that holds their assessment record to delete it; the company approves or declines, an approved request waits 7 days (still undoable) and is then deleted the way the retention job does it, and the company can delete a candidate at any time. A candidate also sees which companies looked at or exported their data (company, action, time, nothing else).

## Why
Nothing let a person ask for deletion, the 7-day undo of the requirements did not exist, a company could not delete a candidate earlier than the retention date, and the candidate could not see who looked at their data.

## What was built
- Migration 0015: `deletion_requests` (two partial unique indexes: one open request per learner and per candidate and attempt; the application role inserts, selects and updates five columns) and `data_views` (insert, select, delete; never update).
- `privacy/deletion.py`: `DeletionService` (learner request, candidate request, undo, the person's list, the company's list, decide, `company_delete`, the job `run` with escalation after 14 days and execution after the hold); `privacy/views.py`: `ViewHistory` (record with one entry a day per company, person and action; the candidate's own list); `privacy/deletion_api.py`: four routes.
- `privacy/retention/candidates.py` shares `schedule_consent_erase`; `build.py` registers the hourly job `deletion_requests`; `housekeeping.py` purges views after 12 months with the logs; `AssessmentService.delete_attempt_invite`; two settings (`deletion_decide_days` 14, `rate_deletion_per_user_per_day` 10); `main.py` wiring.
- IF-1: four operations, six schemas, a 409 response, six request examples; the bundle (47 operations) and the generated models and types regenerated; `contracts/db/table-owners.yaml` (`data_views`); architecture 04 sections 2.7 and 6.
- ADR 0055 (Proposed), handoff H-145, the plan of story 4.4.

## How it works
A learner's request is a `pending` row with `execute_after` = now + 7 days; the account keeps working. The hourly job finds open requests whose date has passed: for a learner the lab erases each practice attempt, the account is deleted (sessions, tokens, roles cascade) and the audit pseudonym is forgotten; an account that took part in an assessment keeps its account. A candidate's request needs a finished attempt of the caller's, waits for the company (`decide_by` 14 days; after that the job writes one `deletion.escalated` audit entry and nothing is deleted), and after approval has `execute_after` = approval + 7 days; the job then erases the attempt through the lab, schedules the consent records 12 months later, deletes the company's invite and the person's views for that company. An undo is a conditional status change; the job only runs open requests.

## Files changed
- New: `privacy/{deletion,deletion_api,views}.py`, `migrations/versions/0015_deletion_requests_and_data_views.py`, tests `test_deletion.py`, `test_deletion_api.py`, `test_deletion_postgres.py`, six request examples under `contracts/api/platform/examples/`, `docs/adr/0055-*.md`, the plan of story 4.4, `docs/assets/p-25-deletion/`.
- Changed: `privacy/models.py`, `privacy/retention/{build,candidates,housekeeping}.py`, `assessments/service.py`, `ports/settings.py`, `main.py`, `platform.openapi.yaml`, the bundle, `packages/py-models/src/vulnmart_models/api.py`, `packages/ts-client/src/api.d.ts`, `contracts/CHANGELOG.md`, `contracts/db/table-owners.yaml`, `test_data_minimum.py`, `test_kernel_settings.py`, `test_retention_housekeeping.py`, `test_platform_contract.py`, `test_role_gates.py`, `test_company_members.py` (pins that changed on purpose), `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/architecture/04-data-and-state.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: "continue automatically", branch, pull request and merge per task, "go with the recommended flow" for open choices. By the builder, in ADR 0055 (Proposed) for confirmation: the account works during the hold; a candidate's withdrawal is the deletion request for the attempt; the existing `ATT-NOT-FOUND` and `ATT-INVALID-STATE` instead of a new error family; no email to the parties; escalation as an audit entry; one view entry a day per company, person and action.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-25-deletion/`.
- New: `test_deletion.py` 25 (SQLite, real services), `test_deletion_api.py` 16 (the routes through the session, CSRF and rate-limit layers), `test_deletion_postgres.py` 6 (as the application role: migration 0015 down and up, the privileges, the one-open-request indexes, a candidate's request through row-level security with another company's invite untouched, a learner's through the cascade).
- Mutation check of the service by editing the code and rerunning `test_deletion.py`: dropping the 7-day condition of the job was caught; dropping the owner condition of the undo, the company condition of the decision and the approval condition of the job were not caught because they are equivalent (the code reads the row afterwards in the same transaction and the exception rolls the update back; a null date never compares as due).
- Full run of `pytest apps/api/tests` with the two containers on the final code: **2664 passed, 0 failed, 1 skipped** (446 s; the skip is a Windows file-mode check in the lab tests). A first full run had 7 failures and 13 errors: seven were pins that changed on purpose (the operation count 25 to 29, the state-changing routes, the org-column list, and the table-owners list that I had duplicated), and 13 errors in `test_retention_postgres.py` were database connection errors in a run that took an hour of wall time while other runs used the machine (cause not investigated further); the same files passed on their own (124 passed) and in the second full run. The first run's output is `pytest-run1-pins-and-pg-connection-2026-10-19.txt`.
- After merging main (PR 41 and 42: the contract labels and the IF-2 withdraw and undo routes) the full run again: **2682 passed, 0 failed, 1 skipped** (469 s, `pytest-full-after-main-merge-2026-10-19.txt`); contract rules 24 PASS, 0 FAIL; the stack test ran before that merge.
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **31 of 31** on the second run. The first run had 30 of 31: the P-22 live-updates test failed ("the milestone arrived on the open stream"; the same code passed on the second run, so it looks like a timing flake of that test, not verified further). The new test: a learner signs up and signs in, the four routes need a session and (the two that change state) the CSRF header, a request is held 7 days, a second open request, a candidate request without an attempt and one for an attempt that is not theirs are refused, an undo works once, the job does nothing for an undone request or before the date, and after the date the account, roles, sessions and pseudonym are gone while the audit entries stay and name nobody. The P-24 stack test now lists the new job.
- `node scripts/check-contract-rules.mjs`: 20 PASS, 0 FAIL, 1 not applicable (alembic head 0015); `scripts/check_platform_contract.py` OK (29 operations); `scripts/check_api_models.py` OK (94 checks); `scripts/platform-mock.test.mjs` 20 of 20. The root script suite `node --test "scripts/*.test.mjs"`: 888 tests, 883 pass; **3 fail on this PC** because `datamodel-codegen` is not installed in the environment (the console script is missing); the models were generated with `uv tool run --from datamodel-code-generator==0.83.0`, the pinned version, through a temporary copy of the script (removed), and CI has the tool.
- NOT run: a browser, the VMs, CI on GitHub (see the pull request), a real lab runtime in the stack (the learner's practice attempts were none, so the erase was exercised through a stand-in in the unit and Postgres tests), the company's side over HTTP (it has no routes).

## Evidence
`docs/assets/p-25-deletion/`: the full pytest output, the first full run, both stack runs, the root script test output.

## Problems met and how they were fixed
- The background agents I started for the Sprint 4 tasks never wrote anything (they stop when the session turn ends), so the task was built in the main session instead.
- The YAML description with a colon inside a plain scalar broke the bundle; quoted by rewording.
- The mock test needs a valid request example for each new body; six examples added.
- The contract rules wanted a new version heading and a "no mock change" line in the changelog, and found the table `deletion_requests` listed twice in the table-owners file; fixed (the architecture's older row for that table is updated to the real columns).
- A test of an attempt that is still running failed because one user cannot have two attempts of one template; it uses a third user.
- Four pinned tests failed once because they list the operations, the state-changing routes, the tables with an organisation column; updated on purpose.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: every route acts only on the caller's own requests and history (not yours is not found); the company methods act only on the company named on the request or attempt; nothing is deleted before approval and the hold; the application role cannot change who asked or what for, cannot delete a request, cannot update a view; audit entries of company and job actions name the company and counts, never a person; the view history shows the company's name, the action and the time only.

## Limitations and follow-ups
- The company's routes (story 5.3), the emails to the parties and the reminder before the 14-day deadline (OI-12), the legal review of the periods (OI-33), no lock or banner during the hold, the dashboards and exports must call `ViewHistory.record` (H-145).
- ADRs 0040 to 0055 are Proposed.
- Remind: Excel, P-25 Done = Yes; confirm story 4.4 so it can move to `done`.
