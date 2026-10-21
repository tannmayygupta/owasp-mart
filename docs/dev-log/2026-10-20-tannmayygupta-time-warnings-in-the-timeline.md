# Time warnings in the timeline (H-359)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | IF-2 2.0.0, timeline, FR-SES-03 |

## Requirements covered
H-359, FR-SES-03, FR-TIM-04. Story: `docs/bmad/initiative-lab/backlog/story-time-warnings-in-the-timeline.md`. Plan: `docs/plans/2026-10-20-handoffs-h355-to-h359.md`.

## Summary (plain language, 3-5 lines)
The engine already writes the 15 and 5 minute time warnings to the attempt log. The timeline route now lists them as `attempt.time_warning` with `minutes_left`, so a recruiter's report shows when the candidate was told time was running out. The contract is IF-2 2.0.0 (the repository rule treats a new value of a response enum as breaking); the recruiter's page shows the warning in words.

## Why
Akshay's story 2.3 showed the warnings in the pages from `deadline_at` and asked whether the timeline should list the server record.

## What was built
- `lab/api.py`: the event `time_warning_sent` maps to `attempt.time_warning`; the number is checked (whole, 1 to 1440) or the entry is left out.
- IF-2: the timeline type, the optional member `minutes_left`, the text of `getTimeline`, examples (one valid, one invalid), the fake lab (a seeded warning, the test hook), `lab-api.md`, the bundle and the generated TypeScript and Python models.
- `apps/web`: `timelineText()` turns timeline entries into words (with a fallback for an unknown type); the recruiter's candidate page uses it.

## How it works
The engine decides when a warning is due and writes it once; the timeline only reads the attempt log. Nothing new is stored.

## Files changed
`apps/api/src/vulnmart/lab/api.py`, `apps/api/tests/test_lab_timeline_warnings.py`, `contracts/api/lab/*`, `contracts/mocks/fake-lab/server.mjs`, `contracts/CHANGELOG.md`, `contracts/COMPAT.md`, `contracts/api/bundle/*`, `packages/ts-client`, `packages/py-models`, `apps/web/lib/api.ts`, `apps/web/app/company/candidates/[attemptId]/page.tsx`, records.

## Decisions made
The timeline lists the warnings (the handoff's proposal). Version 2.0.0 follows the rule of `scripts/check-contract-rules.mjs`; the COMPAT rows for stream P at 2.0.0 are `pending`.

## Tests
- `pytest apps/api/tests/test_lab_timeline_warnings.py` — 3 passed (answers validated against the contract schema).
- `node --test scripts/fake-lab.test.mjs scripts/platform-mock.test.mjs` — 29 passed.
- `check_lab_contract.py` — 22 operations, 44 valid, 104 invalid examples, PASS. `pnpm run contracts:rules` — 20 PASS, 0 FAIL (first run: 1 FAIL, the missing major step). `pnpm run api:check` — OK. `pnpm --filter @vulnmart/web typecheck` — no error.
- Not run: a browser view of the recruiter page with a warning (no live data yet).

## Evidence
Command output above.

## Problems met and how they were fixed
- The first test failed with 401 because the clock fixture also runs the platform session; two hours later the session had ended. The test signs in again at the new time.
- A YAML description with a colon inside a plain scalar broke the contract file; reworded.
- The contract rule demanded a major step: relabelled 2.0.0 with the reason in the changelog.

## Security notes (vulnerable parts only)
None. The timeline shows no flag or secret.

## Limitations and follow-ups
Stream P's sign-off rows for IF-2 2.0.0 are `pending`.
