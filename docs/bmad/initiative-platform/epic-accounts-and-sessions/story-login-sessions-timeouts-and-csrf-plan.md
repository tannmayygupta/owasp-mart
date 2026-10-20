---
title: 'Login, sessions, timeouts and CSRF'
type: 'feature'
ticket: '2'
created: '2026-10-17'
status: done
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/contracts/api/platform/platform.openapi.yaml'
  - '{project-root}/docs/architecture/06-security.md'
  - '{project-root}/docs/architecture/03-origins-and-access.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** A verified learner cannot sign in: there is no session, no timeout, no logout and no CSRF defence (FR-ACC-03, FR-ACC-04, NFR-SEC-03), and the contract's Origin rule is not applied to the public routes either.

**Approach:** The routes `createSession`, `getSession` and `deleteSession` of IF-1 over a `sessions` table that keeps only the hash of the cookie value, idle and absolute timeouts checked with the server clock on every request, a CSRF token that is an HMAC of the session value, the Origin check on every state-changing call, and a login throttle that waits but never locks for good.

## Boundaries & Constraints

**Decisions (developer, 2026-10-17):** "continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0042 (Proposed) for confirmation: a session value stored only as a hash, `last_seen_at` written at most once a minute, CSRF token as an HMAC with no storage, failed-login counting per email address with a 15-minute window, an admin cannot log in until the second factor exists (P-15), session list and revoke routes split out as story 3.6.

**Always:** The cookie is `__Host-vm_session`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, no Domain, no expiry; its value is never in a body or a log; every login makes a new value; a wrong password and an unknown, disabled or deleted account answer the same and cost the same time; "email not verified" is only said after the right password; an ended session is marked revoked so no clock reading revives it; state-changing calls need the dashboard `Origin`; authenticated ones also the CSRF token of their session.

**Never:** No second-factor login (P-15), so an admin account is refused a session (never given one with the password alone); no password change or reset (P-14); no roles or account-type rules beyond reading them (P-13); no login form (dashboards); no contract change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Login | verified account, right password, dashboard origin | 200 Session body, cookie set, new session value | n/a |
| Wrong password, unknown, disabled or deleted | any | 401 AUTH-INVALID-CREDENTIALS, identical bodies | no cookie |
| Unverified, right password | n/a | 403 AUTH-EMAIL-NOT-VERIFIED | no cookie |
| Admin | right password | refused (500 generic, logged), no session | until P-15 |
| Another origin or `Sec-Fetch-Site` not same-origin | any POST, PATCH, DELETE | 403 AUTH-ORIGIN-FORBIDDEN | nothing changes |
| Session read | live cookie | 200, same user, stable CSRF token | n/a |
| Idle 30 min (admin 15), or 12 h absolute | no request / any activity | 401 AUTH-SESSION-REQUIRED, cookie cleared, session revoked | stays ended |
| Logout without or with a wrong CSRF token | DELETE | 403 AUTH-CSRF-FAILED | session stays |
| Logout | right token and origin | 204, cookie cleared, session revoked at once | old cookie is 401 |
| 10 wrong passwords for one address in 15 min | 11th attempt, even with the right password | 429 with Retry-After; after the window it works | a good login clears the failures |
| Rate limiter store down | Valkey error | request refused, not let through | logged |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/accounts/sessions.py` -- `SessionService` (login, resolve, logout, rotate, list, revoke, revoke_all, CSRF).
- `accounts/http.py` -- shared route parts (body, visitor address, limits, Origin, cookie, `authenticated`, `authenticated_with_csrf`); `accounts/session_api.py` -- the three routes; `accounts/api.py` -- P-11 routes now also check Origin.
- `accounts/models.py` (`UserSession`), `migrations/versions/0004_sessions.py` -- table `sessions`; single head 0004.
- `kernel/ratelimit.py` (`peek`, `reset`), `kernel/settings.py` (`csrf_secret`), `ports/settings.py` (login limits), `main.py` (wiring, CSRF key rule), `infra/compose/compose.yaml` (API: CSRF secret, public origin).
- Tests: `test_sessions_service.py`, `test_session_api.py`, `test_accounts_postgres.py` (sessions part), `test_ratelimit.py`; stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] Table, migration 0004, session service with both timeouts, rotation, own-session functions, CSRF token.
- [x] Routes, Origin and CSRF checks, cookie rules, authentication dependencies that also set the scope.
- [x] Login throttle with peek and reset on the limiter; fail-closed behaviour.
- [x] Tests (service, HTTP, Postgres races, limiter with real Valkey) and the real-stack test through the web proxy.
- [ ] (moved to story 3.6) Routes for the session list, revoking one session and logging out everywhere.

**Acceptance Criteria:**
- Given a verified account, when it logs in through the web origin, then the cookie comes back with the attributes above, the session answers, and logout (with the CSRF token) ends it so that a copy of the cookie gets 401.
- Given 30 idle minutes (admin 15) or 12 hours, then the next request is 401 and the cookie is cleared.
- Given a DELETE without the right CSRF token or from another origin, then it is refused and the session lives on.

## Implementation Notes

- Retrofit: the contract asks for the Origin check on public state-changing calls too; the three P-11 routes did not have it and now do (their tests send the header).
- The failed-login counter blocks the right password during the window too; that lets an attacker keep one address waiting, which is the price of not letting guesses through (documented in `session_api.py`).
- Verified on the real stack: `Set-Cookie` passes through the Next rewrite unchanged (an open point of P-07).

## Plan Change Log

- 2026-10-17: the session list, revoke and "log out everywhere" routes split out as story 3.6 (they need a contract change).

## Review Triage Log

### 2026-10-17, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. 1 medium, 2 low; all patched.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The public routes of P-11 had no Origin check although the contract requires it | medium | patch | `check_origin` on all four public POSTs; parametrised tests |
| 2 | A test compared the unknown and wrong-password answers with an `or` that made it pass vacuously | low | patch | now compares the whole body except the request id |
| 3 | A test loop stopped at 11h40 and never reached the 12-hour limit | low | patch | range widened; the test reaches and checks the limit |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
