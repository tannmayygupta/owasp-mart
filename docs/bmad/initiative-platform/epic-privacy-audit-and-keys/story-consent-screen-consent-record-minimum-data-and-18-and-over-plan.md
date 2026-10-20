---
title: 'Consent screen, consent record, minimum data and 18-and-over'
type: 'feature'
ticket: '1'
created: '2026-10-18'
status: done
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/contracts/api/platform/platform.openapi.yaml'
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** A candidate can be sent to an assessment with nothing recording that they were told what is collected and agreed (FR-PRV-01, FR-PRV-02); nothing proves that the platform stores only the minimum (FR-PRV-03); the 18-and-over declaration of FR-PRV-13 is stored since P-09 but is not tied to the requirement by a test.

**Approach:** The routes `getConsentNotice`, `recordConsent` and `listMyConsents` of IF-1 (already in the contract, no contract change): a versioned plain-language notice rendered per attempt (company and retention filled in) with its SHA-256; an append-only `consent_records` table written once per decision, holding the version, the exact text shown and its hash, the retention and company shown, keyed hashes of the address and browser, the method and the audit sequence number; a stale text is refused; a small port (`ConsentTargets`) for the invite and attempt side that story P-21 will implement; a test that fails when a person-data table gets a column the inventory does not list.

## Boundaries & Constraints

**Decisions (developer, 2026-10-18):** OI-37 answered: the short consent record is kept for the assessment retention plus 12 months (the research proposal; the PRD marks it for lawyer review, which is still pending). It is the setting `consent_record_extra_months` (12) and the notice says it; the purge that uses it is story P-24. Earlier: "continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0046 (Proposed) for confirmation: no foreign keys from the record (it must outlive the account), one granted-or-declined decision per attempt by a partial unique index and an advisory lock, a repeated request with the same decision returns the same record and finishes the move, the notice text is pinned to its version by a hash (a changed text without a new version is a start-up error), `ConsentTargets` as P's own port instead of changing stream L's `AttemptPort`.

**Always:** The person decides on their own attempt only (someone else's is 404); the attempt must be in state `consent`; the request repeats the version and hash of the text shown and a mismatch is 409 ATT-CONSENT-STALE; the agree box is not pre-ticked (the browser sends `granted` only after a click: not testable here, it is a page); the record is never updated or deleted by the application role; the address and browser are stored only as keyed hashes; the audit entry is written before the transaction commits and its sequence number is in the record; no email address, name or raw address in the audit details or the record's identifying columns.

**Never:** No withdrawal (story P-25: it adds the value `withdrawn`, the table already allows it); no consent page (dashboards work); no change to the attempt port (handoff H-136 to stream L); no purge of old records (P-24); no legal claim in the notice beyond the PRD's own list, and its wording is a draft until a lawyer reviews it (OI-33).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Read the notice | own attempt in state consent | 200 `{attempt_id, notice_version, notice_text, notice_text_sha256, retention_days_shown, company_name}`, no-store | not own or unknown: 404 ATT-NOT-FOUND; not in state consent: 409 ATT-INVALID-STATE; bad id: 422 |
| Grant | notice version and hash as shown | 201 record; attempt moves to `ready`; one row, one audit entry | stale: 409 ATT-CONSENT-STALE, nothing written |
| Decline | same | 201 record with `declined`; attempt ends | same |
| Same decision again (a retry) | record exists | 201 with the same record; the attempt is moved if it was not yet | no second row, no second audit entry |
| Opposite decision | record exists | 409 ATT-INVALID-STATE | nothing written |
| Two clicks at once | 8 simultaneous requests | exactly one row and one audit entry | the losers get the same record or 409 |
| Failure between record and move | the attempt service is down | 500; the record stays | repeating the request finishes the move |
| List | own records | newest first, `has_more` | limit outside 1..100: 422 |
| Change or delete a record | the application database role | refused by the database | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/privacy/notice.py` and `data/consent-notice.txt` (the text, pinned by version and hash), `consent.py` (`ConsentService`), `api.py` (the three routes), `targets.py` (`ConsentTargets`, `FakeConsentTargets`), `models.py` (`ConsentRecord`), `migrations/versions/0006_consent_records.py` (single head 0006).
- `accounts/fieldkeys.py` (`context_hash`), `ports/settings.py` (`consent_record_extra_months`, `rate_consent_per_user_per_hour`), `main.py` (service, router, `consent=` and `consent_targets=` parameters), `docs/architecture/04-data-and-state.md` (`attempt_id` added to `consent_records`).
- Tests: `test_consent.py`, `test_data_minimum.py`, `test_privacy_postgres.py`; stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] The notice (text, markers, hash, version pin), the model and migration, the service, the routes, the wiring.
- [x] `ConsentTargets` with an in-memory fake (the real one: story P-21).
- [x] Tests: notice, service, HTTP, Postgres (append-only, one decision, race), data minimum; the real-stack test.

**Acceptance Criteria:**
- Given a candidate with an attempt in state consent, when they grant or decline, then exactly one consent record is stored with the text shown and its hash, and the attempt moves on only after that.
- Given a stale hash, then nothing is written and the answer is 409 ATT-CONSENT-STALE.
- Given the application database role, then a record cannot be updated, deleted or truncated.
- Given a new column on a table that holds data about a person, then a test fails until the inventory is updated.

## Implementation Notes

- The attempt in state `consent` does not exist yet (invites are P-20 and P-21) and the attempt port can only create an attempt already `ready`. The routes are therefore built and tested against `FakeConsentTargets`; the running API uses an empty fake, so every attempt id is answered 404 until P-21. "A new user cannot proceed without consent" holds at the service level (the attempt moves on only through `proceed` after a stored decision) and becomes end to end with P-21.
- The contract says a decline ends the attempt in state `cancelled`; architecture 04 section 10.1 says `withdrawn`; the attempt port can cancel only from `ready` or `running`. Not mine to decide: handoff H-136 asks stream L and the contract owner.

## Plan Change Log

## Review Triage Log

### 2026-10-18, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. Things that actually went wrong while building (no defect of the product behaviour on Postgres was found by this pass): findings 1 and 2 were noticed while writing the SQLite-based tests, before any run; finding 3 was found by a failing test.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The service called `pg_advisory_xact_lock`, which SQLite (the fast tests) does not have | low | patch | taken only on Postgres; the race is proved in `test_privacy_postgres.py` |
| 2 | The partial unique index was a full unique index on SQLite, so a later withdrawal row would have clashed there | low | patch | `sqlite_where` added beside `postgresql_where` |
| 3 | A repeated grant returned a naive time from SQLite and an aware time the first time | low | patch | `_view` makes the time aware |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
