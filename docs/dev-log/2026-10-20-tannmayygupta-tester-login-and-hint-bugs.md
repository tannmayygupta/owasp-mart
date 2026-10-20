# Tester reports: shop login not visible in the Network panel, C02 hint not shown

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Partly done (local fix and proof; live reproduction needs the developer) |
| Report tag | bug story, lab console, hints, player experience |

## Requirements covered
C01, C02, FR-HNT-01, FR-HNT-02, FR-LIV (the player experience of the console), LB-11. Story: `docs/bmad/initiative-lab/backlog/bug-tester-cannot-see-shop-login-or-c02-hint.md`.

## Summary (plain language, 3-5 lines)
A tester said they could not see the C01 login in the Network panel and that the C02 hint button showed nothing. In a real Chrome run the shop login request does carry its form fields, and all three C02 hints work through the real lab API and console. Reading the history showed the console the tester likely used was older (before today's player-experience commit). The browser run also found one real weakness: a revealed hint only appeared if a second call succeeded. That is fixed, with tests.

## Why
The developer pasted the tester's report and asked for a bug story for A and B first (the all-challenge audit is a later story).

## What was built
- Console: a revealed hint is painted at once from what the page holds, before the refresh; a failed reveal shows its error on the hint row; the progress load of an opened challenge no longer throws an uncaught error; a note under the Open buttons says where to watch the login (F12 in the shop tab, Network, Preserve log).
- Live e2e: the hint sweep now refuses the "not written yet" placeholder (it is 35 characters and the old limit was 20).

## How it works
`paintRows()` redraws the challenge rows from `state.progress`, `state.points` and `state.hints`. `unlockHint` updates those and paints, then calls `refresh()`. `hintTextProblem()` in `scripts/e2e-live.mjs` is the one rule for an acceptable hint text.

## Files changed
- `apps/lab-console/app.js`, `index.html`, `style.css` — the console changes above.
- `scripts/lab-console.test.mjs` — three new tests (inline error, hint shown when progress fails, the DevTools note) and an error-capable fake fetch.
- `scripts/e2e-live.mjs`, `scripts/e2e-live.test.mjs` — placeholder check and its test.
- `docs/bmad/initiative-lab/backlog/bug-tester-cannot-see-shop-login-or-c02-hint.md` and its plan — the story.
- `CHANGELOG.md`, `docs/traceability.md`, `docs/assets/tester-login-and-hint-bugs/browser-check-output.txt`.

## Decisions made
No ADR. No catalogue, shop or contract file was changed; the hint wording and the C01 scenario stay as they are. The developer's answer on editing challenge files was "1 and 2" (ask per change, and yes edit); I took the stricter reading and changed none.

## Tests
- `node --test scripts/lab-console.test.mjs` — 8 tests, 8 pass. With the old `app.js` restored, the two behaviour tests (inline error, hint shown when progress fails) fail, 6 pass.
- `node --test scripts/e2e-live.test.mjs scripts/lab-console.test.mjs scripts/scan-flags.test.mjs` — 21 pass, 0 fail.
- `node --test "scripts/*.test.mjs"` — 919 tests, 917 pass, 0 fail, 2 skipped (run before the last console edit; the console tests were rerun after it, see above).
- `uv run --locked --package vulnmart-api pytest apps/api/tests/test_lab_api.py apps/api/tests/test_lab_runtime.py -k hint -q` — 5 passed, 46 deselected (baseline, no API change).
- Real Chrome (headless, DevTools protocol), see the evidence file: shop login request shows `POST /login` with the form fields then a 302; C02 hints 1 to 3 reveal in order with the fixed console.
- Not run: the live lab, the live e2e (`scripts/e2e-live.mjs` itself), the pnpm contract checks.

## Evidence
`docs/assets/tester-login-and-hint-bugs/browser-check-output.txt`.

## Problems met and how they were fixed
- The Chrome extension was not connected, so I drove headless Chrome over the DevTools protocol myself. That records the same network events but cannot show whether the DevTools Network list clears on navigation; the "Preserve log" cause for A is therefore a hypothesis.
- My first local lab harness crashed with an AttributeError (the test clock needs a `now` attribute). Fixed in my scratch script only.
- The harness's single shared SQLite connection gave random 500 and 401 answers under concurrent calls. Not a product finding; not checked on Postgres.

## Security notes (vulnerable parts only)
None. No target code, flag or secret was touched or written.

## Limitations and follow-ups
- A and B were not reproduced on the live lab. Open question for the tester: which console build and whether Preserve log was on. The deployed console needs a redeploy to carry this change (`node scripts/live-deploy.mjs`, developer to run).
- The gate and the sidecar were not in the local path; the gate code does not read or change request bodies (read, not run).
- Later story: audit of all 11 challenges and the C01 scenario as the tester described it (User A and User B records), hint wording against the "three progressive hints" idea (the catalogue is Sahil's; show proposed text first).
