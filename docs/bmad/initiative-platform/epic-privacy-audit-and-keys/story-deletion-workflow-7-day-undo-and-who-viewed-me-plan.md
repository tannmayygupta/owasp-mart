---
title: 'Deletion workflow, 7-day undo and who viewed me'
type: 'feature'
ticket: '4'
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

**Problem:** A person cannot ask for their data to be deleted, a candidate cannot ask the company that holds their assessment record, nothing holds a deletion for a 7-day undo, a company cannot delete a candidate earlier than the retention date, and a candidate cannot see which companies looked at their data (FR-PRV-08, 09, 11).

**Approach:** One table of deletion requests and one of company-level views (migration 0015). A learner's request is held 7 days and can be undone; a candidate's request goes to the company, which approves or declines within 14 days (placeholder; the admins are told after that) and an approved request waits the same 7 days; the hourly job `deletion_requests` carries out what is due with the same steps as the retention jobs (the lab erases, the consent records are scheduled 12 months later, the invite, the account and the pseudonym go); the company can delete directly. Four IF-1 routes for the person's side; the company's side stays at service level until the recruiter routes (story 5.3). `ViewHistory.record` is what the dashboards and exports call.

## Boundaries & Constraints

**Decisions (developer):** "Continue automatically", branch, pull request and merge per task, "go with the recommended flow". Claude's choices, in ADR 0055 (Proposed) for confirmation: the account works during the hold; a candidate's withdrawal is the deletion request for the attempt; the existing `ATT-NOT-FOUND` and `ATT-INVALID-STATE` instead of a new error family; no email to the parties; escalation as an audit entry.

**Always:** a request that is not yours is "not found"; a candidate request needs a finished attempt of the caller's; one open request per learner and per candidate and attempt; nothing is deleted before approval and the hold; an undo before the date deletes nothing; the company decides and deletes only its own requests and attempts; audit entries of company and job actions name the company and counts, never a person; the view history shows company, action and time and nothing else.

**Never:** No company routes (story 5.3); no email to the parties (OI-12); no new error codes; no change to the retention jobs' rules (ADR 0054); no judgement of the 7- and 14-day periods (OI-33).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Learner asks | learner account | pending request, `execute_after` = now + 7 days | a second open request: 409; not a learner: 409 |
| Undo | open request, owner | cancelled; the job does nothing | not yours: 404; already closed: 409 |
| Hold over | pending learner request, date passed | practice attempts erased, account and pseudonym deleted | no lab to erase: the job fails, the request stays open; assessment data: account kept |
| Candidate asks | own finished attempt | pending, decide by +14 days | someone else's: 404; unfinished: 409 |
| Company approves | pending request of its own | approved, 7-day hold, candidate can undo | another company: not found; decided already: 409 |
| Company declines | pending request | declined, nothing deleted | n/a |
| Nobody decides | 14 days | escalated once (audit entry), nothing deleted | n/a |
| Hold over | approved request | attempt erased, consent scheduled +12 months, invite and views deleted | no eraser: fails visibly |
| Company deletes | its own attempt | same steps at once, open request done | other company or unknown attempt: not found |
| Who viewed me | candidate | company, action, time, newest first | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/privacy/{deletion,deletion_api,views,models}.py`, `migrations/versions/0015_deletion_requests_and_data_views.py` (single head 0015).
- `privacy/retention/{build,candidates,housekeeping}.py` (the job, the shared consent scheduling, the view purge), `assessments/service.py` (`delete_attempt_invite`), `ports/settings.py` (two settings), `main.py`.
- `contracts/api/platform/platform.openapi.yaml`, bundle, generated models and types, six request examples, `contracts/db/table-owners.yaml`.
- Tests: `test_deletion.py`, `test_deletion_api.py`, `test_deletion_postgres.py`; stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] Migration 0015, the models, the service, the view history, the routes, the job and its wiring.
- [x] IF-1 additions, bundle, generated code, examples.
- [x] Unit tests on SQLite, route tests, Postgres tests as the application role, the real-stack test.

**Acceptance Criteria:**
- Given a learner's request, then nothing is deleted before 7 days, an undo deletes nothing, and after 7 days the account, its attempts and its pseudonym are gone.
- Given a candidate's request, then nothing is deleted without the company's approval, and after approval and 7 days the record is deleted like the retention job does.
- Given a candidate, then they see the company, action and time of each view and nothing else.

## Implementation Notes

- The mutation check of the service: the 7-day wait is caught by the tests; three other mutants (the owner or company condition dropped from the update, the approved-only condition) survive because the code checks the row afterwards inside the same transaction and the exception rolls the update back, so they are equivalent, not gaps.
- The first stack run had one failure in the P-22 live-updates test (the milestone did not arrive on the open stream in time); the second run, with the same code, passed 31 of 31. The first run's output is kept.
- `uv run ... datamodel-codegen` fails on this PC (the console script is missing from the environment): the models were generated with `uv tool run --from datamodel-code-generator==0.83.0`, the pinned version, through a temporary copy of the script that was removed.

## Plan Change Log

## Review Triage Log

### 2026-10-19, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The P-24 stack test listed the jobs exactly and would fail with the new job | low | patch | `deletion_requests` added to its list |
| 2 | The mock test needed request examples for the new body | low | patch | three valid and three invalid examples |
| 3 | `data_views` would never be purged | medium | patch | the log purge deletes views older than 12 months |

## Verification

**Commands:**
- `pytest apps/api/tests` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/platform-mock.test.mjs` -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api`) -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
