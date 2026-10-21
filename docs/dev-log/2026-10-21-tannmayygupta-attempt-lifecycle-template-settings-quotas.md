# The attempt lifecycle, the template settings, the quotas and the rate limits

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | `wp-a-attempt-lifecycle` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | F-05, F-06, F-07, F-08, FR-SES-07, IF-2 2.2.0, ADR 0071 |

## Requirements covered
Story 12 (`docs/bmad/initiative-lab/backlog/story-attempt-lifecycle-template-settings-quotas.md`), the wiring audit and the role-scenario audit.

## Summary (plain language, 3-5 lines)
A recruiter's invite and the candidate's attempt now move together: Start makes the invite `started`, a revoked or expired invite leaves nothing startable, and a repeat invite gets its own attempt. The template's challenge subset, hints, hint cost and flag limit now apply in the lab, the admin's quotas are enforced, costly routes have rate limits, a deployed API refuses to fall back to fakes, and a recruiter can cancel an attempt.

## What was built
- `assessments/service.py`: `start_gate`, `_cancel_attempt`, cancel on `revoke` and in `expire_due`, next generation for a repeat invite. `lab/api.py`: `invite_gate`/`mark_invite_started` on Start, `cancelAttempt`, `throttle`, `hints_enabled`, hint cost, subset in list/hints/score. `lab/runtime.py`: `keys_for`, `hints_on`, `hint_cost_pct`, `scoring_profile`, `_check_quota`, fail-closed guards, learner rules flag mode. `py-attempts` Rules: five new members. `flags/submit.py`: per-minute limit. `ports/engine_reports.py`, `engine_cohort.py`: a scoring profile per attempt. Settings: `instance_assessment_reserve` and four `rate_*`. IF-2 2.2.0 (`cancelAttempt`), mock, bundle, clients.

## How it works
See ADR 0071.

## Files changed
The files above, `contracts/*`, the new tests `test_invite_lifecycle.py` (8), `test_template_settings_reach_the_lab.py` (4), `test_lab_quota.py` (4), `test_lab_production_guard.py` (7), one added case in `test_activity_gate.py`, and repairs of tests that assumed the old behaviour (`test_lab_runtime.py`, `test_lab_pg.py`, `test_activity_gate.py`, `test_lab_live.py`).

## Decisions made
ADR 0071: hint cost is the template percentage times the level; reserve of 2 places for assessments; learner practice never holds a capture; invite and attempt lifecycle as above.

## Tests
- New and changed test files: 8 + 4 + 4 + 7 passed; `test_lab_contract.py`, `test_privacy_wall.py`, `test_lab_runtime.py`, `test_lab_pg.py` (with Postgres), `test_activity_gate.py`, `test_lab_live.py` passed after the repairs; py-attempts 357 passed; `node --test scripts/fake-lab.test.mjs` 9 passed; `pnpm run contracts:rules` 0 FAIL, `api:check` OK.
- Full API suite with Postgres (no Valkey), run in this branch: see the PR description for the final numbers.
- Not run: a live check of the new routes (deploy follows after merge).

## Evidence
Command output above.

## Problems met and how they were fixed
- Turning hints off for candidates by default broke two Postgres lab tests and one runtime test that used default rules; they now create the attempt with the template's hints on.
- Learner practice used the hold mode, which no one could release; five tests used a learner as a stand-in for an assessment and now use a company attempt.
- A fake operation in a contract test was named like the real `cancelAttempt` and broke the bundle; renamed.
- The cancel route first used `reviewable`, which answers 410 for a cancelled attempt; it now answers 409 for a repeat.

## Security notes (vulnerable parts only)
None. Authorization is unchanged: the owner, the recruiter of the company, and the 404 for anyone else.

## Limitations and follow-ups
Not done in this story: candidate write-up submission (the flag is stored), withdrawal mail and consent record, resume after withdrawal, extra time, a recruiter UI button for cancel (the web side is another branch). These stay in the role-scenario matrix as open.