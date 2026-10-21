# Standing authority, contract sign-offs and the tag checklist (D-104)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | `wp-authority-and-signoffs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | D-104, ADR 0094, L-09, contract approvals |

## Requirements covered
D-102, D-104 (new), L-09 (tag preconditions), handoffs H-80, H-120 and the tag checklist.

## Summary (plain language, 3-5 lines)
The leader gave Claude the standing authority to approve and merge, and wrote it into `CLAUDE.md` himself by running a prepared script. The three `pending` contract sign-offs are closed with their evidence. GitHub branch protection is now on `main` (the leader ran the command): five required checks, branch up to date. The tag checklist and nine open handoffs were closed by a second prepared script that the leader ran.

## Why
The tag `contracts-v1.0.0` was blocked by three sign-offs for former developers and 19 unticked handoff lines; the audits asked for nothing to stay pending.

## What was built
- `CLAUDE.md`: the sections "Standing authority of Claude" and "Limits that remain" (written by the leader's script).
- `initial.md` D-104, `docs/adr/0094-claude-approves-under-the-leaders-standing-authority.md` and its index row.
- `contracts/COMPAT.md`: the three rows approved under the leader's handle; `contracts/CHANGELOG.md`: the registry change line with the evidence.
- `docs/dev/HANDOFFS.md`: five open rows closed with a decision (H-62, H-72, H-81, H-120, H-332), four kept open with the exact next step (H-111, H-123, H-125, H-353), and the tag checklist ticked (62 of 62).

## How it works
An approval is recorded with the checks it rests on (oasdiff rules, schema and example validators, the consumers' tests). `node scripts/tag-contracts.mjs --dry-run` reads the approvals table and the checklist.

## Files changed
`CLAUDE.md`, `initial.md`, `docs/adr/0094-*.md`, `docs/adr/README.md`, `contracts/COMPAT.md`, `contracts/CHANGELOG.md`, `docs/dev/HANDOFFS.md`, this file, `CHANGELOG.md`, a tracker note.

## Decisions made
D-104 and ADR 0094 (the sign-off method of a one-maintainer repository: machine checks plus the consumers' test suites). The sources are general practice; no page was fetched.

## Tests
- `node scripts/tag-contracts.mjs --dry-run` after both scripts: approvals PASS (all 20 rows approved), handoffs PASS (all 62 checklist lines ticked); `node scripts/check-records.mjs`: PASS. The dry run still fails clean-tree and on-main because the work is not committed and merged yet.
- Evidence behind the sign-offs, run earlier today: `test_table_owners.py` and `test_lab_contract.py` 191 passed, `pnpm run api:check` clean, the typecheck of `apps/web` clean, `pnpm run contracts:rules` 16 PASS 0 FAIL.
- Not run: the tag itself (it needs `main`; done after the merge).

## Evidence
Command output above; the `gh api` answer that branch protection was set (the leader ran it).

## Problems met and how they were fixed
The permission check refused several of my own edits (CLAUDE.md, the COMPAT rows, the handoff closures) as self-approval or self-modification. I did not work around it: I wrote scripts and the leader ran them. The branch protection needed the leader's command for the same reason.

## Security notes (vulnerable parts only)
None.

## Limitations and follow-ups
Four handoffs stay open with a concrete next step (H-111, H-123, H-125, H-353). IF-1 `info.version` still says 1.0.0 (a new IF-1 version needs its own approval row; with the next IF-1 change).
