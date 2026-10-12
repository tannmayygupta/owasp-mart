# Sign off contracts v1.0.0 as provider and consumer (P-08, story 1.8)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-1-akshay-7 / local commit, not pushed |
| Status | Partly done: review, decisions, COMPAT.md recorded; the approval of the L-09 contracts pull request is still Akshay's step |
| Report tag | contracts, sign-off, BMAD cycle |

## Requirements covered
PB-9 (stream P signs contracts v1.0.0 as provider and consumer). Related: architecture 07 s7.7, D-37, D-42, handoffs H-01 to H-04, H-07, H-08, H-10 to H-18, H-83, H-114.

## Summary (plain language, 3-5 lines)
Stream P reviewed every contract it provides (IF-1, IF-3, IF-8, table owners) and consumes (IF-2, IF-4, IF-5, IF-6, IF-7) and answered all fifteen of its rows on the checklist that must be closed before contracts v1.0.0 are tagged. Three were real decisions; the rest were confirmed as written. `contracts/COMPAT.md` now lists the versions stream P builds against. The one step left is Akshay's approval on Tanmay's tagging pull request.

## Why
Tanmay's L-09 tags contracts-v1.0.0 only after every owner signs (PB-9, architecture 07 s7.7).

## What was built
- `docs/reviews/2026-10-12-p08-contract-sign-off.md`: the sign-off review (versions, every row with default, what is built and the decision, IF-5's 38 open points).
- `contracts/COMPAT.md`: stream P's nine rows (the rules engine's `compat` check passes).
- `docs/dev/HANDOFFS.md`: answers recorded, checklist ticked, H-114 added for Tanmay; `docs/dev/dev1-tanmay.md` points L-09 to H-114; ADR 0023 note on the events migration.

## How it works
Each row was read against what the code of P-02 to P-07 already does; where they agreed the default was confirmed, where they did not (the events identity, the error-body formats, impossible state reports) Akshay decided.

## Files changed
- `docs/reviews/2026-10-12-p08-contract-sign-off.md`, `contracts/COMPAT.md` (new)
- `docs/dev/HANDOFFS.md`, `docs/dev/dev1-tanmay.md`, `docs/adr/0023-instance-event-contract-identity-signing-source.md`
- `CHANGELOG.md`, `docs/traceability.md`, the story plan

## Decisions made
By the developer on 2026-10-12: F-1, the events table has the identity `(instance_id, epoch, seq)` and Tanmay writes its migration (stream L owns the table), Akshay approves; F-2, the sign-off requires IF-2, IF-4 and IF-5 to move to the IF-8 error body before the tag (H-114), because the change would be breaking afterwards; F-3, a state report with an impossible transition is answered 204, stored as history, not applied, and alerted. All other rows and IF-5 open points confirmed (OP 36 moves under F-2).

## Tests
- `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL, 0 NOT-APPLICABLE (compat: 9 rows, every listed version exists).
- `node --test "scripts/*.test.mjs"`: 581 of 581.
- Outputs in `docs/assets/p-08-contract-sign-off/`. No code changed.

## Evidence
`docs/assets/p-08-contract-sign-off/`, the review page.

## Problems met and how they were fixed
- The checklist's text for H-07, H-08 and H-16 predates D-42 and IF-5 0.3.0; the answers confirm the current contract versions, not the older row text.

## Security notes (vulnerable parts only)
None.

## Limitations and follow-ups
- Akshay approves the L-09 contracts pull request on GitHub when Tanmay opens it; then story 1.8 is marked done.
- Tanmay: H-114 (IF-8 alignment before the tag), the `events` migration (H-07), H-113, and the stream L rows of COMPAT.md and of the checklist. Sahil: his rows (T-03).
