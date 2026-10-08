# Developer start guide, task-cycle rule and branch rule

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta |
| Branch / commit | main / (local commit, not pushed) |
| Status | Done (draft rules waiting for the other two developers to read them) |
| Report tag | lifecycle, process |

## Requirements covered
D-14 (documentation rule), D-29 to D-31 (BMAD, trackers), D-33 (stream split).

## Summary (plain language, 3-5 lines)
A start guide for the three developers explains how to set up, how to use each BMAD skill and agent, and the exact cycle for one task: story, build, review, test, close. `CLAUDE.md` now carries the task-cycle and branch rules, so Claude Code follows them without being told each time.

## Why
The user wanted one message that tells the developers how to work with BMAD and Claude Code so they do not get stuck, with Claude updating the tracker and docs for every task.

## What was built
- `docs/dev/START-HERE.md`: the message (setup, seven rules, which BMAD skill for what, the 9-step task cycle with paste-ready prompts, branches and pull requests, what to do when blocked).
- `CLAUDE.md`: "Task cycle" rule and branch rules (one branch and pull request per sprint, EARLY PR exception, SSH for other developers).
- Task files regenerated: each task shows its BMAD story reference (baseline stories already exist, the others are created when the epic is incepted) and EARLY PR marks for tasks another developer waits on in the same sprint.
- Requirement ids moved between tasks so that every task's ids belong to its own epic (FR-DET-04 to L-20, FR-FLG-09 to L-21); workbook regenerated with the new titles (nothing had been ticked yet).

## How it works
Developer decision from the user (2026-10-08): one branch and one pull request after each 8 tasks; both other developers are repository contributors. Claude's proposal accepted by the user: tasks other developers wait on in the same sprint get their own early pull request.

## Files changed
- `docs/dev/START-HERE.md` (new), `docs/dev/dev*.md`, `docs/bmad/VulnMart-Tracker.xlsx`, `CLAUDE.md`, `CHANGELOG.md`

## Decisions made
Branch rule and early-PR exception (user, 2026-10-08). Defaults written by Claude Code and not yet confirmed: one other developer reviews each pull request; sprint branches are created at the start of the sprint (same four branches, but safer than creating them at the end); the first reply to a contract pull request within one working day is a placeholder from the architecture.

## Tests
- Plan checker (outside the repo) re-run after the changes: each sprint 7 to 8 tasks, no wait on a later sprint, no circular waits, all 170 PRD ids covered once. Real output: "PRD ids 170, covered 170" and "Plan checks passed."
- Tracker set-up instructions tried on Tanmay's PC: `_bmad/custom/config.user.toml` with `active_initiative = "initiative-lab"` was read by `resolve_config.py`, and `tickets.py next` listed story 1.1 as ready and the other baseline stories as blocked by their prerequisites. This file is gitignored.
- The guide was not tried on Akshay's Mac or Sahil's PC.

## Evidence
None stored.

## Problems met and how they were fixed
- A first draft of the pull-request rule would have made Akshay and Sahil wait a week for the repository skeleton; the user chose an early-PR exception.
- Some baseline stories carry an `unknown` note that keeps them listed as blocked after their prerequisite is done; the guide explains how to clear it.

## Security notes (vulnerable parts only)
Not applicable.

## Limitations and follow-ups
- `uv` and the skills check still have to be run on Akshay's and Sahil's machines.
- Branch protection on a private personal repository is unverified (EF-30); until settled, reviews are by agreement.
