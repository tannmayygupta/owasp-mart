# Install BMAD (agents and skills) in the repo

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta (with Claude Code) |
| Branch / commit | `main`, committed locally, not pushed |
| Status | Done on Tanmay's PC. Not yet set up on Akshay's and Sahil's machines. |
| Report tag | Process: development lifecycle and tooling |

## Requirements covered
Decisions D-29 (BMAD lifecycle), D-30 (trackers as repo files plus an Excel mirror), D-31 (BMAD installed in the repo). Process requirement from the user.

## Summary
BMAD's agents and skills are now in the repo (`.claude/skills/`, 23 skills) with a runtime folder (`_bmad/`), a team config that sends trackers to `docs/bmad/`, a hash manifest and a cross-platform verifier script. The source was reviewed before anything was installed.

## Why
The user chose BMAD as the lifecycle: one story per task, per developer, implemented, reviewed and tested. The agents need to live in the repo so all three developers' Claude Code use the same skills.

## What was built
- `.claude/skills/` (23 skills, 217 files) copied from BMAD commit `bda3c59` (version 6.13.0-next). Not installed with the unpinned `npx skills add`.
- `_bmad/` created by BMAD's own setup script; `_bmad/custom/config.toml` sets `output_folder = docs/bmad` and `project_name = owasp-mart`.
- `docs/bmad/INSTALL.md` (provenance, review findings, what is and is not installed, rules) and `docs/bmad/skills.sha256` (manifest).
- `scripts/verify-skills.mjs` (verify or regenerate the manifest, line-ending safe).
- `.gitattributes` rules so skills and `_bmad` have identical bytes on every machine.
- `CLAUDE.md` section "Development workflow: BMAD".
- `uv` 0.12.23 installed on this PC with winget (BMAD scripts need it).

## How it works
Skills are instruction files that Claude Code reads. `bmad-ticket` keeps a ticket tree (initiative, epic, story) as markdown under `docs/bmad/`; `bmad-build` implements and verifies a story; the review and QA skills check it. Each developer's `active_initiative` is in a gitignored personal file, so each works in their own tracker folder.

## Files changed
See the commit. New: `.claude/skills/**`, `_bmad/**`, `docs/bmad/*`, `scripts/verify-skills.mjs`. Changed: `.gitattributes`, `CLAUDE.md`, `initial.md`, `CHANGELOG.md`.

## Decisions made
Install by reviewed copy at a pinned commit, minimal skill set (no unattended build, no web research skills), never auto-update. No ADR yet; the decision record is D-29 to D-31 and `docs/bmad/INSTALL.md`.

## Tests
- `uv run setup.py --status`: `bmad_exists` false, no problems, version equals upstream. `--list-config-questions`: none. First setup: `status: created`, `current: true`, `problems: []`.
- Config override check: `resolve_config.py` returned `output_folder = {project-root}/docs/bmad` and `project_name = owasp-mart`.
- `node scripts/verify-skills.mjs`: OK for 217 files. **Negative test:** with one corrupted manifest line it printed `CHANGED` for that file and exited 1; after regenerating, OK again.
- Not tested: BMAD workflows end to end (no story exists yet), setup on macOS, Windows clone of the committed result.

## Evidence
Command outputs shown in the Claude Code session on 2026-10-08. No screenshots.

## Problems met and how they were fixed
1. A first copy command was blocked by a built-in guard because it contained a delete step; the delete was not needed. A later read-only check was denied by the auto-mode classifier without an explanation; it was not worked around (the file-search tool showed the folder was empty), and a plain copy then succeeded.
2. **The first manifest was wrong for other machines.** It hashed files with Windows line endings, so a Mac checkout would fail. Fixed by hashing after normalising line endings, adding `.gitattributes` rules, and generating the manifest with the same script that verifies it.
3. `uv` was not on the PATH of the running shell after installation; commands refresh the PATH from the registry.
4. The installed skills are registered in the session mid-run, so they are available without a restart.

## Security notes
Skills are executable instructions and scripts that run with the developer's permissions. Review findings are in `docs/bmad/INSTALL.md`. The only network call in the installed scripts is the version check in `bmad/scripts/setup.py`. Changes to `.claude/skills/**` and `_bmad/**` need a second reviewer.

## Limitations and follow-ups
- Install `uv` on Akshay's Mac and Sahil's PC; run `node scripts/verify-skills.mjs` on each clone.
- The initiatives, epics and stories for the three developers do not exist yet; they depend on the architecture's work-stream split.
- The Excel tracker and the script that keeps it in step with the markdown trackers are not built yet.
- The BMAD review covered scripts and instructions at a high level, not every line of 217 files.
