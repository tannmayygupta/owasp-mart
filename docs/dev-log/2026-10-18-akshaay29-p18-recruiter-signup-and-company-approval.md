# Recruiter signup and company approval (P-18, story 5.1)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-3-akshay-2 / see the pull request |
| Status | Built and tested at service level. Not built: any HTTP route (IF-1 has none: story 5.3, a contract change), colleague joining, terms at approval, the scope set from the session (P-19), the invite itself (P-20), a maintained disposable list. Story 5.1 is `built`, awaiting the developer's confirmation |
| Report tag | recruiter onboarding, company approval, row-level security, access control, BMAD cycle |

## Requirements covered
FR-ORG-01 (recruiter signup and states, the invite gate), FR-ORG-02 (the company, one admin approval, the queue, the written rejection reason), FR-ORG-04 (the free-email rule and disposable addresses), FR-ACC-10 (a disposable address cannot start a recruiter signup). OI-10 and OI-11 answered by the developer on 2026-10-18. Related: ADR 0048 (new), ADR 0014, handoff H-138 (new). The epic `epic-companies-and-approval` was incepted in this task (`tickets.toml`: stories 5.1, 5.2 = P-19, and 5.3, the routes).

## Summary (plain language, 3-5 lines)
A person can now sign up as a recruiter with a work email and the name of their company. The company starts as "pending" with the person as its owner; once the address is verified, one admin approval activates the company and its owner, or a written rejection explains why not. A recruiter can apply again after a rejection at any time. Only a recruiter whose company is active passes the check that invites will use. Temporary email addresses cannot start a recruiter signup; free webmail can.

## Why
Recruiters and companies were missing entirely: no signup, no company table in use, no approval. Invites (P-20, P-21) and the recruiter dashboards need an approved company. The admin queue also forced a decision about how an admin may read across companies without weakening the company wall.

## What was built
- `orgs/service.py` (`CompanyService`): `signup_recruiter`, `standing`, `active_company_of`, `pending`, `approve`, `reject`, `suspend`, `reinstate`, `reapply`, and `recruiter_state` (the derived state machine). `orgs/disposable.py` and `data/disposable-domains.txt` (75 domains from memory).
- `kernel/db.py`: `org_scoped(admin_visible=..., self_column=...)`, `ORG_ADMIN_VISIBLE`, `ORG_SELF_VISIBLE`, the settings `vulnmart.admin` and `vulnmart.user_id`, and the guard rule for both. Migration 0008: policies `admin_read` (on `organizations`) and `own_membership` (on `org_members`), both read-only.
- `accounts/service.py`: `signup_account` (the signup with two hooks; `signup` calls it); `accounts/directory.py` (`UserDirectory`); `accounts/roles.py` (`require_admin`); `main.py` (`app.state.companies`).
- ADR 0048 (Proposed); handoff H-138; the epic breakdown and the plan of story 5.1.

## How it works
Signup runs the account signup with a hook that refuses a disposable address and a hook that creates the company, the owner membership and the audit entry in the same transaction; the new company is put in scope for the whole call so the row-level security accepts the insert. The recruiter's state is computed from the account and the company, so there is nothing to keep in step. An admin's decision runs with the one company being decided in scope, as a conditional update (`WHERE status = ...`), so two admins at once leave one decision; the audit entry and the outcome mail are written in the same transaction. The queue is the only cross-company read: an admin scope with no company reads `organizations` through the `admin_read` policy.

## Files changed
- New: `orgs/{service,disposable}.py`, `orgs/data/disposable-domains.txt`, `accounts/directory.py`, `migrations/versions/0008_admin_reads_company_directory.py`, tests `test_companies.py`, `test_companies_postgres.py`, `docs/adr/0048-*.md`, the plan of story 5.1, `tickets.toml` of the epic.
- Changed: `kernel/db.py`, `orgs/models.py`, `accounts/{service,roles}.py`, `main.py`, `scripts/e2e/platform-stack.e2e.test.mjs` (the new test, and the P-17 test made safe to run twice on one dev volume), `docs/architecture/04-data-and-state.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: OI-10 (2026-10-18): free webmail allowed with no extra check, disposable stays blocked; OI-11: a rejected company may apply again at any time; earlier "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0048 (Proposed) for confirmation: the two read-only policies, the recruiter state derived from the company, the starter disposable list, service level now with the routes as story 5.3.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-18-companies/`.
- New tests: `test_companies.py` 50 (on SQLite with the real scoped session: signup, free and disposable addresses, bad input, every state, the queue, decisions made once, suspend and reinstate, re-applying three rounds, what the guard allows an admin and a member), `test_companies_postgres.py` 13 (as the application role: both policies and their limits, a company sees only itself, a person reads only their own membership, an admin reads but cannot write or insert, the service through row-level security, 8 simultaneous signups make one account and one company, 8 admins deciding at once leave one decision and one mail, migration 0008 down and up).
- First full run (`pytest-first-run-2-failed-migration-head-2026-10-18.txt`): 2 failed, 2087 passed: the two assertions that name the migration head (`test_kernel_settings.py`, `test_kernel_postgres.py`) still said 0007; updated, as every migration requires. Second full run (`pytest-second-run-1-failed-flaky-queue-order-2026-10-18.txt`): 1 failed, 2088 passed: a flaky test of mine: the queue test relied on the service clock but the company's `created_at` came from SQLite's own clock, which ticks once a second, so two companies made in one second were ordered by their random ids; the service now sets `created_at` from its clock, and the unit tests passed 15 times in a row.
- Final full run with the two containers: **2089 passed, 0 failed, 1 skipped** (437 s, `pytest-2026-10-18.txt`; the one skip is a Windows file-mode check in the lab tests).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **23 of 23** on the final code (`platform-stack-e2e-2026-10-18.txt`), after `docker compose ... build api`. The first run after adding the P-18 test was 22 of 23: the test of story P-17 failed because it counted every earlier run's shredded attempt on the persistent dev volume; it now looks at its own attempt and the run passed twice in a row. The P-18 test drives the service inside the API container as the application database role (so the row-level security of migration 0008 is exercised on the real stack, on a volume that already held 0007): a disposable address is refused and creates nothing, a recruiter signs up, the verification mail arrives and its link verifies through the existing route, the standing goes unverified, pending, active, the invite gate refuses it until the approval, the queue lists the company with the owner's name and the domain (no address), the approval activates it and the approval mail arrives, a second decision is refused, the audit entries are under pseudonyms.
- `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL, 1 not applicable (`contract-rules-2026-10-18.txt`). The text-hygiene, progress-page, dev and demo script tests: 70 of 70.
- NOT run: a browser or any route (none exists); anything on the VMs; CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-18-companies/`: the test outputs.

## Problems met and how they were fixed
- My own test expected the guard to refuse an admin reading `org_members`; the self-visible rule gives an admin only their own rows (none). The rule is what I designed, the expectation was wrong; the test now says what the rule does.
- The P-17 stack test was not safe to run twice on one volume (see Tests); fixed.
- A flaky test of mine and two stale migration-head assertions (see Tests).
- Two slips in my scripted edits: Python mixed into a PowerShell script (nothing ran) and a literal backslash-n in the migration docstring; both repaired with precise edits before any run.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: the company wall (ADR 0014) now has two documented read-only exceptions, each opted in per table and mirrored in the database policy, with tests that say what they do not allow (an admin cannot write or read members; a person cannot read anyone else's membership); decisions are conditional updates; the audit entry carries no reason text; the queue carries no address; a known address and a new one are answered alike; a disposable-domain list from memory is weak and is declared weak.

## Limitations and follow-ups
- No HTTP route, so nobody can sign up as a recruiter over HTTP yet: story 5.3 (a contract change, H-138).
- A recruiter has one company; two recruiters of one domain each start their own until P-19. The terms at approval, the invite cap and the scope from the session are P-19. The invite gate is a function that P-20 calls.
- With no check on free webmail, no waiting period and nothing that ties the domain to the company name, the single admin approval is the only gate against fake recruiters (the developer's choice for OI-10 and OI-11).
- The disposable-domain list is a starter list; replace it with a maintained one.
- OI-10, OI-11, OI-28 and OI-37 are answered but not yet in `initial.md`. ADRs 0040 to 0048 are Proposed.
- Remind: Excel, P-18 Done = Yes; confirm story 5.1 so it can move to `done`.
