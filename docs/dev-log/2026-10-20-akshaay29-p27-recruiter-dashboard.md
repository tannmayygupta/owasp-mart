# Recruiter dashboard, live monitor and hints used

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p27` |
| Status | In progress (the routes done; the pages next) |
| Report tag | platform, dashboards, sprint 4 |

## Requirements covered
FR-DSH-02, FR-DSH-03, FR-HNT-03; the routes for FR-ORG-01, 02, 07, 08 and FR-ASM-01 to 06. Story 2 of `epic-dashboards-and-exports` (ref 8.2, task P-27).

## Summary (plain language, 3-5 lines)
(Filled at the end of the story.)

## Why
A recruiter could not do anything over HTTP (P-18 to P-21 had no routes) and the dashboards app had no recruiter pages. Task P-27 of `docs/dev/dev2-akshay.md`.

## What was built
- API: `orgs/company_api.py` with thirteen recruiter routes (IF-1 1.4.0): sign-up, standing, re-apply, terms, templates, invites.

- Web: the sign-up page offers "I recruit for a company" (`signupRecruiter`); `/company` (standing, re-apply, the terms for the owner, templates, the invite form with the per-address result); `/company/candidates` (the live monitor: invite and attempt state, milestones, captures, countdown, reloaded on the company's live events); `/company/candidates/[attemptId]` (score, per challenge points, time to capture, technique, OWASP tags and stars, active time, hints used when hints were on, evidence, integrity flags with accept or reject and a note, timeline); the nav and the dashboard point recruiters there; `lib/api.ts` gets the recruiter shapes and `duration`.

## How it works
(Filled at the end of the story.)

## Files changed
(Filled at the end of the story.)

## Decisions made
By the developer (2026-10-20): "continue with the other tasks of sprint 4 in same manner": P-27 adds the recruiter routes it needs. By the builder, in ADR 0059 (Proposed).

## Tests
- `test_company_api.py`: 10 passed (sign-up 202 twice, a pending company refused templates, a rejected owner re-applies, terms read, stale refused, accepted, then invites; templates list, get, replace, delete, a bad limit 422; bulk invites address by address, a live invite 409, cancel and cancel again 409; another company sees nothing; a learner finds no company route; a member cannot read the terms; session and CSRF).
- Pins changed on purpose: IF-1 operations 45 to 58 and the seven new state-changing paths (`test_platform_contract.py`, `test_role_gates.py`); with the invite tests 91 passed.
- `check_platform_contract.py` OK (58 operations); `check_api_models.py` OK (116 checks); `platform-mock.test.mjs` 20 of 20; contract rules 18 PASS, 0 FAIL.

- Web: `tsc --noEmit` clean; `next build` builds 14 routes; `node --test apps/web/test/*.test.mjs` 16 of 16 (the new `duration` test).

## Evidence
`docs/assets/p-27-recruiter-dashboard/`.

## Problems met and how they were fixed
- The route tests first failed: the test app had no company resolver for sessions (`set_org_resolver`, as `main.py` does), so the recruiter's session had no company; wired in the test fixture.
- `TemplateView` has no `created_at`: the answer has `updated_at` only (a 500 in the first run).
- `check_platform_contract.py`: the new 404 example needed `request_id`, and six answers needed examples; the mock test needed valid request examples for the terms and the invite action.

## Security notes (vulnerable parts only)
None: platform code.

## Limitations and follow-ups
(Filled at the end of the story.)
