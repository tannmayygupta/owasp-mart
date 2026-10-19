# Player experience of the lab console: brief, start text, hints, write-up, Burp link

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | l-player-experience |
| Status | Partly done (code and tests done; live deploy and a real browser look still to do) |
| Report tag | Lab stream, player experience, IF-2 1.2.0 |

## Requirements covered
C01 to C11 (player-facing text), IF-2 1.2.0, IF-7 1.2.0, FR-LIV (console), D-37.

## Summary (plain language)
A learner who opens the lab console now sees, for every challenge, what it is, how to begin (the demo account to sign in with), the hints (kept on the page once revealed), and after a capture what was wrong and how to fix it. The console also gives a "Copy link for Burp" button that fetches a fresh one-time link, so a learner can paste it into a proxy tool, and a four-step strip that says where they are.

## Why
The reported problem: the console listed challenges without saying how to start, so a learner could not tell which account to use or where a flag would be. The brief asked for working hints, flag validation, progress tracking and Burp-compatible flows.

## What was built
- Catalogue (IF-7 1.2.0): each `challenges/catalog/cNN.yaml` start_state now names the demo credentials; the API reads `brief`, `start` and `write_up` from the entry.
- IF-2 1.2.0 (additive): `ChallengeProgress` has optional `brief`, `start` and, only once solved and only for the practice owner, `write_up` (`vulnerable`, `fix`).
- Console (`apps/lab-console`): expandable challenge cards, hint rows, flag box locked after capture, score bar, steps strip, Copy link for Burp, Burp help.
- Mock `contracts/mocks/fake-lab`, example, bundle, TS client and Python models regenerated.

## How it works
`GET /api/v1/attempts/{id}/challenges` adds brief and start for every challenge. The write-up is added only when the challenge is solved, so reading the list never gives away the fix early. The console puts everything on the page as text, never as HTML.

## Files changed
- `challenges/catalog/c01..c11.yaml`, `apps/api/src/vulnmart/lab/{catalog,api}.py`, `contracts/api/lab/lab.openapi.yaml`, `contracts/mocks/fake-lab/server.mjs`, `contracts/api/lab/examples/valid/challenges.json`, `contracts/CHANGELOG.md`, `contracts/COMPAT.md`, generated bundle/client/models
- `apps/lab-console/{index.html,style.css,app.js}`, `apps/api/tests/test_lab_api.py`, `scripts/lab-console.test.mjs`

## Decisions made
IF-2 change is additive (minor 1.2.0); no ADR (no new technology). The write-up stays hidden until a capture.

## Tests
- `node --test scripts/lab-console.test.mjs`: 5 tests pass (fake DOM plus a scripted API: cards, hints, Burp link, steps, markup shown as text).
- `node --test scripts/fake-lab.test.mjs`: pass. `node scripts/check-contract-rules.mjs`: 18 PASS, 0 FAIL.
- `uv run --locked --package vulnmart-api pytest -q tests/test_lab_api.py tests/test_lab_contract.py`: 206 passed. `uv run --locked --package vulnmart-api pytest -q` (whole API suite): 2458 passed, 233 skipped. `check_lab_contract.py`: PASS (20 operations, 41 valid and 101 invalid examples). Live check: not yet run.

## Evidence
Test output only; no browser screenshot yet (the Chrome extension was not connected).

## Problems met and how they were fixed
- No DOM library in the repo, so the console is tested with a small fake DOM; loading app.js twice with ESM query strings did not re-run it, so the test runs the source through `vm` for each test.
- A line that deleted a hint lock after a correct flag was wrong and was removed.

## Security notes
No new weakness. Credentials in start texts are the seeded demo accounts of the lab only (no real secrets, no flag values).

## Limitations and follow-ups
Not yet deployed to the live platform; the look in a real browser is unchecked. C03 part B (needs a JS-running bot) is still open.