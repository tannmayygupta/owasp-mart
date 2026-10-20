---
title: 'Learner signup, email verification and signup abuse protection'
type: 'feature'
ticket: '1'
created: '2026-10-17'
status: done
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/contracts/api/platform/platform.openapi.yaml'
  - '{project-root}/docs/architecture/03-origins-and-access.md'
  - '{project-root}/docs/architecture/06-security.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** Nobody can create an account yet: no user tables, no password hashing, no verification link, no abuse limits (FR-ACC-01, FR-ACC-02, FR-ACC-10), and the mail worker has no real address lookup (handoff H-127).

**Approach:** The three public routes of IF-1 (`createAccount`, `verifyEmail`, `resendVerification`) over new tables `users`, `user_roles`, `email_tokens`: Argon2id passwords, 256-bit single-use links stored only as a hash, the same answer for known and new addresses, and fixed-window rate limits in Valkey per address and per email.

## Boundaries & Constraints

**Decisions (developer, 2026-10-17):** OI-29: rate limits only, no CAPTCHA (the optional `captcha_token` field stays and is ignored). Branch, pull request and merge per task; "continue automatically". Claude's own choices, recorded in ADR 0041 (Proposed) for the developer to confirm: the Argon2id profile, the token design, fail-closed rate limiting, the proxy-hop rule for the visitor address.

**Always:** Same 202 answer and about the same time for a new and a known address; a link is claimed by one conditional UPDATE; passwords, tokens and addresses are never logged; the account type is enforced by the database (a recruiter or admin cannot hold a role); mail is queued in the account's transaction.

**Never:** No login or session (P-12), no password reset or breach list (P-14), no recruiter or admin signup (P-13, P-18), no dashboards pages (the signup form and the verify-email page), no CAPTCHA provider, no change to the contract.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New signup | valid body | 202 `{"status":"accepted"}`; user, learner role, one verify token, one `account.verify` mail | n/a |
| Known address | same address, any case | same 202; `account.already_registered` mail to the owner; no new account | n/a |
| Concurrent signups | 8 requests, one address | one account, one verify mail, seven already-registered mails | the unique index decides |
| Bad body | `age_declaration` false, 1 or "true"; password under 12 or over 128; extra member; not JSON | 422 naming only the location | never the value |
| Media and size | text/plain; over 16 KB | 415; 413 | n/a |
| Verify | fresh link | 200 verified, token used | n/a |
| Verify again, expired, unknown, wrong purpose | same link twice; after 24 h | 400 AUTH-TOKEN-INVALID, the same for all | n/a |
| Concurrent verify | one link, 8 requests | exactly one 200 | the conditional UPDATE decides |
| Resend | unverified account | old links dead, new mail; 202 for any address | silent for unknown or verified |
| Limits | 4th signup per address per hour; 31st per address per hour | 429 REQ-RATE-LIMITED with Retry-After | the refused request queues nothing |
| Limiter store down | Valkey error | request refused (REQ-INTERNAL), not let through | logged |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/accounts/` -- `models.py` (users, user_roles, email_tokens), `security.py` (Argon2id, ids, tokens, email normalisation), `service.py` (`AccountService`, `DbRecipients`), `api.py` (routes, body reading, client address).
- `apps/api/src/vulnmart/kernel/ratelimit.py` -- `RateLimiter`, in-memory and Valkey implementations.
- `apps/api/migrations/versions/0003_accounts.py`, `migrations/env.py` -- tables, composite foreign key, grants; single head 0003.
- `main.py` (routes and limiter wiring, fail-closed checks), `kernel/settings.py` (`public_origin`, `trusted_proxy_hops`), `ports/settings.py` (limits and `email_token_hours`), `kernel/entrypoints/worker.py` (real address lookup), `notifications/templates.py` (`account.already_registered`).
- Tests: `test_accounts_service.py`, `test_accounts_api.py`, `test_ratelimit.py`, `test_accounts_postgres.py`; stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] Tables, migration 0003, models import in the Alembic env.
- [x] Security helpers, service, `DbRecipients`; the worker uses the real lookup.
- [x] Rate limiter (memory and Valkey), routes, wiring with fail-closed production checks.
- [x] Tests: service, HTTP, limiter (real Valkey), Postgres (rules and races), stack end to end.

**Acceptance Criteria:**
- Given the local stack, when a learner signs up through the web origin, then a verification mail arrives in Mailpit, its link verifies once and a second use is refused.
- Given one address, then the fourth signup in an hour is 429 with Retry-After and queues nothing.
- Given a recruiter or admin row, then the database refuses a learner role for it.

## Implementation Notes

- Argon2id at the OWASP minimum (19 MiB, 2 passes, 1 lane); spike S-12 tunes it. At most 4 hashes run at once per API process (memory).
- The rate-limit window is fixed, not sliding; limits are placeholders (30 per address per hour for signup because a college lab can share one address).
- A pydantic `Literal[True]` accepted the number 1 for `age_declaration`; found by a test, fixed with a strict boolean.
- The visitor address is read from `x-forwarded-for` only when an origin secret protects the API, `trusted_proxy_hops` entries from the right (handoff H-129).

## Plan Change Log

## Review Triage Log

### 2026-10-17, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. 1 high, 1 low; both patched.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | `age_declaration: 1` passed validation although the contract says only `true` | high | patch | strict boolean plus a check; parametrised test for `1`, `"true"`, `false` |
| 2 | The P-09 stack test counted rows by a fixed user id, so a second run on the persistent volume failed | low | patch | unique ids per run; the stack test passed 16 of 16 afterwards |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
