# Assessment templates, creating and sending invites, invite lifecycle (P-20, story 6.1)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-3-akshay-4 / see the pull request |
| Status | Built and tested at service level. Not built: any HTTP route (story 5.3, a contract change), accepting an invite and the consent flow (P-21), the scheduler call (P-24), a limit on resends. Story 6.1 is `built`, awaiting the developer's confirmation |
| Report tag | assessment configuration, invitations, single-use hashed tokens, outbox, BMAD cycle |

## Requirements covered
FR-ASM-01 (templates), FR-ASM-02 (creating and sending invites), FR-ASM-03 (the invite lifecycle). OI-14 and OI-15 answered by the developer on 2026-10-18 (template settings: the write-up default optional, results default right after submit). Related: ADR 0050 (new), ADR 0014, 0040 and 0049, handoff H-140 (new). The epic `epic-assessments-and-invites` was incepted in this task (`tickets.toml`: stories 6.1 and 6.2 = P-21).

## Summary (plain language, 3-5 lines)
A recruiter of an approved company that accepted the data-processing terms can now define an assessment (which challenges, how long, hints, resets and so on) and invite a candidate by email. The candidate has no account, yet the mail arrives: the address travels sealed inside the mail queue and is removed once the mail has left. The database keeps only a hash of the link's token, a resend makes the old link dead, a daily cap limits a company, and editing a template never changes an invite already sent.

## Why
Recruiters had companies (P-18, P-19) but nothing to invite candidates to. The consent flow (P-16) and the accepting story (P-21) need real invites with single-use hashed tokens, and the mail queue could not address a person with no account.

## What was built
- `assessments/models.py`, `tokens.py`, `service.py` (`AssessmentService`): `create_template`, `update_template`, `get_template`, `list_templates`, `delete_template`; `create_invite`, `list_invites`, `get_invite`, `cancel`, `revoke`, `resend`; for the accepting story and the scheduler `find_by_token`, `advance`, `expire_due`, `expire_all`; `validate_template` (the fields, defaults and ranges of FR-ASM-01; the switch-offs refused by name).
- Migration 0010: `assessment_templates`, `template_challenges` (with `org_id`), `invites` (forced row-level security by company; no DELETE for the application role) and `email_outbox.to_address_sealed`.
- Notifications: `DbOutboxPort.enqueue_email(..., to_address=)` seals the address (field key, bound to the invite id); `EmailOutboxService` opens it with an `address_opener`, sends, and clears it; the worker entrypoint and Compose give the mail worker the field secret; `accounts.fieldkeys.from_settings` is shared by the API and the worker.
- `main.py` wiring; ADR 0050 (Proposed); handoff H-140; the epic breakdown and the plan of story 6.1.

## How it works
Creating an invite checks the recruiter's scope against their company, the terms and the cap (the count of the day's invites and the insert run under a lock per company), copies the template's rules onto the invite, stores the hash of a new token (`<company>.<secret>`, 256 random bits) and queues the mail with the sealed address, all in one transaction. The mail worker opens the address, sends, and clears it. The invite remembers its mail, so reading an invite brings `sent` up to date, and anything past its expiry is closed on the read; these settling steps run in a transaction of their own, as conditional updates. Cancel, revoke, resend and the accepting story's moves are conditional updates from the state they start from.

## Files changed
- New: `assessments/{models,tokens,service}.py`, `migrations/versions/0010_assessment_templates_invites_and_sealed_recipients.py`, tests `test_assessments.py`, `test_assessments_postgres.py`, `test_notifications_sealed.py`, `docs/adr/0050-*.md`, the plan of story 6.1, `tickets.toml` of the epic.
- Changed: `notifications/{models,service,worker}.py`, `kernel/entrypoints/worker.py`, `accounts/fieldkeys.py`, `main.py`, `migrations/env.py`, `infra/compose/compose.yaml`, `test_kernel_settings.py`, `test_kernel_postgres.py`, `test_data_minimum.py`, `scripts/e2e/platform-stack.e2e.test.mjs` (the new test; the P-18 test now uses a domain of its own per run), `docs/architecture/04-data-and-state.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: OI-14 and OI-15 (2026-10-18) and "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0050 (Proposed) for confirmation: the sealed address in the outbox row, the company-prefixed 256-bit token, `sent` read from the mail, rules copied onto the invite, conditional moves, the research ranges kept as placeholders (OI-25), a resend not counting against the cap.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-20-invites/`.
- New tests: `test_assessments.py` 74 (SQLite, real scoped session: the token, every template field and refusal, the nine switch-off names, invites, the cap, duplicates, every pair of lifecycle states, expiry, resend, what stays inside a company, the settle steps), `test_assessments_postgres.py` 16 (as the application role: forced row-level security on the three tables, privileges, the database's own state and range checks, deleting a company, 8 creators of one invite make one, 10 creators at a cap of 3 make exactly 3, resend against revoke leaves one winner (20 runs in a row), 8 moves of one invite leave one, migration 0010 down and up), `test_notifications_sealed.py` 12 (the sealed address in the outbox, delivery, clearing, retry, a wrong key).
- Full run of `pytest apps/api/tests` with the two containers on the final code: **2245 passed, 0 failed, 1 skipped** (445 s; the one skip is a Windows file-mode check in the lab tests). An earlier full run, before the last change (`pytest-before-settle-change-2026-10-18.txt`), was 2243 passed.
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **25 of 25** on the final code (`platform-stack-e2e-2026-10-18.txt`), after `docker compose ... build api`. The new test: a recruiter makes a template and invites a candidate whose address has no account; while queued the outbox row holds the address sealed and the link; the real worker sends it and the mail arrives in Mailpit with only its own link; the database holds only the SHA-256 of the token; the sent outbox row holds neither token nor address; neither is in the audit log; reading the invite shows `sent`; a resend gives a second mail and the old link finds nothing; the cap of 1 refuses a second invite and makes nothing; a revoke closes it; the audit entries are under pseudonyms. A run made right after a Docker Desktop stop failed every test on "Docker is not running" (nothing to do with the code); I restarted Docker and the run above is the repeat.
- `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL, 1 not applicable (`contract-rules-2026-10-18.txt`; no contract file is changed). The text-hygiene, progress-page, dev and demo script tests: 70 of 70.
- NOT run: a browser or any route (none exists); anything on the VMs; CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-20-invites/`: the test outputs.

## Problems met and how they were fixed
- The first race test (a resend against a revoke) failed once in twelve runs and showed a real bug: the lazy `created -> sent` step wrote the state unconditionally, so a request that had waited on a lock could overwrite a revoked invite with `sent` and then resend it. All settling steps are conditional updates now, and the race test passed 20 and 25 times in a row afterwards.
- Auditing the settling steps inside the transaction of a change that may be refused would repeat the entry and roll the state back; they now run in a transaction of their own first (two tests added).
- The invite to template reference was `ON DELETE RESTRICT`, which refuses the cascade of a deleted company; noticed while writing the Postgres tests, changed to NO ACTION, and a test deletes a company with templates and invites.
- The P-18 end-to-end test shared one email domain between runs, so after P-19 a second run asked to join the first run's company; the P-20 test cancelled an invite whose mail had already left. Both fixed in the tests.
- A quoting slip in a scripted edit swallowed a template literal in the e2e file and a stray `&&` is not valid PowerShell 5; both caught at once.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: only a hash of a 256-bit token is stored and the token is in no log, no audit entry and no sent outbox row; the candidate's address is sealed (bound to the invite id) while queued and cleared when the mail has left, and is never in params or the audit log; invites and templates are company rows behind forced row-level security (checked as the application role) and an admin cannot read them; every state change is conditional so a stale request cannot undo a revoke; a closed invite stays closed; the daily cap and the one-live-invite rule hold under concurrency.

## Limitations and follow-ups
- No HTTP route (story 5.3). Accepting an invite, the consent flow and handing the attempt to the lab are P-21; the scheduler and the invite purge are P-24.
- `sent` lags until the invite is next read; a resend is neither limited nor counted against the cap; the consent notice still shows the setting for retention, not the template's.
- The template ranges are research placeholders (OI-25); OI-14, OI-15, OI-10, OI-11, OI-28 and OI-37 are answered but not yet in `initial.md`. ADRs 0040 to 0050 are Proposed.
- Remind: Excel, P-20 Done = Yes; confirm story 6.1 so it can move to `done`.
