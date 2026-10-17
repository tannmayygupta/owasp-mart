---
title: 'Seeded accounts for the challenges'
type: 'feature'
ticket: '5'
created: '2026-10-11'
status: 'built'
baseline_revision: 'cd9e37d'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/docs/research/RS-E-challenges-01-06.md'
  - '{project-root}/docs/research/RS-F-challenges-07-11.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The challenges (C01–C11) need a known cast of accounts in every fresh instance — a player seller-staff and customer login, a finance account, a dormant support agent, an admin, a support-agent bot, and filler stores/customers no human uses (FR-SHP-08; RS-E A-3, RS-F). The baseline seed (T-08) only provides the generic demo world; the per-challenge roster does not exist yet, and the AC requires that no seeded password be reused across challenges (C07's and C09's differ).

**Approach:** Add one seed contribution (`contributions/010-challenge-accounts.mjs`, dropped into the T-08 registry — no shared file edited) that seeds the challenge **account roster** as `users` rows over the existing baseline stores (Harbor = player's store, Northwind = the "other" store), each with a distinct, documented, non-secret password exported as data. Accounts only: per-challenge vulnerable data, weak/default passwords and per-instance flags stay with the challenge epics and the injector (D-02: secrets/flags are injected at start, never in source).

## Boundaries & Constraints

**Always:** One new `contributions/NNN-*.mjs` file; reuse the T-08 registry, `createUser`-style hashing (strong hash, never plaintext), fixed `ctx.ts` timestamp, fixed non-colliding ids. Every seeded account password is distinct from every other and from the baseline `SEED_PASSWORD`. Passwords are exported as named data so the brief, tests and later epics reference one source. Stay in `apps/shop/seed/`.

**Never:** No new stores (baseline seeds exactly two; challenge-specific stores like a pending-KYC seller are C11's epic). No flag-shaped values or per-instance secrets. No weak/default passwords baked in for C05/C07/C09 — those epics set the deliberate weakness per instance. No schema changes, no new columns (e.g. `stores.approved_by` is C11's). No business-logic or route changes.

## I/O & Edge-Case Matrix

| Account (email) | Role | Store | Purpose |
|-----------------|------|-------|---------|
| `staff.harbor@vulnmart.test` | seller_staff | Harbor (1) | player's seller-staff login (C01/C06 start) |
| `player.customer@vulnmart.test` | customer | — | player's customer login (C02/C04/C07/C08/C09 start) |
| `finance.ops@vulnmart.test` | finance | — | C07 target (reset-code challenge) |
| `s.iyer@vulnmart.test` | support_agent | — | C09 dormant legacy-login target |
| `admin.root@vulnmart.test` | admin | — | C01/C05/C09-alerts/C11 queue |
| `bot.support@vulnmart.test` | support_agent | — | C03 stored-XSS victim bot (separate from s.iyer) |
| `shopper.lee@vulnmart.test`, `shopper.ng@vulnmart.test` | customer | — | filler customers no human uses |

| Invariant | Expected |
|-----------|----------|
| Every seeded password | distinct across all accounts and ≠ baseline SEED_PASSWORD (FR-SHP-08 AC) |
| Finance (C07) vs s.iyer (C09) password | differ (explicit AC) |
| Each account's password | authenticates that account and no other |
| Determinism | same world across two builds (fixed ids + ts), FR-SHP-12 |
| Flag-shaped value | none in the seeded roster |
| Hashing | every password a strong hash, never plaintext |

</frozen-after-approval>

## Code Map

- `apps/shop/seed/contributions/010-challenge-accounts.mjs` -- new; exports `CHALLENGE_ACCOUNTS` (the roster as data) and a default `seed(db, ctx)` that hashes each distinct password and inserts the `users` rows over baseline stores, with fixed ids and `ctx.ts`.
- `apps/shop/test/seed-challenge-accounts.test.mjs` -- new; asserts the roster is seeded, passwords are pairwise distinct (incl. finance≠s.iyer and ≠ baseline), each authenticates only its own account, hashes are strong, determinism holds, and no flag-shaped value appears.

## Tasks & Acceptance

**Execution:**
- [ ] `010-challenge-accounts.mjs` -- roster-as-data + `seed()` inserting the eight accounts with distinct hashed passwords over baseline stores.
- [ ] `seed-challenge-accounts.test.mjs` -- uniqueness, authenticate-only-own, strong-hash, determinism, no-flag assertions.

**Acceptance Criteria:**
- Given a fresh migrated+seeded instance, when the roster is queried, then all eight accounts exist with the right roles, the player's seller-staff is linked to Harbor, and each can authenticate with its documented password.
- Given the seeded world, when all known passwords are collected, then they are pairwise distinct and the finance (C07) and s.iyer (C09) passwords differ.
- Given any account's password, when used against another account, then authentication fails.
- Given two builds, when seeded, then the account world data is identical (FR-SHP-12); no seeded value is flag-shaped; every hash is strong.

## Implementation Notes

The deliberate weaknesses the challenges rely on (C05 default-admin credentials, C07 finance reset code, C09 s.iyer's common-list weak password) are **not** baked in here: the account exists with a strong distinct placeholder password, and the owning challenge epic sets the weak/default credential per instance (D-02). This story only guarantees the roster and the no-reuse invariant.

## Plan Change Log

## Review Triage Log

### 2026-10-11 — two-lens review (security/blind-hunter, intent-alignment; Opus)

Both lenses confirmed the seed source is clean: no id/store/email/CHECK collisions (roster ids 10–17, baseline 1–3; zero stores added so the T-08 `stores==2` invariant holds; all roles in the enum; status always `active`), no flag-shaped value, no per-instance secret, and no deliberate weak/default credential baked in (s.iyer and finance carry strong distinct placeholders — the C05/C07/C09 weaknesses are the owning epics' per-instance job). Within-file uniqueness was already a real invariant, not a hand-list.

**Fixed:**
- Cross-**challenge** no-reuse (the actual FR-SHP-08 scope) was unguarded: the tests only covered this file, so a future contribution could reuse a password undetected. Added a `seededPasswords` export convention (baseline + roster) and a global test that aggregates every contribution's passwords and asserts they are all distinct — forward-stable as `011-`/`012-` files are added.
- "Authenticates only its own account" was under-proven: it asserted `ok.role === a.role`, which passes for a wrong same-role account (3 customers, 2 support agents). Now asserts `ok.id === a.id`.
- Determinism test read the roster by the fragile `id >= 10`; now filters by the known roster id set. Dropped a near-vacuous plaintext `.includes` check (strong-hash already proves it) and simplified a convoluted async IIFE.

**Acknowledged, not fixed (accepted design choices):**
- "Other stores … no human uses" is met by reusing the baseline stores (Northwind is the C01 cross-store target); no new store is seeded, because the boundary forbids it and the T-08 tests assert exactly two stores. Challenge-specific stores (e.g. a pending-KYC seller for C11) belong to those epics.
- "Dormant" (s.iyer) is narrative-only, not a row state: the schema has no dormant status and a `suspended` status would block the C09 legacy login the challenge needs.
- The RS-F invariant "the weak legacy password must not be accepted by finance" cannot be exercised here — that weak password is injected later (D-02); the cross-rejection test proves distinctness of the strong placeholders instead.

## Design Notes

Ids start at 10 (baseline uses 1–3) to leave room and avoid collisions; stores stay at the two baseline stores so the T-08 `stores.length === 2` invariants hold. The roster is a single exported array so the challenge briefs, the exploit tests and later epics all read one source of truth for emails/passwords.

## Verification

**Commands:**
- `node --test "apps/shop/test/**/*.test.mjs"` -- expected: the new seed-challenge-accounts tests pass with the suite, and the existing T-08 seed/snapshot tests still pass (stores still == 2).
- `corepack pnpm --filter @vulnmart/shop run snapshot` -- expected: snapshot builds and reports the larger user count.
