# Consent screen, consent record, minimum data and 18-and-over (P-16, story 4.1)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-2-akshay-8 / see the pull request |
| Status | Built and tested at API level. Not built: the consent page, withdrawal (P-25), the purge of expired records (P-24); no attempt in state consent exists until P-21. Story 4.1 is `built`, awaiting the developer's confirmation |
| Report tag | privacy, consent, GDPR/DPDP, append-only records, data minimisation, BMAD cycle |

## Requirements covered
FR-PRV-01 (the consent notice), FR-PRV-02 (the append-only consent record, for grant and decline), FR-PRV-03 (minimum data, as a test), FR-PRV-13 (18 and over, tied to the requirement by tests). OI-37 answered by the developer on 2026-10-18 (assessment retention plus 12 months). Related: handoff H-136 (new), ADR 0046, the epic `epic-privacy-audit-and-keys` incepted in this task (`tickets.toml`, four stories: P-16, P-17, P-24, P-25).

## Summary (plain language, 3-5 lines)
A candidate can now be shown a plain-language notice of what is recorded, what is not, who sees it and how long it is kept, with the company that decides named. Their decision (start or decline) is stored once, forever, with the exact text they saw, and the database itself refuses to change or delete it. A screen that shows old text is refused. A test now fails whenever someone adds a column about a person that the data inventory does not list.

## Why
FR-PRV-01 and 02 are the legal basis for processing a candidate's data; the invite flow (P-21) cannot start an assessment without them. FR-PRV-03 and 13 were stated but not checked by anything.

## What was built
- `privacy/notice.py` and `data/consent-notice.txt`: the notice, three markers filled per attempt (company, retention days, months the short record is kept), the SHA-256 of the exact text, and a pin of the text's hash to its version (a changed text without a new version cannot start).
- `privacy/consent.py` (`ConsentService`) and `privacy/api.py`: `getConsentNotice`, `recordConsent`, `listMyConsents` of IF-1 (already in the contract; no contract change). One decision per attempt under an advisory lock; a stale hash is 409 ATT-CONSENT-STALE; the audit entry is written before the commit and its number stored; a repeat of the same decision returns the same record and finishes moving the attempt.
- `privacy/models.py` and migration 0006: `consent_records`, append-only for the application role (SELECT and INSERT), no foreign keys, partial unique index for one granted-or-declined decision per attempt.
- `privacy/targets.py`: `ConsentTargets` (`find`, `proceed`) and an in-memory fake: the shape P needs from the invite and attempt side (story P-21).
- `accounts/fieldkeys.py`: `context_hash` (keyed hash of address and browser); settings `consent_record_extra_months` (12) and `rate_consent_per_user_per_hour` (30, placeholder).
- Epic inception: `docs/bmad/initiative-platform/epic-privacy-audit-and-keys/tickets.toml` (stories 4.1 to 4.4) and the plan of story 4.1.

## How it works
The notice is rendered for an attempt from the file and the settings and hashed. The browser sends the version and hash back with the decision. The service checks that the attempt is the caller's and in state `consent`, takes a lock on the attempt, looks for an earlier decision (same decision: return it; the opposite: conflict), compares the hash with the one the server renders now, appends an audit entry, inserts the row and commits; only then does it tell the attempt side to move on. If that last step fails, the record stays and repeating the request finishes it.

## Files changed
- New: `apps/api/src/vulnmart/privacy/{notice,consent,api,targets,models}.py`, `privacy/data/consent-notice.txt`, `migrations/versions/0006_consent_records.py`, tests `test_consent.py`, `test_data_minimum.py`, `test_privacy_postgres.py`, `docs/adr/0046-*.md`, the plan of story 4.1, `tickets.toml` of the epic.
- Changed: `accounts/fieldkeys.py`, `ports/settings.py`, `main.py`, `migrations/env.py`, `test_kernel_settings.py` and `test_kernel_postgres.py` (head 0006, the new table), `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/architecture/04-data-and-state.md` (`attempt_id` in `consent_records`), `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: OI-37 (2026-10-18): the short record is kept for the assessment retention plus 12 months; earlier "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0046 (Proposed) for confirmation: privilege-based append-only, no foreign keys, one decision per attempt (index plus lock), hash-based staleness, the text pinned to its version, `ConsentTargets` as P's own port instead of changing stream L's `AttemptPort`.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-16-consent/`.
- New tests: `test_consent.py` 62 (notice, service, routes), `test_data_minimum.py` 14, `test_privacy_postgres.py` 10 (the application role cannot update, delete or truncate; one decision per attempt; a withdrawal row may follow; 8 simultaneous grants write one record, one audit entry, one move; a grant and a decline at once leave one winner; the record outlives its user; migration 0006 down and up).
- First full run of `pytest apps/api/tests` (`pytest-first-run-docker-engine-died-2026-10-18.txt`): **3 failed, 1866 passed, 15 errors**: Docker Desktop's engine died during the run (the same thing happened in P-15), so every test that needed Postgres or Valkey after that point timed out on its connection (two Valkey rate-limit tests failed by name; the Postgres tests errored at setup with connection timeouts, among them several of my own that had passed when run alone; I did not identify the third failure from the saved output). That run says nothing about the code; I restarted Docker and the containers and ran the whole suite again.
- Second full run, after the restart (`pytest-second-run-1-failed-route-list-2026-10-18.txt`): **1 failed, 1883 passed, 1 skipped**: `test_role_gates.py` lists every state-changing route of the app and rightly failed on the new `/api/v1/consent`; I added it to the list and re-ran that file with `test_contract.py` (74 passed).
- Final full run, with the two containers: **1884 passed, 0 failed, 1 skipped** (432 s, `pytest-2026-10-18.txt`; the one skip is a Windows file-mode check in the lab tests).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **21 of 21** (`platform-stack-e2e-2026-10-18.txt`; the first run was 20 of 21 because the API image was still the one built before this story, so the consent routes answered 404: `platform-stack-e2e-stale-image-1-failed-2026-10-18.txt` keeps it; after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api` the run passed). The new test goes through the web proxy: the three routes are 401 without a session, 403 without CSRF or from another origin, 404 for an attempt that does not exist, 422 for a malformed id or limit, the list is empty; and in the real database the application role has exactly INSERT and SELECT on `consent_records` and `UPDATE`, `DELETE` and `TRUNCATE` as that role fail with "permission denied". Migration 0006 was applied on top of the existing dev volume (0005), which also shows the upgrade path.
- `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL (1 not applicable) in three of four runs (`contract-rules-2026-10-18.txt`); the first run, made while the full test suite was running, printed 2 FAIL and I did not capture which rules; three later runs, one of them also under load, showed none and I could not reproduce it. The text-hygiene, progress-page, dev and demo script tests: 70 of 70.
- NOT run: a real browser; a consent page (does not exist); the whole `scripts/*.test.mjs` suite; CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-16-consent/`: the test outputs, the contract rules output, and `notice-sample.txt`, the notice as rendered for a sample company with its hash (draft wording).

## Problems met and how they were fixed
- The service used `pg_advisory_xact_lock`, which the SQLite databases of the fast tests do not have, and a partial unique index that SQLite would have made a full one; I noticed both while writing the tests (before any run) and made the lock Postgres-only and added the SQLite form of the index; the real race is proved on Postgres.
- One test failed on a time that came back naive from SQLite and aware the first time; `_view` now makes it aware.
- I damaged an import line of `main.py` with a careless text replacement and repaired it with a precise edit before any run.
- Docker Desktop died during the first full run (see Tests).
- The route-list test failed on the new route (see Tests); the end-to-end test failed once on a stale API image (see Tests): the stack test does not rebuild the image, so after changing API code run the compose `build api` command first.
- A wrong working directory: one `cd` into `apps/api` persisted into later commands; I went back and used absolute paths afterwards.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: the record cannot be changed through the application (privilege, tested on real Postgres and the real stack), the text a person agreed to is stored with its hash, the address and browser are stored only as keyed hashes (never the values, tested), a person can decide only on their own attempt (someone else's is 404), the decision needs the session, CSRF and the dashboard origin, no email address, name or raw address in the audit details (tested).

## Limitations and follow-ups
- There is no consent page, and no attempt in state consent exists until the invite flow (P-21): the running API answers 404 for every attempt id. "A new user cannot proceed without consent" is true at the service level (the attempt moves on only after a stored decision) and becomes end to end with P-21.
- The contract, architecture 04 and the attempt port disagree about where a decline ends the attempt, and the port has no step out of `consent` (H-136).
- Shrinking an expired record to hash and version and replacing `user_id` by a pseudonym are UPDATEs the application role cannot do: P-24 and P-25 must decide (H-136, ADR 0046).
- The notice wording is a draft no lawyer has reviewed (OI-33); OI-37 is answered but not yet in `initial.md`.
- The audit entry is in the in-memory stand-in until P-17.
- Remind: Excel, P-16 Done = Yes; confirm story 4.1 so it can move to `done`.
