# 0057. Admin operations: admin-only routes, a real quota port, and setting ranges

- **Status:** Proposed (the builder's design for the developer to confirm; the quota and cap numbers are placeholders, OI-21)
- **Date:** 2026-10-20
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-ADM-01, FR-ADM-02, FR-ADM-04, FR-ADM-05, FR-ADM-06, FR-ADM-08, FR-ACC-07, FR-ACC-11, FR-PRV-18, OI-21, ADR 0054, 0055
- **Handoffs:** H-150

## Context
The company approval, account status, role and settings services existed without routes (P-13, P-18, P-19), the quota port was an in-memory stub (so a quota could not be set or enforced), and the scheduler's status had no reader (P-24). The admin area needs the queue, user management, force-stop, settings and quotas, capacity and the jobs, each audited, without letting an admin read what a candidate wrote. Questions: who may call it, how an instance is named, what "delete a user" means for each account type, how settings are bounded, where the company and platform caps live, and how errors are named.

## Options considered
1. **Gate:** a new admin check per route / `requires(Role.ADMIN)` in front and `RoleService.require_admin` again in the service.
2. **Instance handle:** the instance id / the attempt id.
3. **Delete a participant:** delete the row / the deletion service's steps (attempts erased, pseudonym forgotten), locked instead when assessment data exists.
4. **Caps:** columns in `quotas` / two settings.
5. **Errors:** a new admin family / the existing `REQ-ROUTE-UNKNOWN`, `ATT-INVALID-STATE`, `REQ-VALIDATION`.

## Decision
- **Gate:** every route uses `requires(Role.ADMIN)` (read) or `requires(Role.ADMIN, csrf=True)` (change). The session carries the admin role only after the second factor (FR-ACC-07), so a learner, a recruiter and an admin without a second factor get 404 `REQ-ROUTE-UNKNOWN`, the answer of a route that does not exist. Every service method checks again against the database (`RoleService.require_admin`: an account that stopped being an active admin is refused even with a live session).
- **`AdminOps`** (`admin/ops.py`): the queue and decisions go through `CompanyService` (which audits and mails the outcome); `users` searches name, address or id and never returns a hash; `act_on_user` locks (disabled, sessions end), unlocks, mails a reset link to the account's own address (an admin never sees or sets a password) or deletes: a participant through `DeletionService.delete_learner_account` (practice attempts erased by the lab, account and pseudonym gone; an account with assessment data is locked instead, `locked_instead`, as in ADR 0054), a recruiter marked deleted with its sessions ended; an admin account, and the admin's own, are never changed here (409). `reason` is required for lock, unlock and delete and never copied into the audit log.
- **Force-stop** names the **attempt** (what the admin screens show; the instance id is the lab's) and calls `LabRuntime.force_stop`, which destroys the instance whatever the attempt's state; the attempt keeps its state and clock; the owner gets the mail `instance.force_stopped` (FR-ADM-04). Without a lab in the process the route answers 500 instead of pretending.
- **Settings:** `DbSettingsPort` gets `set`, `clear` and `overrides` (the type of the default is enforced); `AdminOps` adds ranges: the candidate retention default is 30 to 365 days (FR-ADM-05), the audit log's at least 12 months, the undo window 1 to 30 days, and other numbers 0 to 1,000,000. Old and new value are audited; the row keeps the admin's pseudonym.
- **Quotas:** `DbQuotaPort` (`kernel/quota.py`) replaces the stub in `build_ports` whenever there is a database: a user's row beats a company's, which beats the global one, else one instance (FR-INS-06); the company cap and the platform cap are the new settings `instance_company_cap` (5) and `instance_total_cap` (20), placeholders until OI-21. Every read is at request time, so a change is enforced by the next request without a restart.
- **Capacity:** running and reported instances and failures from the lab (the host status and the state reports), mails waiting and failed, events not yet relayed, failed jobs; counts and states only (FR-ADM-06, FR-ADM-08). **Jobs:** `Scheduler.status()` (FR-PRV-18).
- **Errors:** no new codes: an unknown company, account, attempt, setting or quota is 404 `REQ-ROUTE-UNKNOWN` (the same answer as for a non-admin), a change that does not start from its state is 409 `ATT-INVALID-STATE`, a value outside its range 422 `REQ-VALIDATION`.
- **IF-1:** 13 operations under `/api/v1/admin/` with the tag `admin`.

## Consequences
- What an admin sets is enforced: the lab's quota checks read the table.
- The admin routes have no rate limit of their own (only admins reach them; OI-29 asked for rate limits on the public surface).
- An admin sees account data (name, address, type, status, roles) of everyone; it never sees answers, write-ups or evidence (break-glass is P-31).
- The error titles of `ATT-INVALID-STATE` and `REQ-ROUTE-UNKNOWN` speak of attempts and routes; a dedicated admin family is the cleaner design if the developer wants one.
- Force-stop works only where the lab runs in the API process (today's Compose stack has no lab in the API, so it is not exercised there).

## Evidence
- `test_admin_ops.py` (42), `test_admin_api.py` (46), `test_admin_postgres.py` (4); the real stack: see the dev-log.
- **Not verified:** the quota and cap numbers (OI-21); force-stop against a real orchestrator.
