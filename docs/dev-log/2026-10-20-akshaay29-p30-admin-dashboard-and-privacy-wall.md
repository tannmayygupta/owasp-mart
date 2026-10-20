# Admin dashboard and privacy wall in every view

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p30` |
| Status | In progress |
| Report tag | platform, dashboards, privacy, sprint 4 |

## Requirements covered
FR-DSH-05, FR-DSH-06. Story 4 of `epic-dashboards-and-exports` (ref 8.4, task P-30).

## Summary (plain language, 3-5 lines)
(Filled at the end of the story.)

## Why
An admin had routes (P-28) but no dashboard, the admin's reads of personal data were not logged, and nothing proved view by view that no role reads another user's or company's data. Task P-30 of `docs/dev/dev2-akshay.md`.

## What was built
- `AdminOps.queue` and `AdminOps.users` audit the read (`admin.queue_read`, `admin.users_read`: the count, never the search text).
- `test_privacy_wall.py`: every operation classified with the test that proves its wall; one combined world (real lab runtime, company, invite, consent, deletion, view-history and export services) where each role tries the others' data.
- Web: `/admin` (queue with decisions, users with actions, capacity and force-stop, jobs, settings, quotas; the audit log and break-glass are P-31's).

## How it works
(Filled at the end of the story.)

## Files changed
(Filled at the end of the story.)

## Decisions made
By the developer (2026-10-20): "start with the next task", "update the tracker automatically". No new decision record: the read audit follows FR-DSH-05 as written.

## Tests
- `test_admin_ops.py` and `test_admin_api.py`: 90 passed (the new read-audit test included).
- `test_privacy_wall.py`: 7 passed (every operation classified; public routes carry nobody's data; self routes and the own export show only the caller's data; another learner, the candidate and a recruiter cannot use Ada's attempt or instance on any route, and nothing changed; nobody else can use Cam's consent, deletion, invite or withdrawal; another company sees none of a company's templates, invites, exports or candidate, while the company itself can; every admin route answers learners, recruiters and candidates like an unknown route).
- Web: `tsc --noEmit` clean, `next build` includes `/admin`.

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
(Filled at the end of the story.)
