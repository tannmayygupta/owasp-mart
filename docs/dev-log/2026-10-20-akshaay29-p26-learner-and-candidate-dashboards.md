# Learner and candidate dashboards with hints

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p26` |
| Status | Done (story `built`, awaiting the developer's confirmation to mark it done) |
| Report tag | platform, dashboards, sprint 4 |

## Requirements covered
FR-DSH-01, FR-DSH-04 (export is P-29), FR-HNT-01, FR-HNT-02, FR-ASM-04 (the routes), OI-15 (answered 2026-10-18, ADR 0050). Story 1 of `epic-dashboards-and-exports` (ref 8.1, task P-26).

## Summary (plain language, 3-5 lines)
The dashboards app now has real pages: sign-in (with the authenticator app), sign-up, the email and reset links, an account page, the learner's practice lab and the candidate's assessments. A candidate can open an invite link, accept it, agree to the privacy notice and take the assessment; hints show only when the company allowed them, with the cost confirmed first, and results only when the company's setting allows. A learner sees the catalogue with stars and OWASP tags, runs an instance with live state, unlocks free hints and reads the write-up after a solve. Three new candidate routes (IF-1) and one write-up route (IF-2) make this possible.

## Why
The dashboards app was a one-page tracer bullet (P-07) and a candidate could not accept an invite over HTTP (P-21 had no routes); the mails link to pages that did not exist (H-134). Task P-26 of `docs/dev/dev2-akshay.md`.

## What was built
- API: `assessments/invite_api.py` with `openInvite` (no session, rate limited, no address in the answer), `acceptInvite`, `listMyInvites`; `AssessmentService.describe` and `my_invites`; IF-1 1.3.0.
- The write-up after a solve: the write-up after a solve comes from the lab's own IF-2 1.2.0 (Tanmay, pull request 54, merged 2026-10-20): `listChallenges` gives `write_up` to the owner of a practice attempt once the challenge is captured, never in an assessment. This story first added its own route `getWriteup` to the lab module (with the developer's agreement); when main brought Tanmay's field the route was withdrawn before merging (no change to IF-2 is left in this story). Handoff H-355 asks stream L to enforce `after_release` results on the server.
- Web (`apps/web`): `lib/api.ts` (same-origin fetch, CSRF, messages), `lib/session.tsx` (who is signed in), `lib/live.ts` (live stream with polling fallback), `lib/paths.ts` (no open redirect after sign-in); pages `/login` (with the second factor), `/signup`, `/verify-email`, `/forgot-password`, `/reset-password`, `/account` (name, password, authenticator app with recovery codes shown once, deletion request and undo, who viewed my data), `/dashboard` (invitations and the practice lab), `/invite` (open and accept), `/assessment/[attemptId]` (consent, then the attempt, withdraw and undo, deletion request); the shared `attempt-board.tsx`.

## How it works
Every page is a client component that calls `/api/v1/...` on its own origin; `proxy.ts` (P-07) forwards it with the origin secret, so the browser's cookie and CSRF token are used as they are and the Next.js server holds no session. The pages only call the caller's own routes (`/me/...`, the attempt routes that check the owner), so the API decides what is visible. Live state: an `EventSource` on `/api/v1/live`; any event only triggers a reload of what the page shows; polling while an instance starts and whenever the stream is down. The invite link's token leaves the address bar at once and is kept for the tab (sessionStorage) until it is accepted, so it survives the sign-in detour. Results: shown for a candidate only when the invite's `results_visibility` is `after_submit` and the attempt is submitted.

## Files changed
- New: `apps/api/src/vulnmart/assessments/invite_api.py`, `apps/api/tests/test_invite_api.py`, `apps/web/app/{nav,attempt-board}.tsx`, `apps/web/app/{login,signup,verify-email,forgot-password,reset-password,account,dashboard,invite}/page.tsx`, `apps/web/app/assessment/[attemptId]/page.tsx`, `apps/web/lib/{api,live,paths}.ts`, `apps/web/lib/session.tsx`, `apps/web/test/dashboard-lib.test.mjs`, three request examples under `contracts/api/platform/examples/`, `docs/adr/0058-*.md`, the epic's `tickets.toml` and story plan, `docs/assets/p-26-dashboards/`.
- Changed: `assessments/service.py`, `main.py`, `platform.openapi.yaml`, the bundle, the generated models and types, `contracts/CHANGELOG.md`, pins in `test_platform_contract.py`, `test_role_gates.py`, `scripts/e2e/platform-stack.e2e.test.mjs`, `apps/web/app/{layout,page}.tsx`, `apps/web/app/globals.css`, `docs/dev/HANDOFFS.md` (H-354, H-355), `docs/adr/README.md`, `docs/traceability.md`, `docs/dev/dev2-akshay.md`, `CHANGELOG.md`, `docs/progress/index.html`.

## Decisions made
By the developer (2026-10-20): continue with the sprint 4 tasks one by one and merge each to main; the candidate invite routes are added in P-26 ("Add them in P-26"); the write-up route is added to the lab API by P-26 and Tanmay is told ("I add it, tell Tanmay"); superseded the same day by Tanmay's own IF-2 1.2.0 field, so the route was withdrawn. By the builder, in ADR 0058 (Proposed): only the candidate side of invites, no new error codes (one 409 for every refusal of an accept), client pages over the same-origin proxy with no new dependency, events only trigger reloads, results hidden in the page and handed to stream L for the server.

## Tests
On the developer's Windows 11 PC, Docker 28.5.1, throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-26-dashboards/`.
- `test_invite_api.py`: 9 passed (open with no session and no address, a bad link 400, accept needs the session and CSRF, accept then the consent notice for that attempt, my invites only mine, another account refused without the address, a cancelled invite, the rate limit).
- Before main was merged (with the `getWriteup` route that was then withdrawn, see Problems): its test in `test_lab_api.py` passed (409 before the solve, 200 after, 404 for another account and an unknown challenge, 401 without a session); the route, its test and the IF-2 pins below are not in the merged code.
- Pins changed on purpose: IF-1 operations 42 to 45 and two new state-changing routes (`test_platform_contract.py`, `test_role_gates.py`: 72 passed); before the withdrawal also IF-2 operations 20 to 21, `lab-api.md` lists `getWriteup`, the mock walk-through calls it (`test_lab_contract.py`: 186 passed).
- Contract: `check_platform_contract.py` OK (45 operations); `check_lab_contract.py` PASS; `check_api_models.py` OK (110 checks); `platform-mock.test.mjs` 20 of 20; fake lab mock tests 8 of 8; contract rules **20 PASS, 0 FAIL**, 1 not applicable.
- Web: `tsc --noEmit` clean; `next build` compiles the 11 routes; `node --test apps/web/test/*.test.mjs`: 15 of 15.
- Before main was merged: full `pytest apps/api/tests`, first run: 2799 passed, **4 failed**, 1 skipped: the four IF-2 pins of `test_lab_contract.py` above (`pytest-full-run1-lab-pins-2026-10-20.txt`).
- Before main was merged: full `pytest apps/api/tests` after those pins: **2802 passed, 0 failed, 1 skipped, 1 error** in 535 s (`pytest-full-2026-10-20.txt`; the skip is the Windows file-mode check). The error is a setup timeout in `test_http_service.py` ("the fake orchestrator printed no port within 15 s"), not code of this story; that file alone: 131 passed (`pytest-orchestrator-rerun-2026-10-20.txt`).
- Before main was merged: `node --test "scripts/*.test.mjs" "apps/*/test/**/*.test.mjs"`: 1203 tests, 1195 pass, **3 fail on this PC**: the three generator tests, because `datamodel-codegen` is not installed here (the same three as in P-25; CI has the tool) (`script-and-app-tests-2026-10-20.txt`).
- Stack end to end on real Docker (`--test-name-pattern` with start-up, the P-26 test and tear-down; images rebuilt with `docker compose ... --profile platform --profile web build`): **4 of 4** (`stack-e2e-p26-2026-10-20.txt`): the nine pages answer 200 with the nonce CSP and no flag; open with no session (no address), a bad link 400; another account's accept 409 without the address; accept needs a session; accept, then my invites lists it on real Postgres with the company and title; the other account's list is empty.
- NOT run: a browser (no browser test tooling in the repository; the pages were checked by type, build and the stack's HTTP answers, not clicked); consent and the attempt on the Compose stack (it has no lab in the API process; covered by `test_invite_api.py` and `test_invite_acceptance.py`); the learner flow end to end; CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-26-dashboards/`: the full pytest runs, the script and app tests, the image build log, the three failed stack runs and the passing one.

## Problems met and how they were fixed
- While this story was open, Tanmay merged IF-2 1.2.0 (pull request 54): `write_up` on `listChallenges` for the owner of a practice attempt after the capture, never in an assessment, and also numbered 1.2.0. This story's `getWriteup` route (its own IF-2 1.2.0, a mock route, the lab pins, handoff H-354) would have duplicated it and clashed on the version, so it was withdrawn before merging main and the page reads his field.
- `check_platform_contract.py` first failed: `listMyInvites` had no example answer; added.
- `datamodel-codegen` is not installed on this PC (as in P-25): the models were generated with `uv tool run --from datamodel-code-generator==0.83.0` through a temporary copy of the generator script (removed).
- The write-up route was missing from the fake lab's route table at first (the handler alone is not enough): the mock walk-through answered 404; added.
- Stack test, run 1: my test expected `Cache-Control: private, no-store` on pages; the dev server answers `no-store` (the P-07 page test only checks for `no-store`); aligned. Run 2: `/api/v1/invites/open` answered 404 because `compose up` reused an API image built before this branch; rebuilt the images. Run 3: Postgres prints a boolean joined to text as `true`, not `t`; fixed the expected text. Run 4 passed.
- Review (same session, not independent: the reviewer subagent does not survive this machine's session restarts): the dashboard and the assessment page loaded the lab's catalogue with the invites in one `Promise.all`, so a lab outage hid the invites (and the assessment page said "not one of yours"); the catalogue is now optional. An already accepted invite offered "Accept" again; it now points to the dashboard. A wrong flag would have shown "Something went wrong"; it now says it is not the flag.
- An inline Python edit failed on shell quoting and a heredoc mangled `lib/paths.ts`; both were redone through files.

## Security notes (vulnerable parts only)
None: platform code. Hardening: no address in any invite answer, one refusal for every accept failure, the link token removed from the address bar, `next` limited to same-origin paths, the shop opened with no `opener`, server text rendered as text, no inline script or style.

## Limitations and follow-ups
- Not browser-tested (FR-DSH-01's live instance state and the hint controls were not clicked through); a browser test needs tooling the repository does not have (OI-30).
- `after_release` results are hidden only in the page; the lab still answers them to the candidate (H-355). The recruiter's release action is P-27.
- The write-up comes from Tanmay's `write_up` field: practice attempts only; a candidate never sees it (his design).
- No export (P-29); no recruiter or admin pages (P-27, P-30); the recruiter side of invites has no routes (P-27 or story 5.3).
- A candidate who signs up from the invite page has to open the invite link again after confirming the address (the sign-up flow does not carry the invite).
