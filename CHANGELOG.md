# Changelog

All notable changes to VulnMart. Format follows [Keep a Changelog](https://keepachangelog.com/).
Categories: Added, Changed, Deprecated, Removed, Fixed.

## [Unreleased]

### Added
- `initial.md` v0.2 as the source of truth (decisions D-01 to D-13). (2026-10-08, Tanmay)
- Documentation system: `CLAUDE.md` rule, dev-log, ADRs, traceability table, commit gate (`scripts/check-docs.mjs`, Claude Code hook and git `commit-msg` backstop). (2026-10-08, Tanmay)

### Changed
- Research phase complete: eight research notes (`docs/research/`) and decisions D-15 to D-27 locked in `initial.md` (hosting, web address, live updates, roles, stack, scoring, isolation, shop, privacy, challenge catalogue). (2026-10-08, Tanmay)

### Fixed
- `.githooks/commit-msg` is now marked executable (mode 100755) so the git backstop also runs on macOS and Linux. (2026-10-08, Tanmay)
- Claude Code commit hook now matches the `PowerShell` tool as well as `Bash` (`.claude/settings.json`, `scripts/check-docs.mjs`). On Windows the hook had never fired; only the git backstop was working. Found by a live check. (2026-10-08, Tanmay)
- Added `.gitattributes` so hook and script files keep LF line endings on every machine; otherwise a Windows clone could turn `.githooks/commit-msg` into CRLF and silently disable the commit backstop. (2026-10-08, Tanmay)
