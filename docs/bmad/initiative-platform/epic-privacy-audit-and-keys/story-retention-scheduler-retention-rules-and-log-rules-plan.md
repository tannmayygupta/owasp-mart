---
title: 'Retention scheduler, retention rules and log rules'
type: 'feature'
ticket: '3'
created: '2026-10-19'
status: done
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/architecture/05-key-flows.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** Nothing deletes anything: candidate records, learner accounts, sessions, evidence, logs and outbox rows live for ever, the audit log and the consent records cannot be purged at all, and an admin cannot see whether a purge ran (FR-PRV-04 to 07, 14 to 18).

**Approach:** A scheduler (`job_runs`, a lease so one process runs each job, failures recorded, audited and logged, `status()` for the admin dashboard) in the API process, with a job per rule: candidate retention (the template's days from the end of the attempt or the invite date; the lab erases the attempt, the consent records are scheduled a year later, the invite goes), the learner warning and deletion (12 months after the last login, 30-day warning, a login cancels), learner evidence (30 days after the instance was destroyed), account housekeeping (sessions and their network prefix and browser class after 90 days, expired tokens), log purge (12 months: audit entries behind a checkpoint, refused-event records, job runs, mail rows; sealed address of a mail that never left after 30 days), consent purge, invite expiry and token purge, live cleanup and the audit anchor. Migration 0014 (two privileged functions, one column each on users and consent records, DELETE on invites and security events). The terms say VulnMart is the controller of learner data; a test checks that nothing shown claims a legal duty; a check scans the shop seeds for real-looking data.

## Boundaries & Constraints

**Decisions (developer):** OI-37 (2026-10-18): the consent record is kept for the assessment retention plus 12 months. "Continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0054 (Proposed) for confirmation: the scheduler in the API process with a lease, the privileged functions, the clocks, keeping the account of a learner who took part in an assessment, mail rows purged with the logs, failures shown rather than emailed.

**Always:** every job records its run and its failure (the class of the exception, never its text); a failed job waits ten minutes; the lab erases an attempt (never the platform around it) and a job that needs it and has none fails; deletion steps are in an order that makes a failure safe to repeat; the audit purge never deletes anything younger than 12 months or the newest entry and writes the checkpoint first; the consent purge deletes only what was scheduled; an audit entry of a deletion names counts and a company, never a person; the 30-day warning is not described as a legal duty.

**Never:** No admin route (the admin area, P-28); no company or candidate deletion request or 7-day undo (P-25); no email to admins about a failed job (OI-12, OI-34); no raw container logs (the lab's); no judgement of real names in seeds.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Job due | never ran / last success older than its interval | runs once on one process, recorded | a failure: recorded, audited, logged, retried after 10 min |
| Candidate never started | invite older than its retention | invite deleted, audit entry with counts | n/a |
| Candidate started | attempt over, retention passed | attempt erased, consent scheduled +12 months, invite deleted | no eraser: the job fails and deletes nothing |
| Attempt going | not over | never due | n/a |
| Learner idle 11 months | verified, active, not warned | warning mail, `retention_warned_at` | n/a |
| Learner logs in | warned | mark cleared, deletion cancelled | n/a |
| Learner idle 12 months, warned 30 days ago | no assessment data | practice attempts erased, account and pseudonym deleted | with assessment data: account kept |
| Audit log | entries older than 12 months | purged behind a checkpoint, newest kept, chain verifies | a younger entry is never purged |
| Dead run | `running` over an hour | failed, reported | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/privacy/retention/{scheduler,build,candidates,learners,housekeeping,records}.py`, `migrations/versions/0014_retention.py` (single head 0014).
- `assessments/service.py` (`retention_invites`, `delete_invites`), `lab/runtime.py` (`erase`), `live/store.py` (`sweep`), `accounts/{models,sessions}.py` (`retention_warned_at`, a login clears it), `privacy/models.py` (`erase_after`), `orgs/data/dpa-terms.txt` and `terms.py` (version 2026-10-19.1), `ports/settings.py`, `kernel/settings.py`, `main.py` (scheduler and its lifespan), `infra/compose/compose.yaml`.
- `scripts/check-synthetic-data.mjs`. Tests: `test_retention_*.py`, `test_privacy_statements.py`, `test_live_hub.py` (sweep), `scripts/check-synthetic-data.test.mjs`; stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] Migration 0014, the scheduler, the jobs and their wiring.
- [x] The statements test, the terms line, the synthetic-data check.
- [x] Unit tests on SQLite, Postgres tests as the application role, the real-stack test.

**Acceptance Criteria:**
- Given the stack, then every job ran at start and the admin's status shows the last run of each.
- Given an aged learner, then the warning mail arrives and after the warning period the account goes.
- Given an aged invite, then the job deletes it and the audit entry holds no address.
- Given a failing job, then the failure is recorded, audited and retried after the pause.
- Given the audit log, then old entries are purged behind a checkpoint and the chain still verifies.

## Implementation Notes

- Writing the first test of a failing job showed that a job overdue by days would have been retried on every pass (the retry pause was a minimum against the interval): a failure now always waits ten minutes.
- Writing the audit purge test showed that purging every entry would break the chain of the next one: the newest entry always stays.
- The lab's `security_events` was insert-only, so the log purge failed on the real tables: migration 0014 grants DELETE (found by the whole-scheduler Postgres test).
- Candidate tests that made an attempt end before its invite existed were wrong, not the job: an invite younger than the shortest retention (30 days) is never looked at.

## Plan Change Log

## Review Triage Log

### 2026-10-19, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | A failed job overdue by days was due again on every pass | high | patch | a test with a job that keeps failing; the pause is absolute |
| 2 | The audit purge could delete the newest entry and break the chain | high | patch | `purge_audit_log` keeps the newest; a test purges an all-old log and appends again |
| 3 | The application role could not delete `security_events`, so the log purge failed on Postgres | medium | patch | grant in 0014; the whole-scheduler Postgres test |
| 4 | The terms did not say VulnMart is the controller of learner data (FR-PRV-07) | low | patch | a line and a new version; a test |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test "scripts/*.test.mjs"` -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api`) -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
