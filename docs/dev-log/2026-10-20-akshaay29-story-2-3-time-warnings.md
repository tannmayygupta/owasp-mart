# Time warnings in the attempt page and the recruiter's monitor (story 2.3)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-2-3-time-warnings` |
| Status | Done (story `done`, merged in pull request 71) |
| Report tag | platform, dashboards |

## Requirements covered
FR-SES-03 (warnings at 15 and 5 minutes, recorded as events), FR-NTF-04 (in-app warnings, recruiter alerts through live updates); D-17, D-22.

## Summary (plain language, 3-5 lines)
A candidate now sees "15 minutes left" and then "5 minutes left" on the attempt page, and the recruiter sees the same mark beside each running candidate on the live monitor. The warnings are worked out in the page from the attempt's deadline (the developer's choice: the client clock). Recording them was already done on the server: the lab engine writes each warning once into the attempt log. Asked by the developer: "if anything is pending then continue".

## Why
The story was left planned until the live hub and the dashboards existed and until the warning source was decided.

## What was built
- `timeWarning` and `WARNING_MINUTES` in `apps/web/lib/api.ts`.
- An alert banner in `apps/web/app/attempt-board.tsx` (candidate and learner attempts with a deadline).
- A "N min left" mark in `apps/web/app/company/candidates/page.tsx`.
- `apps/api/tests/test_time_warnings.py`: the record through the real lab runtime.

## How it works
Both pages already counted down from `deadline_at` once a second. `timeWarning` turns the seconds left into 15, 5 or nothing. The server record is the engine's `time_warning_sent` (attempt log, FR-TIM-04): the tick in the API process writes it once per threshold (a late first tick writes only the urgent one). The deadline reaches the monitor through the live updates (the list reloads on each event).

## Files changed
- `apps/web/lib/api.ts`, `apps/web/app/attempt-board.tsx`, `apps/web/app/company/candidates/page.tsx`.
- `apps/web/test/dashboard-lib.test.mjs`, `apps/api/tests/test_time_warnings.py`.
- Docs: the story plan, this log, `CHANGELOG.md`, `docs/traceability.md` (FR-SES-03, FR-NTF-04), `docs/dev/HANDOFFS.md` (H-359).

## Decisions made
- Warning source: the client clock from `deadline_at` (the developer, 2026-10-20). The question as asked did not mention that the engine already records the warnings on the server; with that, nothing is sent from the browser (a browser-made record could be faked or missed), and no contract changes.
- The thresholds in the page are the engine's defaults (15, 5); a template with other `warning_minutes` would show the defaults in the page (the browser does not see the rules).

## Tests
- `.venv/Scripts/python -m pytest apps/api/tests/test_time_warnings.py -q`: 2 passed.
- `node --test apps/web/test/dashboard-lib.test.mjs`: 9 pass.
- `npx tsc --noEmit` (apps/web): clean; `npm run build`: compiled.
- Traceability: FR-SES-03, FR-NTF-04.

## Evidence
`docs/assets/story-2-3-time-warnings/`.

## Problems met and how they were fixed
None.

## Security notes (vulnerable parts only)
None.

## Limitations and follow-ups
- Not browser-tested; the real-stack test was not run.
- The report's timeline (IF-2) does not list `time_warning_sent`: handoff H-359 to stream L.
- If a template's `warning_minutes` differ from (15, 5), the page shows the defaults; exposing the rules would need an IF-2 change (stream L).
