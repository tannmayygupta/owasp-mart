# Snapshot seeding mechanism (T-08)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | Sahil Roy |
| Branch / commit | sprint-1-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 1, deterministic seeded snapshot (FR-SHP-12) |

## Requirements covered
FR-SHP-12 (deterministic seeded world built as a CI snapshot; per-epic seed mechanism). BMAD story 2.1 of `epic-shop-instance-integration`.

## Summary (plain language, 3-5 lines)
Built the mechanism that gives every shop instance the same world. A seed registry discovers contribution modules in a directory and runs them in order, a deterministic baseline seeds a small marketplace (users, stores, categories, products with fixed timestamps), and a build-snapshot CLI migrates a fresh database, runs the seeds, and reports the row counts and build time. Later epics add seed data by dropping a new file in the contributions directory, never by editing a shared file. Only flags and per-instance secrets are injected later, not here.

## Why
FR-SHP-12 requires each instance's data to come from a deterministic seeded world built once as a CI snapshot, so write-ups and automated verification are stable across instances. The mechanism must let later epics (including T-16 seeded challenge accounts) add data without touching shared files.

## What was built
- `apps/shop/seed/registry.mjs` — discovers `contributions/NNN-*.mjs` in numeric order (duplicate-prefix guarded), runs them in one transaction with a shared fixed timestamp.
- `apps/shop/seed/contributions/000-baseline.mjs` — the deterministic baseline world.
- `apps/shop/seed/build-snapshot.mjs` — the CLI: fresh migrate + seed + dynamic row counts + elapsed time; default output `build/snapshot.db`.
- `apps/shop/package.json` — a `snapshot` script; `apps/shop/.gitignore` — ignores built `.db` artifacts.
- `apps/shop/test/seed.test.mjs` — registry order, baseline, determinism, file-output and rebuild.

## How it works
The registry reads the contributions directory, sorts by numeric filename prefix, imports each module (default export `seed(db, ctx)`), and runs them inside one transaction (rolling back and naming the failing contribution on error). The baseline uses fixed ids and a fixed `ctx.ts` for `created_at`/`updated_at`, so the application-visible rows are identical across builds. The snapshot is built once in CI and copied into each instance at start (T-09), so all instances are identical; the file itself is not byte-for-byte reproducible (random password salts, migration timestamp), which FR-SHP-12 does not require.

## Files changed
- `apps/shop/seed/registry.mjs`, `seed/contributions/000-baseline.mjs`, `seed/build-snapshot.mjs` — new.
- `apps/shop/test/seed.test.mjs` — new.
- `apps/shop/package.json` — `snapshot` script; `apps/shop/.gitignore` — new.

## Decisions made
No ADR. Seed passwords are hashed with the real scrypt (random salt), not a fixed salt, because the snapshot is built once and copied — instances stay identical without weakening the seed accounts. Counts in the build summary are dynamic so later contributions are reported without editing shared code.

## Tests
Real commands and results:
- `corepack pnpm --filter @vulnmart/shop test` → 55 passed, 0 failed (registry order + duplicate guard, baseline populates with fixed timestamps and strong hashes, world deterministic across two builds, no flag-shaped value, failing contribution rolls back, in-memory build, on-disk build + rebuild over the file).
- `corepack pnpm --filter @vulnmart/shop run snapshot` → built `build/snapshot.db` in ~320 ms; counts users=3, stores=2, categories=4, products=4 (well under the S-4 10 s proposal).
Traceability row FR-SHP-12 updated in `docs/traceability.md`.

## Evidence
Build output and counts above; the determinism and file-rebuild tests.

## Problems met and how they were fixed
The code review (four lenses) found the `npm run snapshot` script passed no path (built nothing, exit 2), lexicographic contribution ordering, and — importantly — that my "byte-for-byte identical across builds" wording was false (random password salts, migration timestamp). Fixed the script to default to `build/snapshot.db`, switched to numeric ordering with a duplicate guard, added stale-sidecar cleanup and a file-output test, made counts dynamic, and corrected the wording to logical-world determinism. node:sqlite's ExperimentalWarning is expected.

## Security notes (vulnerable parts only)
None. The seeded world carries no flag or per-instance secret (a test asserts no `VM{` appears); seed passwords are known demo-world data, hashed with scrypt. Per-challenge seeded accounts with non-repeating passwords are T-16; flag injection is T-04.

## Limitations and follow-ups
- The in-container copy-on-ready (snapshot → `/data` before readiness) and the "ready only after the injector marker" wiring are T-09; the flag injector is T-04. Both wait on Tanmay's harness (L-06, L-13).
- The baseline world is intentionally small; later epics add their own contributions (orders, challenge data, T-16 seeded accounts).
- The snapshot file is not byte-for-byte reproducible across rebuilds by design; instance identity comes from building once and copying.
