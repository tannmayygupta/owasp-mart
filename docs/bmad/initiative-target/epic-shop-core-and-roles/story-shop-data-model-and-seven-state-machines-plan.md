---
title: 'Shop data model and seven state machines'
type: 'feature'
ticket: '1'
created: '2026-10-09'
status: built
baseline_revision: '218e8bd'
route: 'full'
route_source: 'pinned'
risk: 'medium'
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

**Problem:** The shop has no data model or state logic (FR-SHP-02, FR-SHP-04). Every later shop story — roles (T-07), customer/support/finance/admin flows (T-14, T-15), seeded accounts (T-16), and the challenges — builds on the ~20-table marketplace model and the seven state machines. They must exist, correct, before any of that.

**Approach:** Add a SQLite schema of the ~20 tables from RS-G 1.1 (plus the thin audit log and the C09 security-events/alerts tables from FR-SHP-02) as ordered migrations, a small migration runner, and the seven state machines (seller approval, product, checkout, fulfilment, refund, dispute, payout) as pure transition logic with guards. This is the correct model only; the weaknesses are added later by the challenge epics as isolated paths.

**Decision (confirmed by Sahil 2026-10-09):** the shop uses Node 24's built-in `node:sqlite` as its SQLite driver (not `better-sqlite3`), so there is no native build in the hardened distroless image. Recorded in ADR 0017.

## Boundaries & Constraints

**Always:** Model exactly the RS-G 1.1 entities plus `audit_log`, `security_events` and `alerts` (FR-SHP-02 AC). Money is integer minor units (`*_cents`). The seven state machines allow only the transitions in FR-SHP-04 / RS-G and reject the rest; who may move each is enforced later with roles (T-07), not here. Migrations run on SQLite and are idempotent (a `_migrations` ledger). Stay in `apps/shop/`.

**Never:** Do not build flows, screens, auth, or the permission matrix (T-07, T-14, T-15). Do not add seeding/snapshotting (T-08) or any flag, weakness or seed data. No variants, carriers, tax, multi-currency, reservations or wishlists (out of scope per FR-SHP-02 AC). No ORM that hides SQL (RS-G wants a thin query layer so SQL injection is natural later).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh migrate | empty SQLite db | all tables created, `_migrations` records the version | re-run is a no-op |
| Re-run migrate | already-migrated db | no change, no error (idempotent) | n/a |
| Legal transition | e.g. refund `requested`→`approved` | allowed; new state returned | n/a |
| Illegal transition | e.g. refund `requested`→`processed` | rejected with a clear error naming from/to | throws / returns error, no state change |
| Unknown state | a state not in the machine | rejected | throws |

</frozen-after-approval>

## Code Map

- `apps/shop/migrations/0001_init.sql` -- new; the ~20 tables + `audit_log`, `security_events`, `alerts`, and a `_migrations` ledger table.
- `apps/shop/src/db/index.mjs` -- new; open a SQLite database (driver chosen by Open Question 1) behind a tiny interface (`exec`, `prepare`), so the driver is swappable.
- `apps/shop/src/db/migrate.mjs` -- new; apply `migrations/*.sql` in order, record each in `_migrations`, skip applied ones; a CLI (`node src/db/migrate.mjs <dbfile>`).
- `apps/shop/src/domain/state-machines.mjs` -- new; the seven machines as `{ states, initial, transitions }` plus `canTransition(machine, from, to)` and `assertTransition(...)`.
- `apps/shop/test/db.test.mjs` -- new; migrate a fresh `:memory:`/temp db, assert every expected table exists and re-migration is a no-op.
- `apps/shop/test/state-machines.test.mjs` -- new; for each machine, a legal path passes and representative illegal transitions are rejected.
- `apps/shop/package.json` -- add a `migrate` script (and the driver dep if Open Question 1 picks better-sqlite3).

## Tasks & Acceptance

**Execution:**
- [ ] `apps/shop/migrations/0001_init.sql` -- all tables with keys, foreign keys, `*_cents` integer money, status columns, timestamps.
- [ ] `apps/shop/src/db/index.mjs` + `apps/shop/src/db/migrate.mjs` -- the driver wrapper and the idempotent migration runner + CLI.
- [ ] `apps/shop/src/domain/state-machines.mjs` -- the seven machines and the transition guard.
- [ ] `apps/shop/test/db.test.mjs` -- migration tests (tables exist, idempotent).
- [ ] `apps/shop/test/state-machines.test.mjs` -- transition tests for all seven.
- [ ] `apps/shop/package.json` -- `migrate` script (+ driver dep if chosen).

**Acceptance Criteria:**
- Given a fresh SQLite database, when the migration runner runs, then all ~20+ tables exist and `_migrations` records version 1; running it again changes nothing.
- Given each of the seven state machines, when a legal transition is requested, then it is allowed; when an illegal one is requested, then it is rejected naming from/to, with no state change.
- Given the money columns, when inspected, then they are integer `*_cents` (no floats).
- Given `apps/shop` tests, when run, then the migration and state-machine tests pass (and run in the CI `app tests` job).

## Implementation Notes

- 2026-10-09: Added `apps/shop/migrations/0001_init.sql` (23 domain tables + `_migrations`), `src/db/index.mjs` (node:sqlite wrapper, FK-on), `src/db/migrate.mjs` (idempotent runner + CLI), `src/domain/state-machines.mjs` (seven machines + guards), and tests. Money is integer `*_cents`; status CHECKs mirror the machine state sets. `migrate` script added to package.json.
- Results: `corepack pnpm --filter @vulnmart/shop test` → 21 passed, 0 failed; migrate CLI applies v1 then no-ops; 24 tables in a migrated db.

## Plan Change Log

- 2026-10-09 (review loop): applied 9 patches, 3 rejected. The two substantive ones: (1) tightened the state machines to exactly the RS-G/FR-SHP-04 arrows — removed the unspecified recovery edges (product resubmit/relist, checkout retry, payout hold swaps) that broke the "reject the rest" boundary; (2) added an exhaustive transition test (every non-declared pair rejected), a schema↔machine CHECK mirror test, and a migration rollback/duplicate-version test. Plus schema hygiene (UNIQUE on reviews and cart_items, the missing FK-lookup indexes, `updated_at` on status-bearing tables, removed the premature `order_items.status` default, documented the dual-unit coupon and negative payout net and the shipping snapshot, simplified the dispute CHECK) and runner hardening (numeric sort, duplicate-version guard, guarded ROLLBACK, CLI finally). Tests 16 → 21, all passing.

## Review Triage Log

## Code Review

### 2026-10-09 — 9 patch, 3 rejected

- [x] [Review][Patch] State machines added edges not in RS-G/FR-SHP-04 (product `rejected→pending_review`, `unlisted→pending_review`; checkout `payment_failed→payment_pending`; payout `ready→held`, `held→ready`), violating the "allow only RS-G transitions, reject the rest" boundary. Tighten to the spec (keep published→pending_review and escalated→resolved_*, which RS-G draws/implies) [src/domain/state-machines.mjs]
- [x] [Review][Patch] Transitions tested by representative sample; add an exhaustive test asserting every non-declared state pair is rejected (reject-the-rest at the right surface) [test/state-machines.test.mjs]
- [x] [Review][Patch] The documented schema↔machine CHECK "mirror" is untested; add a test asserting each fully-mirrored status column accepts exactly its machine's states [test/db.test.mjs]
- [x] [Review][Patch] The migration rollback/failure path is unverified; add a test with a bad 0002 migration asserting it throws and leaves no table and no `_migrations` row [test/db.test.mjs]
- [x] [Review][Patch] Migration runner edge cases: sort by numeric version (not lexicographic), reject duplicate versions up front, guard the ROLLBACK, and close the db in a finally in the CLI; document that migration files carry no BEGIN/COMMIT [src/db/migrate.mjs]
- [x] [Review][Patch] `machine()` does not detect orphan/unreachable states; add a reachability check [src/domain/state-machines.mjs]
- [x] [Review][Patch] Missing domain uniqueness: `UNIQUE(reviews.product_id,user_id)` and `UNIQUE(cart_items.cart_id,product_id)` [migrations/0001_init.sql]
- [x] [Review][Patch] Add the missing FK-lookup indexes the comment promised (payments.order_id, refunds/commissions/disputes.order_item_id, ticket_messages.ticket_id, cart_items.cart_id, notifications.user_id, uploads.owner_id) [migrations/0001_init.sql]
- [x] [Review][Patch] Schema hygiene: add `updated_at` to the status-bearing tables; remove `order_items.status` default (set explicitly at creation); document `coupons.value` dual unit, `payouts.net_cents` allowing negatives, and the order shipping snapshot; simplify the redundant `disputes.liable_party` CHECK [migrations/0001_init.sql]

Rejected:
- order shipping fields all-nullable (blind-hunter): by design — a flow-set snapshot (RS-G "shipping address snapshot"); documented, enforced at checkout in T-14.
- INTEGER affinity does not bar floats (intent-alignment): by design — money is cents by naming + affinity + `>=0`, consistent with "correct model only"; a CAST guard is overkill.
- schema↔machine mirror as a blocking gap (verification-gap filed it `defer`): addressed now with the lightweight mirror test above rather than deferred, since it is cheap.

## Design Notes

The driver sits behind `src/db/index.mjs` so the choice is localized and later stories do not hard-code it. The state machines are pure data + functions (no DB), so they are trivially testable and reused by the flow stories, which will persist the resulting status onto the rows. "Who may move a transition" is deliberately out of scope here; it arrives with the permission matrix in T-07.

## Verification

**Commands:**
- `node apps/shop/src/db/migrate.mjs <tempfile>` -- expected: creates the schema; a second run is a no-op.
- `corepack pnpm --filter @vulnmart/shop test` -- expected: migration and state-machine tests pass.
