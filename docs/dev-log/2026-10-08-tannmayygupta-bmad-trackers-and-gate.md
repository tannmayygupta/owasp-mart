# BMAD trackers for the three streams, tracker commit gate and Excel workbook

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta |
| Branch / commit | main / (local commit, not pushed) |
| Status | Partly done: drafts written and mechanically checked; the user has not yet approved the trees |
| Report tag | lifecycle, tracking |

## Requirements covered
D-29, D-30, D-31, D-33 (stream split), D-14 (documentation rule).

## Summary (plain language, 3-5 lines)
Each developer now has a draft BMAD ticket tree (initiative, epics, sprint-zero stories) under `docs/bmad/initiative-platform|lab|target/`. All 170 PRD functional requirements are owned by exactly one stream. The commit gate also asks for a tracker update once these folders exist. A manual Excel workbook was seeded once.

## Why
The user chose BMAD with per-developer trackers in the repository plus a manual Excel tracker (D-29 to D-31), so that every task is tracked and documented for the report.

## What was built
- Three initiative trees generated from a script kept outside the repository: Platform 9 epics, Lab 8 epics (an eighth integration epic proposed by Claude Code, flagged as an assumption), Target 8 epics. Sprint-zero stories exist for each baseline epic only (9, 9 and 6 stories); other epics are envelopes.
- Fixes from the BMAD validation round: cross-stream waits recorded as `unknown` entries, shared decisions given one home, the lab fragment of the platform API (IF-2) added as lab story 9, deployed "Done when" lines added, closing integration epic added.
- `scripts/check-docs.mjs`: with an initiative folder present, a code commit also needs a tracker update under `docs/bmad/initiative-<slug>/`.
- `docs/bmad/VulnMart-Tracker.xlsx` seeded once (Overview, one sheet per stream, Requirements with 170 rows); `.gitattributes` marks `*.xlsx` binary.
- `CLAUDE.md`: tracker-automation rule.

## How it works
The trees are markdown plus `tickets.toml` files that `tickets.py` reads. A story's state is changed in its plan file. The Excel workbook is only edited by hand.

## Files changed
- `docs/bmad/initiative-platform/**`, `docs/bmad/initiative-lab/**`, `docs/bmad/initiative-target/**` — new draft trees
- `docs/bmad/VulnMart-Tracker.xlsx` — new workbook
- `scripts/check-docs.mjs` — tracker rule
- `.gitattributes`, `CLAUDE.md`, `CHANGELOG.md` — small edits

## Decisions made
No new ADR. The trees are drafts; the user must approve them. Open points for the user: owner of the platform edge Caddy, the integration epic, recording the baseline split as a decision, and ADR 0012 tool choices.

## Tests
- `node check.mjs <root>` (coverage script, outside the repo): 170 PRD ids found; platform 76, lab 62, target 32 covered with no missing, extra, duplicate or overlapping ids; "All mechanical checks passed".
- `uv run tickets.py status` on the three initiatives and on the lab baseline epic: `unpinned_after`, `undeclared_after` and `order_conflict` empty in every case; no cycle reported.
- Workbook: opened with openpyxl and the Overview formulas read back (sheets ReadMe, Overview, Platform, Lab, Target, Requirements; 170 requirement rows). Not recalculated: `recalc.py` failed on Windows ("module 'socket' has no attribute 'AF_UNIX'") and no LibreOffice is installed, so the computed values (for example the "OK" check) are unverified until opened in Excel.
- The new gate rule was not re-run live after this change.

## Evidence
None stored.

## Problems met and how they were fixed
- First generation had a duplicate explicit id after inserting the IF-2 entry; every entry now gets an explicit id before the insert.
- A redundant epic dependency on the seller epic was removed after the status output showed it twice.

## Security notes (vulnerable parts only)
Not applicable.

## Limitations and follow-ups
- User approval of the trees is pending; recalculate the workbook in Excel and check the Overview.
- Run `node scripts/verify-skills.mjs` after pulls; nothing was pushed.
