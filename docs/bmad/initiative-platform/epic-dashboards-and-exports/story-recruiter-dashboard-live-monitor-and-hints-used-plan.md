---
title: 'Recruiter dashboard, live monitor and hints used'
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
  - '{project-root}/docs/adr/0058-candidate-invite-routes-and-dashboards-as-client-pages.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** A recruiter cannot do anything over HTTP: there is no route to sign up as a recruiter, see the company's standing, accept the data-processing terms, make an assessment template or send invites (P-18 to P-21 are service level, "story 5.3"), and the dashboards app has no recruiter pages: no list of the company's candidates, no live monitor, no per-candidate report with hints used (FR-DSH-02, FR-DSH-03, FR-HNT-03).

**Approach:** The recruiter routes P-27 needs, in IF-1 (tag `company`): `signupRecruiter` (no session, like `createAccount`), `getMyCompany`, `reapplyCompany`, `getCompanyTerms`, `acceptCompanyTerms`, the template routes (list, create, get, replace, delete) and the invite routes (list, create one or many, act on one: resend, cancel, revoke, reinvite), over the existing `CompanyService` and `AssessmentService`. The candidate's results come from the lab's reviewer routes (IF-2: report, evidence, integrity flags, timeline, which already check the company and record the company's view). Then the pages: a recruiter sign-up, `/company` (standing, terms), templates, the live monitor of the company's candidates (states, milestones, countdown, live from the company stream) and the candidate report (score, per challenge, time to capture, active time, technique and tags, evidence, hints used with their cost, integrity flags and decisions).

## Boundaries & Constraints

**Decisions (developer):** 2026-10-20 "continue with the other tasks of sprint 4 in same manner": P-27 adds the recruiter routes it needs, as P-26 added the candidate ones. Company members and join requests (P-19) stay without routes (story 5.3). The release of results (`after_release`, H-355) is left to stream L's server rule and a later story; P-27 shows the setting.

**Always:** a recruiter sees only their own company's templates, invites and candidates (the services check the company against the database; the lab checks it again); every view of a candidate report is recorded (the lab's reviewer routes do it); a recruiter never sees a person's practice history; no route here changes an admin or another company.

**Never:** no new error code; no change to IF-2; no members or join-request routes; no exports (P-29).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sign up | new address | 202, mail | disposable or bad value 422; known address 202 too |
| Not a recruiter | learner, admin | company routes answer like a route that does not exist | 404 REQ-ROUTE-UNKNOWN |
| Pending company | recruiter of a pending company | `getMyCompany` says pending; templates and invites refused | 409 ATT-INVALID-STATE |
| Terms | owner of an active company | text, version, hash; accept 204 | changed text 409 ATT-CONSENT-STALE; not the owner 404 |
| Invites before terms | active company, no terms | refused | 409 ATT-INVALID-STATE |
| Daily cap | cap reached | the rest returned as `remaining` | a single invite past the cap 429 |
| Other company | template or invite id of another company | not found | 404 ATT-NOT-FOUND |

</frozen-after-approval>

## Code Map

- API: `apps/api/src/vulnmart/orgs/company_api.py` (new), `main.py`; IF-1, bundle, generated models and types, examples; tests `test_company_api.py`.
- Web: `apps/web/app/company/**`, `apps/web/app/signup` (recruiter choice), `apps/web/app/dashboard` (recruiter view).

## Tasks & Acceptance

**Execution:**
- [ ] The recruiter routes, the contract change and their tests.
- [ ] The recruiter pages and their tests; the stack test.

**Acceptance Criteria:**
- Given a recruiter of an active company that accepted the terms, then they make a template, invite a candidate, see the candidate's state change live, and read the report with hints used and their cost.
- Given a recruiter of another company, then none of the first company's templates, invites or reports is visible.
- Given a learner or an admin, then the company routes answer like routes that do not exist.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `pytest apps/api/tests` with the Postgres and Valkey addresses set -- expected: pass
- `node --test apps/web/test/*.test.mjs`, `tsc --noEmit`, `next build` -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (the P-27 test) -- expected: pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
