# Break-glass, audit access, admin limits, legal review and incident handling

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-p31` |
| Status | Done (story `built`; marked done once merged, as the developer asked) |
| Report tag | platform, admin, privacy, sprint 4 |

## Requirements covered
FR-ADM-03, FR-ADM-07, FR-ADM-08, FR-PRV-19, FR-PRV-20; D-94 (OI-12), D-95 (OI-34), D-96 (OI-27), D-97. Story 2 of `epic-admin-and-operations` (ref 9.2, task P-31).

## Summary (plain language, 3-5 lines)
Admins can read the audit log, and every such read is itself recorded. An admin cannot see a candidate's answers, write-ups or evidence, except through break-glass: for one candidate attempt, with a written reason, for 15 minutes; the other admins and the candidate's company are emailed at once, every read is recorded, and another admin reviews it afterwards. There is a draft incident procedure with a command that emails the affected people, and a pack for the legal review (who reviews is still open, OI-33).

## Why
Admins could not read the audit log, there was no controlled way to read a candidate's answers when really needed, nothing proved admins cannot read them otherwise, and there was no legal review action or incident procedure. Task P-31.

## What was built
- `admin/breakglass.py` (`BreakGlassService`: open, read, close, review, and the audit-log read), `admin/models.py` (`break_glass_sessions`), migration 0016, six routes in `admin/api.py` (IF-1 1.6.0), three mail templates, `admin/incident.py` (the notice command), `CompanyService.owner_of_org`; `privacy/exports.py` shares `attempt_results`.
- Docs: `docs/runbooks/incident-procedure.md`, `docs/legal/review-pack.md`, ADR 0062, `initial.md` D-94 to D-97.
- Web: the admin page's audit log and break-glass sections.

## How it works
A break-glass session is a row of `break_glass_sessions` (the architecture's table). Opening it checks the admin against the database, needs a candidate attempt in the lab runtime of this process, queues the alert mails in the same transaction, and audits the opening (session id, attempt, company, minutes; never the reason). Reading goes through the platform route only for the session's own admin while it is open; it reads the lab runtime (as the exports do, with flag-shaped text redacted), appends the read to the row and audits it. The lab's own reviewer routes still answer an admin with 404. Reading the audit log goes through `DbAuditPort.entries` and audits itself.

## Files changed
- New: `apps/api/src/vulnmart/admin/{breakglass,models,incident}.py`, `apps/api/migrations/versions/0016_break_glass_sessions.py`, `apps/api/tests/test_breakglass.py`, `test_breakglass_postgres.py`, `test_incident.py`, `docs/runbooks/incident-procedure.md`, `docs/legal/review-pack.md`, `docs/adr/0062-*.md`, two valid and one invalid request example, the story plan, `docs/assets/p-31-break-glass-audit-and-incidents/`.
- Changed: `admin/api.py`, `orgs/service.py` (`owner_of_org`), `privacy/exports.py` (`attempt_results`), `notifications/templates.py`, `main.py`, `migrations/env.py`, `platform.openapi.yaml`, the bundle, the generated models and types, `contracts/CHANGELOG.md`, pins in `test_platform_contract.py`, `test_role_gates.py`, `test_notification_templates.py`, `test_company_members.py`, `test_kernel_settings.py`, `test_privacy_wall.py` (the six operations classified), `scripts/e2e/platform-stack.e2e.test.mjs`, `apps/web/app/admin/page.tsx`, `apps/web/lib/api.ts`, `initial.md` (D-94 to D-97), `docs/architecture/04-data-and-state.md`, `docs/adr/README.md`, `docs/traceability.md`, `docs/dev/dev2-akshay.md`, `CHANGELOG.md`, `docs/progress/index.html`.

## Decisions made
By the developer: OI-12 (D-94), OI-34 (D-95), OI-27 (D-96), report views (D-97: not in the platform audit log). By the builder, in ADR 0062 (Proposed).

## Tests
- `test_breakglass.py` 5, `test_breakglass_postgres.py` 3 (real Postgres, application role), `test_incident.py` 4, the template tests 180; with the pins, the privacy wall, the admin routes and the exports: 136 passed.
- Contract: `check_platform_contract.py` OK (66 operations); `check_api_models.py` OK (123 checks); `platform-mock.test.mjs` 20 of 20; contract rules **18 PASS, 0 FAIL** (`contract-rules-2026-10-20.txt`).
- Full `pytest apps/api/tests`, first run: 2875 passed, **3 failed**, 1 skipped (`pytest-full-run1-pins-2026-10-20.txt`): three pins that change on purpose with a new table and migration (the org-column list, the migration head 0015 to 0016, the table list); after them the two files pass (46). Full rerun on the final code: **2878 passed, 0 failed, 1 skipped** in 625 s (`pytest-full-2026-10-20.txt`; the skip is the Windows file-mode check).
- `node --test "scripts/*.test.mjs" "apps/*/test/**/*.test.mjs"`: 1218 tests, 1210 pass, **3 fail on this PC** (the three generator tests: `datamodel-codegen` is not installed here; CI has it).
- Web: `tsc --noEmit` clean; `next build` passes; web tests 17 of 17.
- Stack end to end on real Docker (images rebuilt, build exit 0): start-up, the P-25 to P-31 tests and tear-down **10 of 10** on the first run (`stack-e2e-2026-10-20.txt`): on `break_glass_sessions` the application role has INSERT and SELECT and UPDATE only on `closed_at`, `review_note`, `reviewed_at`, `reviewed_by`, `what_read`; an admin's audit log read adds one `admin.audit_read` row; break-glass opens nothing (404) because this stack has no lab in the API process; `python -m vulnmart.admin.incident` inside the API container told 1, queued one `security.incident_notice` and added one `incident.notified` row; a learner gets 404 on the audit and break-glass routes.
- NOT run: break-glass with real candidate content on the Compose stack (no lab in the API process; the full flow is `test_breakglass.py` with the real lab runtime); a browser; CI on GitHub (see the pull request).

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
- **OI-33 open:** who does the legal review and when; the review pack waits.
- The incident procedure does not name who decides (not decided); a draft for the legal review.
- The break-glass alert is a mail, not a live push on the admin stream.
- Not browser-tested (OI-30).
