# Email templates (P-10 part 1, story 2.2)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-2-akshay-2 / see the pull request |
| Status | Partly done: the email templates are built and tested; the in-app warnings part of P-10 (FR-NTF-04) is NOT built and moved to story 2.3. Story 2.2 is `built`, awaiting the developer's confirmation |
| Report tag | email templates, secret handling, input validation, BMAD cycle |

## Requirements covered
FR-NTF-01 (the email types). Not covered: FR-NTF-04 (in-app warnings, recruiter alerts) and FR-SES-03, now story 2.3. Related: FR-ACC-02, FR-ACC-08, FR-ASM-02, FR-PRV-05, FR-PRV-08, FR-PRV-09, handoff H-128.

## Summary (plain language, 3-5 lines)
All nine email types now have their text and HTML in one place. Each mail says who sent it, contains only its own single-use link, and refuses any attempt to put a password, token, flag or address into it. The link is wiped from the database row once the mail has been sent. The in-app warnings were not built, because the pages and the live stream they appear in do not exist yet.

## Why
FR-NTF-01 lists the mail the platform must send, and FR-ASM-02 and FR-ACC-02 say links are single-use and stored only as hashes; a raw link kept in the outbox would work against that.

## What was built
- `notifications/templates.py`: `TemplateSpec` per type with a strict list of parameters, `TemplateRenderer`, `validate_params`, `EMAIL_TYPES` (nine): `account.verify`, `account.password_reset`, `org.approval_outcome`, `candidate.invite`, `recruiter.consent_withdrawn`, `privacy.deletion_requested`, `privacy.deletion_request_for_company`, `privacy.deletion_confirmed`, `learner.retention_warning` (plus `system.test` for operators).
- `notifications/service.py`: `Rendered.sender_name` (invites go out as "<company> via VulnMart"), `InvalidParams`, a validator hook on `DbOutboxPort` (checks at enqueue), removal of secret parameters after sending, `bad-params` as a permanent failure at delivery.
- Wiring: the worker uses `TemplateRenderer`; `build_ports` gives the outbox the validator.
- A story split: `tickets.toml` has the new entry 2.3 (in-app warnings, blocked) and the plan of story 2.2.

## How it works
Whoever causes an email calls `enqueue_email(template, to_user_id, params)`. The params are checked against that template's list right away, inside the caller's transaction, so a wrong call fails loudly instead of creating a mail that can never be sent. At delivery the template builds the text and HTML: every value is cleaned to one line, everything in the HTML is escaped, and links must be plain http or https. After the provider accepts the mail, the parameters that are links are replaced with a marker in the row.

## Files changed
- New: `apps/api/src/vulnmart/notifications/templates.py`, `apps/api/tests/test_notification_templates.py`, the plan of story 2.2.
- Changed: `notifications/service.py`, `notifications/worker.py`, `kernel/services.py`, `apps/api/tests/test_notifications.py` (one test made safe), `tickets.toml` of the epic, `docs/dev/dev2-akshay.md`, `docs/dev/HANDOFFS.md` (H-128 text), `docs/bmad/initiative-platform/deferred-work.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/progress/index.html` (generated from the task files).

## Decisions made
No ADR. Claude's scoping decision, for the developer to confirm: FR-NTF-04 is a separate story (2.3) because its data does not exist before the live hub (P-22, P-23) and the dashboards (P-26). The task line "the warnings show in the app" is therefore not met by P-10. Also decided while building: a mail's parameter list is an allow-list, so an unknown name is refused rather than ignored; the deletion mails are three types (to the requester, to the company, the confirmation) following FR-PRV-08 and FR-PRV-09 as written.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, uv 0.12.23. Output in `docs/assets/p-10-email-templates/`.
- `uv run --package vulnmart-api pytest apps/api/tests -q -rs`: **1126 passed, 12 skipped** (356 s). The 12 skipped are the Postgres and Valkey tests of `test_kernel_postgres.py` and `test_notifications_postgres.py`: Docker could not be started during this story, so they were NOT run again after P-10's changes (they passed in P-09 on real Postgres and Valkey, 1020 passed).
- The new `test_notification_templates.py` plus `test_notifications.py`: 153 passed, repeated 5 times with the same result.
- `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL (1 not applicable). `node --test scripts/check-text-files.test.mjs scripts/progress-page.test.mjs`: 22 of 22 pass. The full `node --test "scripts/*.test.mjs"` was NOT re-run for this story (this story changes no script except none; the P-09 run showed only the Windows line-ending failures).
- NOT run: the real Docker stack (a verification mail to Mailpit); CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-10-email-templates/pytest-no-docker-2026-10-17.txt`.

## Problems met and how they were fixed
- Docker Desktop stopped answering (its Windows backend would not start, and `com.docker.service` was stopped), so no real-stack test could be run. A new end-to-end check I had written was removed again before committing, because CI does not run that test and it would never have been verified.
- One test of P-09 failed once in a full run: Dramatiq's threads shared one in-memory SQLite connection. Fixed by one worker thread in that test; 5 repeated runs pass.
- My own review found that the raw link stayed in the outbox row after sending: now removed at `sent`. It stays while the row is `pending` or `failed` (deferred, see below).

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: allow-listed parameters, header-injection and HTML-injection handling, link scheme check, links removed after sending.

## Limitations and follow-ups
- FR-NTF-04 and FR-SES-03: story 2.3, not built. Open: where the 15 and 5 minute warnings come from.
- A link stays in `email_outbox.params` while the row is `pending` or `failed`; encrypting it with the KeyPort (P-17) would close that.
- The wording of the nine mails is a first draft that nobody else has read. P-25 may change the deletion mails' parameters.
- Remind: Excel, P-10 Done = Yes only for the templates part (decide how you want to mark the split); confirm story 2.2 so it can move to `done`.
