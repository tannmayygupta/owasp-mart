# 0041. Attempt clock, expiry sequence and scoring rules

- **Status:** Proposed (decided on the developer's delegation; to be confirmed)
- **Date:** 2026-10-17
- **Deciders:** Tanmay (by delegation to Claude Code)
- **Requirements:** FR-SES-01 to FR-SES-08, FR-TIM-05, FR-SCR-01 to FR-SCR-06, FR-SCR-09, FR-SCR-10, PRD Appendix A, OI-22, OI-25, D-80 to D-88; handoffs H-87, H-127, H-128, H-129

## Context
Nothing decided when an assessment attempt starts or ends, in which order expiry steps happen, or how a score is computed. The clock start was open (OI-22). The platform's `AttemptPort` and `ReportPort` only had provisional fakes. Built so far: the rules library, the engine and the scoring function in the dependency-free package `packages/py-attempts`, tested with fake clock, store and instance control. Not built: the API adapters, the database store, the scheduler wiring, the recruiter screens.

## Options considered
1. **Clock starts when the instance is ready, stamped by the server (chosen, D-80).** Cold start never counts (FR-TIM-05); the Start button only asks for the instance.
2. **Clock starts when the candidate presses Start.** Cold start would count against the candidate and an attempt could sit in `ready` with a running clock. Not chosen.
3. **Rules in `apps/api` (rejected for D-81):** stream L may write only ports and tests there; a separate package serves both the API and the tests.
4. **Python `round` for the shown score (rejected for D-86):** it rounds half to even; Appendix A needs half-up.

## Decision
- **D-80** (OI-22) The attempt moves `ready` to `running` when the instance is ready; `started_at` = `ready_at`; `deadline_at` = `started_at` + time limit. If the instance never becomes ready the clock never starts.
- **D-81** Rules and engine live in one dependency-free package `packages/py-attempts` (`vulnmart-attempts`, standard library only); thin port adapters will live in `apps/api/src/vulnmart/ports/`.
- **D-82** All timing is absolute UTC instants from an injected clock; the deadline is stored once; browser clock and connection are never inputs. Grace is 60 s after the deadline for submissions only; warnings at 15 and 5 minutes left; all numbers are placeholders held in `Rules` (OI-25).
- **D-83** Expiry: `running` to `expired` to `submitted` in one tick with `submitted_at` = `deadline_at`, then access `frozen`, `frozen_until` = `submitted_at` + 15 minutes, then destroy once `frozen_until` has passed. The freeze is a column and the instance access value, not a state. After a scheduler outage, freeze and destroy happen in the same tick. A manual submit uses `submitted_at` = now.
- **D-84** The engine is the only writer of attempt state; every step is idempotent, uses compare-and-set on a version, and a failed `freeze` or `destroy` leaves the record unchanged for the next tick. The scheduler runs `tick()` every 15 s (placeholder). One attempt per `(user_id, template_id)` (the developer's instruction; the plan text said per invite).
- **D-85** The score is a pure function of three facts per challenge (best milestone, hint levels unlocked, held flag) and the weight table; time, wrong or decoy submissions, technique labels and other players are not parameters.
- **D-86** Exact half-up rounding in integer arithmetic; hint cost is the cumulative sum of the levels unlocked, floored at zero per challenge; weights come from the catalogue table (3 Easy x 60, 6 Medium x 90, 2 Hard x 120, C03 as Medium, sum 960; shares 20, 40, 100; hint costs 10, 20, 30; all placeholders).
- **D-87** A held capture is computed as if the held milestone had not been reached, flagged `held` and never zeroed; the score is recomputed from facts every time; learner mode shows stars, tick and badge and never a hint penalty.
- **D-88** `reported` is reached only by `mark_reported`, after the final score snapshot and only when no held capture is open.

## Consequences
- Easier: the same rules for the API and the tests; every Appendix A example is a test; nothing depends on a browser clock.
- Harder: the API must depend on the new package (H-128, needs `apps/api/pyproject.toml` and Dockerfile lines that stream L may not edit); a SQL `AttemptStore` and a fact source are Akshay's.
- To watch: the 15 s tick granularity; the destroy claim lease of 60 s; the percentages live in `ScoringRules`, not in the template yet; held-capture review (OI-38) has no owner.
- Not proved live: the real `attempts` table, the scheduler, the gate refusing requests while frozen, the orchestrator destroying the instance after 15 minutes. These need a developer runbook run.

## Evidence
Local tests only: `docs/assets/story-7-1-attempt-rules/test-output.txt` (153 passed), `docs/assets/story-7-2-attempt-engine/test-output.txt` (254 passed in total), `docs/assets/story-7-3-scoring-engine/test-output.txt` (221 passed in total, before 7.2 was added). Sources are the PRD (FR-SES, FR-SCR, Appendix A lines 1885-1892), `docs/architecture/04-data-and-state.md` section 10.1 and `docs/design/challenge-specs.md` section 6.2; no outside research was cited by the plans.
