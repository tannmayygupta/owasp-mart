---
title: 'Multi-factor login'
type: 'feature'
ticket: '5'
created: '2026-10-18'
status: built
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/contracts/api/platform/platform.openapi.yaml'
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/architecture/06-security.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** An admin signs in with a password alone and a recruiter cannot add a second factor (FR-ACC-07); the admin session of P-12 even had to be refused because no second factor existed.

**Approach:** TOTP (RFC 6238) with recovery codes: the routes `startMfaEnrolment`, `confirmMfaEnrolment`, `disableMfa` and `completeMfaLogin` of IF-1; the TOTP secret sealed with a field key (architecture: `K_field`), recovery codes kept only as keyed hashes; a login with a second factor ends in a 5-minute single-use ticket; an admin session without a proved second factor has no admin role, so every admin function refuses it; an admin cannot turn the factor off.

## Boundaries & Constraints

**Decisions (developer, 2026-10-17):** "continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0045 (Proposed) for confirmation: an admin with only a password gets a session that can enrol but holds no admin role (so the sign-in is not refused, which would make enrolment impossible), TOTP implemented with the standard library and checked against the RFC vectors, AES-256-GCM through the `cryptography` library for the sealed secret, recovery-code hashes keyed with the field key, tickets stored as hashes with five tries, failed codes throttled per account, any account may turn the factor on (the requirement names recruiters), OI-13 (mandatory for recruiters later, passkeys) stays open.

**Always:** A code works once (its time step must be newer than the last used; a recovery code once); a ticket works once and for five tries; every claim is one conditional UPDATE; wrong, expired, used and unknown are one 401; the secret is shown only in the otpauth address at enrolment and the recovery codes only at confirmation; nothing sensitive in logs; the session value changes when the factor is turned on or off; state changes are audited before they commit.

**Never:** No passkeys or SMS (OI-13); no self-service way to turn the factor off for an admin; no email notifying a recovery-code use (not in FR-NTF-01); no key service yet (the field key is a setting until story P-17); no dashboards page.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Admin signs in with a password only | admin without a factor | 200 session, `mfa_enabled` false, no admin role in the scope; admin routes answer 404 | n/a |
| Start enrolment | session with CSRF | 200 `{otpauth_uri}`; a pending sealed secret (a repeat replaces it) | 409 AUTH-MFA-STATE when already on |
| Confirm | good code | 200 `{recovery_codes}` (10, shown once), new session cookie with the factor proved; an admin now has the admin role | wrong code 401 AUTH-MFA-INVALID, counted; nothing started 409 |
| Login with a factor | right password | 200 `{status: mfa_required, mfa_ticket, mfa_ticket_expires_at}`, no cookie | the account's wait: 429 |
| Second step | ticket and TOTP or recovery code | 200 session with the factor proved | 401 AUTH-MFA-INVALID for wrong, used, replayed, expired or unknown (same body) |
| Same code twice, two requests at once | one code | exactly one session | the other is 401 |
| Five wrong codes on one ticket | n/a | the ticket is dead even for the right code | n/a |
| Disable | password, not an admin | 204, new session cookie, factor and codes removed | admin or not enabled: 409; wrong password 401, counted |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/accounts/totp.py` (RFC 6238), `fieldkeys.py` (`FieldKeys`: seal, open, recovery hash), `mfa.py` (`MfaService`), `mfa_api.py` (the four routes).
- `accounts/sessions.py` (`MfaChallenge`, `open_session`, `mfa_at`, the admin role only with a proved factor, `rotate_in(mfa=...)`, `mfa_enabled`), `session_api.py` (the challenge answer), `http.py` (`mfa_service`), `self_service.py` (real `mfa_enabled` in the profile).
- `models.py` (`MfaCredential`, `RecoveryCode`, `UserSession.mfa_at`, and `EmailToken` with the purpose `mfa` and the column `attempts` for the login ticket), `migrations/versions/0005_mfa.py` (single head 0005), `docs/architecture/04-data-and-state.md`.
- `kernel/settings.py` (`field_secret`), `main.py` (`field_keys_from`, the service and router), `infra/compose/compose.yaml` (dev field secret), `apps/api/pyproject.toml` (`cryptography` 50.0.2).
- Tests: `test_totp_and_fieldkeys.py`, `test_mfa.py`, `test_mfa_api.py`, `test_accounts_postgres.py` (P-15 part); stack test `scripts/e2e/platform-stack.e2e.test.mjs`; `docs/runbooks/seed-admin.md` (first sign-in).

## Tasks & Acceptance

**Execution:**
- [x] TOTP, field keys, tables and migration, the service (enrolment, confirm with recovery codes, disable, ticket, second step).
- [x] Session changes: challenge, `mfa_at`, no admin role without a proved factor, rotation with the factor mark.
- [x] The four routes and the changed login answer; settings, Compose, dependency, runbook.
- [x] Tests (RFC vectors, service, HTTP, real Postgres races) and the real-stack test with an authenticator written in Node.

**Acceptance Criteria:**
- Given an admin account, when it signs in with the password only, then the session reaches no admin function; after enrolling and confirming a code it does; the next sign-in needs the second step.
- Given a TOTP code or a recovery code, then it opens one session once and cannot be replayed; five wrong codes kill the ticket.
- Given a recruiter with the factor on, then they can turn it off with the password and a new session; an admin cannot.

## Implementation Notes

- The previous behaviour (an admin login refused with a generic error until the factor existed) made enrolment impossible; the restricted session replaces it. Tests and the P-13 stack test were updated.
- Designed in from the start and proved by tests: each claim of a code, a recovery code or a ticket is one conditional UPDATE (eight simultaneous requests: one session, on real Postgres), and a failed attempt is written and committed before the error is raised, so a ticket really runs out of tries.
- The `K_field` of the architecture will come from the key service (P-17); `FieldKeys.from_secret` is the only place that changes.
- The authenticator in the real-stack test is written in the test (Node, `crypto`), so it checks the server against an independent implementation of RFC 6238 in addition to the RFC vectors in the unit tests.

## Plan Change Log

## Review Triage Log

### 2026-10-18, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. Things that actually went wrong while building, all fixed: no defect in the product code was found by this pass (the race and attempt-counting designs below were built in from the start and then proved by tests).

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | A test of the admin rule had leftover no-op lines and asserted nothing about an admin function | low | patch | it now calls an admin function with the unproved and the proved scope |
| 2 | An HTTP test used the CSRF token of the old session value after confirming enrolment and got 403 | low | patch (test) | the 403 is correct (the session value changes); the test now checks it and fetches the new token |
| 3 | Five tests and the P-13 stack test assumed an admin login is refused | low | patch (tests) | updated to the restricted session of this story |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
