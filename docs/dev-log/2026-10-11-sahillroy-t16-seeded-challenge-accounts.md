# Seeded accounts for the challenges (T-16)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 2, challenge account roster (FR-SHP-08) |

## Requirements covered
FR-SHP-08 (seed each instance with the accounts the challenges need; no seeded account password is reused across challenges — C07 and C09 differ). BMAD story 3.5 of `epic-shop-core-and-roles`.

## Summary (plain language, 3-5 lines)
Added the known cast of accounts every fresh instance needs for the challenges, as one seed contribution dropped into the T-08 registry (no shared file edited). The roster: the player's seller-staff login at Harbor and a player customer, a finance account (C07), a dormant support agent `s.iyer` (C09), an admin, a support-agent bot (C03, separate from `s.iyer`), and two filler customers no human uses. Each account has a distinct, documented, non-secret placeholder password; the deliberate weak/default credentials for C05/C07/C09 and the per-instance flags are injected later by the challenge epics, never baked in here.

## Why
The challenges need a fixed, independently-solvable start state: a given seller-staff and customer login (RS-E A-3), a finance target and a dormant support agent whose weak legacy login C09 abuses (RS-F), and an admin/bot for roles the customer flow does not cover. Centralising the roster as data gives the briefs, the exploit tests and the challenge epics one source of truth and makes the no-reuse invariant enforceable.

## What was built
- `apps/shop/seed/contributions/010-challenge-accounts.mjs` — exports `CHALLENGE_ACCOUNTS` (the roster as data) and `seededPasswords`, and a `seed(db, ctx)` that hashes each distinct password and inserts eight `users` rows (ids 10–17) over the two baseline stores, with the fixed seed timestamp.
- `apps/shop/seed/contributions/000-baseline.mjs` — now also exports `seededPasswords` (the one convention the global no-reuse test reads).
- `apps/shop/test/seed-challenge-accounts.test.mjs` — roster/role/store-link, authenticate-as-itself-and-no-other, global cross-contribution password distinctness, strong-hash, determinism and no-flag assertions.

## How it works
The T-08 registry runs contributions in numeric-prefix order inside one transaction, so `010-` runs after `000-baseline` and the seller-staff's `store_id = 1` FK is already satisfied. Ids start at 10 to avoid the baseline's 1–3; no stores are added, so the baseline's "exactly two stores" stays true. Every login password is listed in a contribution's `seededPasswords` export; a single test aggregates that export across all contributions and asserts the combined set is distinct — so the FR-SHP-08 cross-challenge no-reuse invariant keeps holding as later epics drop in `011-`, `012-`, … files.

## Files changed
- `apps/shop/seed/contributions/010-challenge-accounts.mjs`, `apps/shop/test/seed-challenge-accounts.test.mjs` — new.
- `apps/shop/seed/contributions/000-baseline.mjs` — added the `seededPasswords` export.

## Decisions made
Accounts only, over the baseline stores. The deliberate weak/default passwords (C05 default admin, C07 finance reset, C09 s.iyer's common-list password) are **not** baked in — each account gets a strong distinct placeholder and the owning epic sets the weakness per instance (D-02: secrets/flags injected at start, never in source). "Other stores no human uses" is met by the existing baseline stores (Northwind is C01's cross-store target); a new store would break the T-08 `stores==2` invariant and belongs to a challenge epic. "Dormant" is narrative-only — the schema has no dormant status and `suspended` would block the C09 login.

## Tests
Real commands and results:
- `node --test "apps/shop/test/**/*.test.mjs"` → **84 passed, 0 failed** (79 prior + 5 new). The roster tests prove: all eight accounts exist with the right roles and the player staff linked to Harbor; `s.iyer` and the bot are distinct support agents; each account authenticates **as itself** (`ok.id === a.id`) and rejects every other account's password; **every seeded password across all contributions is distinct** and finance (C07) ≠ s.iyer (C09); hashes are strong; the roster is identical across two builds and carries no flag. The existing T-08 seed/snapshot tests still pass (stores still == 2).
- Traceability row FR-SHP-08 added in `docs/traceability.md`.

## Evidence
Test output above; the determinism test seeds two in-memory instances and compares the roster rows (excluding the salted hash).

## Problems met and how they were fixed
The two-lens review found the tests under-proved the two hard claims: cross-**challenge** uniqueness was unguarded (the tests only saw this one file), and "authenticates only its own account" asserted role-equality, which a wrong same-role account would pass. Fixed both — the `seededPasswords` convention plus a global distinctness test, and an `ok.id === a.id` assertion — plus nits (fragile `id >= 10` filter, a vacuous plaintext check, a convoluted IIFE).

## Security notes (vulnerable parts only)
No deliberate weakness here — this is the correct roster. No flag-shaped value or per-instance secret is in source; no weak/default credential is baked in; every password is a strong scrypt hash and distinct across the whole seeded world. The challenge-specific weaknesses (C05/C07/C09) and flags arrive via the injector and the challenge epics.

## Limitations and follow-ups
- The real weak/default passwords for C05/C07/C09 and all per-instance flags are set by those challenge epics, not here.
- Challenge-specific stores and vulnerable data (e.g. C04's delivered 2,500 order, C08's pending-payment order, C02's gift-card serial 1, C11's pending-KYC seller) belong to the challenge epics.
