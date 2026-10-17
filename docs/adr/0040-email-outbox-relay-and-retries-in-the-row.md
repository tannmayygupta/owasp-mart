# 0040. Email: Postgres outbox with a relay, retries in the row, Brevo as the first real provider

- **Status:** Proposed (the provider part is the developer's answer to OI-32 on 2026-10-17; it is not yet recorded in `initial.md`)
- **Date:** 2026-10-17
- **Deciders:** Akshay (answer on the provider); Claude Code (design, for the developer to confirm)
- **Requirements:** FR-NTF-02, FR-NTF-03, D-21, OI-32, OI-9

## Context
Email must never be lost under a daily cap (FR-NTF-02), a failed send must be retried with back-off and be visible to admins, and the sender cannot use a verified domain (DuckDNS cannot publish SPF and DKIM, architecture 03). Valkey may lose data (architecture 02: "Dramatiq loses only unacknowledged queue items, which the outbox and scheduler re-create").

## Options considered
1. **Dramatiq retries only** (the actor carries the mail and Dramatiq retries it) — simple, but a Valkey data loss loses the mail and the retry state; the daily cap would have to be tracked in Valkey too.
2. **Outbox row is the truth, Dramatiq only delivers** — the row holds state, attempts and the next try time; a relay loop leases due rows and sends their ids to a Dramatiq actor with `max_retries=0`. A lost queue or a dead worker only delays mail (the lease runs out and the row is claimed again).
3. **No Dramatiq: the worker polls the outbox and sends** — least moving parts, but D-21 names Dramatiq and later stories (exports, deletion) need the same queue.

## Decision
Option 2. `email_outbox` is written in the caller's transaction (`DbOutboxPort`); `EmailOutboxService.claim_due` leases up to `min(batch, daily cap left)` rows in id order with `FOR UPDATE SKIP LOCKED`; the actor `vulnmart.deliver_email` sends one row and records `sent`, `retry` (back-off 1 min, 5 min, 30 min, 2 h, 6 h), `failed` (after 6 attempts, or at once for a permanent refusal) or `deferred` (the provider reported its cap: next UTC day, attempt not used). The cap is the setting `email_daily_cap` (default 300, 0 = none). Error codes on the row are a fixed list, never provider text. Provider: an interface with an SMTP adapter (Mailpit in development) and the Brevo API adapter; the developer chose Brevo with a verified single sender.

## Consequences
- Delivery is at-least-once: a crash after the provider accepted a mail and before the row says `sent` can send that one mail twice. Brevo's API has no idempotency key that we found; accepted for a training platform.
- Mail beyond the cap waits in order and goes out the next day; the cap counts mails sent today in the table, so it also holds across several workers.
- The worker needs a `RecipientLookup`; the real one comes with accounts (P-11). Until then a development resolver exists and staging and production refuse to start the worker without a real one.
- The admin list of failed mail and a requeue button are service functions today (`failed_rows`, `requeue`, `stats`); the admin screen is story P-28.

## Evidence
- Brevo API: `POST https://api.brevo.com/v3/smtp/email`, header `api-key`, body `sender`, `to`, `subject`, `htmlContent`, `textContent`; 201 with `messageId` (https://developers.brevo.com/reference/sendtransacemail, read 2026-10-17). The page names the 400 codes `not_enough_credits` and `Insufficient credits` but no 429 or rate limit.
- Brevo free plan: 300 sends a day, resets daily (help.brevo.com, "What are the limits of the Free plan?", from a search on 2026-10-17). **Unverified:** that transactional API mail counts toward the 300; the page did not say. Also unverified: Single Sender Verification steps (read only in search summaries).
- Dramatiq 2.2.1 with `redis` 8.1.0 resolves on Python 3.14 (`uv pip install --dry-run`, 2026-10-17). Using the Redis broker against Valkey 9.0.6 is shown by the Valkey test in `apps/api/tests/test_notifications_postgres.py` (spike S-18 stays open for kill and ack behaviour under load).
