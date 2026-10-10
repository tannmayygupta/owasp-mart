# Shop identity, six roles, permissions and strong hashing (T-07)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | Sahil Roy |
| Branch / commit | sprint-1-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 1, shop identity and authorization (FR-SHP-01/03/09) |

## Requirements covered
FR-SHP-01 (marketplace identity and accounts), FR-SHP-03 (six roles and the RS-G permission matrix), FR-SHP-09 (strong password hashing). BMAD story 3.2 of `epic-shop-core-and-roles`. Decision: ADR 0018 (password hashing).

## Summary (plain language, 3-5 lines)
Gave the shop its accounts, its six-role permission matrix, and strong password hashing. Passwords are hashed with Node's built-in scrypt (salted, timing-safe verify, no MD5 or unsalted hashes). Accounts can be created and authenticated over the T-06 users table. The RS-G permission matrix is encoded as data with a `can(role, action, ctx)` decision function that enforces store and owner scoping and defaults to deny. The correct matrix is built here; the deliberate gaps challenges rely on are added later as isolated paths.

## Why
The shop's flows (T-14, T-15), seeded accounts (T-16) and every challenge need correct identity and authorization, and FR-SHP-09 requires strong hashing so a leaked shop hash cannot cross-solve C02.

## What was built
- `src/identity/password.mjs` — scrypt `hash`/`verify`, `isStrongHash` (enforces the param floor), `needsRehash`, PHC-style stored strings, a password-length cap.
- `src/identity/accounts.mjs` — `createUser` and `authenticate` over `users`, with normalized email, duplicate and unknown-role guards, and no password-hash leakage.
- `src/domain/roles.mjs` — the six roles.
- `src/domain/permissions.mjs` — the RS-G 1.2 matrix, `can()`, `permissionScope()` (diagnostic), `requiresRedaction()` (finance amounts-only).
- `src/identity/branding.mjs` — neutral marketplace identity constants (name "VulnMart", neutral theme).
- `test/password.test.mjs`, `test/accounts.test.mjs`, `test/permissions.test.mjs`.

## How it works
`password.mjs` derives a key with scrypt (N=2^15, r=8, p=1, 32-byte key, 16-byte salt), stores `scrypt$N=…,r=…,p=…$salt$key`, and verifies in constant time, computing `maxmem` from the stored params so a higher-cost hash still verifies. `accounts.authenticate` always runs a verify (against a dummy hash for unknown emails) to avoid user enumeration and returns the user without the hash. `permissions.can()` resolves each matrix cell against the context (own, own_store, own_store_under_limit, amounts_only) with a safe default deny. Who enforces this at routes, and the login lockout, come with the flows (T-14/T-15).

## Files changed
- `apps/shop/src/identity/password.mjs`, `accounts.mjs`, `branding.mjs` — new.
- `apps/shop/src/domain/roles.mjs`, `permissions.mjs` — new.
- `apps/shop/test/password.test.mjs`, `accounts.test.mjs`, `permissions.test.mjs` — new.
- `docs/adr/0018-shop-password-hashing.md` — new decision record.

## Decisions made
ADR 0018: passwords use Node's built-in `crypto.scrypt` (not argon2/bcrypt), so the hardened distroless image needs no native hashing dependency (consistent with ADR 0017). Parameters follow OWASP guidance and live in one module so they can be raised; `needsRehash` lets the login flow upgrade old hashes.

## Tests
Real commands and results:
- `corepack pnpm --filter @vulnmart/shop test` → 48 passed, 0 failed (hash round-trip, malformed-input non-throw, weak-format and cost-downgrade rejection, length cap, higher-cost verify; account create/auth, email normalization, no hash leak, non-string email; the permission matrix cells with store/owner scoping, amounts-only redaction, and safe default deny).
- `grep -riE "md5|sha1|createHash" apps/shop/src` → only comments; no weak password hashing (FR-SHP-09 AC).
Traceability rows FR-SHP-01, FR-SHP-03, FR-SHP-09 updated in `docs/traceability.md`.

## Evidence
Test output above; the weak-hash grep result.

## Problems met and how they were fixed
The security review (four reviewer lenses) found real hardening gaps: `isStrongHash` accepted cost-downgraded scrypt, `authenticate` returned the password hash, `maxmem` was computed from the module default (self-lockout risk), email was not normalized, and `permissionScope` could be misused as a gate. All fixed, with tests. Brute-force lockout is deferred to the login flow (T-14), where it interacts with C07 and C09.

## Security notes (vulnerable parts only)
This is the correct, hardened identity layer — not a weakness. Password hashing is scrypt with a salt and a parameter floor; the weak-hash weakness C02 needs is a separate isolated path in that challenge. The permission matrix is correct here; C01's missing store check and other role gaps are added by the challenge epics. No real passwords or secrets in code; test fixtures are throwaway.

## Limitations and follow-ups
- Sessions, routes, pages and the password-reset flow are T-14/T-15 (reset is C07).
- Brute-force lockout, attempt accounting and security-event emission are the login flow's job (T-14); the `needsRehash` seam and `security_events`/`alerts` tables are ready. See `docs/bmad/initiative-target/deferred-work.md`.
- scrypt runs synchronously; acceptable for single-user instances, revisit if the threat model changes.
