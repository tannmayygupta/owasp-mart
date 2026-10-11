---
title: 'Shop identity, six roles, permissions and strong hashing'
type: 'feature'
ticket: '2'
created: '2026-10-09'
status: built
baseline_revision: '82532f1'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/docs/research/RS-G-shop-domain.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The shop has a data model (T-06) but no accounts, no role permissions, and no password hashing (FR-SHP-01, FR-SHP-03, FR-SHP-09). The flows (T-14, T-15), seeded accounts (T-16) and every challenge need correct identity and the six-role permission matrix, and C02 must not be cross-solvable from a weak password hash.

**Approach:** Add (1) a password-hashing module on Node's built-in `crypto.scrypt` (strong, salted, timing-safe verify — no MD5, no unsalted); (2) an accounts service over the T-06 `users` table (create with a hashed password, authenticate); (3) the RS-G 1.2 permission matrix as data with a `can(role, action, ctx)` guard that enforces the store/owner scoping; and (4) a minimal neutral branding constant. The correct matrix is built here with real store checks; the deliberate gaps challenges rely on (e.g. C01's missing store check) are added later as isolated paths, not here.

**Decision (recorded in ADR 0018):** passwords use `crypto.scrypt` (Node built-in), so the hardened distroless image needs no native hashing dependency, consistent with ADR 0017.

## Boundaries & Constraints

**Always:** Hash with scrypt + a per-password random salt; verify in constant time; store a self-describing PHC-style string (never a bare digest). The permission matrix is the RS-G 1.2 table exactly, scoped by store for seller roles, own-resource for customers, amounts-only for finance, any-read for support, all for admin. Keep everything in `apps/shop/`.

**Never:** No MD5, SHA-1, or unsalted/fast hashes anywhere. Do not build routes, pages, sessions/cookies, or reset flows (T-14, T-15; reset is C07). Do not add the deliberate permission gaps (challenge epics). No seed accounts (T-16). No real passwords or secrets in code or tests beyond throwaway fixtures.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hash + verify | a password | `hash()` returns a `scrypt$...` string; `verify()` true for the right password | n/a |
| Wrong password | a different password | `verify()` false | constant-time, no throw |
| Tampered hash | malformed stored string | `verify()` false | no throw, no crash |
| Create account | email, password, role | row inserted with a hashed password; duplicate email rejected | UNIQUE violation surfaced |
| Authenticate | email + password | the user on success, null on bad email or password | no user-enumeration difference |
| can(): customer own order | actor=customer, ctx.owner=self | allowed | n/a |
| can(): customer other's order | actor=customer, ctx.owner=other | denied | n/a |
| can(): seller own store vs other | actor=seller_owner | allowed for own store_id, denied otherwise | n/a |
| can(): admin | any action | allowed | n/a |
| can(): unknown role/action | bad input | denied (false), never throws to "allow" | safe default deny |

</frozen-after-approval>

## Code Map

- `apps/shop/src/identity/password.mjs` -- new; `hash(password)` and `verify(password, stored)` on `crypto.scrypt`, PHC-style encoding, timing-safe compare.
- `apps/shop/src/identity/accounts.mjs` -- new; `createUser(db, {email,password,role,store_id})` and `authenticate(db, email, password)` over the `users` table.
- `apps/shop/src/identity/branding.mjs` -- new; neutral marketplace identity constants (name "VulnMart", neutral theme); full pages are T-14.
- `apps/shop/src/domain/permissions.mjs` -- new; the RS-G 1.2 matrix as data + `can(role, action, ctx)` with scope resolution (own / own_store / amounts_only / under_limit / all / deny).
- `apps/shop/src/domain/roles.mjs` -- new; the six role constants and helpers (seller roles, staff ⊂ owner).
- `apps/shop/test/password.test.mjs`, `test/accounts.test.mjs`, `test/permissions.test.mjs` -- new; the I/O matrix above.
- `apps/shop/migrations/0001_init.sql` -- READ ONLY here; `users` already exists (T-06).

## Tasks & Acceptance

**Execution:**
- [ ] `apps/shop/src/identity/password.mjs` -- scrypt hash/verify, PHC-style, timing-safe; a guard that rejects weak/legacy formats.
- [ ] `apps/shop/src/identity/accounts.mjs` -- create + authenticate over `users`, using the hashing module.
- [ ] `apps/shop/src/domain/roles.mjs` + `apps/shop/src/domain/permissions.mjs` -- roles and the RS-G matrix with `can()`.
- [ ] `apps/shop/src/identity/branding.mjs` -- neutral identity constants.
- [ ] `apps/shop/test/{password,accounts,permissions}.test.mjs` -- cover the I/O matrix, including scoped allow/deny per role.

**Acceptance Criteria:**
- Given a password, when hashed and verified, then the right password verifies true and a wrong one false; a tampered stored value verifies false without throwing.
- Given the shop source and tests, when scanned, then no MD5/SHA-1/unsalted password hashing exists (FR-SHP-09 AC).
- Given each row of the RS-G 1.2 matrix, when `can(role, action, ctx)` is evaluated, then it matches the matrix, with store/owner scoping enforced and a safe default-deny for unknown inputs.
- Given account creation, when two users share an email, then the second is rejected; authenticate returns null for a bad email or password.

## Implementation Notes

- 2026-10-09: Added `src/identity/password.mjs` (scrypt hash/verify/isStrongHash/needsRehash, PHC-style, timing-safe), `src/identity/accounts.mjs` (createUser/authenticate over `users`, normalized email, no hash leak), `src/domain/roles.mjs` and `src/domain/permissions.mjs` (the RS-G 1.2 matrix + `can`/`permissionScope`/`requiresRedaction`), `src/identity/branding.mjs`, and tests. ADR 0018 records the scrypt choice.
- Results: `corepack pnpm --filter @vulnmart/shop test` → 48 passed, 0 failed; `grep -riE "md5|sha1|createHash" apps/shop/src` finds only comments (FR-SHP-09 holds).

## Plan Change Log

- 2026-10-09 (review loop): applied 7 security patches, 1 deferred, 4 rejected. Patches: `isStrongHash` now enforces the scrypt param floor (rejects cost-downgraded hashes); `authenticate` no longer returns the password hash; `maxmem` is derived from the actual stored params (no self-lockout); a password-length cap bounds scrypt cost; email is normalized (case-insensitive login, no case-dup) and a non-string email is guarded; `permissionScope` is role-guarded and documented diagnostic-only, with a new `requiresRedaction` for the finance amounts-only obligation; a `needsRehash` seam added. Deferred brute-force lockout to T-14 (interacts with C07/C09). Rejected: the "VulnMart" name (FR-SHP-01 mandates it), the enforcement-vs-decision surface (routes are T-14/T-15), sync scrypt (single-user instances; length cap bounds cost), and the timing-test point. Tests 39 → 48.

## Review Triage Log

## Code Review

### 2026-10-09 — 7 patch, 1 defer, 4 rejected (security-sensitive)

- [x] [Review][Patch] `isStrongHash`/`parse` accept arbitrarily weak scrypt params (`N=1,r=1`), so the guard meant to reject weak hashes passes a cost-downgraded one; enforce the PARAMS floor (N, r, keylen, salt) [src/identity/password.mjs]
- [x] [Review][Patch] `authenticate` returns the full row including `password_hash`; project to `{id,email,role,store_id,status}` [src/identity/accounts.mjs]
- [x] [Review][Patch] `verify`/`hash` compute `maxmem` from module `PARAMS`, not the actual N/r, so a higher-cost stored hash throws and rejects a correct password; derive `maxmem` per call [src/identity/password.mjs]
- [x] [Review][Patch] No maximum password length — a huge password amplifies scrypt cost; cap length before hashing [src/identity/password.mjs]
- [x] [Review][Patch] Email is not normalized and `authenticate` does not guard a non-string email (dup accounts / case-sensitive login / bind throw); trim+lowercase on create and authenticate and guard the type [src/identity/accounts.mjs]
- [x] [Review][Patch] `permissionScope` has no role guard and returns the raw rule — misused as a gate it bypasses scoping; add the guard, document it diagnostic-only, and add `requiresRedaction(role, action)` so the finance `amounts_only` obligation is explicit [src/domain/permissions.mjs]
- [x] [Review][Patch] Add a `needsRehash(stored)` seam so params can be raised later; the rehash-on-login itself is the login flow's job (T-14) [src/identity/password.mjs]
- [x] [Review][Defer] No brute-force throttling/lockout or attempt accounting in `authenticate` [src/identity/accounts.mjs] — deferred: lockout and security-event emission belong to the login flow (T-14) and interact with C07 (weak reset) and C09 (unlogged legacy login); recorded in deferred-work.
- [x] [Review][Reject] "enforces / real store checks" tested only on caller-supplied ctx, not real resources — by design: route/flow wiring where ctx is populated from real rows is deferred to T-14/T-15; `can()` is a correct decision function.
- [x] [Review][Reject] Branding name "VulnMart" "telegraphs vulnerability" — FR-SHP-01 explicitly names the marketplace "VulnMart"; "neutral" is about the visual theme, not the name.
- [x] [Review][Reject] Synchronous `scryptSync` is an event-loop DoS — low in this threat model (instances are single-user and the orchestrator resets a stuck one); the password-length cap bounds per-call cost. Async can come with a spec update if the model changes.
- [x] [Review][Reject] "no user enumeration" test asserts only the return value, not timing — timing is non-deterministic to unit-test; the `DUMMY_HASH` equalization path stays.

## Design Notes

scrypt parameters follow OWASP's guidance for scrypt (cost N=2^15, r=8, p=1, 32-byte output, 16-byte random salt); they live in `password.mjs` so they can be raised later. The permission matrix keeps the scope vocabulary tiny (own / own_store / amounts_only / under_limit / all / deny) so `can()` is readable and every cell is testable; the "amounts_only" result is a signal the finance read path uses to redact personal data in T-15. Enforcement at routes is later — this story provides the decision function the flows call.

## Verification

**Commands:**
- `corepack pnpm --filter @vulnmart/shop test` -- expected: password, accounts and permission tests pass with the existing suite.
- `grep -riE "md5|sha1|createHash\\('sha1'\\)" apps/shop/src` -- expected: no password hashing uses them (FR-SHP-09).
