# Developer task lists, simple Excel tracker and small clean-up

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta |
| Branch / commit | main / (local commit, not pushed) |
| Status | Partly done: draft plan, waiting for team approval |
| Report tag | lifecycle, planning |

## Requirements covered
D-29, D-30, D-33 (stream split).

## Summary (plain language, 3-5 lines)
Each developer now has one task file with every task for the four weekly sprints (7 or 8 per sprint, 31 to 32 per person). The Excel tracker was replaced by a simple workbook with one sheet per developer (task, sprint, Done Yes/No). Two junk items were removed and the docs index was refreshed.

## Why
The user asked for a clear per-developer task list and a simple tracker, with 4 sprints of a week and 7 to 8 tasks each, so each developer can work alone without waiting.

## What was built
- `docs/dev/dev1-tanmay.md`, `dev2-akshay.md`, `dev3-sahil.md`: tasks with epic, what to build, requirement ids, what it waits on, done-when, plus a table of who is waiting on each task.
- `docs/bmad/VulnMart-Tracker.xlsx` replaced: three sheets with a Done dropdown and a done count.
- `CLAUDE.md` repo map and tracker rule, `docs/README.md` index.
- Removed the ignored crash dump `bash.exe.stackdump` and the empty `_bmad-output` folder (both untracked).

## How it works
Tasks are the developer's own to-do list; each is turned into a BMAD story when started. Every task lists the requirement ids it covers.

## Files changed
- `docs/dev/*.md` (new), `docs/bmad/VulnMart-Tracker.xlsx`, `CLAUDE.md`, `docs/README.md`, `CHANGELOG.md`

## Decisions made
Sprint dates (8 Oct to 4 Nov) and the split of tasks across sprints are a proposal, not yet approved. No ADR.

## Tests
A checking script (outside the repo) ran on the plan: each sprint holds 7 or 8 tasks; every "waits on" id exists and none waits on a later sprint or on a later task of the same developer in the same sprint; no circular waits; all 170 PRD functional requirement ids are covered by exactly one developer's tasks (62 Tanmay, 76 Akshay, 32 Sahil), and none is outside the PRD. The workbook was opened with openpyxl and sheet names, task counts and the formulas were read back; the formulas were not calculated (no spreadsheet program was run).

## Evidence
None stored.

## Problems met and how they were fixed
The first check run reported false circular waits because some "waits on" texts named the task that waits on them, and a requirement-id parser bug; the texts were reworded and the parser fixed, then the check passed.

## Security notes (vulnerable parts only)
Not applicable.

## Limitations and follow-ups
- Workload is high: about 8 tasks per person per week. The team should agree what to cut first if a sprint slips.
- Open questions named in tasks (OI-xx) are still unanswered.
- The wider clean-up the user asked for is waiting on their answers about which files count as unnecessary.
