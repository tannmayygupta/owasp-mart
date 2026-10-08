# Changelog

All notable changes to VulnMart. Format follows [Keep a Changelog](https://keepachangelog.com/).
Categories: Added, Changed, Deprecated, Removed, Fixed.

## [Unreleased]

### Added
- `initial.md` v0.2 as the source of truth (decisions D-01 to D-13). (2026-10-08, Tanmay)
- Documentation system: `CLAUDE.md` rule, dev-log, ADRs, traceability table, commit gate (`scripts/check-docs.mjs`, Claude Code hook and git `commit-msg` backstop). (2026-10-08, Tanmay)

### Added (2026-10-08, Tanmay)
- Product Requirements Document `docs/prd/PRD.md` (170 FR, 49 NFR, 38 open items) and research note RS-I on the four design traps and the lifecycle.
- BMAD 6.13.0-next installed from a reviewed, pinned copy: 23 skills in `.claude/skills/`, runtime in `_bmad/`, install record and hash manifest in `docs/bmad/`, verifier `scripts/verify-skills.mjs`, BMAD section in `CLAUDE.md`. `uv` is a new prerequisite for developers.
- Decisions D-28 (design traps) and D-29 to D-31 (lifecycle, trackers, tooling) in `initial.md`.

### Added (challenge design, 2026-10-08, Tanmay)
- `docs/design/challenge-specs.md`: detailed design of the 11 challenges with milestones, tests and event catalogue; decisions D-32 (DC-1 to DC-15) accepted; PRD open items OI-16 to OI-20 resolved.

### Changed
- `.gitattributes` pins LF line endings for skills and `_bmad` so hashes match on every machine.
- Research phase complete: eight research notes (`docs/research/`) and decisions D-15 to D-27 locked in `initial.md` (hosting, web address, live updates, roles, stack, scoring, isolation, shop, privacy, challenge catalogue). (2026-10-08, Tanmay)

### Fixed
- `.githooks/commit-msg` is now marked executable (mode 100755) so the git backstop also runs on macOS and Linux. (2026-10-08, Tanmay)
- Claude Code commit hook now matches the `PowerShell` tool as well as `Bash` (`.claude/settings.json`, `scripts/check-docs.mjs`). On Windows the hook had never fired; only the git backstop was working. Found by a live check. (2026-10-08, Tanmay)
- Added `.gitattributes` so hook and script files keep LF line endings on every machine; otherwise a Windows clone could turn `.githooks/commit-msg` into CRLF and silently disable the commit backstop. (2026-10-08, Tanmay)
