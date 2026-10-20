# Recruiter dashboard, live monitor and hints used

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p27` |
| Status | Done (story `built`, awaiting the developer's confirmation to mark it done) |
| Report tag | platform, dashboards, sprint 4 |

## Requirements covered
FR-DSH-02, FR-DSH-03, FR-HNT-03; the routes for FR-ORG-01, 02, 07, 08 and FR-ASM-01 to 06. Story 2 of `epic-dashboards-and-exports` (ref 8.2, task P-27).

## Summary (plain language, 3-5 lines)
A recruiter can now use VulnMart from the dashboards: sign up with the company's name, wait for an admin's approval, accept the data-processing terms, make assessment templates and invite candidates one by one or in bulk. The candidates page shows every invited candidate's state, milestones, captures and remaining time, updated live. A candidate's report shows the score, per challenge the points, time to capture and technique, the evidence, the hints used and the integrity flags, which the recruiter can accept or reject with a note.

## Why
A recruiter could not do anything over HTTP (P-18 to P-21 had no routes, "story 5.3") and the dashboards app had no recruiter pages. Task P-27 of `docs/dev/dev2-akshay.md`.

## What was built
- API: `orgs/company_api.py` with thirteen recruiter routes (IF-1 1.4.0): `signupRecruiter`, `getMyCompany`, `reapplyCompany`, `getCompanyTerms`, `acceptCompanyTerms`, `listTemplates`, `createTemplate`, `getTemplate`, `updateTemplate`, `deleteTemplate`, `listCompanyInvites`, `createInvites` (one or many), `actOnInvite` (resend, cancel, revoke, reinvite).
- Web: the sign-up page offers "I recruit for a company"; `/company` (standing, re-apply, the terms for the owner, templates, the invite form with the per-address result); `/company/candidates` (the live monitor: invite and attempt state, milestones, captures, countdown, re-invites marked, reloaded on the company's live events); `/company/candidates/[attemptId]` (score, per challenge points, time to capture, technique, OWASP tags and stars, active time, hints used when hints were on, evidence, integrity flags with accept or reject and a note, timeline); the nav and the dashboard point recruiters there; `lib/api.ts` gets the recruiter shapes and `duration`.

## How it works
The routes sit behind `requires(Role.RECRUITER)` (the owner role for the terms and re-applying), so anyone else gets the answer of a route that does not exist; the services check the session's company against the database again, so another company's template or invite is not found. The candidate's results are not copied into IF-1: the pages read the lab's reviewer routes (attempt, progress, report, evidence, integrity flags, timeline), which check the company and record each view of the report and the evidence (story L-25). The monitor reloads on the company's live events and polls only while the stream is down.

## Files changed
- New: `apps/api/src/vulnmart/orgs/company_api.py`, `apps/api/tests/test_company_api.py`, `apps/web/app/company/page.tsx`, `apps/web/app/company/candidates/page.tsx`, `apps/web/app/company/candidates/[attemptId]/page.tsx`, five valid and three invalid request examples under `contracts/api/platform/examples/`, `docs/adr/0059-*.md`, the story plan, `docs/assets/p-27-recruiter-dashboard/`.
- Changed: `main.py`, `platform.openapi.yaml`, the bundle, the generated models and types, `contracts/CHANGELOG.md`, pins in `test_platform_contract.py` and `test_role_gates.py`, `scripts/e2e/platform-stack.e2e.test.mjs`, `apps/web/app/{signup/page,dashboard/page,nav}.tsx`, `apps/web/lib/api.ts`, `apps/web/app/globals.css`, `apps/web/test/dashboard-lib.test.mjs`, `docs/dev/HANDOFFS.md` (answers to H-137, H-139 to H-143, H-355), `docs/adr/README.md`, `docs/traceability.md`, `docs/dev/dev2-akshay.md`, `CHANGELOG.md`, `docs/progress/index.html`.

## Decisions made
By the developer (2026-10-20): "continue with the other tasks of sprint 4 in same manner": P-27 adds the recruiter routes it needs, as P-26 added the candidate ones. By the builder, in ADR 0059 (Proposed): only what the dashboard needs (members and join requests stay for story 5.3), the candidate's results from the lab's reviewer routes, no new error codes, paths under `/api/v1/company`.

## Tests
On the developer's Windows 11 PC, Docker 28.5.1, throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-27-recruiter-dashboard/`.
- `test_company_api.py`: 10 passed (sign-up 202 twice, a pending company refused templates, a rejected owner re-applies, terms read, stale refused, accepted, then invites; templates list, get, replace, delete, a bad limit 422; bulk invites address by address, a live invite 409, cancel and cancel again 409; another company sees nothing; a learner finds no company route; a member cannot read the terms; session and CSRF).
- Pins changed on purpose: IF-1 operations 45 to 58 and the seven new state-changing paths (`test_platform_contract.py`, `test_role_gates.py`).
- Contract: `check_platform_contract.py` OK (58 operations); `check_api_models.py` OK (116 checks); `platform-mock.test.mjs` 20 of 20; contract rules **18 PASS, 0 FAIL**, 1 not applicable (`contract-rules-2026-10-20.txt`).
- Full `pytest apps/api/tests`: **2813 passed, 0 failed, 1 skipped** in 507 s (`pytest-full-2026-10-20.txt`; the skip is the Windows file-mode check).
- `node --test "scripts/*.test.mjs" "apps/*/test/**/*.test.mjs"`: 1209 tests, 1201 pass, **3 fail on this PC**: the three generator tests, because `datamodel-codegen` is not installed here (as in P-25 and P-26; CI has it) (`script-and-app-tests-2026-10-20.txt`).
- Web: `tsc --noEmit` clean; `next build` builds 14 routes; web tests 16 of 16 (again after the monitor fix below).
- Stack end to end on real Docker (images rebuilt, build exit 0): start-up, the P-26 test, the new P-27 test and tear-down **5 of 5** on the first run (`stack-e2e-2026-10-20.txt`): the three recruiter pages answer 200 with the nonce CSP; two recruiters sign up over HTTP (202); a pending company is refused a template (409); an admin approves both; the owner reads and accepts the terms, makes a template with hints on and invites a candidate; the candidate signs up and accepts; the recruiter's list shows the candidate's state, attempt and hint rules; the second company sees no invite or template (404 for the first company's template); a learner gets 404 REQ-ROUTE-UNKNOWN.
- NOT run: a browser (no browser test tooling); the report and the monitor's lab data on the Compose stack (it has no lab in the API process; the lab's reviewer routes are tested by stream L); CI on GitHub (see the pull request). The monitor fix after the stack and suite runs touched only the web page (web tests, `tsc` and the build rerun).

## Evidence
`docs/assets/p-27-recruiter-dashboard/`: the full pytest output, the script and app tests, the contract rules, the image build log, the stack run.

## Problems met and how they were fixed
- The route tests first failed: the test app had no company resolver for sessions (`set_org_resolver`, as `main.py` does), so the recruiter's session had no company; wired in the test fixture.
- `TemplateView` has no `created_at`: the answer has `updated_at` only (a 500 in the first run).
- `check_platform_contract.py`: the new 404 example needed `request_id`, and six answers needed examples; the mock test needed valid request examples for the terms and the invite action.
- My report page first multiplied the hints used by the template's cost; the lab charges per hint level (placeholder 10, 20, 30 percent, `lab-api.md`), so that figure would have been invented: the page shows the hints used and the template's stated cost, and the points after the cost.
- Review against the handoffs (same session, not independent): H-141 asked that a replaced attempt's results stay visible: the monitor now loads the attempt of a superseded invite and marks re-invites. H-143: the monitor polled every 2 seconds while candidates ran, which would keep an idle recruiter signed in; it now relies on live events and polls only while the stream is down.

## Security notes (vulnerable parts only)
None: platform code. Hardening: non-recruiters cannot tell the company routes exist; another company's data is "not found"; the recruiter reads only the attempt of their own company's invite, never practice history.

## Limitations and follow-ups
- FR-DSH-02 says every view of a candidate report is written to the audit log: the lab records it in the attempt log and the candidate's view history, not in the platform audit log (ADR 0059): for the developer to decide.
- No release action for `after_release` results (H-355); no member or join-request routes (story 5.3); a second recruiter joins only through the service.
- The monitor calls the lab twice per active candidate on each reload; fine for the expected numbers, worth a combined route if companies invite hundreds at once.
- Not browser-tested (OI-30).
