# 0045. TOTP second factor: sealed secret, keyed recovery codes, a restricted session for an admin without one

- **Status:** Proposed (the builder's design for the developer to confirm; the requirement fixes the outcome: TOTP for every admin, optional for recruiters, OI-13 open)
- **Date:** 2026-10-18
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-ACC-07, FR-ACC-03, FR-ACC-10, D-19, OI-13, NFR-SEC-01, NFR-SEC-02

## Context
FR-ACC-07 says every admin login needs an authenticator-app code and that an admin without one reaches no admin function. The contract (IF-1) fixes the routes, the ticket and the recovery codes. It does not say how an admin who has only a password can ever enrol, where the TOTP secret lives, how recovery codes are stored, or how many tries a login gets.

## Options considered
1. **An admin before enrolment:** refuse the sign-in (nobody could enrol; P-12 did this as a stopgap) / give a session that can enrol but holds no admin role / enrol out of band at creation (the seed prints a secret).
2. **TOTP code:** a library (`pyotp`) / the standard library, about 30 lines, checked against the RFC 6238 vectors.
3. **The secret at rest:** hashed (impossible, it must be read back) / sealed with AES-256-GCM under a field key (architecture 04 and 06, `K_field`) / in clear.
4. **Recovery codes:** plain / a fast hash / a keyed hash (HMAC with the field key) / a slow hash per code.
5. **Tries:** a limit per account only / a ticket that allows five tries plus a limit per account.
6. **Replay:** accept a code again within its window / require a newer time step than the last used.

## Decision
- An admin who signs in with only a password gets a session that carries **no admin role** (`mfa_at` is empty in the `sessions` row), so every admin function refuses it, and that session can enrol. Confirming enrolment records the proof, changes the session value and from then on the sign-in is two steps. The role is decided in one place (`SessionService.resolve`), so no admin route has to remember to check.
- TOTP is the standard library (RFC 6238 over RFC 4226, SHA-1, 6 digits, 30 seconds, one step either side), verified against all six RFC test vectors and against an independent implementation in the end-to-end test.
- The secret is sealed with AES-256-GCM through the `cryptography` library (new dependency, 50.0.2); the key comes from `VULNMART_FIELD_SECRET(_FILE)` through HKDF with its own label, and the account id is the associated data. Staging and production do not start without the secret.
- Recovery codes are 48 random bits shown as 10 Base32 characters, ten per enrolment, stored only as HMAC-SHA256 under a second key derived from the field secret (a leaked table cannot be searched offline), each usable once.
- A login ticket is 256 random bits kept as a hash, valid 5 minutes, single use, five tries; wrong codes are also counted per account (10 in 15 minutes) and a login that reaches the second step first checks that wait.
- A code must belong to a time step newer than the last one used, and every claim is a conditional UPDATE, so one code or ticket opens at most one session even when two requests arrive together.
- Any account may turn the factor on (the requirement names recruiters); a non-admin may turn it off with the password; an admin cannot.

## Consequences
- An admin's first session exists with no powers; a dashboards page has to show "set up your authenticator" for it (the answer's `mfa_enabled` is false).
- If an admin loses the phone and the recovery codes, only an operator can recover the account in the database; there is no self-service path by design. A runbook states that.
- The field secret is a setting until the key service (story P-17): rotating it makes every sealed secret unreadable (and every recovery hash unmatched), so it must not change without a migration.
- TOTP is phishable; passkeys (OI-13) would be stronger and are not built.
- SHA-1 inside HMAC is what authenticator apps support; it is not a weakness of this use.

## Evidence
- RFC 6238 appendix B test vectors (the SHA-1 table) reproduced in `test_totp_and_fieldkeys.py`: six times, 8 and 6 digits. RFC 4226 section 5.3 dynamic truncation is the code in `totp.py`. The RFCs themselves were **not re-read** during this story; the vectors are from memory and pass, which is strong evidence they are right.
- Real stack: an admin created by the seed command signs in without admin powers, enrols through the web proxy, confirms with a code made by a Node implementation of RFC 6238, gets ten recovery codes, signs in in two steps, cannot replay a code, uses a recovery code once, and cannot turn the factor off (`platform-stack.e2e.test.mjs`, 20 of 20). The database holds `v1.`-sealed text for the secret and 64-character hashes for the codes.
- Real Postgres: eight simultaneous uses of one TOTP code, of one recovery code and of one ticket each open exactly one session (`test_accounts_postgres.py`).
- OWASP ASVS 5.0 multi-factor authentication chapter and NIST SP 800-63B authenticator requirements: **not re-read during this story.**
