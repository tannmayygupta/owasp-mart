# Sole maintainer passes the approvals rule, then the contracts tag (D-105)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | `wp-solo-maintainer-approvals` (commit hash after the commit) |
| Status | Done |
| Report tag | D-105, ADR 0095, L-09 |

## Requirements covered
L-09 (the tag), ADR 0029, D-102, D-104, D-105.

## Summary (plain language, 3-5 lines)
The CI rule that asks another person to approve contract changes could never be satisfied after the tag, because nobody else is on the project. It now lets the named sole maintainer pass, while every other contract rule still runs. The tag `contracts-v1.0.0` follows the merge.

## Why
Pushing the tag first would have blocked every later contract pull request (found while preparing the tag).

## What was built
`soleMaintainer()` and its use in `approvalsCheck` (`scripts/check-contract-rules.mjs`), the line in `contracts/COMPAT.md`, a test file, ADR 0095, D-105, the registry change line in `contracts/CHANGELOG.md`.

## How it works
The line is read from the base copy of COMPAT.md, so a pull request cannot add itself. The first pull request that adds it changes no contract file, so it is not under the rule.

## Files changed
`scripts/check-contract-rules.mjs`, `scripts/check-contract-rules.sole-maintainer.test.mjs`, `contracts/COMPAT.md`, `contracts/CHANGELOG.md`, `docs/adr/0095-*.md`, `docs/adr/README.md`, `initial.md`, `CHANGELOG.md`, this file, a tracker note.

## Decisions made
D-105 and ADR 0095.

## Tests
See the pull request checks and the output recorded by the script: `node --test scripts/check-contract-rules.sole-maintainer.test.mjs`, `node scripts/check-contract-rules.mjs`, `node scripts/check-records.mjs`, then the 20 CI checks and `node scripts/tag-contracts.mjs --dry-run` on `main`.

## Evidence
The script output of the leader's terminal.

## Problems met and how they were fixed
The permission check refused me the edit of the approvals rule (it weakens a gate I would pass); the leader ran a prepared script.

## Security notes (vulnerable parts only)
None.

## Limitations and follow-ups
When a second maintainer joins, remove the line.