# Login, sessions, timeouts and CSRF (P-12, story 3.2)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-2-akshay-4 / see the pull request |
| Status | Built and tested at API level. Not done: the routes for a user's own session list and "log out everywhere" (moved to story 3.6, they need a contract change) and the login form (dashboards). Story 3.2 is `built`, awaiting the developer's confirmation |
| Report tag | login, server-side sessions, timeouts, CSRF, Origin check, brute-force throttle, BMAD cycle |

## Requirements covered
FR-ACC-03 (sessions, logout, a new id at login), FR-ACC-04 (idle and absolute timeouts; the own-session functions exist, their routes do not), NFR-SEC-03 (CSRF token plus Origin check). Related: FR-ACC-02 (the "not verified" answer), FR-ACC-08 and FR-ACC-10 (throttling without a permanent lock), handoffs H-130 (for P-13 to P-15), H-131 (for Tanmay), ADR 0042.

## Summary (plain language, 3-5 lines)
A verified learner can now log in, stay logged in while active, and log out. The browser gets a cookie that only the server can understand; the database keeps only a fingerprint of it, so a stolen copy of the database cannot be used to log in. The session ends after 30 idle minutes or 12 hours, and logging out ends it at once. Anything that changes data must come from the dashboard origin and carry a token tied to the session, and ten wrong passwords for one address make it wait 15 minutes.

## Why
FR-ACC-03 and 04 and NFR-SEC-03 are the core of the authentication chapter of ASVS; every later screen depends on a trustworthy session.

## What was built
- `sessions` table (migration 0004): hash of the cookie value, user, last seen, absolute deadline, coarse network prefix and device class, revoked time.
- `accounts/sessions.py` (`SessionService`): login (same error for wrong, unknown, disabled and deleted; same time for unknown; admin refused until MFA exists), `resolve` (both timeouts, ended means revoked), `logout`, `rotate`, `list_sessions`, `revoke`, `revoke_all`, the CSRF token.
- `accounts/http.py` (shared route parts), `accounts/session_api.py` (`createSession`, `getSession`, `deleteSession`), `authenticated` and `authenticated_with_csrf` dependencies that also put the user and roles in scope.
- The Origin check on every state-changing call, including the four public routes of P-11 (a retrofit: the contract asks for it).
- Rate limiter: `peek` and `reset` (memory and Valkey) for the failed-login counter. Settings: `VULNMART_CSRF_SECRET(_FILE)` (required in staging and production), login limits. Compose: API gets a development CSRF secret and the dashboard origin.

## How it works
Login checks the password (the same work for an unknown address), then makes a random value, stores its hash and sets it as the cookie. Each request reads the cookie, hashes it, loads the row, checks it is not revoked, not idle too long and not past 12 hours, and marks activity (at most one write a minute). Logout marks the row revoked. The CSRF token is an HMAC of the cookie value under a server key, so it needs no storage and belongs to one session; changing routes need it in a header plus the right `Origin`. Failed logins are counted per email address in Valkey, and past 10 in 15 minutes the address gets 429 until the window ends.

## Files changed
- New: `apps/api/src/vulnmart/accounts/{sessions,http,session_api}.py`, `apps/api/migrations/versions/0004_sessions.py`, tests `test_sessions_service.py`, `test_session_api.py`, `docs/adr/0042-*.md`, the plan of story 3.2.
- Changed: `accounts/{api,models}.py`, `kernel/{ratelimit,settings}.py`, `ports/settings.py`, `main.py`, `infra/compose/compose.yaml`, `scripts/e2e/platform-stack.e2e.test.mjs`, `test_accounts_api.py`, `test_accounts_postgres.py`, `test_ratelimit.py`, `test_kernel_origin.py`, `test_kernel_settings.py`, `test_kernel_postgres.py`, `epic-accounts-and-sessions/tickets.toml`, `docs/dev/HANDOFFS.md`, `docs/dev/dev1-tanmay.md` (one Handoffs line), `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer (2026-10-17): "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0042 (Proposed) for confirmation: hashed session value, at-most-once-a-minute activity write, HMAC CSRF token (the contract's choice), the Origin rule for public calls, failed logins counted per email address, an admin refused a session until the second factor exists, the session list routes as a separate story.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-12-sessions/`.
- `pytest apps/api/tests` with the two containers: **1300 passed, 0 failed, 0 skipped** (384 s, `pytest-2026-10-17.txt`).
- New tests: session service (24: both timeouts including a 12-hour run of activity and the 15-minute admin limit, rotation, own sessions, CSRF), HTTP (about 20: cookie attributes, identical 401 bodies, 403 for an unverified address only after the right password, planted cookie not adopted, Origin and CSRF refusals that leave the session alone, a stolen cookie after logout, the throttle that ends by itself, nothing sensitive in logs), Postgres (8 simultaneous logins give 8 sessions; 8 simultaneous logouts end it once; sessions go with their user), limiter `peek` and `reset` (including real Valkey).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **17 of 17**, including login through the web proxy: the cookie arrives with Path=/, Secure, HttpOnly, SameSite=lax and no Domain, Max-Age or Expires (so `Set-Cookie` passes the Next rewrite unchanged, an open point of P-07); only the hash is in the database; wrong password 401, unverified 403 and no cookie; a login from another origin 403; logout without the token 403, from another origin 403, with both 204; a copy of the old cookie 401.
- `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL. `node --test` on `check-text-files`, `progress-page`, `dev` and `demo`: 70 of 70. The whole `scripts/*.test.mjs` suite was not re-run for this story.
- NOT run: a real browser (there is no login form); the deployed Vercel path (handoff H-131); CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-12-sessions/`.

## Problems met and how they were fixed
- The contract's Origin check was missing from the public routes of P-11: added to all four, their tests updated.
- Three of my own tests were weak or wrong on the first pass (an `or` that could pass vacuously, a loop that stopped before 12 hours, a PowerShell replace that skipped one test); each was tightened or completed.
- A stray junk key typed into `compose.yaml` was removed before any run.
- Existing tests that build a "production" app needed a CSRF key (the new rule that strict environments need one): updated.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: hashed session values, no fixation (a planted cookie is never adopted), the same answer and time for unknown accounts, CSRF token bound to the session, Origin check, an ended session cannot be revived by the clock, throttle that fails closed, nothing sensitive logged (tested).

## Limitations and follow-ups
- No login form or "who am I" page (dashboards); `getMe`, `updateMe` and password change are P-14.
- The session list, revoke and "log out everywhere" routes: story 3.6 (contract change).
- An admin cannot log in until P-15; `mfa_enabled` is false until then.
- The failed-login wait also applies to the right password (a trade-off documented in ADR 0042); limits are placeholders.
- Expired session rows are not purged yet (P-24). The Valkey session cache of the architecture is not built.
- Remind: Excel, P-12 Done = Yes (the list routes are story 3.6); confirm story 3.2 so it can move to `done`.
