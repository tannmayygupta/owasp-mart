# Admin dashboard and privacy wall in every view

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p30` |
| Status | Done (story `built`; marked done once merged, as the developer asked) |
| Report tag | platform, dashboards, privacy, sprint 4 |

## Requirements covered
FR-DSH-05, FR-DSH-06. Story 4 of `epic-dashboards-and-exports` (ref 8.4, task P-30).

## Summary (plain language, 3-5 lines)
An admin now has a dashboard: the approval queue, user management, capacity and force-stop, the scheduled jobs, settings and quotas. Reading people's data there (the user list, the approval queue) is written to the audit log, with the count but never the search text. A new test proves the privacy wall for every operation of the API: each role tries the other parties' data and every try fails, and a new operation cannot be added without saying how its wall is tested. Building that test found that a candidate cannot start an assessment yet (the lab has no start route), handed to Tanmay.

## Why
An admin had routes (P-28) but no dashboard, the admin's reads of personal data were not logged, and nothing proved view by view that no role reads another user's or company's data. Task P-30 of `docs/dev/dev2-akshay.md`.

## What was built
- `AdminOps.queue` and `AdminOps.users` audit the read (`admin.queue_read`, `admin.users_read`: the count, never the search text).
- `test_privacy_wall.py`: every operation classified with the test that proves its wall; one combined world (real lab runtime, company, invite, consent, deletion, view-history and export services) where each role tries the others' data.
- Web: `/admin` (queue with decisions, users with actions, capacity and force-stop, jobs, settings, quotas; the audit log and break-glass are P-31's).

## How it works
`CLASSES` in `test_privacy_wall.py` maps every operation of the bundle to public, self, own id, company or admin, and to the test that proves its wall; a test reads the bundle and fails on an unclassified operation or a missing test. The world is one app: the real `LabRuntime` (fake instance host) with the company, assessment, invite, consent (over the lab's attempt port), deletion, view-history and export services on SQLite, and the session's company resolver. The admin page is a client page over the P-28 routes; the server audits the reads.

## Files changed
- New: `apps/api/tests/test_privacy_wall.py`, `apps/web/app/admin/page.tsx`, the story plan, `docs/assets/p-30-admin-dashboard-and-privacy-wall/`.
- Changed: `apps/api/src/vulnmart/admin/ops.py`, `apps/api/tests/test_admin_ops.py`, `apps/web/lib/api.ts`, `apps/web/app/{nav,dashboard/page}.tsx`, `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/dev/HANDOFFS.md` (H-356), `docs/traceability.md`, `docs/dev/dev2-akshay.md`, `CHANGELOG.md`, `docs/progress/index.html`.

## Decisions made
By the developer (2026-10-20): "start with the next task", "update the tracker automatically". No new decision record: the read audit follows FR-DSH-05 as written.

## Tests
- `test_admin_ops.py` and `test_admin_api.py`: 90 passed (the new read-audit test included).
- `test_privacy_wall.py`: 7 passed (every operation classified; public routes carry nobody's data; self routes and the own export show only the caller's data; another learner, the candidate and a recruiter cannot use Ada's attempt or instance on any route, and nothing changed; nobody else can use Cam's consent, deletion, invite or withdrawal; another company sees none of a company's templates, invites, exports or candidate, while the company itself can; every admin route answers learners, recruiters and candidates like an unknown route).
- Web: `tsc --noEmit` clean, `next build` includes `/admin`.
- Full `pytest apps/api/tests`: **2830 passed, 0 failed, 1 skipped** in 489 s (`pytest-full-2026-10-20.txt`).
- `node --test "scripts/*.test.mjs" "apps/*/test/**/*.test.mjs"`: 1210 tests, 1202 pass, **3 fail on this PC** (the three generator tests: `datamodel-codegen` is not installed here; CI has it). Contract rules **16 PASS, 0 FAIL**, 1 not applicable (no contract changed).
- Stack end to end on real Docker (images rebuilt, build exit 0): start-up, the P-26, P-27, P-28, P-29 and new P-30 tests and tear-down **8 of 8** on the first run (`stack-e2e-2026-10-20.txt`): `/admin` served with the nonce CSP; an admin's user search and queue read each add one `audit_log` row and the search text is in no row; a learner gets 404 REQ-ROUTE-UNKNOWN.
- NOT run: a browser; the privacy wall on Postgres row-level security (the wall test is SQLite; the row-level policies are tested per story on Postgres); CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-30-admin-dashboard-and-privacy-wall/`.

## Problems met and how they were fixed
- The privacy-wall world first used the company tests' origin (403 from the Origin check); it uses the app's origin.
- `active_company` adds the admin each time; the second company is set up step by step.
- Eve's consent try first used made-up notice values and was refused by validation (422) before the ownership check; it uses the real notice, so the 404 proves the wall.
- Found while building the world: a candidate cannot start an assessment over HTTP: the consent creates the attempt in the lab (`ready`), and IF-2 declares `startAttempt` (pending OI-22) but the lab has no such route; handoff H-356 to Tanmay. The P-26 candidate page calls the route as the contract says.

## Security notes (vulnerable parts only)
None: platform code.

## Limitations and follow-ups
- No candidate can start an assessment until stream L adds the start route (H-356, OI-22).
- The audit log view and break-glass are P-31.
- The admin page asks for reasons with the browser's prompt box; a proper form is a later polish.
- Not browser-tested (OI-30).
