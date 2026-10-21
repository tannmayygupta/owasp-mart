# Learner and candidate screens follow the sequenced run and the mode, plus the first browser tests

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | `wp-e-learner-candidate-web` (hash after the commit) |
| Status | Done, with the limits listed at the end |
| Report tag | dashboards, sequenced learner run, candidate assessment, browser tests |

## Requirements covered
F-14 and F-16 of the wiring audit (F-16 only in that the page still polls when the live stream is down), audit section 6 gaps 2 and 7, FR-DSH-01, FR-DSH-04, FR-NTF-04, D-80, ADR 0063, ADR 0070 (new).

## Summary (plain language, 3-5 lines)
The Next.js dashboards could not play the lab the way production runs it: a learner could not begin a challenge, so flags and hints answered 409. The learner screen now shows one challenge at a time with a countdown from the server's clock, the account points, the write-up when time runs out and a new run after a finished one. A company assessment is never drawn as practice and the other way round. The candidate screens got the missing messages (preparing, closed invite, expired, withdraw/undo state, results hidden). The console filters by mode too. For the first time a real browser drives the learner and candidate flows.

## Why
Audit F-14 (P1): sequenced mode broke the dashboards. Audit gaps 2 and 7: the learner/candidate split was only a filter on one page, and no browser test had ever run these flows.

## What was built
- `apps/web/lib/attempt-logic.ts`: the rules as pure functions (skew and seconds-left arithmetic, mode split, practice-run choice, sequenced-run detection, stage selection, candidate view and results rule).
- `apps/web/app/sequenced-stage.tsx` (new) and `apps/web/app/attempt-board.tsx` (reworked): the sequenced learner stage; the board of all challenges stays for company assessments; `expectedMode` makes a wrong-mode attempt show a notice and a link, nothing of it is loaded; the countdown uses `server_time`; a challenge that ran out while the page was open stays on stage with its write-up; hint errors show on the hint's row; the candidate board has a preparing state (the clock starts at ready, D-80), withdrawn/undo notes (undo only while `delete_after` is set), an expired note and the results-later notice.
- `apps/web/app/dashboard/page.tsx`: practice run chosen by mode, only a count of challenges before a run (no list ahead), account points, a note with a link when the account only has an assessment, "Start my lab".
- `apps/web/app/assessment/[attemptId]/page.tsx`: results rule from `candidateResultsAllowed` (also after expiry), a message per closed invite state.
- `apps/lab-console/app.js`: only `mode: learner` attempts are practice; a candidate attempt is never read; with only an assessment the start panel carries a note and a link to `/assessment/<id>`.
- `apps/web/lib/api.ts`: only a separate marked block of types (`ChallengeProgress`, `ProgressList`, `AccountProgress`) and `server_time` on `Attempt`.
- Browser tests: `tests/web-e2e/` (Playwright) and `apps/api/tests/e2e_web_server.py` (the real API app, see ADR 0070). `apps/web` got `test` and `test:e2e` scripts.
- `docs/runbooks/web-e2e.md` with the proposed CI job (not added to `.github`).

## How it works
The page detects a sequenced run from what the server sends (`current_key`, `total` or a `state` on the entries). The countdown is `expires_at` minus the server's now, where the server's now is the browser clock plus the skew of the last `server_time`; at zero the page reads the lab again and the server decides. The browser test moves the test API's clock to prove it: the page ends the challenge only after a re-read, as it must.

## Files changed
- `apps/web/lib/attempt-logic.ts`, `apps/web/app/sequenced-stage.tsx`, `apps/web/app/attempt-board.tsx`, `apps/web/app/dashboard/page.tsx`, `apps/web/app/assessment/[attemptId]/page.tsx`, `apps/web/app/globals.css`, `apps/web/lib/api.ts`, `apps/web/package.json`
- `apps/web/test/attempt-logic.test.mjs` (17 tests)
- `apps/lab-console/app.js`, `scripts/lab-console.test.mjs` (3 new tests, fixtures carry `mode`)
- `apps/api/tests/e2e_web_server.py`, `tests/web-e2e/**`
- `docs/runbooks/web-e2e.md`, `docs/adr/0070-*.md`, story 41 and its plan, `docs/assets/wp-e-learner-candidate-web/*.png`

## Decisions made
ADR 0070 (browser tests: Playwright, real API app, separate folder with its own lockfile). Alternatives in the ADR.

## Tests
Real runs on this machine (Windows, PowerShell 5.1, Chrome installed, headless):
- `pnpm --filter "@vulnmart/web" typecheck`: no errors.
- `node --test "apps/web/test/*.test.mjs"`: 35 tests, 35 pass (17 of them new, in `attempt-logic.test.mjs`).
- `node --test scripts/lab-console.test.mjs scripts/web-lockfile-sync.test.mjs`: 15 tests, 15 pass (the console file has 13: 10 old, 3 new).
- `node scripts/check-text-files.mjs`: PASS.
- `E2E_BROWSER_CHANNEL=chrome pnpm --filter "@vulnmart/web" test:e2e`: 6 tests, 6 pass, 6 of 6 passed in each of the last four full runs (47 to 57 seconds; earlier runs failed on test mistakes and on the time-out bug listed below). Tests: a closed invite; candidate with release (invite, sign-in, accept, consent, start, 15-minute warning, flag, submit, results hidden, recruiter release, results shown); candidate with hints off (withdraw, undo); the mode split; sign-up, confirm, sign-in, sign-out; the sequenced learner run (start, begin, hint, wrong flag, flag, next, the clock moved 41 minutes and the challenge ends with its write-up, finish, a new run that keeps the account points). Every test also fails on a Content-Security-Policy violation or an uncaught page error: none occurred.
- Not run: the same suite on the GitHub ubuntu runner (Playwright's own Chromium); the proposed job is untested there.

## Evidence
`docs/assets/wp-e-learner-candidate-web/`: ten screenshots from the headless Chrome run (learner ready, active with countdown and hint, captured with write-up, time ran out, run finished; candidate consent, running with the 15-minute warning, submitted with results hidden, released, and the dashboard note).

## Problems met and how they were fixed
- The audit's base was wrong for this worktree: `main` has no sequenced mode at all (it lives on `l-tester-login-hint-bugs`, 48 commits ahead, the branch the deployed lab runs). I fast-forwarded this branch to `origin/l-tester-login-hint-bugs` (no rewrite) and the pull request targets that branch.
- Adding Playwright to the pnpm workspace changed how pnpm resolved `next` (optional peer), so the root lockfile and `apps/web/pnpm-lock.yaml` disagreed and `web-lockfile-sync.test.mjs` failed. Fixed by moving the tests to `tests/web-e2e/` with its own lockfile (dead end: the workspace package).
- First learner run: after the clock moved, the page showed the next challenge instead of the one that ran out. Fixed: a challenge that was active and is now expired stays on stage.
- `Resolve-Path` and square brackets (`[attemptId]`) in the PowerShell edits needed `-LiteralPath`/full paths; a PowerShell double-quoted `${...}` ate a template literal once (screenshots wrote to `C:\`, caught by the test, fixed).
- The recruiter's release through Playwright's request API got 401 (cookie not kept); it now signs in through the sign-in page in its own browser context.

## Security notes (vulnerable parts only)
No vulnerable behaviour was added. The test runner's hooks return the flag of a test instance (made from random keys of the process); they are on a loopback test server and never go through the dashboards' proxy. No real flag, secret or credential is in any file; the password in the tests is a local test value of the throw-away database.

## Limitations and follow-ups
- Finding for the API (not touched here): `hints_enabled(rec)` in `apps/api/src/vulnmart/lab/api.py` returns false for every company attempt (a placeholder), so a template with hints on gives candidates no hints, while the invite and the page header say "hints on". The page follows the attempt, so the header and the table disagree for candidates until the API reads the template. The candidate hint unlock (cost confirmation) therefore has no end-to-end test; it is covered only by the table code.
- A learner who only has an assessment on the dashboard sees the invitations table plus a note; the live-stream route (`createLiveTicket`, F-16) is not touched.
- The sequenced stage uses polling (15 s) or the live stream; the countdown fix after a long-asleep tab depends on that re-read.
- Not browser-tested: reset, stop, copy-link (console only), the recruiter pages, and keyboard-only use (labels, focus rings and reduced motion are in the CSS but no accessibility tool was run).
- ADR 0070 and story 41 use numbers chosen to avoid colliding with other work in flight; renumber at merge if needed.