# 0059. Recruiter routes, and the recruiter dashboard over the lab's reviewer routes

- **Status:** Proposed (the builder's design for the developer to confirm; the developer asked on 2026-10-20 to continue "in the same manner" as P-26, so P-27 adds the recruiter routes it needs)
- **Date:** 2026-10-20
- **Deciders:** Claude Code (design); the developer (scope)
- **Requirements:** FR-DSH-02, FR-DSH-03, FR-HNT-03, FR-ORG-01, 02, 07, 08, FR-ASM-01 to 06, ADR 0048 to 0051, ADR 0058, handoffs H-138 to H-140, H-355

## Context
A recruiter could not do anything over HTTP: the company, template and invite services (P-18 to P-21) had no routes ("story 5.3"), and the dashboards app had no recruiter pages. The recruiter dashboard needs the company's candidates with their state, milestones and countdown live, and per candidate the score, the per-challenge results, time to capture, active time, technique and tags, evidence, hints used with their cost and integrity flags, every view audited and no practice history.

## Options considered
1. **Scope:** all of story 5.3 (members, join requests included) / what the dashboard needs (sign-up, standing, terms, re-apply, templates, invites).
2. **Candidate results:** new platform routes that copy the lab's data / the lab's reviewer routes (IF-2 report, evidence, integrity flags, timeline), which already check the company and record each view of the report or evidence in the attempt log and the candidate's view history (story L-25).
3. **Errors:** new company codes / the existing `REQ-ROUTE-UNKNOWN`, `ATT-NOT-FOUND`, `ATT-INVALID-STATE`, `ATT-CONSENT-STALE`, `REQ-RATE-LIMITED`.
4. **Paths:** `/api/v1/recruiter/...` / `/api/v1/company/...` (what the recruiter acts on).

## Decision
- **Thirteen routes under `/api/v1/recruiters` and `/api/v1/company`** (IF-1 1.4.0, tag `company`): sign-up (no session, 202 always), the standing, re-apply, the terms (read and accept, the owner only), templates (list, create, get, replace, delete), invites (list with filters, create one or many, resend, cancel, revoke, re-invite). Members and join requests stay without routes (story 5.3).
- **Gate:** `requires(Role.RECRUITER)` (the owner role for the terms and re-applying): anyone else gets the answer of a route that does not exist; the services check the session's company against the database again.
- **Results from the lab:** the dashboard reads the candidate's attempt, progress, report, evidence, integrity flags and timeline from the lab's reviewer routes (IF-2), which check the company and record each company view in the attempt log (`recruiter_viewed_report`) and the candidate's view history (story L-25); no copy in IF-1.
- **Errors:** no new codes (the mapping is in `orgs/company_api.py`); a single invite past the daily cap is 429, a bulk invite returns the rest as `remaining`.
- **Hints used (FR-HNT-03):** the report's hints per challenge with the template's cost percentage, shown only when hints were on.

## Consequences
- A company can be run from the dashboards: sign up, be approved by an admin (P-28), accept the terms, make templates, invite candidates and follow them live.
- The 404 and 409 answers are less precise than dedicated codes.
- A second recruiter joins only through the service (no route for join requests yet).
- The release of `after_release` results still has no action (H-355).
- FR-DSH-02 asks that every view of a candidate report is written to the audit log: today it is the attempt log and the view history, not the platform audit log (`audit_log`); recorded for the developer to decide.

## Evidence
- `apps/api/tests/test_company_api.py`; the web tests and the stack test: see the dev-log of P-27.
