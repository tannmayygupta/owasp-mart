# Changelog

All notable changes to VulnMart. Format follows [Keep a Changelog](https://keepachangelog.com/).
Categories: Added, Changed, Deprecated, Removed, Fixed.

## [Unreleased]

### Added (T-08 snapshot seeding mechanism, 2026-10-09, Sahil)
- `apps/shop/seed/`: a per-epic seed registry that discovers `contributions/NNN-*.mjs` in numeric order and runs them in one transaction, a deterministic baseline world (users, stores, categories, products with fixed timestamps), and a `build-snapshot` CLI (`pnpm run snapshot`) that migrates a fresh SQLite db, seeds it, and reports dynamic row counts and build time (~320 ms). Later epics add seed data by dropping a file, no shared-file edits. Snapshot is a gitignored CI artifact. 7 tests. Covers FR-SHP-12.

### Added (T-07 shop identity, roles, permissions and hashing, 2026-10-09, Sahil)
- `apps/shop/` identity and authorization: scrypt password hashing (`src/identity/password.mjs`, salted, timing-safe, param floor, PHC-style, no MD5/unsalted — ADR 0018), an accounts service (`src/identity/accounts.mjs`, create/authenticate over `users`, normalized email, no hash leak), the six roles and the RS-G 1.2 permission matrix with a scoped `can(role, action, ctx)` guard (`src/domain/roles.mjs`, `permissions.mjs`), and neutral branding (`src/identity/branding.mjs`). 48 tests. Covers FR-SHP-01, FR-SHP-03, FR-SHP-09.

### Added (T-06 shop data model and seven state machines, 2026-10-09, Sahil)
- `apps/shop/` data layer: 23-table SQLite schema (`migrations/0001_init.sql`, the RS-G 1.1 marketplace model plus the thin audit log and the C09 security-events/alerts tables, integer `*_cents` money, status CHECKs mirroring the state machines), an idempotent migration runner + CLI (`src/db/migrate.mjs`, `migrate` script), and the seven state machines (`src/domain/state-machines.mjs`: seller approval, product, checkout, fulfilment, refund, dispute, payout) as pure guarded transition logic. On Node 24's built-in `node:sqlite` (ADR 0017). 21 tests. Covers FR-SHP-02, FR-SHP-04.

### Added (T-05 exploit test runner skeleton, 2026-10-09, Sahil)
- `challenges/tests/runner/` exploit test runner: runs an exploit test against any instance URL and reports passed (vulnerable) / failed (fixed) / errored (could not run), as a library and a CLI (exit 0/1/3, 2 on usage). Ships a tiny vulnerable/fixed stub and a demo exploit under `challenges/tests/_example/`, a self-test (6 cases) proving pass-on-vulnerable and fail-on-fixed, and a CI `exploit runner` job that fails if no exploit tests are found. Node built-ins only. Covers TB-4.

### Added (T-03 IF-6/IF-4 consumer review, 2026-10-09, Sahil)
- Target-stream consumer review and sign-off of the instance contract (IF-6 v0.1.0) and the instance event contract (IF-4 v0.1.0): `docs/reviews/2026-10-09-target-if6-if4-consumer-review.md`. Confirms every IF-6 open point owned by Sahil, checks IF-4 carries every shop-produced event the 11 challenges need, and raises one change request (CR-1: the `/version` env names vs the env allowlist). Covers TB-2.

### Added (T-01 shop skeleton, 2026-10-09, Sahil)
- `apps/shop/` shop skeleton (tracer bullet): Express 5.2.1 on Node 24 answering `/healthz`, `/readyz` and `/version`, packaged as a hardened, digest-pinned container (non-root uid 65532, read-only rootfs, cap-drop ALL, no-new-privileges, 512 MB / 256 pids) with a `/readyz` healthcheck. Unit tests (5) cover the endpoint behaviour; a new CI `app tests` job runs `apps/*/test` on every pull request. Proven on Sahil's PC with `docker run` (all three endpoints 200, container healthy). Covers TB-3, TB-5.

### Added (instance contract v0, L-02, 2026-10-08, Tanmay)
- Instance contract v0 (IF-6) in `contracts/instance/`: contract text, three JSON Schemas (injection document, flags file, instance template), 5 valid and 129 invalid examples, `contracts/CHANGELOG.md`. Checked by `scripts/validate-contracts.mjs` (`pnpm run contracts:check`) with tests. Ajv 8.20.0 and ajv-formats 3.0.1 added as pinned dev dependencies; CI `scripts` job now installs dependencies first. End-to-end tests in `scripts/e2e/contracts.e2e.test.mjs`. Awaiting Sahil's approval as consumer.

### Added
- `initial.md` v0.2 as the source of truth (decisions D-01 to D-13). (2026-10-08, Tanmay)
- Documentation system: `CLAUDE.md` rule, dev-log, ADRs, traceability table, commit gate (`scripts/check-docs.mjs`, Claude Code hook and git `commit-msg` backstop). (2026-10-08, Tanmay)

### Added (2026-10-08, Tanmay)
- Product Requirements Document `docs/prd/PRD.md` (170 FR, 49 NFR, 38 open items) and research note RS-I on the four design traps and the lifecycle.
- BMAD 6.13.0-next installed from a reviewed, pinned copy: 23 skills in `.claude/skills/`, runtime in `_bmad/`, install record and hash manifest in `docs/bmad/`, verifier `scripts/verify-skills.mjs`, BMAD section in `CLAUDE.md`. `uv` is a new prerequisite for developers.
- Decisions D-28 (design traps) and D-29 to D-31 (lifecycle, trackers, tooling) in `initial.md`.

### Added (BMAD trackers, 2026-10-08, Tanmay)
- Draft BMAD ticket trees for the three streams under `docs/bmad/initiative-*` (all 170 FR owned once), a manually maintained Excel workbook `docs/bmad/VulnMart-Tracker.xlsx`, and a tracker-update rule in the commit gate and `CLAUDE.md`.

### Added (developer task lists, 2026-10-08, Tanmay)
- `docs/dev/dev1-tanmay.md`, `dev2-akshay.md`, `dev3-sahil.md`: all tasks by weekly sprint (4 sprints, 7 to 8 tasks each); the Excel tracker is now one simple sheet per developer (Done Yes/No). `docs/README.md` index refreshed.

### Added (developer start guide, 2026-10-08, Tanmay)
- `docs/dev/START-HERE.md` (how to use BMAD and Claude Code for one task at a time), task-cycle and branch rules in `CLAUDE.md`, BMAD story references and EARLY PR marks in the task files.

### Added (challenge design, 2026-10-08, Tanmay)
- `docs/design/challenge-specs.md`: detailed design of the 11 challenges with milestones, tests and event catalogue; decisions D-32 (DC-1 to DC-15) accepted; PRD open items OI-16 to OI-20 resolved.

### Added (L-01 repository skeleton, 2026-10-08, Tanmay)
- Monorepo skeleton (architecture 07 section 1), pinned tools (Node 24.21.0, pnpm 12.10.1, Python 3.14.8, uv 0.12.23) with empty pnpm and uv workspaces and lockfiles, Compose project `vulnmart` with a hardened `hello` service, `scripts/dev.mjs` (`hello`, `up`, `down`, `doctor`) with tests, `.github/CODEOWNERS`, and CI `.github/workflows/ci.yml`. Docker on Tanmay's PC was repaired (WSL updated to 2.7.13, 8 GB cap in `.wslconfig`, Docker data moved to D:); `hello`, `doctor` and the container hardening pass on real Docker (19 unit and 10 end-to-end tests). CI green on a pull request is not yet confirmed.

### Added (architecture, 2026-10-08, Tanmay)
- Architecture documents `docs/architecture/` (index, evidence register, 7 design documents) and decision records `docs/adr/0002` to `0015`. Decisions D-33 (three work-streams P, L, T; Tanmay L, Akshay P, Sahil T), D-34 (two Oracle VMs, amends D-15) and D-35 (per-attempt keys, ASVS level 3 for key and audit, loopback HTTP for development, catalogue as a read-only SQLite file).

### Changed
- `.gitattributes` pins LF line endings for skills and `_bmad` so hashes match on every machine.
- Research phase complete: eight research notes (`docs/research/`) and decisions D-15 to D-27 locked in `initial.md` (hosting, web address, live updates, roles, stack, scoring, isolation, shop, privacy, challenge catalogue). (2026-10-08, Tanmay)

### Fixed
- `.githooks/commit-msg` is now marked executable (mode 100755) so the git backstop also runs on macOS and Linux. (2026-10-08, Tanmay)
- Claude Code commit hook now matches the `PowerShell` tool as well as `Bash` (`.claude/settings.json`, `scripts/check-docs.mjs`). On Windows the hook had never fired; only the git backstop was working. Found by a live check. (2026-10-08, Tanmay)
- Added `.gitattributes` so hook and script files keep LF line endings on every machine; otherwise a Windows clone could turn `.githooks/commit-msg` into CRLF and silently disable the commit backstop. (2026-10-08, Tanmay)
