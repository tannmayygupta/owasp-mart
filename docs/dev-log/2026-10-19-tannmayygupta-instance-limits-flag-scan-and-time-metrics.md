# Instance limits that free abandoned slots, the flag scan in CI, and the time-metrics 500

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | tannmayygupta |
| Branch / commit | l-instance-limits-flag-scan-metrics |
| Status | Partly done: the three fixes are built and tested; the live effect of the new limits is not yet observed |
| Report tag | lab, L-14, L-19, L-25, FR-INS-04, FR-FLG-08, FR-TIM-01 |

## Requirements covered
L-14 (limits), L-19 (CI scan), L-25 (report 500), L-30 (load check cleanup); FR-INS-04, FR-FLG-08, FR-TIM-01.

## Summary
The load check of 8 learners showed that five instances were still `ready` after 68 minutes: the lab put `idle_minutes` 1440 and `max_minutes` 1440 into every instance, so a closed browser tab held one of the seven slots of vm-i for a whole day, against the L-14 Done-when (60 minutes idle, 4 hours total). The limits are now 60 and 240 for a learner, and for a candidate 120 idle and the template's time limit plus 30 minutes in total. Two older audit findings are closed in the same pull request: a CI step now scans every image layer for flag patterns, and a capture dated before the start no longer turns the report into a 500.

## Why
The load check found the limits; the 2026-10-18 audit listed the other two (L-19 "a script, not a CI job"; L-25 `time_metrics` raises).

## What was built
- `LabRuntime`: `DEFAULT_TEMPLATE_LIMITS` 60 and 240; `_limits_for(rec)` gives a candidate 120 idle and `time_limit_minutes + 30` total (at most 1440); `clamp_to_start` for the time metrics.
- `.github/workflows/images.yml`: the pull request build now uses `--load`, sets up Node and runs `node scripts/scan-flags.mjs --image` on each image; a hit fails the job and values are never printed. A change to the scanner runs the job.
- `scripts/e2e-live.mjs`: the load check stops its own instances through the normal route and checks it. `scripts/live-free-test-instances.mjs` (new): lists, and with `--apply` frees, the instances that earlier test runs left on the live lab; it only touches attempts of throwaway accounts whose address starts with `e2e-`.

## How it works
The orchestrator reaper destroys an instance after `idle_minutes` without activity (counted from ready or the last activity) or after `max_minutes` in total; both come from the limits the platform puts in the create request, which is what changed.

## Files changed
- `apps/api/src/vulnmart/lab/runtime.py`, `apps/api/tests/test_lab_runtime.py`
- `.github/workflows/images.yml`, `scripts/ci-workflow-shape.test.mjs`
- `scripts/e2e-live.mjs`, `scripts/live-free-test-instances.mjs`
- `docs/dev/dev1-tanmay.md`, `docs/traceability.md`, `CHANGELOG.md`

## Decisions made
No ADR. The numbers are the orchestrator's own documented defaults (`lifecycle.py`: 60 and 240). The candidate numbers (120 idle, time limit plus 30 minutes) are mine and are not confirmed by Akshay's template rules; they only avoid cutting off an assessment.

## Tests
- `apps/api/tests/test_lab_runtime.py` 27 passed (two new: the limits, the clamp); `test_lab_api.py` and `test_lab_loop.py` passed.
- `node --test scripts/ci-workflow-shape.test.mjs` 16 passed (one new, for the scan step).
- Local scan of the four built images (shop, mock-services, import-service, bot): CLEAN.
- The dry run of `live-free-test-instances.mjs` on the live host: "would free 10 attempt(s) of 26 test account(s)" (read only, nothing changed).

## Evidence
`docs/assets/production-readiness/e2e-run16-load8.json` (the load check that found it), `e2e-run17-final.json` (journey 34 of 34 on the final deploy).

## Problems met and how they were fixed
- Cleaning the instances the load check left was refused by the permission system (cancelling attempts on the live platform), so the new script exists for the developer to run; they hold five of seven slots until it is run or 24 hours pass.
- The live withdraw proof could not run on the final deploy because of the full capacity (`Busy`); it ran 11 of 11 before, on the code before the last change.

## Security notes
No flag is printed by the scan; the cleanup script only touches throwaway accounts.

## Limitations and follow-ups
- Not observed live: an instance destroyed after 60 idle minutes (needs a deploy of this change and an hour). L-14 stays open.
- The scan covers images, not logs; a scan of a running instance on vm-i is still to be done by hand (L-19 stays open).
- `FR-TIM-04` events on the allow-list are still never emitted (L-25 stays open).