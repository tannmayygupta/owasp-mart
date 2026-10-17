---
title: 'Scoring engine: hiring formula, milestone credit, hint floor, held captures, learner progress, Appendix A reproduced'
type: 'feature'
ticket: '3'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/prd/PRD.md', '{project-root}/docs/design/challenge-specs.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No code computes a score. FR-SCR-01 to 06, 09, 10 and the six worked examples of PRD Appendix A (lines 1885-1892) must be reproduced by tests, with the per-challenge hint floor at zero and held captures kept out until a human decides. Akshay's report screens (P-26) read it through `ReportPort`.

**Approach:** In `packages/py-attempts` add `scoring.py`, a pure function. Input: a `Catalogue` (challenge key to weight W, default the real 11 of challenge-specs section 6.2 with the placeholders 60, 90, 120 and C03 as Medium: 3 Easy x 60, 6 Medium x 90, 2 Hard x 120, sum 960) and per-challenge `Fact(milestone best on any valid path, hint_levels_unlocked, held)`; `Rules` supplies the milestone shares (20, 40, 100) and hint cost percentages per level (10, 20, 30). Output: `ScoreResult(shown 0..1000, per_challenge tuple of (key, milestone, hints_used, points, held), tie_break facts)`. Hiring: `net_c = max(0, W_c x (share(best milestone) - sum(hint pct of unlocked levels)))`; `shown = round_half_up(1000 x sum(net_c) / sum(W_c))`. Learner: `learner_progress` returns stars (0 to 3 by milestone), solved tick (M3) and the no-hints badge (M3 with zero hints); hints never lower it. Adapter `EngineReportPort` in `apps/api/src/vulnmart/ports/engine_reports.py` implements `ReportPort.score` and `challenge` from a `FactSource` Protocol (milestones and hints come from the platform's tables; held captures from the review queue), returns the existing `Score` and `ChallengeResult`, and delegates `evidence` and `integrity_flags` to a wrapped port (stories 6 and L-21 fill them).

**Proposed (decided on the developer's delegation):**
- **D-85:** the score is a pure function of three facts per challenge (best milestone, hint levels unlocked, held flag) and the weight table. Time, wrong submissions, decoy submissions, technique labels and other players' results are not parameters, so FR-SCR-04, 05, 02 (label) and the no-decay rule hold by construction; a test inspects the function signature and that a fact with extra keys is refused.
- **D-86:** rounding is exact half-up in integer arithmetic (not Python's `round`, which rounds half to even): `shown = (2000 x S + T) // (2 x T)` with `S = sum W_c x max(0, share - hintpct)` and `T = 100 x sum W_c`; per-challenge `points` is the same half-up of `W x pct / 100`. Hint cost is the cumulative sum of the levels unlocked (Appendix A: two hints = 10% + 20% = 30%), floored at zero per challenge. Weights come from the catalogue table, never hard-coded in the function; the template's `hint_cost_pct` may replace the percentages.
- **D-87:** a held capture is computed as if the held milestone had not been reached (the challenge falls back to its best non-held milestone), flagged `held` in the result, and is never zeroed; accepting the capture (reviewer, story 6) changes the fact and the score is recomputed from facts every time (no stored running total is trusted). Learner mode shows stars, tick and badge, never a hint penalty.

## Boundaries & Constraints

**Always:** integer arithmetic only (no float); the function is deterministic and has no side effect; unknown challenge key, milestone below `none`, hint level outside 1 to 3 or a duplicate hint level is refused with a `ValueError`; the score is always within 0 and 1000; the shown score of "all 11 captured, no hints" is exactly 1000; the tests contain every Appendix A row verbatim and also the same rows through the real catalogue; the adapter never returns a score for a purged attempt (it maps `AttemptNotFound` and `AttemptGone` as `ReportPort` says). Test weights and results are numbers, never flag values or secrets.

**Never:** reading the clock, an event log or a request in the scoring function (the facts are derived by L-21 and the platform, outside it); subtracting for wrong or decoy submissions; a score above 1000 or below 0; storing flags; changing `ReportPort`'s existing calls or `Score`/`ChallengeResult` (additions only, none planned); changing contracts or error codes; editing `apps/api` outside `ports` and `tests`; hypothesis or any new dependency (use exhaustive loops); the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Appendix A 1 | Medium W 90, M3, no hints | 90 | none |
| Appendix A 2 | Medium, M2 (exploit evidence, no flag) | 36 | none |
| Appendix A 3 | Hard W 120, M3, hints 1 and 2 | 84 | none |
| Appendix A 4 | Easy W 60, M1, hint 1 | 6 | none |
| Appendix A 5 | Easy W 60, M1, hints 1, 2 and 3 | 0, not -24 | none |
| Appendix A 6 | all 11 at M3, no hints | shown 1000 | none |
| Floor only on its own challenge | C01 floored to 0 by hints, C02 at M3 | C02 points unchanged | none |
| Same milestone by two paths | M2 reached twice | counted once | none |
| Wrong or decoy submissions | any number | no change (not an input) | none |
| Time | any time spent | no change (not an input) | none |
| Held capture | C05 M3 held, M2 earlier | C05 counts at M2, flagged held | none |
| Reviewer accepts | held cleared | C05 counts at M3, score recomputed | none |
| Rounding half | S gives x.5 | rounds up (half-up) | none |
| Hint without progress | milestone none, 3 hints | 0 for that challenge, total not negative | none |
| Learner | M3 with 2 hints | 3 stars, solved, no badge | none |
| Learner badge | M3, zero hints | badge awarded | none |
| Bad input | hint level 4, unknown key C12 | refused | `ValueError` |

</frozen-after-approval>

## Code Map

- `packages/py-attempts/src/vulnmart_attempts/scoring.py` (new), and the weight table `catalogue.py` (new); `rules.py` of story 1 holds the shares and hint percentages.
- `packages/py-attempts/tests/test_scoring_appendix_a.py` (every Appendix A row, quoted with its line in `docs/prd/PRD.md:1885-1892`), `test_scoring_properties.py` (exhaustive loops: for every milestone x every subset of hint levels x each tier weight: within 0 and weight; milestone-monotone; hints never raise; per-challenge independence; permutation of challenges does not change the total; a full 11-challenge sweep from all-`none` to all-M3 is non-decreasing), `test_scoring_inputs.py` (signature has no time, no submission input; refusals), `test_learner_progress.py`, `test_scoring_held.py`.
- `docs/design/challenge-specs.md:548-579` (read) -- the tier mapping, total 960 with C03 = 3 (D-32, DC-6); and `docs/prd/PRD.md:787-843` (FR-SCR-01 to 10), `:1874-1900` (Appendix A).
- `apps/api/src/vulnmart/ports/reports.py:14-45` (`CHALLENGE_KEYS`, `Milestone`, `ChallengeResult`, `Score`) -- the adapter returns these; `:66-87` the Protocol.
- `apps/api/src/vulnmart/ports/lab_fakes.py:104-170` (`FakeReportPort`) -- pattern and the protocol test.
- `apps/api/tests/test_engine_reports.py` (new) -- `isinstance(EngineReportPort(...), ReportPort)`, an Appendix A case through the adapter, `AttemptGone` mapping, the milestone names (`none`, `M1`, `M2`, `M3`) equal the library's.
- `apps/api/src/vulnmart/scoring/__init__.py` (read) -- the module folder P created for stream L; tables `milestones`, `integrity_flags`, `score_snapshots` are listed in `contracts/db/table-owners.yaml` (owner `scoring`); the fact source over those tables is Akshay's migration (H-329).
- Docs: dev-log, CHANGELOG, traceability (FR-SCR-01 to 06, 09, 10), HANDOFFS rows (H-329; closes the L-23 line of "Others are waiting on you"), evidence `docs/assets/story-7-3-scoring/` (real pytest output), `docs/dev/dev1-tanmay.md` L-23 stays unticked until the developer confirms.

## Tasks & Acceptance

**Execution:**
- [ ] `catalogue.py`, `scoring.py` -- formula, half-up rounding, learner progress (D-85, D-86, D-87)
- [ ] `engine_reports.py` in `apps/api/.../ports` -- `EngineReportPort` and the `FactSource` Protocol with an in-memory source
- [ ] tests -- all rows above, every Appendix A example, the exhaustive property loops
- [ ] handoff H-329 and docs as in the Code Map

**Acceptance Criteria:**
- Given the six rows of PRD Appendix A, then the results are 90, 36, 84, 6, 0 and 1000 shown, in the library test and again through `EngineReportPort`.
- Given hints that exceed a challenge's raw points, then that challenge is 0 and every other challenge is unchanged.
- Given a held capture, then the score excludes it, the result flags it, and accepting it restores the credit on the next computation.
- Given two attempts with equal captures and different times, then the scores are equal (the function takes no time).
- Given the exhaustive loops, then every score is within 0 and 1000 and no hint raises a score.
- Given a learner at M3 with zero hints, then the badge is awarded; with hints it is not, and the stars are unchanged.

## Verification

**Commands (Windows dev PC, from the repository root):**
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests` -- expected: pass
- `uv run --locked --package vulnmart-api pytest -q` -- expected: pass (including `test_engine_reports.py`)
- `uv lock --check` -- expected: pass
- `node scripts/check-contract-rules.mjs`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass

**Provable locally:** the formula, every Appendix A example, held-capture handling, learner progress and the adapter shape. **Needs the live platform and other streams:** real milestones and hints per attempt (L-21 milestone engine and the hint unlock table, Akshay's migration), the held-capture review decision (story 6, OI-38), and the recruiter report screen showing the number (P-26); so a real end-to-end score on the demo stack is a runbook step of the integration epic, not claimed here.

## Handoffs to add in the same commit

- **H-329 (to P-26, P-05, Akshay):** `ReportPort.score` will be served by `EngineReportPort` from a `FactSource`: per attempt and challenge key the best milestone, the list of hint levels unlocked (from `hint_unlocks`) and whether a capture is held (from the review queue). Please provide that read over the `milestones`, `hint_unlocks` and `integrity_flags` tables (or tell L the column names), and cache nothing: the score is recomputed from facts on every read or on `attempt.score_updated`. The shown number is the 0 to 1000 integer; the screens show time beside it and never compute points. Default if no answer: L ships the in-memory fact source and the demo seeds facts through it.

## Implementation Notes

Built 2026-10-17 (library part). Real result: `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests` gave `221 passed` (153 existing + 68 new); raw output in `docs/assets/story-7-3-scoring-engine/test-output.txt`. `uv lock --check`, `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs` passed. Public API of story 7.1 unchanged.

- New: `catalogue.py` (`Catalogue`, `ScoringRules`), `scoring.py` (`Fact`, `compute_score`, `ScoreResult`, `learner_progress`, `learner_overview`, `Milestone`); exports added to `__init__.py`. Tests: `test_scoring_appendix_a.py` (all six rows with PRD lines, alone and through the real catalogue, plus the challenge-specs 94/125/63 figures), `test_scoring_properties.py`, `test_scoring_inputs.py`, `test_learner_progress.py`, `test_scoring_held.py`.
- Deviation 1: the percentages live in a new `ScoringRules` (catalogue.py), not in story 7.1's `Rules`, so `Rules.to_dict` (the `attempts.rules` jsonb shape) is not changed. Template override can build a `ScoringRules` later.
- Deviation 2: `Fact` has a fourth field `fallback` (the best non-held milestone), needed to compute a held capture at the previous milestone; it is only valid with `held`.
- NOT built: `EngineReportPort` and its `FactSource` and `apps/api/tests/test_engine_reports.py`. `apps/api/pyproject.toml` does not depend on `vulnmart-attempts`, and stream L may not edit it. Handoff H-328 need: Akshay adds `vulnmart-attempts = { workspace = true }` to the `vulnmart-api` dependencies and sources (and the Dockerfile copy of `packages/py-attempts`), then the adapter and its test are added. `uv run --package vulnmart-api pytest -q` was not run (apps/api untouched).
- Not done here (main session): H-329 row, dev-log, CHANGELOG, traceability.