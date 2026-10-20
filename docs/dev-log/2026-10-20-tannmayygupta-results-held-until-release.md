# Results held until the recruiter releases them (H-355)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | IF-2 2.1.0, OI-15, FR-DSH-02 |

## Requirements covered
H-355, OI-15, FR-DSH-02. Story: `docs/bmad/initiative-lab/backlog/story-results-held-until-the-recruiter-releases-them.md`.

## Summary (plain language, 3-5 lines)
When a company sets "results shown when I release them", the candidate's own score and progress stay hidden until the recruiter presses a Release button on the candidate's report page. Before, only the candidate's page hid them; the API answered anyone who asked directly. The default (results after submit) and learners' practice are unchanged.

## Why
Akshay's stories P-26 and P-27 left the server rule to stream L (handoff H-355).

## What was built
- `vulnmart_attempts/rules.py`: new rule `results_visibility` (default `after_submit`, strict values, kept in the stored rules).
- `ports/engine_attempts.py`: the invite's `results_visibility` is copied into the attempt's rules.
- `lab/api.py`: `getScore` 404 and `listChallenges` masked for the candidate while hidden; new route `releaseResults` (recruiter of the owning company, finished attempts only, idempotent, one log line); `Attempt.results_released` where the rule applies.
- `attempt_log.py`: the event `results_released` (recruiter id only) is on the allow-list.
- IF-2 2.1.0 (additive), examples, fake lab, bundle, clients, COMPAT (Akshay's row `pending`).
- `apps/web`: the assessment page shows results once `results_released`; the recruiter's report page has the Release button; the Start confirmation now says the clock starts when the instance is ready (D-80).

## How it works
The release is a fact in the attempt log, not a new column, so no migration. Hidden means: the owner of a company attempt, not a reviewer, rule `after_release`, no `results_released` line yet.

## Files changed
`packages/py-attempts/src/vulnmart_attempts/{rules,attempt_log}.py`, `apps/api/src/vulnmart/ports/engine_attempts.py`, `apps/api/src/vulnmart/lab/api.py`, `apps/api/tests/{test_lab_results_release,test_lab_contract,test_privacy_wall}.py`, `contracts/api/lab/*`, `contracts/mocks/fake-lab/server.mjs`, `contracts/{CHANGELOG,COMPAT}.md`, `scripts/check_lab_contract.py`, generated clients and bundle, `apps/web` (3 files).

## Decisions made
OI-15 applies (2026-10-18). Release kept in the attempt log (no migration); only results visibility is carried to the attempt (hint and rate settings are decided elsewhere).

## Tests
- `pytest tests/test_lab_results_release.py` — 4 passed (rule storage, candidate hidden then released, release only after the end and only by the company, default unaffected).
- `pytest` of lab results, privacy wall, lab contract, lab api, sequence api, sequence, start and timeline tests — 245 passed. `packages/py-attempts` — 357 passed.
- `node --test scripts/fake-lab.test.mjs scripts/platform-mock.test.mjs` — 29 passed. `pnpm run contracts:rules` — 20 PASS, 0 FAIL. `pnpm run api:check` — OK. `pnpm --filter @vulnmart/web typecheck` — no error.
- Not run: the recruiter page in a browser; the Postgres store with the new rule member (the rules go through the same `to_dict` and `from_dict`).

## Evidence
Command output above.

## Problems met and how they were fixed
- The first test failed on the contract schema (`results_released` unexpected): the contract was changed first in the same story.
- `journal()` never raises, which would hide a failed release; the route appends to the log directly.

## Security notes (vulnerable parts only)
None. A candidate cannot release their own results; the same 404 as for a stranger.

## Limitations and follow-ups
The timeline of the candidate still lists milestones; if results must be hidden there too, that is a later decision. Akshay signs off IF-2 2.1.0 (row `pending`).