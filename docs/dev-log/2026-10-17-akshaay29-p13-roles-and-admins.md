# Account types, candidate role and admin creation (P-13, story 3.3)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-2-akshay-5 / see the pull request |
| Status | Built and tested at service level. Not built: HTTP routes for role changes and admin creation (P-28), the invite acceptance that grants the candidate role (P-21). Story 3.3 is `built`, awaiting the developer's confirmation |
| Report tag | roles, account types, admin creation, least privilege, seed command, BMAD cycle |

## Requirements covered
FR-ACC-05 (account types, role rules, admin-only role changes, audited), FR-ACC-06 (the candidate role on the same login; the grant only), FR-ACC-11 (admins only through another admin or a seed command), FR-ACC-01 (a learner cannot reach recruiter or admin routes). Related: FR-ACC-07 (an admin cannot sign in yet), handoffs H-130 (used), H-132 (for P-14 and P-17), H-133 (for P-21 and P-28), ADR 0043.

## Summary (plain language, 3-5 lines)
The platform now enforces who can be what. A learner can gain the candidate role next to the learner role; a recruiter or admin can never hold either, and both the code and the database say so. The first admin is made by a command run on the server, later admins by another admin (who never sees their password: the new admin gets a link to choose one). No web request can create an admin. A learner calling a recruiter-only or admin-only address gets the same "not found" as for an address that does not exist.

## Why
FR-ACC-05 and 11 are the privilege-separation core of the platform (an admin is the most powerful account), and later stories (invites, companies, the admin area) all need a safe way to grant roles and to restrict routes.

## What was built
- `accounts/roles.py` (`RoleService`): `grant_candidate_role`, `grant`, `revoke`, `roles_of`; `RoleNotAllowed`, `NotAnAdmin`, `UnknownUser`. Admin actions are checked against the database, not only the scope; revoking ends the person's sessions; the audit entry is appended before the change commits.
- `accounts/admins.py` (`AdminService`): `seed_admin`, `create_admin`; admin passwords at least 16 characters; `EmailInUse`.
- `accounts/seed_admin.py`: the command `python -m vulnmart.accounts.seed_admin`; `docs/runbooks/seed-admin.md`.
- `accounts/http.py`: `requires(*roles, csrf=False)`, a dependency that answers 404 to a caller without one of the roles.
- Mail type `account.admin_created`; the two services on `app.state` for later stories.

## How it works
Granting the candidate role looks at the account: a participant gets a role row (a savepoint makes two grants at once leave one row), anyone else is refused with their account type. An admin's change first confirms in the database that the caller is an active admin, writes the audit entry, then commits. The seed makes an admin with a password the operator supplies; an admin creating an admin stores a random password nobody knows plus a one-time link mailed to the new admin. The `requires` dependency reads the roles of the live session on every request, so a removed role stops working at once.

## Files changed
- New: `apps/api/src/vulnmart/accounts/{roles,admins,seed_admin}.py`, tests `test_roles_and_admins.py`, `test_role_gates.py`, `docs/adr/0043-*.md`, `docs/runbooks/seed-admin.md`, the plan of story 3.3.
- Changed: `accounts/http.py`, `main.py`, `notifications/templates.py`, `test_notification_templates.py`, `test_accounts_postgres.py`, `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer (2026-10-17): "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0043 (Proposed) for confirmation (the requirements fix only the outcome): the seed takes the password from the operator, an admin-created admin gets a link not a password, admin passwords of 16 characters or more, an admin's address marked verified at creation, 404 for a caller without the role, taking a role away ends the person's sessions, the audit entry before the commit.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-13-roles-admins/`.
- `pytest apps/api/tests` with the two containers: **1352 passed, 0 failed, 0 skipped** (381 s, `pytest-2026-10-17.txt`).
- New tests: roles and admins (about 30: the grant and its repeat, refusal for recruiter and admin with the type, only an active admin changes roles including a forged scope and a disabled admin, revoke ends sessions, a failing audit write undoes the change, the seed and its refusals, an admin creating an admin, the seed command's exit codes and that the password is never printed or logged), role gates over HTTP (12: a learner refused with the same body as an unknown route, a recruiter allowed, CSRF and Origin first, roles read on every request, no route and no signup field can make an admin), Postgres (8 simultaneous candidate grants add one role; 6 simultaneous seeds make one admin; the database and the service both refuse a participant role for a recruiter or admin; a failing audit write leaves no account, token or mail).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **18 of 18**, including the seed command run inside the API container: an admin with an Argon2id hash and no learner role, a second run exits 3, the admin's login answers a generic 500 with no cookie and no session, a signup naming an account type is 422, and SQL that tries to give the admin a candidate role is refused by the foreign key. The first run of that new test failed (see Problems).
- `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL. `node --test` on `check-text-files`, `progress-page`, `dev` and `demo`: 70 of 70. The whole `scripts/*.test.mjs` suite was not re-run for this story.
- NOT run: a real browser; CI on GitHub (see the pull request); no HTTP route exists for the admin operations, so none was tested over HTTP.

## Evidence
`docs/assets/p-13-roles-admins/`.

## Problems met and how they were fixed
- The first real-stack run of the new admin test failed with "other side closed": the test client reused a keep-alive socket that the Next server had closed after the slow `docker exec` steps. I reproduced the stack by hand first and the product answered correctly (a clean 500 with a log line); the test helper now tries once more on a closed socket.
- A route-listing test found nothing because FastAPI wraps included routers; it now reads the generated OpenAPI paths and checks they list the included routers.
- A PowerShell replace mis-targeted once while editing a test; fixed by hand and re-checked.
- A scope that claims admin was trusted at first; a review of my own code made the service ask the database, with tests for a forged scope and a disabled admin.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: no route or request field can create an admin, an admin never receives a secret from the creator, admin actions are checked in the database, a role-gated route does not reveal that it exists, the database refuses the participant roles for other account types, and the seed password never goes on a command line, to a log or to the audit entry.

## Limitations and follow-ups
- No HTTP routes for role changes or admin creation (P-28); the invite acceptance and the clear refusal message with its new registry code (P-21): handoff H-133.
- Audit entries are in-memory until the durable log (P-17): handoff H-132. The seed command also logs each entry.
- An admin cannot sign in until the second factor (P-15) and cannot choose a password until the reset story (P-14); so no admin screen can be tried yet.
- Remind: Excel, P-13 Done = Yes; confirm story 3.3 so it can move to `done`.
