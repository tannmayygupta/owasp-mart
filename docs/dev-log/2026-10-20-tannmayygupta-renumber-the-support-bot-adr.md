# Renumber the support-bot decision record (H-357)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | records, ADR numbering |

## Requirements covered
H-357. Story: `docs/bmad/initiative-lab/backlog/story-renumber-the-support-bot-adr.md`. Plan: `docs/plans/2026-10-20-handoffs-h355-to-h359.md`.

## Summary (plain language, 3-5 lines)
Two decision records were numbered 0058. The support-bot record is now 0061, and everything that cited it as 0058 now says 0061. Akshay's 0058 (candidate invite routes) is untouched.

## Why
Akshay found the duplicate while merging and left handoff H-357; the files are stream L's, so the fix is ours.

## What was built
- `git mv` of the record, its heading, and the ADR index (rows 0061 and 0063).
- References changed only on lines about the support bot: `services/bot` (two comments, the controller, the Dockerfile), `CHANGELOG.md`, `contracts/CHANGELOG.md` (two lines), `docs/traceability.md`, the C03 part B dev-log.
- ADR 0062's numbering note and the handoff row H-357.

## How it works
A one-time script replaced `ADR 0058` and the file name only on lines that also mention jsdom, the support bot or IF-6 1.0.1; it was deleted afterwards.

## Files changed
The files named above; no behaviour changed (the code edits are comments and one Dockerfile comment).

## Decisions made
None new.

## Tests
- Search for `0058` next to jsdom, support bot or bot files: no hit remains.
- `node scripts/check-text-files.mjs` — PASS. `pnpm run contracts:rules` — see the run after this change in the final report of the branch.
- `node --test` in `services/bot` — see the full run in the final report.

## Evidence
The search results above.

## Problems met and how they were fixed
Some references sit on very long lines that also mention Akshay's record; the replacement is limited to lines that match the support-bot words so his references stay.

## Security notes (vulnerable parts only)
None.

## Limitations and follow-ups
None.
