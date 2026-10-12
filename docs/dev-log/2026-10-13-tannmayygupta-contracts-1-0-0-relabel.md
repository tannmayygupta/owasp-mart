# Relabel every contract 1.0.0 (release commit, L-09)

| Field | Value |
|---|---|
| Date | 2026-10-13 |
| Developer | tannmayygupta |
| Branch / commit | sprint-2-tanmay, release commit 0a2a43b (this document was restructured later, uncommitted) |
| Status | Partly done: release commit made; the tag `contracts-v1.0.0` does not exist and the approvals are pending |
| Report tag | contracts, release, L-09 |

## Requirements covered
LB-8, D-48, ADR 0029 (row LB-8 in `docs/traceability.md`).

## Summary (plain language, 3-5 lines)
Every contract (IF-1 to IF-8, DB) was labelled 1.0.0 in one release commit, so the sign-offs and the later tag `contracts-v1.0.0` mark the same version. No contract content changed in that commit. The tag was not made: all 19 Approvals rows in `contracts/COMPAT.md` are still pending and 27 handoff checklist lines are not ticked.

## Why
ADR 0029 asks for one release commit that relabels every contract before the tag; it was done after story 1.16 so streams P and T sign the final labels.

## What was built
A `1.0.0` entry in each contract's section of `contracts/CHANGELOG.md` ("first stable release, no content change"); the Versions and Approvals tables of `contracts/COMPAT.md` name 1.0.0; the version labels of the contract documents and OpenAPI files say 1.0.0; the bundle was regenerated.

## How it works
`scripts/check-contract-rules.mjs` (job `contract-rules`) compares the contract files with the changelog and COMPAT.md. `scripts/tag-contracts.mjs --dry-run` lists the tag preconditions and never tags.

## Files changed
- `contracts/CHANGELOG.md`, `contracts/COMPAT.md` (Versions and Approvals versions)
- contract documents and OpenAPI files (version labels only)
- `contracts/api/bundle/*` (regenerated, version string only)

## Decisions made
None new (ADR 0029, D-48).

## Tests
Real outputs saved in `docs/assets/contracts-1-0-0-relabel/` (taken 2026-10-13 after the later audit fixes, which also relabelled a few leftover version strings and added the `INST-START-FAILED` code):
- `node scripts/check-contract-rules.mjs`: 29 PASS, 0 FAIL, 1 NOT-APPLICABLE (the approvals rule starts with the tag).
- `node scripts/tag-contracts.mjs --dry-run`: NOT READY, 5 of 8 preconditions fail (clean-tree, on-main, up-to-date, approvals with 19 pending, handoffs with 27 of 62 lines not ticked); versions, release-labels and tag-absent pass. No tag was created.
- At the release commit: `node --test "scripts/*.test.mjs"` 705 pass, 0 fail (recorded then).

## Evidence
`docs/assets/contracts-1-0-0-relabel/check-contract-rules.txt` and `tag-contracts-dry-run.txt` (contain only contract names and GitHub handles).

## Problems met and how they were fixed
The first run failed the mock rule for IF-1 and the bundle check; fixed with the line "no mock change: label only" and by regenerating the bundle.

## Security notes (vulnerable parts only)
None. No secrets involved.

## Limitations and follow-ups
Akshay and Sahil sign their rows (their own commits) and so does Tanmay; handoff checklist lines; merge to main; then the tag (never pushed by Claude). All rows must be re-confirmed at 1.0.0; the P-08 review of 2026-10-12 does not satisfy the tag.