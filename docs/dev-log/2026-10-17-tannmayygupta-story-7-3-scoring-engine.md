# Scoring engine: hiring formula, milestone credit, hint floor, held captures (story 7.3)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (commit of this story follows; not committed when this entry was written) |
| Status | Partly done: pure scoring library built and its tests passed locally; the `ReportPort` adapter and any live score are not built |
| Report tag | scoring, hiring formula, Appendix A, FR-SCR-01 to FR-SCR-06, FR-SCR-09, FR-SCR-10, D-85, D-86, D-87 |

## Requirements covered
FR-SCR-01 to 06, 09, 10 (library part); PRD Appendix A examples; decisions D-85, D-86, D-87 (new, Proposed); ADR 0041; handoff H-329 (new). Task L-23 (stays unticked).

## Summary (plain language, 3-5 lines)
A pure function now turns three facts per challenge (best milestone, hint levels unlocked, held or not) and a weight table into a score from 0 to 1000. Time, wrong submissions and other players are not inputs, so they cannot change it. Hints never push one challenge below zero, a held capture counts as if it had not happened until a human decides, and learner mode gets stars, a tick and a badge instead of a score.

## Why
No code computed a score. The six worked examples of PRD Appendix A must be reproduced by tests and the report screens (P-26) need a number from `ReportPort`.

## What was built
- `packages/py-attempts/src/vulnmart_attempts/catalogue.py`: `Catalogue` (weights of the 11 challenges: 3 Easy x 60, 6 Medium x 90, 2 Hard x 120, C03 as Medium, sum 960) and `ScoringRules` (milestone shares 20, 40, 100 and hint costs 10, 20, 30).
- `scoring.py`: `Fact`, `compute_score`, `ScoreResult`, `learner_progress`, `learner_overview`, `Milestone`.
- Tests: `test_scoring_appendix_a.py` (all six rows with PRD line numbers, alone and through the real catalogue, plus the challenge-specs 94, 125 and 63 figures), `test_scoring_properties.py`, `test_scoring_inputs.py`, `test_learner_progress.py`, `test_scoring_held.py`.
- Not built: `EngineReportPort`, its `FactSource` and `apps/api/tests/test_engine_reports.py` (stream L may not edit `apps/api/pyproject.toml`; the dependency is H-328).

## How it works
Hiring: per challenge `net = max(0, W x (share(best milestone) - sum of hint percentages unlocked))`; the shown score is the exact half-up rounding of `1000 x sum(net) / sum(W)`, in integer arithmetic only (not Python `round`, which rounds half to even). A held capture falls back to the best non-held milestone and is flagged `held`; accepting the capture changes the fact and the score is recomputed from facts every time. Unknown challenge key, hint level outside 1 to 3, a duplicate level or a milestone below `none` raise `ValueError`.

## Files changed
- `packages/py-attempts/src/vulnmart_attempts/{catalogue,scoring}.py`, `__init__.py` (exports) - new / changed
- `packages/py-attempts/tests/test_scoring_*.py`, `test_learner_progress.py` - new
- `docs/assets/story-7-3-scoring-engine/test-output.txt` - raw output
- Docs: this entry, ADR 0041, `initial.md` (D-85 to D-87), HANDOFFS (H-329), CHANGELOG, traceability, dev1 file

## Decisions made
D-85 (score is a pure function of three facts and the weight table), D-86 (exact half-up integer rounding, cumulative hint cost, floor at zero per challenge), D-87 (held capture computed as if not reached, recomputed from facts, learner mode shows no hint penalty). Deviations inside the plan: the percentages live in a new `ScoringRules` and not in story 7.1's `Rules`, so the `attempts.rules` jsonb shape did not change; `Fact` has a fourth field `fallback`, valid only with `held`. See `docs/adr/0041-attempt-clock-scoring-and-expiry.md`.

## Tests
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests`: 221 passed in 0.52 s (153 existing, 68 new). Raw output in the evidence file.
- `uv lock --check`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`: pass (plan notes).
- NOT run: `uv run --package vulnmart-api pytest -q` (apps/api untouched), `check-contract-rules`.
Traceability rows: FR-SCR-01 to 06, 09, 10.

## Evidence
`docs/assets/story-7-3-scoring-engine/test-output.txt`.

## Problems met and how they were fixed
None recorded in the plan notes. The `EngineReportPort` could not be added because it needs the API to depend on the new package, which stream L may not edit; the need is in H-328.

## Security notes (vulnerable parts only)
Not a vulnerable part. The function takes no time, event log or request, so a player cannot influence the score except by real progress. No flag value appears in tests (weights and results are numbers).

## Limitations and follow-ups
- No real end-to-end score: real milestones and hints need the milestone engine (story 6.3 in a fake store), Akshay's tables (H-329, H-333) and the held-capture review decision (OI-38).
- The recruiter screen (P-26) is not built.
- The adapter `EngineReportPort` is still to be built once the API depends on the package.
