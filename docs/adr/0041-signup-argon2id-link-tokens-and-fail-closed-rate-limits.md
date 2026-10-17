# 0041. Signup: Argon2id profile, hashed single-use links, fail-closed rate limits

- **Status:** Proposed (OI-29 answer is the developer's, 2026-10-17; the rest is the builder's design for the developer to confirm)
- **Date:** 2026-10-17
- **Deciders:** Akshay (OI-29); Claude Code (design)
- **Requirements:** FR-ACC-01, FR-ACC-02, FR-ACC-10, FR-ACC-05, D-21, OI-29, NFR-SEC-03

## Context
Learner signup is public, so it is the first endpoint an attacker meets: password storage, link guessing, account enumeration, mail bombing and automated signups all apply. Stack: FastAPI, Argon2id, Valkey, the outbox of ADR 0040.

## Options considered
1. **Passwords:** Argon2id at the OWASP minimum (19 MiB, 2, 1) / the RFC 9106 low-memory profile (64 MiB, 3, 4) / bcrypt. The API container has 256 MiB and several signups can overlap.
2. **Link tokens:** random 256-bit value stored as a SHA-256 hash / a signed token (JWT-like) with no storage / a slow hash of a short code. Signed tokens cannot be used once without storage anyway; a slow hash is pointless for 256 bits of randomness.
3. **Rate limit store failure:** let requests through (fail open) / refuse (fail closed).
4. **CAPTCHA (OI-29):** none / Turnstile / a neutral hook. The developer chose none.

## Decision
- Argon2id, 19 MiB, 2 passes, 1 lane (the OWASP floor), at most 4 hashes at once per process; spike S-12 may raise it. The password is hashed for known and unknown addresses alike so the answer takes the same time.
- Tokens: 32 random bytes, URL-safe, kept as a SHA-256 hash, claimed with one conditional UPDATE; one error for used, expired, unknown and wrong-purpose.
- The signup answer is 202 with one body for a new and a known address; a known address gets an "already registered" mail. The cost is that one address can be sent that mail, so it is limited per address (3 an hour) and per visitor address (30 an hour, placeholders).
- Rate limits are fixed-window counters in Valkey (one Lua call), keyed by a hash of the address, and **fail closed**: if Valkey is down the request is refused.
- Visitor address: `x-forwarded-for` only when an origin secret protects the API (architecture 03 rule 4), the entry `trusted_proxy_hops` from the right; IPv6 counted per /64.
- No CAPTCHA now (OI-29: rate limits only); the optional `captcha_token` field is kept and ignored.
- The database enforces FR-ACC-05: `user_roles` has a composite foreign key to `users (id, account_type)` with `account_type = 'participant'`.

## Consequences
- A shared address (a college lab) can hit the per-address limit sooner than one person would; the numbers are settings.
- Valkey becoming unavailable stops signup (and later login throttling) instead of silently removing the protection; the readiness check already reports it.
- A visitor address behind an unknown number of proxies is wrong if `trusted_proxy_hops` is wrong; behind `caddy-p` it needs 2 (handoff H-129).
- Argon2id strength is the minimum; a stronger setting costs memory per concurrent signup.

## Evidence
- OWASP Password Storage Cheat Sheet (Argon2id minimum 19 MiB, t=2, p=1) and RFC 9106 section 4 (recommended profiles): **from memory of the documents, not re-read during this story.**
- `argon2-cffi` 25.1.0 resolves and runs on Python 3.14 (`uv pip install --dry-run`, 2026-10-17); the hash string produced starts `$argon2id$v=19$m=19456,t=2,p=1$` (test `test_passwords_are_argon2id_with_a_salt_and_verify_in_both_directions`).
- Race behaviour shown on real Postgres 18.6: 8 simultaneous signups for one address make one account and one verification mail; 8 simultaneous uses of one link give one success (`test_accounts_postgres.py`).
