---
title: "In-app time warnings and recruiter alerts"
ticket: 3
status: built
---

# In-app time warnings and recruiter alerts

**Covers:** FR-NTF-04, FR-SES-03. **After:** story 2.2, the live hub (P-22, P-23), the dashboards (P-26, P-27).

## The open point, answered (2026-10-20)
The warning source: the developer chose "client clock from deadline_at". Found while planning: the engine of stream L already records the warnings on the server
(`vulnmart_attempts.engine`, the attempt log's `time_warning_sent` with `minutes_left`, once per threshold, by the tick that `lab/background.py` runs in the API process).
So the pages only show the warnings, from `deadline_at` on the reader's clock; nothing is recorded from the browser and no contract changes.

## Plan
1. `timeWarning(secondsLeft)` in `apps/web/lib/api.ts`: 15 from fifteen minutes left, 5 from five, else null; the engine's default thresholds (15, 5).
2. The attempt page (`attempt-board.tsx`): an alert banner at each warning.
3. The recruiter's live monitor (`company/candidates/page.tsx`): a "N min left" mark beside the time left; the list reloads on live events and the time ticks every second.
4. Tests: the helper (`dashboard-lib.test.mjs`); the server record through the real lab runtime (`test_time_warnings.py`).
5. Handoff H-359 to stream L: the IF-2 timeline does not list `time_warning_sent` (TIMELINE_TYPES), so the report's timeline does not show the warnings.

**Commands:**
- `.venv/Scripts/python -m pytest apps/api/tests/test_time_warnings.py -q` -- result: 2 passed
- `node --test apps/web/test/dashboard-lib.test.mjs` -- result: 9 pass
- `npx tsc --noEmit` and `npm run build` in `apps/web` -- result: clean, compiled

**Results (2026-10-20):** as above; evidence `docs/assets/story-2-3-time-warnings/`.
