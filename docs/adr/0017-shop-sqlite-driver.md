# 0017. Shop SQLite driver: Node built-in `node:sqlite`

- **Status:** Accepted
- **Date:** 2026-10-09
- **Deciders:** Sahil (stream T), confirmed in T-06
- **Requirements:** FR-SHP-02, FR-SHP-04, FR-CHL-04 (C03 injection), D-24, D-35

## Context
The shop (stream T) needs an in-process SQLite database per instance (RS-G 1.5: smallest cost, realistic enough for the injection challenge). The shop runs as a hardened, non-root, read-only **distroless** container (T-01), which has no shell and no build toolchain. The driver choice affects the image (native build or not), the query layer the challenges build on, and every later Target story.

## Options considered
1. **`node:sqlite` (Node 24 built-in).** Pros: no dependency and no native build, so it drops straight into distroless; synchronous API; single-statement `prepare` fits the C03 read-only-catalogue injection design (D-35, "one statement per call"); pinned Node means a pinned driver. Cons: marked experimental in Node 24 (emits a startup `ExperimentalWarning`; API may change across Node majors).
2. **`better-sqlite3` (native module).** The driver RS-G 1.5 recommended. Pros: battle-tested, no warning, rich API. Cons: a native addon — it must be compiled in the Docker builder stage and the compiled binary copied into distroless with a matching Node ABI, which adds image size and build moving parts and a rebuild risk on Node upgrades.

## Decision
Use **`node:sqlite`**, Node 24's built-in SQLite, behind a thin `apps/shop/src/db/` wrapper so the driver is swappable if the experimental API shifts. This keeps the hardened image free of native builds and matches the single-statement query shape the injection challenge wants.

## Consequences
- Easier: the distroless runtime needs no compiler or copied binary; migrations and queries use `DatabaseSync`; the data layer is pinned with Node.
- Harder / watch: the `ExperimentalWarning` appears at startup (suppress or accept in the shop); watch Node release notes for `node:sqlite` API changes at each Node major bump; the wrapper is the one place to change if we ever revert to `better-sqlite3`.
- The platform database is unaffected (PostgreSQL, separate stream); the two SQLite/Postgres choices are independent.

## Evidence
- RS-G 1.5 (`docs/research/RS-G-shop-domain.md`): SQLite per instance; original `better-sqlite3` recommendation (pre-dates a stable `node:sqlite`).
- Node.js `node:sqlite` documented API (`DatabaseSync`, `prepare`, `exec`); verified working on the repo's pinned Node 24 on 2026-10-09 (emits `ExperimentalWarning`). UNVERIFIED: long-term API stability across future Node majors.
