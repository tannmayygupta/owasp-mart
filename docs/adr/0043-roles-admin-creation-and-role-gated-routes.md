# 0043. Roles, admin creation and role-gated routes

- **Status:** Proposed (the builder's design for the developer to confirm; the requirements fix only the outcome: admins come from another admin or a seed command, never from signup)
- **Date:** 2026-10-17
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-ACC-05, FR-ACC-06, FR-ACC-11, FR-ACC-01, D-19

## Context
Three account types exist, only participants hold the roles learner and candidate, and an admin is the most powerful account of the platform. FR-ACC-11 says how an admin must *not* be made. It does not say how the first one gets credentials, how a later one does, what happens to a person's session when a role is taken away, or what a caller without a role is told.

## Options considered
1. **Credentials of an admin created by an admin:** the creator types a password / a temporary password is mailed / a single-use link to choose one. The first two put a usable secret in the creator's hands or in an inbox.
2. **Credentials of the first admin:** a fixed default password / a seed command that takes a password from the operator or makes one.
3. **A caller without the role:** 403 with a clear text / 404 like an unknown route. The registry has no 403 for this, and 403 tells an attacker the route exists.
4. **Role taken away:** let sessions run to their timeout / end the person's sessions.
5. **Audit write order:** after the change commits / before it commits.

## Decision
- The seed command (`python -m vulnmart.accounts.seed_admin`) takes the password from an environment variable or standard input, or makes one and prints it once; at least 16 characters; never on the command line. Nothing changes if the address already has an account.
- An admin creating an admin sends no password: the account starts with a random one nobody knows and a single-use link (a `reset` token, mail `account.admin_created`) lets the new admin choose their own; the creator never sees a secret.
- Admin addresses are marked verified at creation (the creator vouches; the link proves control).
- Role-gated routes answer 404 `REQ-ROUTE-UNKNOWN`, identical to a route that does not exist (the contract's "not yours is not found" rule), after the CSRF and Origin checks for state-changing routes.
- Taking a role away ends all of that person's sessions; roles are read from the database on every request anyway, so a removed role is refused at once.
- The audit entry is appended before the change commits: a failing audit write undoes the change. The reverse failure (the entry exists, the commit failed) over-reports, which is the safe direction.
- Only an *active admin in the database* may change roles or create admins: a scope that claims admin is not enough.
- The clear refusal message for a recruiter accepting a candidate invite needs a new registry code; it belongs to the contract change of the invite routes (story P-21).

## Consequences
- An admin created here cannot sign in before the second factor (P-15) and the reset link (P-14) exist; the seeded admin cannot sign in before P-15. That is intended (FR-ACC-07) but means no admin screen can be exercised yet.
- The audit entries are lost with the process until the durable audit log exists (P-17); the seed command also logs a line for that reason.
- The operator who seeds an admin knows that admin's initial password; changing it at the first sign-in is a P-14 follow-up.
- A caller with the wrong role cannot tell a forbidden route from a missing one; support has to read the log to know which happened.

## Evidence
- PRD section 2.1, Platform roles (the Admin row) and FR-ACC-05, FR-ACC-11; architecture 06 (elevation of privilege row), read 2026-10-17.
- Real stack: the seed command inside the API container made an admin with no role and a stored Argon2id hash; a second run exited 3; the admin login answered a generic 500 and set no cookie; SQL that tried to give the admin a candidate role was refused by the foreign key (`platform-stack.e2e.test.mjs`, 18 of 18).
- Real Postgres: eight simultaneous candidate grants add the role once; six simultaneous seeds for one address make one admin; a failing audit write leaves no account, token or mail (`test_accounts_postgres.py`).
