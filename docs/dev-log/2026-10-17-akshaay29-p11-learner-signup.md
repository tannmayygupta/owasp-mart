# Learner signup, email verification and signup abuse protection (P-11, story 3.1)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-2-akshay-3 / see the pull request |
| Status | Built and tested at API level; the signup form and the verify-email page (dashboards) are not built. Story 3.1 is `built`, awaiting the developer's confirmation |
| Report tag | signup, Argon2id, single-use links, rate limiting, account enumeration, BMAD cycle |

## Requirements covered
FR-ACC-01, FR-ACC-02, FR-ACC-10 (signup, verify and resend only), OI-29 (answered by the developer: rate limits only). Related: FR-ACC-05 (the database rule), FR-PRV-13 (the declaration), handoffs H-127 (answered), H-129 (new, for Tanmay), ADR 0041.

## Summary (plain language, 3-5 lines)
A person can now sign up as a learner through the API, receive a verification email, and verify with a link that works exactly once. Signing up with an address that already has an account gives the same answer and sends that owner a mail saying so, so nobody can find out which addresses are registered. Too many requests from one visitor address, or for one email address, get a 429. There is still no page to click through: the signup form and the verify page belong to the dashboards.

## Why
FR-ACC-01 and 02 are the front door of the platform; FR-ACC-10 protects it. Everything that follows (login, invites, instances) needs an account.

## What was built
- Tables (migration 0003): `users`, `user_roles` (a composite foreign key to `users (id, account_type)` means only a participant can hold a role), `email_tokens`.
- `accounts/security.py`: Argon2id hashing (19 MiB, 2 passes, 1 lane), user ids, 256-bit link tokens kept as SHA-256 hashes, email normalisation.
- `accounts/service.py`: `AccountService.signup`, `verify_email`, `resend_verification`; `DbRecipients` (the real address lookup for the mail worker, answering H-127).
- `accounts/api.py`: the three routes of IF-1, bounded JSON body reading (415, 413, 422 without echoing values), the visitor-address rule, at most 4 hashes at once per process.
- `kernel/ratelimit.py`: fixed-window counters in Valkey (one Lua call) with an in-memory twin for tests.
- `main.py`: routes and limiter wiring; strict environments refuse to start without Valkey, or with an `http://` public origin.
- A new mail type, `account.already_registered`; the worker now uses the real lookup (with the development fallback in dev and test).

## How it works
Signup normalises the email, checks the password length (12 to 128; the breach list is P-14), hashes the password, then in one transaction either adds the learner, the learner role, a verification token and the mail, or (address known) adds only the "already registered" mail. The link in the mail holds a random token; the database keeps only its hash. Using the link runs a single UPDATE that succeeds for one request only. Before any of that, each route counts the request against Valkey (visitor address first, before the body is read, then the email hash).

## Files changed
- New: `apps/api/src/vulnmart/accounts/{models,security,service,api}.py`, `apps/api/src/vulnmart/kernel/ratelimit.py`, `apps/api/migrations/versions/0003_accounts.py`, tests `test_accounts_service.py`, `test_accounts_api.py`, `test_ratelimit.py`, `test_accounts_postgres.py`, `docs/adr/0041-*.md`, the epic breakdown `epic-accounts-and-sessions/tickets.toml` and the plan of story 3.1.
- Changed: `main.py`, `kernel/settings.py`, `ports/settings.py`, `kernel/entrypoints/worker.py`, `notifications/{templates,fakes}.py`, `migrations/env.py`, `apps/api/pyproject.toml`, `uv.lock`, `scripts/e2e/platform-stack.e2e.test.mjs`, `test_kernel_origin.py`, `test_kernel_settings.py`, `test_kernel_postgres.py`, `test_notification_templates.py`, `docs/dev/HANDOFFS.md`, `docs/dev/dev1-tanmay.md` (one Handoffs line), `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer (2026-10-17): no CAPTCHA, rate limits only (OI-29); branch, pull request and merge per task. By the builder, in ADR 0041 (Proposed) for confirmation: the Argon2id profile, hashed 256-bit links, fail-closed rate limits, the proxy-hop rule for the visitor address, the `already_registered` mail.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-11-signup/`.
- First full run: `pytest apps/api/tests`: 1220 passed, **2 failed** (`pytest-first-run-2-failed-2026-10-17.txt`): two existing origin-secret tests built a production app without a Valkey address, which the new startup rule refuses. The test now passes an address, and two tests for the new startup rules were added; the two affected files were run again: 59 passed.
- Full run after that fix, with the Postgres and Valkey containers: **1226 passed, 0 failed, 0 skipped** (335 s, `pytest-2026-10-17.txt`).
- `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL. `node --test` on `check-text-files`, `progress-page`, `dev` and `demo` script tests: 70 of 70. The whole `scripts/*.test.mjs` suite was not re-run for this story (P-09 run: only Windows line-ending failures).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **16 of 16**, including a new test: signup through the web origin, the verification mail in Mailpit holding only its own link, an Argon2id hash and the learner role in the real database, the token itself not stored, verify once then 400, a repeat signup answered the same and mailed "already registered", the fourth signup for one address 429 with Retry-After, and a 422 that does not echo the password. (A first run of this file had 1 failure in an older P-09 test; see Problems.)
- New tests: service (31), HTTP (about 30 cases), limiter (including a real Valkey, 16 threads allowing exactly 5), Postgres (rules and races: 8 simultaneous signups give one account and one verification mail; 8 simultaneous uses of one link give one success).
- NOT run: a real browser (there is no page yet); CI on GitHub (see the pull request); the Argon2id cost on the real VM (spike S-12).

## Evidence
`docs/assets/p-11-signup/`.

## Problems met and how they were fixed
- A test found that `age_declaration: 1` was accepted: pydantic's `Literal[True]` treats the number 1 as true. Fixed with a strict boolean and a check.
- Docker Desktop was stopped at the start of the session; `docker desktop restart` brought it back, so real-database tests could run again.
- `uv sync` fails on this PC when it tries to remove packages in the OneDrive-synced `.venv` ("access denied"); `uv run --inexact` installs the new dependency without removing anything.
- PowerShell `Set-Content -Encoding utf8` wrote a byte order mark into `apps/api/pyproject.toml`, which the repository's text check rejects: rewritten without it (found before committing). A PowerShell replace also inserted a literal `\n` into two test files: fixed.
- The P-09 stack test counted outbox rows by a fixed user id, so a second run on the persistent Postgres volume found two: it now uses ids unique to the run.
- The 2 failures of the first full run (above).

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: Argon2id, hashed single-use links claimed atomically, no account oracle in the answer (and the same hashing time), strict body handling that never echoes a value, rate limits that fail closed, the database refusing a role for a recruiter or admin, no password, token or address in logs (tested for the password).

## Limitations and follow-ups
- No signup form or verify page (dashboards); no login yet (P-12), so a verified learner cannot do anything yet.
- Argon2id is at the minimum cost; the numbers (limits, 24 hours) are placeholders; the visitor address needs `VULNMART_TRUSTED_PROXY_HOPS=2` behind `caddy-p` (H-129, Tanmay).
- `captcha_token` is accepted and ignored. OI-29's answer is not yet in `initial.md`.
- Remind: Excel, P-11 Done = Yes; confirm story 3.1 so it can move to `done`.
