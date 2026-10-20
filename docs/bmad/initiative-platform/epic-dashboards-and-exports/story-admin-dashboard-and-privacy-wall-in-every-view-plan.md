---
title: 'Admin dashboard and privacy wall in every view'
type: 'feature'
ticket: '4'
created: '2026-10-20'
status: in-progress
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/prd/PRD.md'
  - '{project-root}/docs/adr/0057-admin-operations-admin-only-routes-a-real-quota-port-and-setting-ranges.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** An admin has routes (P-28) but no dashboard (FR-DSH-05), and the admin's reads of personal data (the user list, the approval queue) are not logged although FR-DSH-05 says every admin read of personal data is. Nothing proves, view by view, that no role can read another user's or another company's data (FR-DSH-06).

**Approach:** The admin dashboard page `/admin` over the P-28 routes (approval queue with decisions, users with lock, unlock, reset link and delete, capacity, the retention jobs, settings, quotas, force-stop by attempt id; the audit log and break-glass are shown as P-31's). `AdminOps.queue` and `AdminOps.users` write an audit entry for the read (who, how many, never the search text). `test_privacy_wall.py`: a classification of every IF-1 and IF-2 operation (public, own, company, admin, catalogue) that fails when a new operation is not classified, and one combined world (the real lab runtime with the company, invite, consent, deletion, view-history and export services) where each role tries the other parties' data on every operation that takes an id or returns personal data, and every try fails.

## Boundaries & Constraints

**Decisions (developer):** 2026-10-20 "start with the next task"; "update the tracker automatically" (stories are marked done once merged).

**Always:** an admin read of personal data writes an audit entry without the search text; the wall test tries every classified operation; a refusal never says whose data it is.

**Never:** no audit log reading, no break-glass, no legal review (P-31); no new route; no new error code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Admin opens the users list | admin with a second factor | the list, and an audit entry `admin.users_read` with the count | n/a |
| Admin without a second factor | `/admin` | told to set up the authenticator app | routes 404 |
| Learner B reads learner A's attempt | any attempt route | 404 | nothing changes |
| Recruiter of company B reads company A's candidate | report, evidence, invites, templates, export | 404 | no view recorded |
| Recruiter reads a learner's practice attempt | report | 404 | n/a |
| New operation added to the contract without a class | the wall test | fails | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/admin/ops.py` (read audits); `apps/api/tests/test_admin_ops.py`; `apps/api/tests/test_privacy_wall.py` (new).
- Web: `apps/web/app/admin/page.tsx` (new), the nav and the dashboard for admins.

## Tasks & Acceptance

**Execution:**
- [x] Admin read audits; the privacy-wall test (2026-10-20: admin tests 90, privacy wall 7).
- [ ] The admin dashboard page; the stack test.

**Acceptance Criteria:**
- Given an admin with a second factor, then the dashboard shows the queue, users, capacity, jobs, settings and quotas, and reading users or the queue is audited.
- Given every role, then no try to read another user's or another company's data succeeds, one test per view.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `pytest apps/api/tests` with the Postgres and Valkey addresses set -- expected: pass
- web tests, `tsc --noEmit`, `next build` -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (the P-30 test) -- expected: pass
