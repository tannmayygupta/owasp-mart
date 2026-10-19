# Contract versions made true and the tag rule amended (IF-2, IF-5, IF-7, DB, GATE)

| Field | Value |
|---|---|
| Date | 2026-10-19 |
| Developer | tannmayygupta |
| Branch / commit | l-contracts-release-labels |
| Status | Partly done: versions and the rule are fixed; the sign-offs and the tag are not |
| Report tag | contracts, L-09 |

## Requirements covered
L-09, LB-8, D-37, H-80, H-120, H-121; ADR 0029.

## Summary
`node scripts/tag-contracts.mjs --dry-run` failed on versions and labels: `contracts/COMPAT.md` still said 1.0.0 for four contracts that had moved on (IF-2 1.0.1, IF-5 1.1.0, IF-7 1.1.0, DB 2.0.0) and GATE was 0.1.0. The tag rule also demanded exactly 1.0.0 for every contract, which can no longer be true. COMPAT.md now lists the real versions, GATE has a label-only 1.0.0 entry, and the rule accepts 1.0.0 or higher.

## Why
The tag marks what is really shipped. Rewriting four live contracts back to 1.0.0 would have falsified the changelog. The developer chose "record the real versions" (asked in chat, 2026-10-19).

## What was built
- `contracts/COMPAT.md`: Versions and Approvals rows carry the real versions. The rows Sahil approved at 1.0.0 (IF-7 owner, DB consumer) are back to `pending`, because he approved another version.
- `contracts/CHANGELOG.md`: GATE 1.0.0 (label only, with the required `registry change:` line); `contracts/edge/gate-ticket.md` status line says 1.0.0.
- `scripts/tag-contracts.mjs`: rule `release-labels` accepts every contract at 1.0.0 or higher; a 0.x draft still fails. New test for a contract at 1.1.0.
- ADR 0029 amended, runbook step 3 reworded.

## Files changed
- `contracts/COMPAT.md`, `contracts/CHANGELOG.md`, `contracts/edge/gate-ticket.md`
- `scripts/tag-contracts.mjs`, `scripts/tag-contracts.test.mjs`
- `docs/runbooks/contracts-tag.md`, `docs/adr/0029-contract-approvals-by-ci-and-tag-procedure.md`, `docs/dev/HANDOFFS.md` (H-352), `docs/dev/dev1-tanmay.md`, `docs/traceability.md`, `CHANGELOG.md`

## Decisions made
Amendment to ADR 0029 (release-labels rule). Alternatives: tag a later name such as contracts-v1.1.0 (rejected by the developer), roll the changelog back to 1.0.0 (rejected: falsifies history).

## Tests
- `node --test scripts/tag-contracts.test.mjs`: 15 of 15 pass (14 before plus the new case).
- `node scripts/check-contract-rules.mjs --base origin/main`: 18 PASS, 0 FAIL, 1 NOT-APPLICABLE (approvals, no tag yet).
- `node scripts/tag-contracts.mjs --dry-run`: versions PASS (10 contracts), release-labels PASS; still FAIL: clean-tree and on-main (this is a feature branch, run again on main after the merge), approvals (18 pending) and handoffs (19 of 62 lines not ticked). No tag was made.

## Evidence
Command outputs above; nothing else to attach.

## Problems met and how they were fixed
The first dry-run reported only IF-2 in the truncated output; the full output showed four mismatches (IF-2, IF-5, IF-7, DB), found by printing every line.

## Security notes (vulnerable parts only)
None. No flag or secret is involved.

## Limitations and follow-ups
The tag still needs Akshay (P-08: IF-1, IF-3, IF-8, DB owner rows and consumer rows), Sahil (IF-7 owner and DB again), my own rows, and the 19 open checklist lines (H-352 asks for them).