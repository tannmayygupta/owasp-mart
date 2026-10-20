---
title: 'Break-glass, audit access, admin limits, legal review and incident handling'
type: 'feature'
ticket: '2'
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

**Problem:** An admin cannot read the audit log (FR-ADM-07); there is no break-glass step to read a candidate's answers when it is really needed (FR-ADM-03), and nothing proves that an admin cannot read them otherwise (FR-ADM-08); the legal review of the notice, retention and 18+ rule has no recorded action (FR-PRV-19), and there is no incident procedure (FR-PRV-20).

**Approach:** Admin routes for the audit log (each read itself audited) and for break-glass: open a grant for one candidate attempt with a written reason (15 minutes, D-94), which alerts the other admins and the company's owner by mail; read that attempt's report, evidence and timeline only through the open grant (each read recorded with what was read); close it early; a later review by another admin. Grants are rows of a new table (migration 0016). A test proves that an admin without a grant reads no candidate content. The legal review pack (`docs/legal/review-pack.md`, OI-33 open) and the incident procedure (`docs/runbooks/incident-procedure.md`, D-95, a draft for legal review) with a command that mails a notice to affected people, audited.

## Boundaries & Constraints

**Decisions (developer):** OI-12 (D-94): 15 minutes, alert to the other admins and the company; OI-34 (D-95): short procedure, no time target, draft for legal review; D-97: report views stay in the attempt log and the view history. 2026-10-20 "start with the next task", "update the tracker automatically".

**Always:** no standing admin access to candidate content; a grant names the admin, the reason, the start, the end and what was read; the reason text is kept in the grant row, never in the audit log; the grant's admin cannot review their own grant; an audit read is audited.

**Never:** no read of a learner's practice attempt through break-glass (candidate attempts only); no change to IF-2 (the content is read from the lab runtime in process, as the exports do); no new error code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Admin reads the audit log | filters, cursor | entries; an `admin.audit_read` entry | non-admin 404 |
| Open break-glass | candidate attempt, reason of 20 or more characters | grant, 15 minutes; mails to other admins and the company owner; audit | practice or unknown attempt 404; short reason 422 |
| Read through a grant | the grant's admin, while open | report, evidence, timeline; the read recorded | expired or closed 409; another admin 404 |
| Admin without a grant | the lab's report route | 404 | n/a |
| Review | another admin, grant over | reviewed; audit | own grant or still open 409 |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/admin/breakglass.py` (new), `admin/api.py` (routes), `admin/models.py` or the privacy models (the grant table), `migrations/versions/0016_*.py`, `notifications/templates.py` (two alerts and the incident notice), `admin/incident_notice.py` (command), `main.py`; IF-1, bundle, generated code, examples, `contracts/db/table-owners.yaml`.
- Tests: `test_breakglass.py`, `test_breakglass_postgres.py`, the admin route tests, the privacy wall.
- Docs: `docs/legal/review-pack.md`, `docs/runbooks/incident-procedure.md`, `initial.md` D-94 to D-97.

## Tasks & Acceptance

**Execution:**
- [x] Audit log route; break-glass service, table, routes, alerts; the admin-limit test (2026-10-20: break-glass 5, Postgres 3, incident 4).
- [ ] Legal review pack, incident procedure and notice command; the admin page; the stack test.

**Acceptance Criteria:**
- Given an admin, then reading the audit log works and is itself logged.
- Given an admin without a grant, then no candidate answer, write-up or evidence is readable; with a grant, it is, for 15 minutes, the other admins and the company are mailed, and every read is recorded.
- Given the legal review and incident items, then the review pack and the procedure exist and OI-33 is recorded as open.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `pytest apps/api/tests` with the Postgres and Valkey addresses set -- expected: pass
- web tests, `tsc --noEmit`, `next build` -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (the P-31 test) -- expected: pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
