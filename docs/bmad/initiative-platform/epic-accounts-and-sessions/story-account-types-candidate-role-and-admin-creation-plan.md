---
title: 'Account types, candidate role and admin creation'
type: 'feature'
ticket: '3'
created: '2026-10-17'
status: done
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/architecture/06-security.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** Roles are only a table: nothing grants the candidate role, nothing refuses it to a recruiter or admin with a clear reason, no admin can be created at all, and there is no way to restrict a route to some roles (FR-ACC-05, FR-ACC-06, FR-ACC-11, FR-ACC-01 "a learner cannot reach recruiter or admin screens").

**Approach:** A `RoleService` (candidate role at invite acceptance; admin-only grant and revoke; every change audited), an `AdminService` (a seed command for the first admin; an admin creating another, who gets a link to choose their own password), and a `requires(...)` route dependency that answers 404 to a caller without the role. The database rule from migration 0003 stays the last line.

## Boundaries & Constraints

**Decisions (developer, 2026-10-17):** "continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0043 (Proposed) for confirmation, none of which the requirements fix: how a new admin gets credentials (the seed takes a password from the operator; an admin-created admin gets a single-use link, never a password from the creator), admin passwords at least 16 characters, the admin's address marked verified at creation, a role-gated route answers 404 (the contract's "not yours is not found"), taking a role away ends the person's sessions, the audit entry is written before the change commits.

**Always:** No route and no signup field can make an admin; an admin holds no learner or candidate role; only an active admin changes roles or creates admins (the scope and the database must agree); every grant, revoke and admin creation is appended to the audit log; the password of the seed never goes on a command line or into a log.

**Never:** No HTTP route for role changes or admin creation (the admin area is story P-28; a route needs a contract change); no second-factor login (P-15), so an admin created here cannot sign in yet; no change to account types after creation; no invite acceptance (P-21), only the function it will call.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Candidate role | participant with the learner role | both roles; audit `role.granted` (actor `system:invite`); a repeat changes nothing | n/a |
| Candidate role for a recruiter or admin | any | `RoleNotAllowed(account_type)`, nothing written, no audit | the invite route (P-21) turns it into the clear message |
| Admin grants or revokes | active admin scope | change plus audit; revoke ends the person's sessions | unknown role is ValueError |
| Anyone else tries | learner, recruiter, a scope that claims admin for a non-admin, a disabled admin | `NotAnAdmin`, nothing changes | n/a |
| Seed | email, name, password of 16 to 128 characters | admin created, verified, no role, audit `admin.created` actor `system:seed` | same address again: nothing changes, exit code 3 |
| Admin creates an admin | active admin | account with a random unknown password, a `reset` link by mail, audit actor = the creator | known address: `EmailInUse`; audit failure: nothing is left |
| Signup naming `account_type` or role | any extra field | 422, no account | n/a |
| A learner calls a recruiter or admin route | live session | 404 REQ-ROUTE-UNKNOWN, identical to a route that does not exist | n/a |
| Role taken away | session in use | the very next request is refused (roles read every request) | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/accounts/roles.py` (`RoleService`, `RoleNotAllowed`, `NotAnAdmin`, `UnknownUser`), `admins.py` (`AdminService`, `EmailInUse`), `seed_admin.py` (the command), `http.py` (`requires`).
- `notifications/templates.py` (`account.admin_created`), `main.py` (the services on `app.state.roles` and `app.state.admins`).
- Tests: `test_roles_and_admins.py`, `test_role_gates.py`, `test_accounts_postgres.py` (P-13 part); stack test `scripts/e2e/platform-stack.e2e.test.mjs`.
- `docs/runbooks/seed-admin.md`.

## Tasks & Acceptance

**Execution:**
- [x] Role service and admin service with audit entries; the seed command; the new mail type.
- [x] The `requires` dependency and its tests (a learner refused, a recruiter allowed, CSRF kept, roles read each request).
- [x] Tests: service, HTTP, real Postgres (races, the database refusal, audit failure leaves nothing), the seed command in the real container.
- [ ] (P-28 and P-21) The admin routes for role changes and admin creation; the invite acceptance that calls `grant_candidate_role` and the clear refusal message.

**Acceptance Criteria:**
- Given a participant, when the candidate role is granted, then the same login holds both roles; given a recruiter or admin, then it is refused and nothing is written, by the code and by the database.
- Given the running stack, when the seed command runs, then an admin exists with no learner role, cannot sign in yet, and a second run changes nothing; a signup naming an account type is 422.
- Given a learner session, when it calls a recruiter-only or admin-only route, then the answer is the same 404 as for a route that does not exist.

## Implementation Notes

- The audit port in a running process is the in-memory stand-in until story P-17; the seed command also logs each entry as a line because its process ends at once.
- The failure of the first real-stack run was a stale keep-alive socket in the test client after slow `docker exec` steps, not a product defect: `call` now tries once more on a closed socket.
- The "clear message" of FR-ACC-05 for a recruiter accepting an invite needs its own registry code (none exists); that is part of the contract change that comes with the invite routes (P-21).

## Plan Change Log

## Review Triage Log

### 2026-10-17, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. 1 medium, 1 low; both patched.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | A scope that says admin was trusted without asking the database | medium | patch | `NotAnAdmin` unless the account is an active admin in the database; tests with a forged scope and a disabled admin |
| 2 | A route-listing test read `app.routes` and found nothing (FastAPI wraps included routers) | low | patch | reads the generated OpenAPI paths and checks they list the included routers |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
