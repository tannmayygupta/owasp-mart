# Own sign-off rows in COMPAT.md

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | tannmayygupta |
| Branch / commit | l-tanmay-signoff-rows |
| Status | Done |
| Report tag | contracts, L-09 |

## Requirements covered
L-09, ADR 0029.

## Summary
The developer told Claude in chat to set their sign-off rows to approved. Every pending Approvals row of @tannmayygupta in contracts/COMPAT.md is now approved with the date 2026-10-19, at the versions the table lists (IF-2 1.1.0, IF-4 1.0.0, IF-5 1.1.0, IF-6 1.0.0, IF-7 1.1.0, DB 2.1.0, GATE 1.0.0).

## Why
The tag contracts-v1.0.0 needs every row approved.

## What was built
Only the rows and a registry change line in contracts/CHANGELOG.md.

## How it works
The tag script reads the status column.

## Files changed
- contracts/COMPAT.md, contracts/CHANGELOG.md, CHANGELOG.md

## Decisions made
None beyond the developer's instruction.

## Tests
See the pull request: check-contract-rules and tag-contracts dry run.

## Evidence
Pull request checks.

## Problems met and how they were fixed
None.

## Security notes
None.

## Limitations and follow-ups
Akshay's and Sahil's rows and 19 checklist lines are still open (H-352).
