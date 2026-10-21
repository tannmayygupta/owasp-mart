# Recruiter and admin dashboards, cohort board screen, browser and accessibility tests (work package F)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | wp-f-recruiter-admin-web, uncommitted (the lead commits); content of origin/main cd9610e applied under it |
| Status | Done (open follow-ups below) |
| Report tag | recruiter and admin web, OI-30 |

## Requirements covered
FR-DSH-02, FR-DSH-05, FR-ORG-02, FR-ORG-03, FR-ORG-08, FR-ASM-01, FR-ASM-03, FR-ASM-05, FR-SES-07, FR-SCR-07, FR-SCR-08, FR-ADM-01, FR-PRV-08, FR-ACC-09, D-93, OI-30. Role scenarios R-05, R-06, R-08, R-09, R-14, R-17, R-24, R-26, R-28, A-04, A-24, C-36, X-19.

## Summary (plain language)
The recruiter and admin screens now draw every route that exists on main and show the API's refusals. A real-browser suite (recruiter, admin, account, accessibility) runs against the production build, and every main page of every role passes an axe-core WCAG A and AA check.

## Why
Audit gaps R-14, R-09, R-26 and the rest above, and OI-30 (no browser tests, no accessibility check).

## What was built
- Recruiter: template form with every setting, new and edit (`apps/web/app/company/template-form.tsx`); company profile and terms; invite actions single and bulk and Cancel attempt on `/company/candidates` (the buttons follow the API's state rules in `inviteActions`); the cohort view `/company/templates/[templateId]/cohort` over `getCohort` (ranking-aid wording, no decision control); colleagues (join requests, members); candidates' deletion requests; delete a record now on the report.
- Admin: company directory with the invite cap per company, suspend, reinstate, delete.
- Account: change of email address and `/confirm-email-change`.
- Accessibility: scrollable table wrappers are keyboard-reachable focusable regions (axe rule `scrollable-region-focusable`).
- Test API (`apps/api/tests/e2e_web_server.py`): wires the company, export, deletion, admin, break-glass and second-factor services; seeds two admins with an authenticator, a pending company, a cohort-board template and more invites; hook `/_e2e/totp`.

## How it works
The screens only call routes of the contract. Backend authorisation is unchanged and not trusted by the screens: the browser tests include a refusal for each admin form (a value out of range, an attempt that does not exist). The first version of this work added its own cohort route; work package B had merged the same route (`getCohort`, same path), so mine was deleted before commit (route, contract operation, examples, changelog entry, test) and the screen uses B's `items` shape. B also carries the template switch `cohort_board`.

## Files changed
- `apps/web/app/company/page.tsx`, `template-form.tsx`, `candidates/page.tsx`, `candidates/[attemptId]/page.tsx`, `templates/[templateId]/cohort/page.tsx`; `apps/web/app/admin/page.tsx`; `apps/web/app/account/page.tsx`; `apps/web/app/confirm-email-change/page.tsx`; `apps/web/lib/api.ts`
- `apps/api/tests/e2e_web_server.py`; `tests/web-e2e/tests/{helpers,candidate,recruiter,admin,account,zz-accessibility}.spec.mjs`, `tests/web-e2e/package.json` and lockfile (`@axe-core/playwright` 4.11.3, published 2026-04-30)
- records: ADR 0076, story and plan 63, role scenarios, changelog, traceability, `docs/runbooks/web-e2e.md`

## Decisions made
ADR 0076 (real routes only, bulk is client-side sequencing, accessibility gate).

## Tests (real, Windows, installed Chrome, headless, production build)
- `$env:E2E_BROWSER_CHANNEL="chrome"; pnpm --filter "@vulnmart/web" test:e2e` (ports 3160 and 18160): 20 passed (1.4 min) on the final run: account 1, admin 2, candidate 4, learner 2, recruiter 6, accessibility 5.
- `pnpm --filter "@vulnmart/web" typecheck`: 0 errors. `node --test "apps/web/test/*.test.mjs"`: 35 of 35.
- `uv run --offline --package vulnmart-api pytest apps/api/tests -q`: 2752 passed, 245 skipped (Postgres and Valkey not available), 1 xfailed (known, package G).
- `pnpm run contracts:rules`: 37 PASS, 0 FAIL. `pnpm run api:check`: bundle and generated code current, 133 checks 0 problems. `node scripts/check-records.mjs`: PASS.
- Traceability row WP-F.

## Evidence
`docs/assets/wp-f-recruiter-admin-web/` (screenshots of the journeys).

## Problems met and how they were fixed
- A second browser context has no dialog handler, so the candidate's Start confirm was dismissed and the attempt stayed `ready`: the test adds one.
- A deletion request is refused while the attempt is not over (product rule): the test submits first.
- The test API's lab keeps attempts in memory, not in the SQL table the deletion service reads: an adapter in the test API reads them from the lab.
- Several first selectors matched two elements (the nav link and the dashboard card, the route announcer also has role alert): exact names and class selectors.
- WP-A made the candidate attempt follow the template's hints, so the old "no hint control" assertion became the hint control being drawn.
- axe found one violation (scrollable regions not keyboard reachable) on the admin page; fixed on every table wrapper.

## Security notes
No vulnerable part. The seeded authenticator secret and the test password exist only in the test API process; no flag is written anywhere.

## Limitations and follow-ups
- Not run on the GitHub runner. Break-glass is tested for its refusals only. The re-invite and delete-record-now buttons have no browser click test (API tests cover them). Escalated deletion requests have no admin screen (A-19). axe finds only part of the accessibility problems: a manual screen-reader and mobile pass is open. No mock change needed (no contract change in this package).