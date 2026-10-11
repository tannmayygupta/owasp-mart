# Shop data model and seven state machines (T-06)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | Sahil Roy |
| Branch / commit | sprint-1-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 1, shop core data model (FR-SHP-02, FR-SHP-04) |

## Requirements covered
FR-SHP-02 (about 20 tables), FR-SHP-04 (seven state machines). BMAD story 3.1 of `epic-shop-core-and-roles`. Decision: ADR 0017 (SQLite driver).

## Summary (plain language, 3-5 lines)
Built the shop's correct marketplace data model and its seven state machines. The schema is 23 tables (the RS-G 1.1 entities plus the thin audit log and the C09 security-events and alerts tables), created by an idempotent migration runner on SQLite. The seven state machines (seller approval, product, checkout, fulfilment, refund, dispute, payout) are pure, tested transition logic that allows only the transitions the spec draws and rejects the rest. No weaknesses, flows, roles or seed data — those come in later stories.

## Why
Every later shop story (roles T-07, flows T-14/T-15, seeded accounts T-16, and all the challenges) builds on this model and these state machines, so they must exist and be correct first (FR-SHP-02, FR-SHP-04).

## What was built
- `apps/shop/migrations/0001_init.sql` — 23 tables with keys, foreign keys, integer `*_cents` money, status CHECKs that mirror the state machines, uniqueness and indexes.
- `apps/shop/src/db/index.mjs` — the one place that names the driver (`node:sqlite`, ADR 0017), with foreign keys enforced per connection.
- `apps/shop/src/db/migrate.mjs` — idempotent migration runner (numeric-version order, duplicate-version guard, per-migration transaction with guarded rollback) and a CLI.
- `apps/shop/src/domain/state-machines.mjs` — the seven machines and `canTransition`/`assertTransition` guards.
- `apps/shop/test/db.test.mjs`, `apps/shop/test/state-machines.test.mjs` — 21 tests total.
- `apps/shop/package.json` — a `migrate` script.

## How it works
Migrations are `NNNN_name.sql` applied in numeric order and recorded in a `_migrations` ledger, so re-running is a no-op and a failing migration rolls back atomically. The state machines are pure data and functions (no DB, no roles); later stories persist the resulting status onto the row, and the status CHECK constraints enforce membership at the database. Who may move a transition is enforced with the permission matrix in T-07, not here.

## Files changed
- `apps/shop/migrations/0001_init.sql`, `apps/shop/src/db/index.mjs`, `apps/shop/src/db/migrate.mjs`, `apps/shop/src/domain/state-machines.mjs` — new.
- `apps/shop/test/db.test.mjs`, `apps/shop/test/state-machines.test.mjs` — new.
- `apps/shop/package.json` — `migrate` script.
- `docs/adr/0017-shop-sqlite-driver.md` — new decision record.

## Decisions made
ADR 0017: the shop uses Node 24's built-in `node:sqlite` (not `better-sqlite3`), so the hardened distroless image needs no native build. Confirmed by Sahil before building. The driver sits behind `src/db/index.mjs` so it is swappable.

## Tests
Real commands and results:
- `corepack pnpm --filter @vulnmart/shop test` → 21 passed, 0 failed (migrations apply, idempotent; FK enforced; status CHECK rejects out-of-machine values; each status column mirrors its machine; a failing migration rolls back and records nothing; duplicate versions rejected; all seven machines allow only the declared transitions and reject every other pair).
- `node --test "apps/*/test/*.test.mjs"` (the CI command) → 21 passed.
- `node apps/shop/src/db/migrate.mjs <file>` → applies v1, second run no-ops; 24 tables in the migrated db.
Traceability rows FR-SHP-02 and FR-SHP-04 updated in `docs/traceability.md`.

## Evidence
Test output above; the migration CLI output (`applied migrations: 1` then `up to date`).

## Problems met and how they were fixed
Ajv-style strict issues did not apply here, but the code review (four reviewer lenses) found two real problems: the state machines had added recovery edges the spec does not draw (violating the "reject the rest" boundary), and transitions were tested only by sample. Fixed by tightening the machines to exactly the RS-G/FR-SHP-04 arrows and adding an exhaustive transition test, a schema↔machine mirror test, and a migration rollback test. node:sqlite emits an ExperimentalWarning, which is expected and harmless.

## Security notes (vulnerable parts only)
None yet — this is the correct model. Password hashing itself is T-07. The audit log is deliberately thin and the C09 security-events/alerts tables exist for the logging challenge. No flags, secrets or seed data.

## Limitations and follow-ups
- Resubmit-after-reject / retry / hold-release edges are intentionally absent (not in RS-G); add them via a spec update if a flow needs them.
- `updated_at` columns exist but are set by the application; no triggers.
- The schema↔machine mirror is tested for the six fully-mirrored tables; `orders.status` is the checkout subset and `payments.status` has no machine (by design).
