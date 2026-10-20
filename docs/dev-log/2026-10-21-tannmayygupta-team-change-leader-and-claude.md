# Team change: the leader and Claude only (D-102)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done |
| Report tag | D-102, ADR 0064, process |

## Requirements covered
D-102 (new), D-29 to D-31 and D-37 read through it.

## Summary (plain language, 3-5 lines)
The leader told Claude that the other developers are gone and that only the two of them implement everything end to end. `CLAUDE.md` was rewritten for that: the leader decides, Claude implements all streams, one tracker, no handoffs or sign-offs by other people, simple branch names. A safety floor stays.

## Why
The old rules made Claude stop at another developer's files and wait for people who are not there. The audits of 2026-10-21 show that this left handoffs and sign-offs hanging.

## What was built
`CLAUDE.md` (rewritten), `initial.md` D-102, ADR 0064 and its README row, a banner in `docs/dev/START-HERE.md`, a changelog line.

## How it works
Rules only; the commit gate (`scripts/check-docs.mjs`) is unchanged and still asks for a dev-log, a changelog line and a tracker update.

## Files changed
`CLAUDE.md`, `initial.md`, `docs/adr/0064-*.md`, `docs/adr/README.md`, `docs/dev/START-HERE.md`, `CHANGELOG.md`, this file, a tracker note.

## Decisions made
D-102 and ADR 0064, confirmed by the leader's instruction on 2026-10-21. Judgement calls the leader can reverse: the safety floor (infrastructure and firewall changes stay with the leader; scheduler, real email and bulk cancellation need his go), "one tracker = `initiative-lab`", the Excel tracker retired, `pending` COMPAT rows left untouched until he says to close them.

## Tests
None (documentation only). No code changed.

## Evidence
`git diff` of the commit.

## Problems met and how they were fixed
My first helper script used the names `R` and `Rd`, which are PowerShell aliases (history, and `rd` = Remove-Item). `Rd 'initial.md'` deleted `initial.md` from the working tree. It is tracked, so `git restore initial.md` brought it back unchanged (checked: no diff, 143781 bytes). The helpers were renamed.

## Security notes (vulnerable parts only)
None.

## Limitations and follow-ups
The task files, `HANDOFFS.md` (88 open rows by the wiring audit) and the COMPAT pending rows still name former developers; cleaning them is a later task if the leader wants it.