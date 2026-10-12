# Dev-log: relabel every contract 1.0.0 (release commit, L-09)

- **Date:** 2026-10-13 · **Developer:** tannmayygupta · **Branch:** sprint-2-tanmay · **Task:** L-09 (follows story 1.16)

## What was done
The release commit of ADR 0029: every contract (IF-1 to IF-8, DB) got a `1.0.0` changelog entry ("first stable release, no content change"), the Versions and Approvals tables of `contracts/COMPAT.md` name 1.0.0, and the version labels in the four contract documents and three OpenAPI files say 1.0.0. The bundle was regenerated (only the version string changed).

## Decisions
None new (ADR 0029, D-48). Done after story 1.16 so stream P and stream T sign the final labels.

## Tests and results (real)
- `node scripts/check-contract-rules.mjs`: 27 PASS, 0 FAIL.
- `node scripts/tag-contracts.mjs --dry-run`: versions and release-labels PASS; failing only: clean tree, on main, up to date (branch work not merged), approvals (19 pending, theirs to sign) and handoffs (26 of 62 lines not ticked).
- `node --test "scripts/*.test.mjs"`: 705 pass, 0 fail. Text-file check passes.

## Problems
The first run failed the mock rule for IF-1 and the bundle check; fixed with the line "no mock change: label only" and by regenerating the bundle.

## Open
Akshay and Sahil sign their rows (their own commits); handoff lines; merge to main; then the tag (never pushed by Claude).
