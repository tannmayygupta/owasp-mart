---
title: 'Cohort board and ranking aid (L-28)'
type: 'feature'
ticket: '7'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/prd/PRD.md']
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** FR-SCR-07 (no global leaderboard; an optional private cohort board) and FR-SCR-08 (a tie-break order as an aid only) are open (OI-26). Story 3's `ScoreResult` already returns the tie-break facts (`TieBreak`), so only the ordering and the scoped view are missing.

**Approach:** In `packages/py-attempts` add `ranking.py`, pure and dependency-free: `ranking_key(score_result, last_capture_at, active_seconds)` returns a tuple that sorts best first: higher shown score, then more full captures, then lower total hint cost, then lower active time, then earlier last capture (an attempt with no capture sorts last on that key), then attempt id for a stable order. `suggest_order(rows)` returns the rows in that order with, for each row, the plain-language reason of the first key that separated it from the next ("same score; more full captures"). No row is ever dropped, hidden or marked failed, and every result carries the label "ranking aid, the recruiter decides". In `apps/api/src/vulnmart/ports/` add `EngineCohortPort.cohort(org_id, assessment_id) -> CohortView`: it lists only attempts of that organisation and that assessment that are `reported` (or `submitted` with no open held capture), takes the organisation from the passed scope, refuses a missing or foreign org, and returns the aid order plus the facts (shown score, captures, hint cost, active seconds). There is no route, no global query and no cross-organisation call in this story; the screen is Akshay's.

**Proposed (decided on the developer's delegation):**
- **D-93 (OI-26):** build the private cohort view for the pilot only, scoped to one organisation and one assessment, off unless the assessment turns it on (`cohort_board` flag in the template, default false). Adopt the research tie-break order as the aid; it never ranks anyone out, never reads another organisation's data and never exposes a candidate to other candidates (recruiter view only). No global or public leaderboard exists anywhere: a test greps the ports package for a function that lists across organisations.

## Boundaries & Constraints

**Always:** pure ordering (same input, same order); equal rows keep a stable order by attempt id; a held-open or withdrawn attempt is not in the board; the organisation always comes from the scope argument, never from a candidate id; time is shown, never scored.

**Never:** a public or global ranking page or query (FR-SCR-07); auto-rejecting or hiding a candidate; showing candidate names (ids only, the screen resolves names under its own access rules); contracts or error codes; a new dependency; editing `apps/api` outside `ports` and `tests`; the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Score order | 640 vs 590 | 640 first | none |
| Tie on score | more full captures wins | reason says so | none |
| Tie on score and captures | lower hint cost wins, then lower active time, then earlier last capture | reason names the separating key | none |
| Full tie | identical facts | order by attempt id, reason "no difference" | none |
| No capture | attempt with zero captures | sorts last on the last-capture key | none |
| Board off | `cohort_board` false | `CohortDisabled` | `CohortDisabled` |
| Foreign org | scope org differs from assessment org | refused | `CohortForbidden` |
| Held open | `submitted` with an open held capture | not listed | none |

</frozen-after-approval>

## Code Map

- `packages/py-attempts/src/vulnmart_attempts/scoring.py` -- `ScoreResult`, `TieBreak`; `store.py` -- `AttemptRecord`.
- `apps/api/src/vulnmart/ports/scope.py` -- `ScopePort`; `ports/engine_reports.py` (story 3) for the score facts; `ports/errors.py` (additive errors).
- New: `ranking.py`, `ports/engine_cohort.py`; tests `packages/py-attempts/tests/test_ranking.py`, `apps/api/tests/test_engine_cohort.py`.
- docs: dev-log, CHANGELOG, traceability FR-SCR-07, FR-SCR-08, evidence `docs/assets/story-7-7-cohort-aid/`, handoff row.

## Tasks & Acceptance

**Execution:**
- [ ] `ranking.py` + tests: every key separately, full tie, no capture, determinism, permutation property (shuffled input gives the same output)
- [ ] `EngineCohortPort` + tests: org scoping, disabled board, held-open excluded
- [ ] no-global-leaderboard test (grep of `ports/` for a cross-organisation listing)
- [ ] docs -- handoff, dev-log, CHANGELOG, traceability, story `built`

**Acceptance Criteria:**
- Given rows that tie on score, then the order follows captures, hint cost, active time, last capture, and each row says why.
- Given another organisation's scope, then nothing is returned and an error is raised.
- Given any input, then no row is dropped and no cross-organisation function exists.

## Handoffs (proposed, add rows in the same commit)

- To Akshay (P-26/P-27 recruiter screens): `cohort(org_id, assessment_id)` is the whole API; show it only when the assessment has `cohort_board` on and label the order "ranking aid". The template field `cohort_board` (default false) is an addition to the assessment template for you to store (OI-26 decision, D-93). Default if no answer: board off.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests/test_ranking.py`
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_engine_cohort.py`
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`
