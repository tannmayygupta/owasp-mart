---
title: 'Anti-cheat signals and held-capture review (L-27)'
type: 'feature'
ticket: '6'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/prd/PRD.md', '{project-root}/docs/design/challenge-specs.md']
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** Detection already exists in part: the flag submit service limits wrong submissions and the milestone engine holds an inconsistent capture (stories 6.1 to 6.3, 7.x), and `MilestoneStore.hold` marks it. Missing: the timing-anomaly and write-up similarity detectors (FR-ACH-03, 04), a named reviewer who accepts or rejects a held capture with an audited note (FR-ACH-07, FR-SCR-10), and proof that no signal ever zeroes or fails a candidate (FR-ACH-06).

**Approach:** First read `apps/api/src/vulnmart/flags/submit.py` and `ingest/engine.py` and list in the dev-log what ACH-01 (5 wrong per 10 minutes, 10-minute lock, cap 30 per challenge per assessment, limit hit logged) and ACH-02 already do; add only what is missing (the cap of 30 and the log line, if absent). New pure detectors in `packages/py-attempts/src/vulnmart_attempts/integrity.py` (standard library only): `too_fast(capture_s, minimum_s)` and `after_long_idle(idle_s, limit_s)` for FR-ACH-03 with the minimum from a rules value (placeholder 60 s until pilot data, OI-25), and `similar_writeups(texts: Mapping[attempt_id, str], threshold)` using word 3-gram shingles and Jaccard similarity (no dependency), pairs above 0.8 within one assessment, returning ids and a score only. Each detector returns plain facts; the engine side turns them into `IntegritySink.add(attempt_id, kind, explanation, dedupe_key)` with a plain-language explanation. Review service in `apps/api/src/vulnmart/ingest/review.py`: `HeldCaptureReview(milestones, audit, clock, may_review)`; `held(attempt_id)` lists held captures with the evidence ids; `decide(attempt_id, challenge_key, reviewer, decision in {accept, reject}, note)` checks `may_review(reviewer, attempt_id)`, writes an `AuditPort` record (reviewer id, decision, time, note id, never the note text beyond 500 characters of the recruiter's own words, never a flag), and calls the new additive `MilestoneStore.release_held(attempt_id, key)` (accept: the held milestone counts, the score is recomputed from facts, D-87) or `keep_held(attempt_id, key)` (reject: it stays excluded; nobody is zeroed). A decision is final once recorded and idempotent for the same reviewer and decision.

**Proposed (decided on the developer's delegation):**
- **D-92 (OI-38):** the reviewer of a held capture is the recruiter of the organisation that owns the assessment, and an organisation Admin may review as well; nobody outside the organisation. There is no hard deadline that changes a score: after 7 days an open held capture raises a reminder event (`held_review_overdue`, ids only) and the attempt stays `submitted` (D-88). Who may review is a function `may_review` supplied by the platform (RBAC is Akshay's); the library default allows `recruiter` and `admin` of the same `org_id` only.
- **D-94:** only the activity-versus-capture check (FR-ACH-02) holds a capture; submission limit hits, timing anomalies, decoy use and similarity are flags only (evidence for a human, shown with a plain explanation), because the PRD says timing numbers come from pilot data and an anomaly must not reduce a score before then. A noisy check is switched from hold to flag-only by one rules value `activity_check_mode` (`hold` or `flag`). No signal changes a score; a test proves it by computing the score with and without flags.

## Boundaries & Constraints

**Always:** a flag has a plain-language explanation and a dedupe key (one flag per cause); the reviewer, decision and time are audited; integrity data holds ids, kinds and numbers, never pasted flags, write-up text or personal data (the write-up text is an input to the function only, never stored or logged by it); a held capture stays out of the score until accepted and is never turned into a zero; the review needs an authenticated reviewer id from the platform (the library trusts the caller's `may_review`, it does not do login).

**Never:** auto-reject, auto-zero or auto-fail; webcam, microphone, screen, tab, paste or ID capture (FR-ACH-05: none exists and a test greps the package for those words); a new dependency; contracts, error codes; editing `apps/api` outside `ingest`, `ports` and `tests`; a real database; the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Too fast | capture 20 s after ready, minimum 60 | flag `timing`, explanation, score unchanged | none |
| Instant after idle | 40 min idle then capture in 2 s | flag `timing` | none |
| Similar write-ups | two attempts of one assessment, 3-gram Jaccard 0.9 | one `similarity` flag per pair, ids only | none |
| Different assessments | same texts, different `assessment_id` | no flag | none |
| Held capture | inconsistent evidence | held, excluded from score, `held` true in result | none |
| Accept | recruiter of the org | counts again, score recomputed, audit row | none |
| Reject | recruiter | stays excluded, audit row, attempt not zeroed | none |
| Wrong reviewer | other org or learner | refused, no audit row of a decision | `ReviewForbidden` |
| Repeat decision | same reviewer, same decision | no second audit row | none |
| Conflicting repeat | accept after reject | refused (final) | `ReviewFinal` |
| 8 days open | still held | `held_review_overdue` event once, still held | none |
| Flag-only mode | `activity_check_mode = flag` | inconsistent capture counts and is flagged | none |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/flags/submit.py` -- limits and lock; `apps/api/src/vulnmart/ingest/engine.py`, `stores.py` -- `MilestoneStore.hold`, `IntegritySink`, `ActivityGate`, `InMemoryMilestoneStore` (add `held`, `release_held`, `keep_held`).
- `apps/api/src/vulnmart/ports/audit.py`, `ports/reports.py` (`IntegrityType`, `IntegrityFlag`); `ports/fakes.py` `FakeAuditPort`.
- `packages/py-attempts/src/vulnmart_attempts/scoring.py` -- `Fact.held`; `rules.py` -- add `min_capture_seconds`, `idle_capture_seconds`, `activity_check_mode` (additive defaults).
- New: `integrity.py`, `ingest/review.py`; tests `packages/py-attempts/tests/test_integrity.py`, `apps/api/tests/test_ingest_review.py`.
- docs: dev-log, CHANGELOG, traceability FR-ACH-01 to 07 and FR-SCR-10, evidence `docs/assets/story-7-6-anti-cheat/`, handoff rows, OI-26-style answer note for OI-38.

## Tasks & Acceptance

**Execution:**
- [ ] read-first note of what ACH-01 and ACH-02 already do; fill only the gaps (cap 30, limit-hit log)
- [ ] `integrity.py` + tests (boundaries of every threshold, shingle edge cases: short text, empty text, identical text)
- [ ] `MilestoneStore` additions + `review.py` + tests (matrix above, audit rows, idempotence)
- [ ] no-auto-zero test: score identical with every flag kind present and with none
- [ ] no-proctoring test: package and consent strings contain none of the forbidden capture words
- [ ] docs -- handoffs, dev-log, CHANGELOG, traceability, story `built`

**Acceptance Criteria:**
- Given a held capture, then the score excludes it until a permitted reviewer accepts it, the decision is audited with reviewer, decision and time, and a rejection never zeroes the attempt.
- Given any mix of flags, then the shown score is unchanged.
- Given similar write-ups in one assessment, then one flag per pair exists with an explanation and no text.

## Handoffs (proposed, add rows in the same commit)

- To Akshay (P-26 recruiter report, RBAC): `may_review(reviewer, attempt_id)` is yours; default recruiter or admin of the same org (D-92, OI-38). Show flags with their explanation and a decision box; call `HeldCaptureReview.decide`. Needs the table behind `held` and the audit row. Default if no answer: as written.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests`
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_ingest_review.py apps/api/tests/test_flags_submit.py apps/api/tests/test_ingest_engine.py`
- `node scripts/scan-flags.mjs`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`
