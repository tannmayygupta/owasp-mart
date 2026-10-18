# 0046. Append-only consent record, a notice text pinned to its version, and a ConsentTargets port

- **Status:** Proposed (the builder's design for the developer to confirm; the requirements fix the outcome, OI-37 was answered by the developer on 2026-10-18)
- **Date:** 2026-10-18
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-PRV-01, FR-PRV-02, FR-PRV-03, FR-PRV-13, OI-37, OI-33, D-12, D-25

## Context
FR-PRV-02 asks for an append-only record of every grant, decline and withdrawal that holds the notice version, a snapshot and hash of the text shown, the retention and company shown, hashed address and browser, the method and a link into the audit chain. The contract (IF-1) fixes three routes. It does not say how "append-only" is enforced, what happens to the record when the account is deleted, how a stale screen is detected, how two simultaneous clicks are handled, or where the attempt in state `consent` comes from (invites do not exist yet, and the attempt port of stream L can only create an attempt already `ready`).

## Options considered
1. **Append-only:** a convention in code / the application database role has no UPDATE, DELETE or TRUNCATE right on the table / a trigger that refuses changes.
2. **Account deletion:** a foreign key with a cascade (the proof disappears with the account) / no foreign key (the row stays; the deletion workflow replaces the identity with a pseudonym).
3. **One decision per attempt:** check in code only / a partial unique index / an advisory lock plus the index.
4. **Stale text:** compare versions only / compare the hash of the exact text the server renders now (company and retention filled in).
5. **Changing the text:** edit the file freely / pin the file's hash to its version so that a changed text without a new version cannot start.
6. **Attempt side:** change stream L's `AttemptPort` / wait for P-21 / a small port of our own with an in-memory fake.

## Decision
- The application role has SELECT and INSERT on `consent_records` and nothing else, so the database refuses a change, a delete and a truncate (tested on Postgres as that role). Triggers were not added: the privilege is the simpler guard, and the table owner is the migration role, which the API does not use.
- There are no foreign keys from the record to `users`, `attempts` or the company table. The record is the proof that a person was asked; it outlives the account. Story P-25 replaces the identity behind `user_id` with a pseudonym (the `subject_map`), it does not delete the row.
- One granted-or-declined decision per attempt: a partial unique index is the backstop and a transaction-scoped advisory lock on the attempt serialises the check, the audit entry and the insert. A repeat of the same decision returns the existing record (and finishes moving the attempt, so a failure between the two steps heals when the request is repeated); the opposite decision is 409. A withdrawal (P-25) is a later row and is allowed by the index.
- The request repeats the version and the SHA-256 of the text shown. The server renders the notice for that attempt now (the company name and the retention days are filled in) and a different hash is 409 ATT-CONSENT-STALE. The record stores the rendered text as it was shown.
- `data/consent-notice.txt` is pinned: `TEMPLATE_HASHES` maps each version to the hash of the file's text, and the service refuses to start when they differ. Changing the wording needs a new version line (the old line stays so old records stay explainable). The wording is a draft that no lawyer has reviewed (OI-33).
- The address and the browser string are stored only as HMAC-SHA256 under a third key derived from the field secret (a copy of the table cannot be reversed by hashing every IPv4 address); the browser string is cut at 300 characters first; a missing value is stored as nothing.
- The audit entry is appended before the transaction commits and its sequence number is stored. The audit log is still the in-memory stand-in until story P-17, so the number links to nothing durable yet.
- `ConsentTargets` (`find`, `proceed`) is the shape P needs from the invite and attempt side. `FakeConsentTargets` is the stand-in; the running API uses an empty one (every attempt id is 404) until P-21 implements the real one and stream L is asked for the step out of `consent` (handoff H-136).
- The short record is kept for the assessment retention plus 12 months (OI-37, the developer's answer); this is the setting `consent_record_extra_months` and the notice states it. The purge that applies it belongs to P-24.

## Consequences
- The notice cannot be changed silently, and what a person agreed to is provable from the row alone.
- A record can never be corrected, even a wrong one; a correction is a new row. That is the point of the requirement.
- The same privilege rule means the application cannot later shrink an expired record to its hash and version (PRD section 9) or replace `user_id` by a pseudonym either: both are UPDATEs. Stories P-24 and P-25 must choose a separate privileged role or a migration-owned function (handoff H-136). This ADR does not decide it.
- Because there is no foreign key, a mistyped `user_id` would not be caught by the database; the service takes it from the session.
- Until P-21, the consent routes can only be exercised with the fake; "a new user cannot proceed without consent" is true at the service level and becomes end to end then.
- The contract says a decline ends the attempt in state `cancelled`, architecture 04 section 10.1 says `withdrawn`, and the attempt port can cancel only from `ready` or `running`. The inconsistency is not resolved here (handoff H-136).

## Evidence
- `test_consent.py` (notice, service and routes on SQLite), `test_privacy_postgres.py` (the app role cannot update, delete or truncate; one decision per attempt; eight simultaneous grants write one record, one audit entry and one move; migration 0006 down and up), `test_data_minimum.py`.
- GDPR, DPDP and the lawyer's view on whether a self-declared age and this wording are enough: **not read and not verified** (OI-33 is open; all statements in the PRD are secondary). The retention of the short record (OI-37) is marked [LAWYER] in the PRD and has not been reviewed.
