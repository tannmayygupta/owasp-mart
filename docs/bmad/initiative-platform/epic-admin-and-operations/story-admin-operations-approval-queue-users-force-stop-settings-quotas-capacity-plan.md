---
title: 'Admin operations: approval queue, users, force-stop, settings, quotas, capacity'
type: 'feature'
ticket: '1'
created: '2026-10-20'
status: built
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** An admin has no way to work: the approval queue, user management, force-stop, settings and quotas exist only as service code or not at all, the quota port is an in-memory stub so nothing an admin sets is enforced, and the capacity and the scheduler's runs cannot be seen (FR-ADM-01, 02, 04, 05, 06, FR-PRV-18).

**Approach:** `AdminOps` (the queue through the company service, users with lock, unlock, reset link and delete, force-stop through the lab, settings with ranges, quotas, capacity, jobs) behind 13 admin-only routes (`requires(Role.ADMIN)`: a non-admin and an admin without a second factor get 404 REQ-ROUTE-UNKNOWN), every change audited; a real `DbQuotaPort` over the `quotas` table replaces the stub so the lab enforces what the admin sets; `DbSettingsPort` gets `set`, `clear`, `overrides`; two settings for the company and platform caps; a mail to the owner of a force-stopped instance.

## Boundaries & Constraints

**Decisions (developer):** "continue automatically", "go with the recommended flow"; OI-29 rate limits only. Claude's choices, in ADR 0057 (Proposed): attempts as the handle of force-stop, a participant's deletion through the deletion service (locked instead when it holds assessment data), a recruiter account marked deleted, no admin account changed through these routes, the setting ranges, the caps as settings, the existing error codes.

**Always:** every method checks the admin against the database, not only the session; every change is audited without a reason's text, an address or anything a candidate wrote; an admin never sees or sets a password; a value outside its range is refused; a quota change is read by the next request.

**Never:** No break-glass, audit-log reading or legal review (P-31); no admin dashboard pages (P-30); no admin creation route (FR-ACC-11: admins come from the seed command or `AdminService.create_admin`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Non-admin | learner, recruiter, admin without second factor | 404 REQ-ROUTE-UNKNOWN on every route | nothing changes |
| Approve | pending company | 204, company active, owner mailed | already decided: 409; unknown: 404 |
| Reject/suspend | no reason | 422 | n/a |
| Lock | active account | locked, sessions end | already locked: 409; admin or own: 409 |
| Reset | active account | reset link to its own address | not active: 409 |
| Delete | participant / with assessment data / recruiter | deleted / locked instead / marked deleted | admin: 409 |
| Force-stop | attempt | instance destroyed, owner mailed | unknown: 404; no lab: 500 |
| Setting | candidate retention 29 or 366 | 422 | wrong type: 422 |
| Quota | user, company, global | the lab reads it at once | bad id or range: 422 |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/admin/{ops,api}.py`, `kernel/quota.py`, `kernel/settings.py` (`set`, `clear`, `overrides`), `kernel/services.py` (the real quota port), `ports/fakes.py`, `ports/settings.py` (two caps), `lab/runtime.py` (`force_stop`), `privacy/deletion.py` (`delete_learner_account`), `notifications/templates.py` (`instance.force_stopped`), `main.py`.
- IF-1 (13 operations), bundle, generated models and types, eight request examples.
- Tests: `test_admin_ops.py`, `test_admin_api.py`, `test_admin_postgres.py`; pins in `test_role_gates.py`, `test_notification_templates.py`, `test_platform_contract.py`; stack test.

## Tasks & Acceptance

**Execution:**
- [x] The service, the routes, the quota port, the settings writes, the force-stop and its mail.
- [x] IF-1 additions, bundle, generated code, examples.
- [x] Unit, route and Postgres tests; the real-stack test.

**Acceptance Criteria:**
- Given an admin with a second factor, then the queue, users, settings, quotas, capacity and jobs answer and every change is audited.
- Given a quota change, then the next quota read of the lab gives the new number.
- Given a non-admin or an admin without a second factor, then every admin route answers like a route that does not exist.

## Implementation Notes

- The mutation check of the operations: seven of eight mutants were caught; the one that survived (allowing the admin's own account) is equivalent, because the admin's own account is always an admin account, which is refused first.
- `test_role_gates.py` asserted that no state-changing route has "admin" in its path; it now leaves out the admin area and checks that none of its routes makes or promotes an admin.

## Plan Change Log

## Review Triage Log

### 2026-10-20, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The quota port was an in-memory stub: nothing an admin set was enforced | high | patch | `DbQuotaPort` in `build_ports` |
| 2 | A participant with assessment data cannot be deleted without breaking the company's record | medium | patch | locked instead, outcome `locked_instead` |
| 3 | FR-ADM-04 asks that the owner is notified | low | patch | mail `instance.force_stopped` |

### 2026-10-20, quick review (bmad-code-review, lens: quick), loop 1
Run in the main session, not by an independent subagent: the reviewer subagent was stopped twice by session restarts.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | A company quota given as an upper-case UUID is stored as typed; the lab looks it up in lower case, so it never applies | medium | patch | `_check_quota_target` returns the lower-case id; test `test_a_company_quota_given_in_upper_case_is_stored_as_the_lab_looks_it_up` |
| 2 | The P-28 stack test reused the P-13 admin address, so the seed did nothing and the login failed 401 | medium | patch | own address, seed result asserted; rerun 4 of 4 |
| 3 | IF-1 changed without a contracts changelog entry (contract rules 2 FAIL) | medium | patch | entry 1.2.0; 18 PASS |
| 4 | Deleting a recruiter who owns a company leaves it with a deleted owner | low | defer | dev-log follow-up (P-30/P-31) |
| 5 | `DELETE /admin/quotas` without parameters removes the global quota | low | defer | dev-log follow-up |
| 6 | Concurrent first writes of one quota can hit the unique key (500); a mail failure after a force-stop answers 500 after the stop | low | defer | dev-log follow-up |

## Verification

**Commands:**
- `pytest apps/api/tests` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/platform-mock.test.mjs` -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL

**Results (2026-10-20):** full pytest 2787 passed, 1 skipped; admin and pinned files after the review fix 165 passed; contract rules 18 PASS, 0 FAIL; platform mock 20 of 20; stack: full run 31 of 32 before the test fix, P-28 test 4 of 4 after it. Output in `docs/assets/p-28-admin-operations/`.
