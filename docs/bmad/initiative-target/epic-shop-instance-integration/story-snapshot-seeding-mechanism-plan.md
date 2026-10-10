---
title: 'Snapshot seeding mechanism'
type: 'feature'
ticket: '1'
created: '2026-10-09'
status: built
baseline_revision: 'db62cfe'
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

**Problem:** Each shop instance must start from the same deterministic world, built once in CI as a snapshot, with only flags/secrets injected per instance (FR-SHP-12). There is no seeding yet, and later epics must be able to add their own seed data without editing shared files.

**Approach:** Add a per-epic seed registry that auto-discovers contribution modules in `apps/shop/seed/contributions/`, a deterministic baseline contribution (fixed timestamps so the data is identical across builds), and a `build-snapshot` CLI that migrates a fresh database, runs the contributions, and measures the build time. The snapshot is a CI/build artifact (not committed); the per-instance flag injector and the in-container copy-on-ready are later stories (T-04, T-09).

## Boundaries & Constraints

**Always:** The world is deterministic — no randomness, explicit fixed `created_at`/`updated_at` in seed rows, so two builds yield identical data (FR-SHP-12 AC). A later epic adds seed data only by dropping a new module in `contributions/`, never by editing a shared file. Seed passwords are hashed (T-07) and are world data, not per-instance secrets. Measure and print the build/seed time (S-4 input). Stay in `apps/shop/`.

**Never:** No flags, per-instance secrets, or the injector (T-04). No in-container snapshot copy or readiness wiring (T-09). No challenge seed accounts (T-16). Do not commit a `.db` snapshot. No randomness or wall-clock values in seed rows.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Build snapshot | fresh db path | migrate + run contributions; a populated db; time printed | fails loudly on a bad contribution |
| Determinism | build twice | identical seed data (same rows, same fixed timestamps) | n/a |
| Add a contribution | a new file in `contributions/` | it is discovered and run in order, no shared-file edit | ordered by filename |
| Ordering | contributions depend on order (users before stores) | filename-prefix order (`000-`, `010-`…) | documented |
| Empty/invalid contribution | a module with no default fn | skipped with a clear error | throws naming the file |


## Code Map

- `apps/shop/seed/registry.mjs` -- new; `discoverContributions(dir)` (reads `contributions/*.mjs` in filename order) and `runSeeds(db, contributions)`; each contribution's default export is `seed(db, ctx)`.
- `apps/shop/seed/contributions/000-baseline.mjs` -- new; the deterministic baseline world (categories, two approved stores, products, a demo customer/seller), fixed timestamps, hashed passwords via T-07.
- `apps/shop/seed/build-snapshot.mjs` -- new; CLI: migrate a fresh db, run contributions, print row counts and the elapsed build time.
- `apps/shop/package.json` -- add a `snapshot` script.
- `apps/shop/.gitignore` -- ignore built `*.db` snapshots.
- `apps/shop/test/seed.test.mjs` -- new; registry order, baseline populates, determinism across two builds.
- `apps/shop/src/db/`, `src/identity/` -- READ ONLY; reused (migrate, openDb, accounts).

## Tasks & Acceptance

**Execution:**
- [ ] `apps/shop/seed/registry.mjs` -- discovery + ordered run.
- [ ] `apps/shop/seed/contributions/000-baseline.mjs` -- deterministic baseline world.
- [ ] `apps/shop/seed/build-snapshot.mjs` + `apps/shop/package.json` `snapshot` script + `.gitignore`.
- [ ] `apps/shop/test/seed.test.mjs` -- registry, baseline, determinism.

**Acceptance Criteria:**
- Given a fresh database, when `build-snapshot` runs, then migrations apply, every contribution runs in filename order, the db is populated, and the elapsed time is printed.
- Given two separate builds, when their seed data is compared, then it is identical (deterministic world, FR-SHP-12 AC).
- Given a new module dropped in `contributions/`, when a snapshot is built, then it is discovered and run without editing any shared file.
- Given the baseline, when inspected, then it contains no flag or per-instance secret and all passwords are strong hashes (T-07).

## Implementation Notes

- 2026-10-09: Added `seed/registry.mjs` (directory-discovered, numerically-ordered, duplicate-guarded contributions run in one transaction), `seed/contributions/000-baseline.mjs` (deterministic world: 3 users, 2 approved stores, 4 categories, 4 products, fixed timestamps, hashed passwords), `seed/build-snapshot.mjs` (migrate + seed + dynamic counts + timing, default `build/snapshot.db`), a `snapshot` script, and `apps/shop/.gitignore`. Tests in `test/seed.test.mjs`.
- Results: `pnpm run snapshot` builds in ~320 ms (well under the S-4 10 s proposal); `corepack pnpm --filter @vulnmart/shop test` → 55 passed, 0 failed.

## Plan Change Log

- 2026-10-09 (review loop): applied 9 patches, 2 rejected. Fixed the broken `npm run snapshot` (now defaults to `build/snapshot.db`), numeric contribution ordering + duplicate-prefix guard, stale-sidecar cleanup + a directory guard, a dynamic table-count summary, a zero-contribution guard, the `.gitignore` `-shm` entry, the named-contribution rollback error with `BEGIN` inside the try, and the Green-Tea-under-Books mislabel (added a Grocery category). Corrected the overstated "byte-for-byte identical" wording to logical-world determinism (the snapshot is built once and copied; rows are deterministic, salts/timestamps are not). Added a file-output + rebuild test. Rejected fixed-salt seed hashing (not required; the snapshot is built once) and folded the `:memory:` CLI edge into the default-path change. Tests 54 → 55.

## Review Triage Log

## Code Review

### 2026-10-09 — 9 patch, 2 rejected

- [x] [Review][Patch] `npm run snapshot` passes no path, so it prints help and exits 2 (builds nothing); default the output to `build/snapshot.db` (the dir `.gitignore` reserves) and keep an explicit path override [apps/shop/package.json, seed/build-snapshot.mjs]
- [x] [Review][Patch] Contributions sort lexicographically, so `100-` precedes `20-`; sort by numeric prefix like the migration runner, and reject duplicate prefixes up front [seed/registry.mjs]
- [x] [Review][Patch] "byte-for-byte identical across builds" is false (random password salt, `_migrations.applied_at` wall-clock); correct the wording to logical-world determinism — the snapshot is built once and copied, so instances are identical, and the app-visible rows are deterministic [seed/registry.mjs, seed/build-snapshot.mjs]
- [x] [Review][Patch] `buildSnapshot`'s on-disk path is untested and only removes the main `.db`, not the `-journal`/`-wal`/`-shm` sidecars; remove sidecars on a fresh build, guard a directory path, and add a file-output test (build, rebuild over the file, same counts) [seed/build-snapshot.mjs, test/seed.test.mjs]
- [x] [Review][Patch] `runSeeds` drops the failing contribution's name and runs `BEGIN` outside the try; name it and move `BEGIN` inside [seed/registry.mjs]
- [x] [Review][Patch] Build summary counts a hardcoded four tables; count every seeded table dynamically so later contributions are not under-reported [seed/build-snapshot.mjs]
- [x] [Review][Patch] `.gitignore` omits `*.db-shm`; add it [apps/shop/.gitignore]
- [x] [Review][Patch] `buildSnapshot` silently produces an empty snapshot when no contributions are found; throw instead [seed/build-snapshot.mjs]
- [x] [Review][Patch] Seed realism: "Green Tea Sampler" is filed under Books; add a Grocery category and file it there [seed/contributions/000-baseline.mjs]

Rejected:
- Make seed password hashing reproducible with a fixed salt (blind/intent): rejected — FR-SHP-12 is met by building the snapshot once and copying it, so instances are identical; a fixed salt would weaken the seed accounts for no required gain. The wording is corrected instead.
- `:memory:` via the CLI resolves to a path (edge): folded into the default-path patch (the CLI passes a real build path; `:memory:` is a programmatic/test input).

## Design Notes

Determinism is the crux of FR-SHP-12: the schema defaults `created_at`/`updated_at` to `CURRENT_TIMESTAMP`, which is wall-clock and non-deterministic, so seed rows set an explicit fixed timestamp (a constant ISO date). The registry discovers contributions by reading the directory so a later epic adds seed data by adding a file (ordered by a numeric filename prefix), never by editing a shared list. The snapshot is built in CI and copied into each instance at start (T-09); here we build and measure it, and prove the data is identical across builds.

## Verification

**Commands:**
- `corepack pnpm --filter @vulnmart/shop run snapshot -- <tmpfile>` -- expected: migrates, seeds, prints counts and elapsed ms.
- `corepack pnpm --filter @vulnmart/shop test` -- expected: seed tests pass with the suite.
