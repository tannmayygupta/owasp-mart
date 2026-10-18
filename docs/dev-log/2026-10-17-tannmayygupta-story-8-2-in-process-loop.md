# In-process loop test: instance, signed events, milestones, attempt clock and score (story 8.2)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet |
| Status | Done (in-process, no Docker) |
| Report tag | integration, loop test |

## Requirements covered
LX-1 (in-process part), FR-SES-02, FR-SES-04, FR-SES-05, FR-SES-09, FR-SCR-01, FR-SCR-02, FR-SCR-03, FR-DET-01, FR-ACH-07, FR-TIM-01 to 03.

## Summary
One pytest, `apps/api/tests/test_lab_loop.py`, runs a whole assessment through `LabRuntime` on a fake clock and `FakeInstanceHost`: instance ready starts the clock, a signed IF-4 event credits C01 (a replay and a forged signature change nothing), a pasted flag credits C02, a hint is unlocked, a capture on C03 is held by an activity gate, a reset gives a new epoch (the old flag no longer credits, the reset is counted, the clock does not move), the deadline passes (auto-submit, freeze, destroy), and the score stays at the hand-computed number.

## Why
It is the demo's fast, CI-safe proof that the pieces work together, and it runs in well under a second.

## What was built
`apps/api/tests/test_lab_loop.py` (one scenario) and `apps/api/tests/test_lab_review_reset_withdraw.py` (held-capture review accept and reject, wrong reviewer, three resets then refusal, withdrawal and deletion after seven days).

## How it works
The expected score is written as a number computed from the weights (C01 60, C02 90, total 960, M3 = 100 percent, hint level 1 = 10 percent): (60 + 81) = 141 points, 1000 x 141 / 960 = 146.875, half up = 147. The held capture on C03 stays out of the score; the attempt stays `submitted` (not `reported`) while a capture is held (D-88).

## Files changed
See "What was built".

## Decisions made
None new. The activity gate in the test is a stand-in that denies C03; the real activity-versus-capture check (FR-ACH-02) is not wired into the runtime.

## Tests
`uv run --locked --package vulnmart-api pytest apps/api/tests/test_lab_loop.py apps/api/tests/test_lab_review_reset_withdraw.py -q`: 1 + 7 passed. Both also ran inside the runs recorded in the story 8.1 dev-log.

## Evidence
`docs/assets/story-8-1-lab-runtime/pytest-lab.txt` (runtime, routes, image files and loop tests, 40 passed).

## Problems met and how they were fixed
The first version of the loop test built the runtime twice to pass a gate; `build_lab_runtime` now takes `gate`. Two assertions in the review tests were first written so they could never fail (`... if hasattr(...) else True`); replaced by direct checks of the audit rows.

## Security notes
No flag value is printed or stored; the test derives flags from the per-process random keys.

## Limitations and follow-ups
FR-ACH-01 and FR-ACH-02 (submission limit coverage and the real activity gate) are not tested here. The Docker loop is story 8.3.
