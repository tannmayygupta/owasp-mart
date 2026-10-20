# Learner and candidate dashboards with hints

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p26` |
| Status | In progress (API part done; the web pages next) |
| Report tag | platform, dashboards, sprint 4 |

## Requirements covered
FR-DSH-01, FR-DSH-04, FR-HNT-01, FR-HNT-02, FR-ASM-04 (the routes), OI-15 (answered 2026-10-18). Story 1 of `epic-dashboards-and-exports` (ref 8.1, task P-26).

## Summary (plain language, 3-5 lines)
(Filled at the end of the story.)

## Why
The dashboards app was a one-page tracer bullet and a candidate could not accept an invite over HTTP (P-21 had no routes). Task P-26 of `docs/dev/dev2-akshay.md`.

## What was built
- API: `assessments/invite_api.py` with `openInvite`, `acceptInvite`, `listMyInvites`; `AssessmentService.describe` and `my_invites`; IF-1 1.3.0.
- Lab API (Tanmay's module, the developer agreed): `getWriteup` (IF-2 1.2.0), `CatalogEntry.write_up`; the fake lab mock; `check_lab_contract.py`; handoffs H-354 (check it) and H-355 (enforce `after_release` results on the server).

## How it works
(Filled at the end of the story.)

## Files changed
(Filled at the end of the story.)

## Decisions made
By the developer (2026-10-20): continue with the sprint 4 tasks one by one and merge each to main; the candidate invite routes are added in P-26. By the builder, in ADR 0058 (Proposed).

## Tests
- `pytest apps/api/tests/test_invite_api.py`: 9 passed. Pinned files (`test_platform_contract.py`, `test_role_gates.py`): 72 passed after the intended pin changes (operations 42 to 45, two new state-changing routes).
- `check_platform_contract.py` OK (45 operations); `check_api_models.py` OK (110 checks); `platform-mock.test.mjs` 20 of 20; contract rules 18 PASS, 0 FAIL.

- `test_lab_api.py -k "write_up or catalogue"`: 2 passed (the new write-up test: 409 before the solve, 200 after, 404 for another account and an unknown challenge, 401 without a session); fake lab mock tests 8 of 8; `check_lab_contract.py` PASS; contract rules 20 PASS, 0 FAIL.

## Evidence
`docs/assets/p-26-dashboards/`.

## Problems met and how they were fixed
- `check_platform_contract.py` first failed: `listMyInvites` had no example answer; added.
- `datamodel-codegen` is not installed on this PC (as in P-25): the models were generated with `uv tool run --from datamodel-code-generator==0.83.0` through a temporary copy of the generator script (removed).

## Security notes (vulnerable parts only)
None: platform code.

## Limitations and follow-ups
(Filled at the end of the story.)
