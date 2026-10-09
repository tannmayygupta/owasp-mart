# Changelog

All notable changes to VulnMart. Format follows [Keep a Changelog](https://keepachangelog.com/).
Categories: Added, Changed, Deprecated, Removed, Fixed.

## [Unreleased]

### Added (orchestrator API v0, L-04, 2026-10-09, Tanmay)
- Orchestrator API contract v0 (IF-5) in `contracts/orchestrator/`: OpenAPI 3.1 file for the seven calls and the signed state report, contract text with state machine, signing, idempotence, errors and 30 open points (proposals for Akshay), 15 valid and 33 invalid examples, a signing vector. Checked by `scripts/check_orchestrator_contract.py`, now the second half of `pnpm run contracts:check`.
- Python package `vulnmart-api` (`apps/api`, only the ports): `InstanceHost` protocol, `FakeInstanceHost`, `HttpInstanceHost` (standard library only). Fake orchestrator service in `contracts/mocks/fake-orchestrator/server.mjs` (Node, no dependencies). 204 Python tests; the protocol suite runs against the fake host and against the client plus the fake service. After review: the fake host mirrors the service validation, the client refuses unsafe setups and treats any odd answer as `OrchestratorUnavailable`, the fake service hardens body, query and method handling (405), the contract check no longer fails with a traceback.
- Pinned Python dev dependencies (pytest 9.1.1, openapi-spec-validator 0.9.0, jsonschema 4.26.0, pyyaml 6.0.3, uv_build 0.12.23); `apps/api` added to the uv workspace; CI `scripts` job now also runs the Python tests and `contracts:check`.
### Added (instance event contract IF-4, L-03, 2026-10-08, Tanmay)
- Instance event contract v0 (IF-4) in `contracts/events/`: contract text with the 29-type event catalogue, JSON Schema, a derived posted-body schema, 29 valid events, 3 signed requests, 6 valid posted bodies and 61 invalid examples. Fake ingest in `contracts/mocks/fake-ingest/` (answers 202, 200, 401, 413, 422). Checked by `scripts/validate-events.mjs` (`pnpm run events:check`; `pnpm run contracts:check` now runs both checks) with unit and end-to-end tests. No new dependency.

### Added (instance contract v0, L-02, 2026-10-08, Tanmay)
- Instance contract v0 (IF-6) in `contracts/instance/`: contract text, three JSON Schemas (injection document, flags file, instance template), 5 valid and 129 invalid examples, `contracts/CHANGELOG.md`. Checked by `scripts/validate-contracts.mjs` (`pnpm run contracts:check`) with tests. Ajv 8.20.0 and ajv-formats 3.0.1 added as pinned dev dependencies; CI `scripts` job now installs dependencies first. End-to-end tests in `scripts/e2e/contracts.e2e.test.mjs`. Merged in pull request #2 (CI green); Sahil's "to confirm" rows are still open. Decisions D-36 (placement volumes, injector without network) and D-37 (pull request review optional during initial development).

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
- Monorepo skeleton (architecture 07 section 1), pinned tools (Node 24.21.0, pnpm 12.10.1, Python 3.14.8, uv 0.12.23) with empty pnpm and uv workspaces and lockfiles, Compose project `vulnmart` with a hardened `hello` service, `scripts/dev.mjs` (`hello`, `up`, `down`, `doctor`) with tests, `.github/CODEOWNERS`, and CI `.github/workflows/ci.yml`. Docker on Tanmay's PC was repaired (WSL updated to 2.7.13, 8 GB cap in `.wslconfig`, Docker data moved to D:); `hello`, `doctor` and the container hardening pass on real Docker (19 unit and 10 end-to-end tests). CI was green (4 of 4 jobs) on pull request #1, merged into `main`.

### Added (architecture, 2026-10-08, Tanmay)
- Architecture documents `docs/architecture/` (index, evidence register, 7 design documents) and decision records `docs/adr/0002` to `0015`. Decisions D-33 (three work-streams P, L, T; Tanmay L, Akshay P, Sahil T), D-34 (two Oracle VMs, amends D-15) and D-35 (per-attempt keys, ASVS level 3 for key and audit, loopback HTTP for development, catalogue as a read-only SQLite file).

### Changed
- `.gitattributes` pins LF line endings for skills and `_bmad` so hashes match on every machine.
- Research phase complete: eight research notes (`docs/research/`) and decisions D-15 to D-27 locked in `initial.md` (hosting, web address, live updates, roles, stack, scoring, isolation, shop, privacy, challenge catalogue). (2026-10-08, Tanmay)

### Fixed
- `.githooks/commit-msg` is now marked executable (mode 100755) so the git backstop also runs on macOS and Linux. (2026-10-08, Tanmay)
- Claude Code commit hook now matches the `PowerShell` tool as well as `Bash` (`.claude/settings.json`, `scripts/check-docs.mjs`). On Windows the hook had never fired; only the git backstop was working. Found by a live check. (2026-10-08, Tanmay)
- Added `.gitattributes` so hook and script files keep LF line endings on every machine; otherwise a Windows clone could turn `.githooks/commit-msg` into CRLF and silently disable the commit backstop. (2026-10-08, Tanmay)
