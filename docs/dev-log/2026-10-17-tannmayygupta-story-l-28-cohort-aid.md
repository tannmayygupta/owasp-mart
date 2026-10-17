# Cohort board and ranking aid (L-28)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet |
| Status | Partly done (ordering and the scoped cohort rules in the library done and tested; the `EngineCohortPort` adapter in apps/api is not built) |
| Report tag | attempts, scoring and integrity |

## Requirements covered
FR-SCR-07, FR-SCR-08, D-22, D-93 (OI-26).

## Summary (plain language, 3-5 lines)
Added the suggested tie-break order for recruiters and the rules of the private cohort view: one organisation, one assessment, off unless turned on, no one hidden or dropped.

## Why
FR-SCR-08 needs an order and FR-SCR-07 needs the board to stay private and scoped.

## What was built
`ranking.py` (`ranking_key`, `suggest_order`, `RANKING_LABEL`) and `cohort.py` (`build_cohort`, `on_board`, `CohortDisabled`, `CohortForbidden`).

## How it works
Key, best first: higher shown score, more full captures, lower hint cost, lower active time, earlier last capture (no capture or no active time sorts last), then attempt id. Each row carries the reason of the first key that separated it from the next ("same score; more full captures", "no difference" for a full tie) and the label "ranking aid, the recruiter decides". `build_cohort` refuses a missing or foreign organisation first, then a board that is off, then lists only `reported` attempts and `submitted` ones with no open held capture.

## Files changed
- `packages/py-attempts/src/vulnmart_attempts/ranking.py`, `cohort.py` - new
- `packages/py-attempts/tests/test_ranking.py`, `test_cohort.py` - new

## Decisions made
D-93 as written (board for the pilot, default off, research order adopted); not confirmed beyond the developer saying to proceed. My assumption: the single configurable point is the `board_enabled` argument, which the platform reads from the template's `cohort_board` field (default false).

## Tests
`uv run --locked --package vulnmart-attempts pytest packages/py-attempts/tests/test_ranking.py packages/py-attempts/tests/test_cohort.py -q` -> 20 passed (includes a 25-shuffle permutation check). Full package: 350 passed.

## Evidence
Terminal output above.

## Problems met and how they were fixed
None.

## Security notes (vulnerable parts only)
Not a vulnerable part. Rows hold ids only. The "no global listing" test checks that the cohort module has only `on_board` and `build_cohort`, and that scope comes first; the planned grep of `apps/api/.../ports/` is not done.

## Limitations and follow-ups
Not built: `EngineCohortPort.cohort(org_id, assessment_id)` in apps/api ports, its tests, the ports-package grep test, and the handoff row to Akshay (template field `cohort_board`).
