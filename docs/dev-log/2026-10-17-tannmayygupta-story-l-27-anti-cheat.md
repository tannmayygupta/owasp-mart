# Anti-cheat signals and held-capture review (L-27)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet |
| Status | Partly done (library detectors and review service done and tested; apps/api review service, `MilestoneStore` additions, the read-first note on ACH-01/02 and the cap-of-30 gap check are not done) |
| Report tag | attempts, scoring and integrity |

## Requirements covered
FR-ACH-03, FR-ACH-04, FR-ACH-05 (no capture words in the package), FR-ACH-06, FR-ACH-07, FR-SCR-10, D-92 (OI-38), D-94.

## Summary (plain language, 3-5 lines)
Added detectors for too-fast captures, capture right after a long idle period and similar write-ups, each returning plain facts that become flags with an explanation. Added a held-capture review service: a named reviewer accepts or rejects, the decision is audited, and nothing is ever zeroed automatically.

## Why
FR-ACH-03/04 detectors did not exist and FR-ACH-07 had no reviewer step.

## What was built
`integrity.py` (`too_fast`, `after_long_idle`, shingles and Jaccard, `similar_writeups`, `similar_across`, signals and `raise_signals`, `capture_treatment`) and `review.py` (`HeldItem`, `HeldStore` with an in-memory store, `HeldCaptureReview`, `AuditRecord`, `default_may_review`, overdue reminder). Additive `Rules` fields: `min_capture_seconds` 60, `idle_capture_seconds` 1800, `instant_capture_seconds` 5, `activity_check_mode` "hold".

## How it works
Detectors are pure. Similarity uses lower-cased word 3-gram shingles and Jaccard; a pair is flagged only strictly above 0.8, texts under 3 words never match, and different assessments are never compared. `HeldCaptureReview.decide` checks the supplied `may_review`, audits (reviewer id, decision, time, note cut at 500 characters, a note id hash), then releases (accept: counts in full) or keeps (reject: stays held at its earlier milestone, never zero). A repeated same decision adds no audit row; a different one raises `ReviewFinal`; a wrong reviewer raises `ReviewForbidden` and writes nothing. After 7 days an open held capture raises one `held_review_overdue` event; it stays open and the score is unchanged.

## Files changed
- `packages/py-attempts/src/vulnmart_attempts/integrity.py`, `review.py` - new
- `packages/py-attempts/src/vulnmart_attempts/rules.py` - additive fields
- `packages/py-attempts/tests/test_integrity.py`, `test_review.py` - new

## Decisions made
D-92 (OI-38) and D-94 as written in the plan, not confirmed beyond the developer saying to proceed. Assumptions of mine: the default `may_review` takes a `{id, role, org_id}` mapping from the platform and allows only `recruiter` and `admin` of the owning organisation; a same decision by a different reviewer is also treated as a repeat; an extra rules value `instant_capture_seconds` (5 s) defines "instantly after idle" because the plan gave no number; 1800 s is my placeholder for "long idle". All are placeholders until pilot data (OI-25).

## Tests
`uv run --locked --package vulnmart-attempts pytest packages/py-attempts/tests/test_integrity.py packages/py-attempts/tests/test_review.py -q` -> 27 passed. Full package: 350 passed. Hand-computed: a held M3 with M2 fallback on an Easy challenge shows 25, accepted shows 63; 17 of 19 shingles = 0.8947; exactly 4/5 is not flagged.

## Evidence
Terminal output above.

## Problems met and how they were fixed
None in the run. The "no auto-zero" proof is limited to what the library owns: the score function takes no flag or time input (checked by signature), and the same facts score the same with and without flags raised.

## Security notes (vulnerable parts only)
Not a vulnerable part. Write-up text is only an input and never stored or returned. A test greps the package source for proctoring words.

## Limitations and follow-ups
Not done: `apps/api/.../ingest/review.py` and the `MilestoneStore.release_held/keep_held` additions (apps/api out of scope), the read-first note on what `flags/submit.py` already covers for ACH-01/02 and the cap-of-30 / limit-hit log check, handoff rows to Akshay (`may_review`, decision box).
