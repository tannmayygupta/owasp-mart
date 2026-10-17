# 0042. Sessions: hashed cookie value, HMAC CSRF token, origin check, login throttle

- **Status:** Proposed (the builder's design for the developer to confirm; the CSRF token form is the contract's, decided 2026-10-09, ADR 0019 M2)
- **Date:** 2026-10-17
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-ACC-03, FR-ACC-04, FR-ACC-08, FR-ACC-10, NFR-SEC-03, D-21

## Context
Login is the second thing an attacker meets after signup. The contract fixes the cookie (`__Host-vm_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, no Domain), the timeouts (30 minutes idle, 15 for an admin, 12 hours absolute, all placeholders), and the CSRF defence (a token plus an Origin check). It leaves open how the session is stored, how failed logins are counted and what to do about an admin before the second factor exists.

## Options considered
1. **Storage:** the session value in the database in clear / only its hash / a signed cookie with no server state. A signed cookie cannot be revoked at once (FR-ACC-03 asks for that).
2. **Idle clock:** write `last_seen_at` on every request / at most once a minute. The first adds a write to every call (the live stream will make many).
3. **CSRF token:** a random value stored with the session / an HMAC of the session value under a server key. The second needs no storage and is the contract's choice.
4. **Failed logins:** count per visitor address only / per email address only / both. Per address alone lets one attacker try many accounts from many addresses; per email alone lets anyone make an address wait.
5. **Admin before MFA:** let the password alone through / refuse. FR-ACC-07 says an admin without the second factor reaches nothing.

## Decision
- The cookie holds 256 random bits; the database holds only their SHA-256 hash. A login always makes a new value (no fixation); `rotate` makes another at a privilege change and keeps the old absolute deadline.
- Idle and absolute limits are read from settings on every request with the server clock; an ended session is marked revoked, so a changed clock cannot bring it back. `last_seen_at` is written at most once a minute, so a session can end up to a minute early, never late.
- The CSRF token is HMAC-SHA256 of the session value under `VULNMART_CSRF_SECRET(_FILE)` (required in staging and production, random per process in dev and test), compared in constant time.
- Every state-changing call, public ones included, needs `Origin` equal to `VULNMART_PUBLIC_ORIGIN` and, where sent, `Sec-Fetch-Site: same-origin` (403 AUTH-ORIGIN-FORBIDDEN); authenticated ones also the token (403 AUTH-CSRF-FAILED).
- Login is counted twice: all attempts per visitor address (60 an hour) and wrong passwords per email address, known or not (10 in 15 minutes). Past the second limit even the right password waits for the rest of the window; a right password clears the count. Limits are placeholders.
- An admin account is refused a session with an internal error and a log line until the second-factor login exists (story P-15).
- The user's own session list, revoking one and "log out everywhere" exist as service functions; their routes need a contract change and are story 3.6.

## Consequences
- An attacker can keep one email address waiting by failing on purpose for 15 minutes at a time; the alternative is letting guesses through. Nobody is locked for good.
- A deployment must run behind one dashboard origin; a second origin (for example `localhost` next to `127.0.0.1`) is refused by design.
- The CSRF key must be the same on every API process, and rotating it ends every CSRF token (the browser fetches a new one with `GET /session`).
- Sessions are only in Postgres; the architecture's Valkey cache of active sessions is not built and may never be needed.
- Expired session rows stay in the table until a purge job exists (the retention scheduler, story P-24).

## Evidence
- Contract: cookie, header and CSRF wording in `contracts/api/platform/platform.openapi.yaml` (security schemes, `SessionCookie`, `CsrfFailed`), read 2026-10-17.
- Shown on the real stack through the Next proxy: the cookie arrives with `Path=/`, `Secure`, `HttpOnly`, `SameSite=lax` and no Domain, Max-Age or Expires; logout with the right token ends the session and a copy of the cookie then gets 401 (`platform-stack.e2e.test.mjs`, 17 of 17).
- Race behaviour on real Postgres: eight simultaneous logins make eight sessions; eight simultaneous logouts of one session end it exactly once (`test_accounts_postgres.py`).
- OWASP ASVS 5.0 session chapter, OWASP Session Management and CSRF cheat sheets: **not re-read during this story** (NFR-SEC-01 asks for the official text before the report).
