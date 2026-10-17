---
title: 'Outbox, queue worker and email provider'
type: 'feature'
ticket: '1'
created: '2026-10-17'
status: built
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/architecture/02-deployment-and-network.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** Nothing sends email yet: the outbox port is an in-memory fake, the worker only idles, and no provider is chosen (FR-NTF-02, FR-NTF-03).

**Approach:** An `email_outbox` table written in the caller's transaction; a relay loop that leases due rows (in order, never more than the daily cap allows) and sends their ids to a Dramatiq actor on Valkey; the actor sends one row through a provider adapter and records the result in the row, which owns retries and back-off. Brevo (API) and SMTP (Mailpit) adapters.

## Boundaries & Constraints

**Decisions (developer, 2026-10-17):** Brevo with a verified single sender (OI-32); "continue automatically" through P-09 to P-16; branch, pull request and merge per task. Design choices below are Claude's and are recorded as ADR 0040 (Proposed) for the developer to confirm.

**Always:** Postgres is the truth; the row holds a user id, never an address; error codes on the row are a fixed list, never provider text; the Brevo key and any secret come from the environment or a secret file, never from a repository file; the worker refuses to start in staging or production without a real recipient lookup.

**Never:** No templates beyond one built-in test template (P-10). No account lookup (P-11). No admin screens (P-28). No domain-event table or relay (P-22). No change to the port Protocols of P-05.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Enqueue | row written in a transaction that commits | one `pending` row | rollback leaves no row |
| Bad enqueue | empty template or user, an address in params, params over 8 KB or not JSON | ValueError, no row | n/a |
| Delivery | due row, provider accepts | `sent`, one provider call, `sent_at` set | a second delivery of the same message is skipped |
| Transient failure | provider network or 5xx error | `pending`, `attempts+1`, `next_attempt_at` by back-off | after 6 attempts `failed`, listed for admins |
| Permanent refusal | provider 4xx, unknown recipient or template | `failed` at once | requeue by an admin |
| Provider cap | Brevo `not_enough_credits` | `pending`, attempt not used, tomorrow | n/a |
| Local cap | cap 2, 5 rows | 2, 2, 1 over three days, in order | rows wait unchanged |
| Worker dies after claim | lease running | not claimed again until the lease ends, then claimed | n/a |
| Valkey or database down in the relay | exception in a pass | logged, next pass runs | loop continues |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/notifications/` -- `models.py` (table), `provider.py` (adapters and error kinds), `service.py` (`DbOutboxPort`, `EmailOutboxService`), `fakes.py`, `worker.py` (broker, actor, `RelayLoop`).
- `apps/api/migrations/versions/0002_email_outbox.py`, `migrations/env.py` -- the table and the app role's rights; single head 0002.
- `apps/api/src/vulnmart/kernel/entrypoints/worker.py` -- starts Dramatiq's worker and the relay when Postgres and Valkey addresses are set.
- `kernel/settings.py`, `ports/settings.py` -- email settings (environment) and `email_daily_cap` (admin setting).
- `kernel/services.py` -- `build_ports(session_source=...)` wires `DbOutboxPort`.
- `infra/compose/compose.yaml` (worker service), `scripts/demo.mjs`, `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] Table, migration 0002, models import in Alembic env.
- [x] Provider adapters (Brevo API, SMTP) with error classification.
- [x] Service: enqueue, claim with lease and cap, deliver, failure handling, admin functions.
- [x] Dramatiq actor (`max_retries=0`), relay loop, worker entrypoint, Compose service.
- [x] Unit tests (SQLite, fakes, StubBroker), Postgres and Valkey tests, stack e2e (real Docker).

**Acceptance Criteria:**
- Given a row enqueued in a transaction, when the worker runs, then Mailpit receives exactly one message and the row is `sent` with one attempt.
- Given a provider that fails twice, when time passes, then the mail is retried after 1 and 5 minutes and then sent.
- Given a worker that is stopped while mail is queued, when it starts again, then the mail is delivered.
- Given 5 rows and a cap of 2, then 2, 2 and 1 are sent on three days, in order.

## Implementation Notes

- Retries live in the row, not in Dramatiq (ADR 0040); the actor has `max_retries=0`.
- Delivery is at-least-once; the window is between the provider accepting a mail and the row being marked sent.
- Brevo's free plan allows 300 sends a day (help centre); whether API mail counts is unconfirmed, so the cap is a setting and the adapter also reacts to the provider's own cap error.

## Plan Change Log

## Review Triage Log

### 2026-10-17, self-review by the builder (lens: quick), loop 0
This was a read of my own diff by the same session, not an independent review. Verdicts: 2 medium, 1 low. All patched.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | Two workers claiming at the same time could both take the last cap slots (leased rows were not counted) | medium | patch | `claim_due` subtracts rows with a live lease; test `test_rows_leased_by_another_worker_count_against_the_cap` |
| 2 | The "no address in params" check looked only at top-level strings | medium | patch | `_strings` walks nested values and keys; a nested case added to the refusal test |
| 3 | Evidence files written by `Tee-Object` carried a byte order mark (text-hygiene test failed) | low | patch | Files rewritten without it; `check-text-files` passes |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest -q` with the Postgres and Valkey test addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs`, `node --test "scripts/*.test.mjs"` -- expected: 0 FAIL (one known failure on Windows, see the dev-log)
