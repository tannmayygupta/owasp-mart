# Break-glass, audit access, admin limits, legal review and incident handling

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p31` |
| Status | In progress |
| Report tag | platform, admin, privacy, sprint 4 |

## Requirements covered
FR-ADM-03, FR-ADM-07, FR-ADM-08, FR-PRV-19, FR-PRV-20; D-94 (OI-12), D-95 (OI-34), D-96 (OI-27), D-97. Story 2 of `epic-admin-and-operations` (ref 9.2, task P-31).

## Summary (plain language, 3-5 lines)
(Filled at the end of the story.)

## Why
Admins could not read the audit log, there was no controlled way to read a candidate's answers when really needed, nothing proved admins cannot read them otherwise, and there was no legal review action or incident procedure. Task P-31.

## What was built
- `admin/breakglass.py` (`BreakGlassService`: open, read, close, review, and the audit-log read), `admin/models.py` (`break_glass_sessions`), migration 0016, six routes in `admin/api.py` (IF-1 1.6.0), three mail templates, `admin/incident.py` (the notice command), `CompanyService.owner_of_org`; `privacy/exports.py` shares `attempt_results`.
- Docs: `docs/runbooks/incident-procedure.md`, `docs/legal/review-pack.md`, ADR 0062, `initial.md` D-94 to D-97.
- Web: the admin page's audit log and break-glass sections.

## How it works
(Filled at the end of the story.)

## Files changed
(Filled at the end of the story.)

## Decisions made
By the developer: OI-12 (D-94), OI-34 (D-95), OI-27 (D-96), report views (D-97: not in the platform audit log). By the builder, in ADR 0062 (Proposed).

## Tests
- `test_breakglass.py` 5, `test_breakglass_postgres.py` 3 (real Postgres, application role), `test_incident.py` 4, the template tests 180; with the pins, the privacy wall, the admin routes and the exports: 136 passed.
- Contract: `check_platform_contract.py` OK (66 operations); `check_api_models.py` OK (123 checks); `platform-mock.test.mjs` 20 of 20; contract rules 18 PASS, 0 FAIL.

## Evidence
`docs/assets/p-31-break-glass-audit-and-incidents/`.

## Problems met and how they were fixed
- The table was first named `break_glass_grants` with my own columns; the architecture and the DB contract already planned `break_glass_sessions` with `admin_id`, `started_at`, `what_read`: renamed to match, so the DB contract is unchanged.
- Opening a session first answered 500: the company owner was read in a second database session inside the open transaction, which on the tests' shared SQLite connection rolled the insert back; the owner is now read before the transaction.
- The first expiry test moved the whole clock 15 minutes, which also ended the admin's sign-in (admins idle out after 15 minutes); the test moves the session's window instead.
- My first draft of the incident procedure named a person who decides; nobody decided that, so the procedure says it is not named yet.

## Security notes (vulnerable parts only)
None: platform code.

## Limitations and follow-ups
(Filled at the end of the story.)
