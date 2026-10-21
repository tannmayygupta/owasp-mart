# Milestone engine driven by a rules file, credit decisions, paste and sharing signal (story 6.3)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (commit of this story follows; not committed when this entry was written) |
| Status | Partly done: engine, rules file, paste service and tests built and passed locally against in-memory fakes; no database tables, no route or worker calls it yet |
| Report tag | milestone engine, rules as data, negative observation C09, paste flag, sharing signal, FR-DET-05, FR-DET-06, FR-FLG-04, FR-FLG-05, FR-FLG-09, D-74, D-75 |

## Requirements covered
FR-DET-01 (tags read from the catalogue in a test), FR-DET-05, FR-DET-06, FR-FLG-04 (platform decides), FR-FLG-05, FR-FLG-09, D-22, D-32, OI-17; decisions D-74, D-75 (Proposed, in ADR 0092); handoffs H-43 (proposal), H-77 (answered as built), H-333, H-334 (new). Task L-21 (part; stays unticked: evidence through KeyPort, activity metadata and bot visits are a later story).

## Summary (plain language, 3-5 lines)
A data-driven engine now turns IF-4 events into milestones M1 to M3 for all 11 challenges from one JSON rules file (33 rules, five rule kinds). M3 is credited only from a flag the platform recomputed itself, or a correct paste; bot events never count; a decoy or another instance's flag writes an integrity flag without any flag value. The C09 "nothing was logged" rule uses the platform's arrival time and a 30 s grace. The paste service answers only correct or incorrect and limits wrong attempts.

## Why
Nothing turned events into milestones: the catalogue `signal` fields are null, the `events` and `milestones` tables do not exist, and the platform had no check that a flag the sidecar reported is the right one for the right instance and epoch. FR-DET-05, 06, FR-FLG-04, 05 and 09 were not met. Handoffs H-43, H-77.

## What was built
- `apps/api/src/vulnmart/ingest/{milestone_rules.json,rules.py,engine.py,stores.py,catalogue.py}`: rules file and validator, engine (`process(event)`, `tick(now)`), Protocols and in-memory fakes (events, milestones, integrity sink, instance directory, activity gate, submission log), catalogue loader for tests.
- `apps/api/src/vulnmart/flags/submit.py`: paste service `submit_flag`, limit of 5 incorrect per challenge per 10 minutes, no pasted text stored.
- `apps/api/src/vulnmart/ports/errors.py`: new `FlagRateLimited` (code ATT-FLAG-RATE-LIMITED, `retry_after`).
- Tests: `apps/api/tests/{ingest_support,test_ingest_rules,test_ingest_engine,test_ingest_c09,test_flags_submit}.py`.

## How it works
Rule kinds: `event`, `any`, `count`, `count_distinct`, `flag`, `negative_window`; the engine has no per-challenge Python and never reads the catalogue's `signal` text. A test fails if a challenge or milestone has no rule or a rule names an event type or field that is not in the event schema. The best milestone per (attempt, challenge) counts once and is kept across resets; an event of an old epoch still credits M1 and M2 but never M3. M3: on `proxy.flag_seen` the engine recomputes with `FlagChecker` from `candidate_sha256`, instance, epoch and challenge; the sidecar's `kind` is only a hint. If the `ActivityGate` refuses, the credit is `held` (no credit). C09 M2: at least 20 legacy failures, then a success for the same account, with no `shop.security_event_written` for that account in 600 s plus a 30 s grace, all on `received_at`.

## Files changed
- `apps/api/src/vulnmart/ingest/*`, `apps/api/src/vulnmart/flags/submit.py`, `apps/api/src/vulnmart/ports/errors.py` - new / changed
- `apps/api/tests/*` - new (five files)
- `docs/assets/story-6-3-milestone-engine/test-output.txt`
- Docs: this entry, ADR 0092, `initial.md` (D-74, D-75), HANDOFFS, CHANGELOG, traceability, dev1 file

## Decisions made
D-74 (milestone rules are data), D-75 (C03 has one flag key: the real C03 flag is part A, union injection; part B gives M1 and M2; "both parts for M3" waits for an IF-6 change; needs the developer's confirmation). See ADR 0092. Deviations from the plan: the rule language gained the `where` operator `contains` and, on `count`, the options `sum_field` and `then`; C07's backup branch is encoded as `at_least` 501 with a completed reset of any role as the closing event; the flag recompute runs for every `proxy.flag_seen` kind because the sharing check needs `foreign`; a correct flag pasted for another challenge answers `incorrect`; a pasted correct flag whose M3 is already credited answers `correct` / `credited`; pending C09 windows are held in engine memory and lost on restart unless success events are replayed.

## Tests
Raw output in `docs/assets/story-6-3-milestone-engine/test-output.txt`.
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_ingest_rules.py apps/api/tests/test_ingest_engine.py apps/api/tests/test_ingest_c09.py apps/api/tests/test_flags_submit.py`: 90 passed.
- `uv run --locked --package vulnmart-api pytest -q` (whole api suite): 1102 passed, 7 skipped (Postgres tests, no DSN set).
- `node scripts/validate-events.mjs`: PASS. `node scripts/scan-secrets.mjs`: PASS.
- `node scripts/check-text-files.mjs`: one FAIL at that time, in another agent's file (`services/sidecar/test/events.test.mjs:68`, replacement character); none in this story's files.
- NOT run: `validate-catalog.mjs`, `check_table_owners.py`, `bmad-code-review`, `bmad-qa-generate-e2e-tests`.
Traceability rows: FR-DET-01, 05, 06, FR-FLG-04, 05, 09, D-22, D-32, OI-17.

## Evidence
`docs/assets/story-6-3-milestone-engine/test-output.txt`.

## Problems met and how they were fixed
The plan's rule language could not express two spec rules (a list-valued `tags` field for C03, and "more than 500 failed confirms then a completed reset" for C07); the two additions listed under decisions were made and are validated and tested.

## Security notes (vulnerable parts only)
Not a vulnerable part of the shop; this is platform scoring input. The paste path gives no oracle: wrong, decoy, stale and other-instance all answer `incorrect`; the sixth wrong paste in 10 minutes is refused even for the correct value; the text is never stored, logged or echoed. Integrity flag explanations hold instance ids and the challenge key, never a flag or digest.

## Limitations and follow-ups
- The real tables `events`, `milestones`, `integrity_flags`, `flag_submissions`, the ingest route that calls the engine and a tick at least every 10 s are Akshay's (H-333).
- The event schema rejects `system:kyc-fallback` for `store.approved.approved_by` (the `$defs/id` pattern has no colon; the shipped example uses `system`): C11 M2 cannot fire from a schema-valid event until Sahil changes the schema or the rule value (H-334).
- C03 M3 is flag-only (D-75 open); C03 part A M2 has no event today; C01 M2's target-store branch is not encoded; `auth.attempt` `result` values `failure` and `success` are assumed (H-334).
- `held` captures have no reviewer yet (OI-38).
- Not live: the live proof is the local loop of a later story and T-32 on vm-i.
