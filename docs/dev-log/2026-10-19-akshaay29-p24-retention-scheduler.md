# Retention scheduler, retention rules and log rules (P-24, story 4.3)

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-3-akshay-8 / see the pull request |
| Status | Built and tested at service level and on the local stack. Not built: an admin route that shows the last run of each job (the data is `Scheduler.status`; the admin area adds the route, P-28 and P-30), the company's and the person's own deletion with the 7-day undo (P-25), raw container logs (the lab's), an email to admins about a failed job (OI-12, OI-34 open). Not verified: the legal review of the periods (OI-33). Story 4.3 is `built`, awaiting the developer's confirmation |
| Report tag | retention, auto-delete, scheduled jobs, audit log purge, data minimisation, BMAD cycle |

## Requirements covered
FR-PRV-04 (candidate retention), FR-PRV-05 (learner retention and warning), FR-PRV-06 (evidence), FR-PRV-07 (controller and processor roles in the terms), FR-PRV-14 (session details after 90 days), FR-PRV-15 (security and system logs after 12 months), FR-PRV-16 (nothing claims a legal duty), FR-PRV-17 (synthetic data only), FR-PRV-18 (the scheduler and its failure reports). OI-37 answered by the developer on 2026-10-18 (the consent record outlives the assessment record by 12 months). Related: ADR 0054 (new), ADR 0047, 0050, 0052; handoff H-144 (new). The 7-day undo and deletion requests are P-25.

## Summary (plain language, 3-5 lines)
The platform now deletes what its rules say it should delete, on a schedule, and shows whether each job ran. A candidate's assessment is deleted when the template's time is up (the invite date if they never started); the short proof of consent goes a year later. A learner who has not logged in for 12 months is warned 30 days before and then deleted, unless they log in. Old sessions, mail rows, logs and audit entries are purged (the audit log behind a checkpoint, so it still verifies), and a failed job is recorded, audited and tried again.

## Why
Nothing deleted anything: records, accounts and logs would live for ever, the append-only audit log and consent records could not be purged at all, and an admin could not see whether a purge had run.

## What was built
- `privacy/retention/scheduler.py`: `Scheduler` (a run is a row of `job_runs`; a lease under a Postgres advisory lock lets one process run each job; a dead run is written off; a failed job waits ten minutes; every failure is recorded with the exception's class only, audited as `job.failed` and logged), `status()` for the admin dashboard, and the loop thread.
- `privacy/retention/{candidates,learners,housekeeping,records,build}.py`: eleven jobs (candidate retention, consent purge, learner warning, learner retention, evidence retention, account housekeeping, log purge, invite expiry, invite token purge, live cleanup, audit anchor).
- Migration 0014: `users.retention_warned_at`, `consent_records.erase_after` (one updatable column), the privileged functions `purge_audit_log` (never younger than 12 months, never the newest entry, a checkpoint first) and `purge_consent_records` (only what was scheduled), DELETE on `invites` and on the lab's `security_events`.
- `AssessmentService.retention_invites` and `delete_invites`, `LabRuntime.erase` (a public wrapper around the lab's erase), `StreamWriter.sweep` for idle live streams, a login clears `retention_warned_at`, the settings of the periods, `main.py` and Compose (`VULNMART_SCHEDULER_ENABLED`).
- The data-processing terms now say VulnMart is the controller of a learner's practice data (version 2026-10-19.1); `scripts/check-synthetic-data.mjs`; ADR 0054 (Proposed); handoff H-144; the plan of story 4.3.

## How it works
Every minute the loop asks the scheduler which jobs are due (never ran, last success older than the interval, or ten minutes after a failure). A job claims its run with a `running` row under an advisory lock, does its work as of the clock and returns a short summary. Candidate retention reads every company's invites, works out when each is due (the end of the attempt plus the template's days, or the invite date plus them), and for each due one erases the attempt through the lab, schedules the consent records a year later and deletes the invite. Learner retention warns by mail (the mail and the mark in one transaction) and, 30 days later, erases the practice attempts and the account. The audit purge is one database function that keeps the chain verifiable.

## Files changed
- New: `privacy/retention/*`, `migrations/versions/0014_retention.py`, tests `test_retention_{scheduler,candidates,learners,housekeeping,postgres}.py`, `test_privacy_statements.py`, `scripts/check-synthetic-data.{mjs,test.mjs}`, `docs/adr/0054-*.md`, the plan of story 4.3, `docs/assets/p-24-retention/`.
- Changed: `assessments/service.py`, `lab/runtime.py`, `live/store.py`, `accounts/{models,sessions}.py`, `privacy/models.py`, `orgs/data/dpa-terms.txt`, `orgs/terms.py`, `ports/settings.py`, `kernel/settings.py`, `main.py`, `infra/compose/compose.yaml`, `test_data_minimum.py`, `test_kernel_settings.py`, `test_lab_pg.py` and `test_assessments_postgres.py` (two privilege assertions that the new grants change on purpose), `test_live_hub.py` (sweep), `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/architecture/04-data-and-state.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: OI-37 (2026-10-18), "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0054 (Proposed) for confirmation: the scheduler in the API process with a lease, the two privileged functions, the clocks, a learner who took part in an assessment keeps the account until that data is gone, mail rows purged with the logs, failures shown rather than emailed, the package under the privacy module.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-24-retention/`.
- New: `test_retention_scheduler.py` 12, `test_retention_candidates.py` 17, `test_retention_learners.py` 15, `test_retention_housekeeping.py` 12 (SQLite, real services; including every job on an empty database), `test_retention_postgres.py` 13 (as the application role: the functions and what they refuse, the privileges, a due candidate record through row-level security and the consent purge a year later, the learner cascade, six processes starting one job and one running it, the whole scheduler on the real tables), `test_privacy_statements.py` 19, two store sweep tests that run against the in-memory store and a real Valkey (4), `scripts/check-synthetic-data.test.mjs` 6.
- Full run of `pytest apps/api/tests` with the two containers on the final code: **2596 passed, 0 failed, 1 skipped** (435 s; the one skip is a Windows file-mode check in the lab tests). A run before the last fixes had 4 failures, all from the deliberate privilege changes or the module list (`pytest-run1-privilege-tests-2026-10-19.txt`).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **30 of 30** on the final code. The new test: every one of the eleven jobs ran at API start and the admin's status shows each; an aged learner's warning mail really arrives through the worker and says nothing about a legal duty, the account is not deleted the day it is warned and is deleted after the warning period with its pseudonym forgotten; an aged invite is deleted by the candidate retention job and the audit entry holds the company and counts but no address; published event rows past their week are cleared; no job failed.
- `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL, 1 not applicable (alembic head 0014). The full root script suite `node --test "scripts/*.test.mjs"`: 882 tests, 878 pass; **4 fail on this PC and fail the same way on an untouched main**: three that need `datamodel-codegen` (not installed here) and the `vmi-audit` "labs chain (finding D1)" test; CI has the tool. The repository's own scan of the working tree caught two secret-shaped strings in my new synthetic-data test; they are now built at test time.
- NOT run: a browser, the VMs, CI on GitHub (see the pull request), the lab runtime in the stack (there is none, so the real lab erase was exercised only through a stand-in).

## Evidence
`docs/assets/p-24-retention/`: the test outputs and the first failing pytest run.

## Problems met and how they were fixed
- The first test of a failing job showed a real scheduler bug: a job overdue by days was due again on every pass after a failure; the ten-minute pause is now absolute.
- The audit purge test showed that purging every entry would break the chain of the next one; the newest entry always stays.
- The whole-scheduler Postgres test found that the application role could not delete the lab's `security_events` (insert-only in its migration); migration 0014 grants it, flagged for Tanmay in H-144.
- Four older tests failed once because they pinned the old privileges (`invites` and `security_events` could not be deleted) or the module list; updated on purpose, and the invite delete is now tested against row-level security.
- My candidate tests first made attempts end before their invite existed (the job rightly never looked at them); rewritten with realistic dates.
- The secret scan of the repository flagged my own test strings; fixed by building them at test time.
- The session ended while a verification run was in the background; the saved outputs showed it had finished, and the one stage that had not (the root script tests) was rerun.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: the audit log and consent records can be purged only by two database functions that refuse to do more than their name says (never audit entries younger than 12 months or the newest one, never a consent record that was not scheduled); a deletion step order that makes a failure safe to repeat; a job that needs the lab and has none fails instead of deleting around it; an audit entry of a deletion names a company and counts, never a person; the learner's pseudonym is forgotten with the account; the application role still cannot update or delete the audit log, only insert a checkpoint (as before, now written down).

## Limitations and follow-ups
- The admin route for the job status (P-28, P-30); early deletion and the 7-day undo (P-25, H-144); raw container logs; the legal review of the periods (OI-33) and an email to admins about failures (OI-12, OI-34).
- A learner who also took part in an assessment keeps the account until that data goes. Companies that accepted the earlier terms accept version 2026-10-19.1 before they invite again. ADRs 0040 to 0054 are Proposed.
- Remind: Excel, P-24 Done = Yes; confirm story 4.3 so it can move to `done`.
