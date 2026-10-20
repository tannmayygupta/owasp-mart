---
title: "Session list, revoke and log out everywhere routes"
ticket: 6
status: built
---

# Session list, revoke and log out everywhere routes

**Covers:** FR-ACC-04 (AC: a user can list and revoke their own sessions and log out everywhere). **After:** story 3.2 (P-12).

## Plan (2026-10-20)
1. IF-1 1.7.0 (additive): `listMySessions` `GET /api/v1/me/sessions`, `logOutEverywhere` `DELETE /api/v1/me/sessions`, `revokeMySession` `DELETE /api/v1/me/sessions/{ref}`; schemas `SessionRef`, `MySession`, `MySessionList`; no new error code (ending an unknown or ended ref is 204, the list shows what is left).
2. Routes in `accounts/session_api.py` over the existing `SessionService`; ending the current session (one or all) clears the cookie.
3. Service: the ref must be 16 lower-case hex characters (it feeds a LIKE prefix match; `%` or `_` would match several sessions); `auth.session_revoked` and `auth.logout_all` audited; `created_at` set from the service clock.
4. Bundle and generated clients regenerated; COMPAT.md IF-1 1.7.0, re-approved by the developer (answer of 2026-10-20: "Re-approve at 1.7.0").
5. Account page: a "Where you are signed in" section (list, sign out one, sign out everywhere).
6. Pins updated: operation count (69), state-changing routes, privacy-wall classes.

**Commands:**
- `.venv/Scripts/python -m pytest apps/api/tests` -- result before the pin updates: 4 failed (the pins), 2883 passed, 1 skipped
- `.venv/Scripts/python -m pytest` on the route, service, session, contract, wall and role-gate files -- result: 135 passed
- `node scripts/check-contract-rules.mjs` -- result: 18 PASS, 0 FAIL
- `node --test "scripts/*.test.mjs" "apps/*/test/**/*.test.mjs"` -- result: 1215 pass, 3 fail (the generator tests; `datamodel-codegen` is not installed locally)
- `npm run build` in `apps/web` -- result: compiled

**Results (2026-10-20):** as above; evidence `docs/assets/story-3-6-session-routes/`.
