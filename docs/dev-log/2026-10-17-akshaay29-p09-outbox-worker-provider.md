# Outbox, queue worker and email provider (P-09, story 2.1)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-2-akshay / see the pull request |
| Status | Built and tested; the story state is `built` until the developer confirms it is done |
| Report tag | email outbox, Dramatiq, Valkey, Brevo, BMAD cycle |

## Requirements covered
FR-NTF-02 (outbox and queue, retries, visible to admins), FR-NTF-03 (provider: Brevo single sender, the developer's answer to OI-32 on 2026-10-17). Related: D-21, OI-9, handoffs H-127 (account lookup, for P-11 and P-14) and H-128 (templates and the admin view, for P-10 and P-28), ADR 0040.

## Summary (plain language, 3-5 lines)
Emails are now written to a table in the same database transaction as whatever causes them, so an email exists exactly when its cause does. A worker takes due rows in order, never more than the daily cap allows, and sends them through a provider adapter (Mailpit by SMTP in development, Brevo's API for the real thing). A failed send is retried after 1, 5, 30 minutes, 2 and 6 hours and then shown as failed for admins. If the worker or Valkey dies, nothing is lost because the table is the truth.

## Why
FR-NTF-02 asks that a daily cap never loses a message; every later email (verification, reset, invites) depends on this path.

## What was built
- `notifications/models.py`, migration `0002_email_outbox.py`: table `email_outbox` (state `pending`, `sent`, `failed`, attempts, next attempt time, a lease, a fixed error code, provider message id). Not company-scoped; the app role gets row rights.
- `notifications/service.py`: `DbOutboxPort` (writes in the caller's session, never commits), `EmailOutboxService` (claim due rows with a lease and `SKIP LOCKED`, deliver one row, record success, retry, deferral or failure, `failed_rows`, `requeue`, `stats`).
- `notifications/provider.py`: `SmtpProvider`, `BrevoApiProvider`, and three error kinds (transient, permanent, daily cap).
- `notifications/worker.py`: Dramatiq actor with `max_retries=0`, `RelayLoop`, broker and provider factories. `kernel/entrypoints/worker.py` starts them when Postgres and Valkey addresses are set.
- Compose: a `worker` service (profile `platform`). Settings: email variables, and the admin setting `email_daily_cap` (default 300, 0 means no cap).
- Dependency: `dramatiq[redis]` 2.2.1 (pulls `redis` 8.1.0).

## How it works
The cause (for example a signup) adds a row and commits. Every 5 seconds the relay asks the database for the oldest due rows, leases them for 5 minutes (so no other worker takes them) and queues their ids in Valkey. A Dramatiq thread loads the row, looks up the address, renders the message, calls the provider, and writes the result back. Success: `sent`. A temporary problem: the row waits for its back-off time. A refusal: `failed` at once. The provider saying its daily limit is reached: the row waits until the next UTC day without using up an attempt. The local cap counts mails sent today plus rows currently leased, so several workers cannot overshoot it. If a worker dies, the lease expires and the next pass takes the row again.

## Files changed
- New: `apps/api/src/vulnmart/notifications/{models,provider,service,fakes,worker}.py`, `apps/api/migrations/versions/0002_email_outbox.py`, `apps/api/tests/test_notifications.py`, `apps/api/tests/test_notifications_postgres.py`, `docs/adr/0040-email-outbox-relay-and-retries-in-the-row.md`, the epic breakdown `docs/bmad/initiative-platform/epic-notifications-and-email/tickets.toml` and the story plan.
- Changed: `kernel/entrypoints/worker.py`, `kernel/services.py`, `kernel/settings.py`, `ports/settings.py`, `migrations/env.py`, `apps/api/pyproject.toml`, `uv.lock`, `infra/compose/compose.yaml`, `scripts/demo.mjs`, `scripts/e2e/platform-stack.e2e.test.mjs`, `apps/api/tests/test_kernel_settings.py` and `test_kernel_postgres.py` (head is now 0002), `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`.

## Decisions made
ADR 0040 (Proposed): the outbox row owns state and retries, Dramatiq only delivers; at-least-once delivery. By the developer on 2026-10-17: Brevo single sender; branch, pull request and merge for each task; keep going through P-09 to P-16. Alternatives considered are in the ADR.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, uv 0.12.23, Node 24.11.0, Docker 28.5.1. Outputs in `docs/assets/p-09-outbox-worker/`.
- `uv run --package vulnmart-api pytest apps/api/tests -q` with throwaway Postgres 18.6 and Valkey 9.0.6 containers (`VULNMART_TEST_POSTGRES_DSN`, `VULNMART_TEST_APP_DSN`, `VULNMART_TEST_VALKEY_URL` set): **1020 passed, 0 skipped** (537 s). That includes 26 new test functions (35 cases in the first full run) in `test_notifications.py` and 5 in `test_notifications_postgres.py` (migration to head and back, the app role's rights, 4 workers never claiming the same row, lease expiry after a "crash", rollback leaves no row, five mails through a real Valkey broker). One more test was added after the full run (rows leased by another worker count against the cap, and a nested address in params); the notification, settings and ports files were run again: 98 passed.
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` on real Docker: **15 of 15**, including a row delivered to Mailpit exactly once (and not again after a second relay pass) and mail queued while the worker was stopped delivered after it started.
- `node --test "scripts/*.test.mjs"`: 765 tests, 759 pass, 4 fail, 2 skipped (`script-tests-2026-10-17.txt`). Three failures are the `generate-api-code` tests, which also failed on the unchanged baseline (CRLF in the checked-out generated files on this PC). The fourth, `check-text-files`, was caused by this story: a byte order mark in my first evidence files (PowerShell `Tee-Object`). Fixed, and `node --test scripts/check-text-files.test.mjs` now passes 5 of 5. The other script tests were not re-run after that fix.
- `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL (one rule not applicable: no `contracts-v*` tag yet).
- NOT run: the Brevo adapter against Brevo (no key or account); a worker kill during a send under load (spike S-18); CI on GitHub.

## Evidence
`docs/assets/p-09-outbox-worker/` (pytest, stack end-to-end, script tests). No screenshots.

## Problems met and how they were fixed
- Docker Desktop was not running: started it.
- A first draft of migration 0002 had a bad import (migration 0001 cannot be imported by name): rewritten with its own small role helper.
- Three existing tests hard-coded the single head `0001` and the five-table list: updated to `0002` and six tables.
- `uv sync` failed once with "access denied" inside `.venv` (a lock by OneDrive or another process); retrying worked.
- My own review found two defects before closing: two workers could together overshoot the daily cap (leased rows were not counted), and the "no address in params" check looked only at top-level strings. Both fixed with tests.
- The full script test suite on this Windows PC has a failure that was there before this change: `generate-api-code.test.mjs` compares generated TypeScript with the file on disk and the file has CRLF line endings here (seen on the unchanged baseline).

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant choices: the outbox holds a user id, never an address; error codes are fixed labels, never provider text (it can contain the address); the Brevo key comes from an environment variable or a secret file; a deployed worker refuses to start without a real recipient lookup; the development resolver is limited to dev and test.

## Limitations and follow-ups
- Delivery is at-least-once; one duplicate is possible if the worker dies between the provider accepting a mail and the row being marked sent.
- Not verified: that Brevo's 300 a day counts API mail; Single Sender Verification steps; the production sender address (OI-9). Decision on OI-32 not yet in `initial.md` (needs your confirmation).
- No admin HTTP routes yet (P-28). No templates beyond `system.test` (P-10). No real account lookup (P-11, H-127).
- Remind: set Done = Yes for P-09 in the Excel sheet, and confirm the story so it can move from `built` to `done`.
