---
title: 'Milestone engine driven by a rules file: credit decisions, paste submission, sharing signal'
type: 'feature'
ticket: '3'
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
context: ['{project-root}/docs/design/challenge-specs.md', '{project-root}/contracts/events/app-events.md', '{project-root}/docs/dev/HANDOFFS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing turns the events of IF-4 into milestones. The catalogue (IF-7) has `milestones.m1..m3.signal: null` in all 11 stubs (`challenges/catalog/c09.yaml:22-31` and the others; H-43/OI-17 not settled), the `milestones` and `events` tables do not exist yet (only `0001_kernel_orgs_baseline.py`), and the platform has no check that a flag reported by the sidecar is the right one for the right instance and epoch, no paste submission service (`submitFlag`, `lab.openapi.yaml:222-260`) and no sharing signal. FR-DET-05, 06, FR-FLG-04 (platform decides), 05, 09 and FR-DET-01 (tags are read from the catalogue) are not met. Handoffs H-43, H-77.

**Approach:** A data-driven engine in `apps/api/src/vulnmart/ingest/` with its rules in one JSON file, and the paste service in `apps/api/src/vulnmart/flags/submit.py`. Five rule kinds cover all 33 milestones (11 challenges x 3): `event` (first matching event), `count`, `count_distinct`, `flag` (M3: a verified flag) and `negative_window` (C09 M2). The engine is pure Python over Protocols with in-memory fakes (events, milestones, integrity flags, instance directory, activity gate), so it runs in pytest now and Akshay's ingest worker and route call it later. Decided on the developer's delegation: D-74 (rules as data), D-75 (C03 has one flag key), D-71 and D-72 (story 1). All Proposed; the main session records them.

## Boundaries & Constraints

**Always:**
- **Rules file** `apps/api/src/vulnmart/ingest/milestone_rules.json` (JSON, not YAML: `pyyaml` is a dev-only dependency of `vulnmart-api`, and `pyproject.toml` is not ours to edit). Shape: `{"schema_version":"0.1","challenges":{"C01":{"m1":RULE,"m2":RULE,"m3":RULE},...}}`. A RULE is one of: `{"kind":"event","type":T,"where":W}`, `{"kind":"any","of":[RULE,...]}`, `{"kind":"count","type":T,"where":W,"at_least":N,"group_by":F?}`, `{"kind":"count_distinct","type":T,"where":W,"field":F,"at_least":N}`, `{"kind":"flag"}`, `{"kind":"negative_window",...}` (below). `W` is a map from a `data` field (or the envelope fields `session_kind`, `challenge_key`) to a literal, `{"in":[...]}`, `{"ne":x}` or `{"nonempty":true}`. The catalogue's `signal` text may later hold a rule id (`rule:c01.m1`); until T-30 the rules file is the source (D-74); the engine never reads `signal`.
- **A test fails** if a challenge or milestone has no rule, if a rule names an event type that is not in `contracts/events/instance-events.schema.json` or a `where` field that the type's data schema does not have, or if two challenges differ only by a copied-and-edited branch (there is no per-challenge Python: the only per-challenge data is the JSON).
- **The 33 rules** (from `docs/design/challenge-specs.md` section 2 and the catalogue of app-events.md section 7; a short form, the file is the truth):
  C01 M1 `shop.cross_store_order_read`; M2 count_distinct `order_id` at least 3; M3 flag.
  C02 M1 `shop.giftcard_attempt` result `unknown_wellformed` or `redeemed`; M2 result `redeemed` and card_class `unsold_test`; M3 flag.
  C03 M1 any of `shop.catalog_query_error`, `proxy.crs_match` with tag `attack_sqli` (the schema's `class` pattern `^[a-z0-9_]{1,32}$` has no hyphen, so the sidecar maps the CRS tag `attack-sqli` to `attack_sqli`, story 5), `shop.ticket_markup_stored`; M2 `collector.hit` bot_tagged true; M3 flag (D-75).
  C04 M1 `shop.refund_decision` path `quick`; M2 count `shop.refund_decision` path `quick` decision `auto_approved` at least 2 grouped by `order_id`; M3 flag.
  C05 M1 `shop.verbose_error` handler `c05_api`; M2 `ops.page_served` client_class `ne` `internal`; M3 flag.
  C06 M1 `import.job` flagged_keys nonempty; M2 `import.job` polluted true; M3 flag.
  C07 M1 `auth.reset_requested` account_role `finance`; M2 any of `auth.password_reset_completed` account_role `finance`, or count `auth.reset_confirm_batch` summed `fail_count` above 500 then a completed reset; M3 flag.
  C08 M1 `webhook.received` source `non_gateway`; M2 `order.paid` verified false; M3 flag.
  C09 M1 `auth.attempt` route `legacy`; M2 `negative_window`; M3 flag.
  C10 M1 `importer.fetch_attempt` url_class in `loopback`, `private`, `link_local`, `internal_name`; M2 `meta.request_served` ua_class `importer`; M3 flag.
  C11 M1 `kyc.result` outcome `invalid_verbose`; M2 `store.approved` approved_by `system:kyc-fallback`; M3 flag.
- **M3 is credited only from a flag the platform verified.** On `proxy.flag_seen` with kind `real` the engine recomputes with `FlagChecker` (story 1) from `candidate_sha256`, the event's `instance_id`, `epoch` and `challenge_key`; the sidecar's `kind` is a hint, not proof (FR-FLG-04: the platform decides). `correct` and the event's epoch equal to the instance's current epoch: credit M3 for that challenge to the instance's attempt, through the `ActivityGate` (default allows; the real gate is FR-ACH-02 of the attempts epoch): gate says no -> `held` (the capture waits for a human, no credit). `stale_epoch`, `decoy`, `other_instance`, `wrong`: no credit; `decoy` writes an integrity flag of type `decoy`, `other_instance` one of type `sharing`; the explanation text holds both instance ids and the challenge key and never a flag or digest (FR-FLG-09).
- **Never self-declared, any valid path:** a milestone is credited only by an event or a verified flag; the best milestone per `(attempt, challenge)` counts once; a later lower milestone changes nothing; the store is keyed by attempt and challenge, not by epoch, so a reset keeps milestones (FR-DET-05). An event of an old epoch still credits M1 and M2 under its own epoch's instance (history) but never M3 (M3 needs the current epoch).
- **Bot events never count:** an event with `session_kind` `bot` (or source `bot`) is ignored for milestones; it is kept in the event log and counted for the bot visit record (story 4). `internal` session events (orchestrator, platform) are ignored for player milestones too, except `instance.flags_injected` which is not a milestone event.
- **Negative-observation rule (C09 M2, FR-DET-06):** `negative_window` params: `group_by` `account_id`; `failures` = `auth.attempt` with route `legacy` and result in the failure set, at least 20; `success` = `auth.attempt` route `legacy` result in the success set; `window_s` 600; `absent` = `shop.security_event_written` for the same `account_id` in the same window, count 0; `grace_s` 30. Time is the platform's arrival time `received_at` of each event, not the instance clock (IF-4 section 2). The rule fires on the success event's arrival only after `grace_s` more seconds (the engine's `tick(now)` finalises pending windows; the caller runs it at least every 10 s), because shop events can arrive late; a `shop.security_event_written` that arrives in the grace period cancels the credit. A sequence gap is not a block. Fakes and tests drive the clock.
- **Paste (FR-FLG-05)** `submit_flag(attempt_id, challenge_key, text)` returns `(result, credit)` as `FlagSubmissionResult`: `correct` or `incorrect` (the reason is never given: no oracle), credit `credited`, `held` or `none`. Wrong, decoy, stale and other-instance all answer `incorrect`, count toward a limit of 5 incorrect per challenge per 10 minutes (a sliding window with an injected clock; the sixth raises `FlagRateLimited` for the API to answer 429 `ATT-FLAG-RATE-LIMITED` with `Retry-After`, even for a correct value, `lab.openapi.yaml:229-236`), and write the integrity flags above. The text is never stored, logged or echoed; only `(attempt, challenge, result)` goes to the `FlagSubmissionLog` Protocol. A pasted correct flag credits M3 like an automatic one and is a no-op if M3 is already credited. The attempt must be `running` (`AttemptPort.get`), else the existing `AttemptStateInvalid`.
- **Sharing signal (FR-FLG-09):** `other_instance` is found by recomputing the same challenge's flag for the instances in `InstanceDirectory.recent(challenge_key, template_id, within_s=...)` (live and recently ended instances, at most 200, all their epochs up to the current one; a bounded loop of HMAC calls), both from the sidecar's `candidate_sha256` and from paste. One integrity flag per `(attempt, other instance)` pair.
- **Catalogue reads (FR-DET-01):** a loader `ingest/catalogue.py` reads `challenges/catalog/*.yaml` only in tests and in a CLI helper (YAML is not a runtime dependency); the production path takes tags from the catalogue-sync tables (owner `admin`, Sahil/Akshay). The test asserts that all 11 entries have OWASP 2021 and 2025, CWE, ATT&CK tags (present in the stubs now) and that the engine's challenge list equals the catalogue keys.
- Stores are Protocols with in-memory fakes in `ingest/stores.py`: `EventLog` (append idempotent by `(instance_id, epoch, seq)`, read ordered by `(epoch, seq)`), `MilestoneStore`, `IntegritySink`, `InstanceDirectory`, `ActivityGate`, `FlagSubmissionLog`. The real tables (`events`, `milestones`, `integrity_flags`, `flag_submissions`: owners in `contracts/db/table-owners.yaml:37-44`) are a handoff to Akshay (H-330); nothing here migrates.
- No flag, digest, candidate text or key in any log line, exception, repr or test message.

**Never:**
- Editing the catalogue files, IF-7 (`contracts/catalog/challenge.schema.json`), IF-4, IF-5, IF-6, `apps/api/pyproject.toml`, migrations, Akshay's non-port API code, `.github/workflows/**`, the Excel tracker; pushes and commits; git checkout, stash or reset; AWS; ssh.
- Reading `signal` text as a rule; a branch on a challenge key in engine code; crediting from the sidecar's `kind` alone; scoring formulas (L-23).
- Deciding the real C03 two-flag shape (D-75 is a proposal, see Open).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rules complete | the JSON file | 11 x 3 rules; event types and fields exist in the schema | test fails on a gap |
| M1 then M3 | first matching event, later verified flag | M1 then M3; best is M3 | none |
| M3 first | flag before any M1 or M2 | M3 credited (any valid path); M1, M2 not back-filled | none |
| Verified flag | `proxy.flag_seen` real, hash of the right flag, current epoch | M3 credited | none |
| Sidecar lies | kind real but hash is a decoy or wrong | no credit; decoy -> integrity `decoy` | none |
| Stale epoch | flag of epoch 1, instance now epoch 2 | no credit | none |
| Other instance | hash of B's flag on A | no credit; integrity `sharing` naming A and B, no flag | none |
| Bot event | `session_kind` bot | ignored for milestones | none |
| Held | `ActivityGate` refuses | `held`, no credit | none |
| Reset | milestone M2 earned at epoch 1, instance reset | M2 still there; M3 needs a flag of epoch 2 | none |
| Duplicate | the same event twice (same triple) | credited once; second is a no-op | none |
| C09 happy | 20 legacy failures, 1 success for `s.iyer`, 0 security events, window 600 s, then 30 s grace | M2 after the grace | none |
| C09 logged | one `shop.security_event_written` for the account inside the window or grace | no M2 | none |
| C09 other route | 25 failures on route `web` | no M2 (and no M1) | none |
| C09 slow | 20 failures spread over 15 minutes | no M2 | none |
| Paste correct | right flag, attempt running, gate allows | `correct`, `credited`; text not stored | none |
| Paste wrong x6 | six wrong in 10 minutes | five `incorrect`, then `FlagRateLimited` even for the right flag | caller answers 429 |
| Paste decoy | decoy text | `incorrect`, `none`; integrity `decoy` | none |
| Paste state | attempt not running | `AttemptStateInvalid` | caller answers 409 |
| Unknown type | event type not in the rules | no effect, no error | none |

</frozen-after-approval>

## Code Map

- `contracts/events/instance-events.schema.json:955-1134` and `:1254-1560` (the per-type `data_*` definitions) and `contracts/events/app-events.md:155-199` (event catalogue) -- read only; the field names the rules use.
- `docs/design/challenge-specs.md:87-432` (the 11 specs: milestone tables), `:677-716` (event catalogue), `:610-627` (flag locations) -- the source of the rules.
- `challenges/catalog/c01.yaml` to `c11.yaml` (stubs, `milestones.*.signal: null`), `contracts/catalog/challenge.schema.json:112-122` and `:146-155` (`milestones`, the `milestone` def), `scripts/validate-catalog.mjs:20` -- read only (Sahil owns them).
- `apps/api/src/vulnmart/ingest/__init__.py` and `apps/api/src/vulnmart/flags/__init__.py` -- the stream L folders; new: `ingest/engine.py`, `ingest/rules.py` (loader and validator), `ingest/milestone_rules.json`, `ingest/stores.py`, `ingest/catalogue.py`, `flags/submit.py`.
- `apps/api/src/vulnmart/ports/reports.py:14-30` (`CHALLENGE_KEYS`, `Milestone`, `IntegrityType` with `DECOY` and `SHARING`), `:58-63` (`IntegrityFlag`), `ports/instances.py:46` (`InstancePort.get`), `ports/attempts.py` (`AttemptPort.get`, states), `ports/errors.py` (`AttemptStateInvalid`; add `FlagRateLimited` here: ports file, allowed) -- the types the engine reuses.
- `apps/api/src/vulnmart/flags/checker.py` (story 1) -- the verification the engine and paste call.
- `apps/api/src/vulnmart/ports/lab_fakes.py:37-52` (the shared attempt store of the fakes) -- how `FakeInstanceDirectory` can read the same fake instances in tests.
- `contracts/api/lab/lab.openapi.yaml:222-260` (`submitFlag`), `:829-849` (`FlagSubmissionRequest`, `FlagSubmissionResult`) -- the paste contract; read only.
- `contracts/events/examples/valid/instance-events/` and `.../posted/` -- the example events the replay tests start from (one JSON per type); the tests add a small builder for the rest.
- Tests: `apps/api/tests/test_ingest_rules.py`, `test_ingest_engine.py`, `test_ingest_c09.py`, `test_flags_submit.py` (new).
- Docs: dev-log, CHANGELOG, traceability (FR-DET-01, 05, 06, FR-FLG-04, 05, 09, D-22, D-32, OI-17), HANDOFFS (H-43 proposal, H-77 answer, new rows H-330 for Akshay and H-331 for Sahil), `docs/assets/story-6-3-milestone-engine/`.

## Tasks & Acceptance

**Execution:**
- [ ] `ingest/milestone_rules.json` and `ingest/rules.py` -- the 33 rules, loader, validation against the event schema
- [ ] `ingest/engine.py` -- `process(event)`, `tick(now)`, the five rule kinds, bot and epoch rules, idempotence by triple
- [ ] `ingest/stores.py` -- Protocols and in-memory fakes
- [ ] `flags/submit.py` -- paste service, window limit, no value stored, integrity writes
- [ ] sharing signal wired into engine and paste through `InstanceDirectory.recent`
- [ ] tests -- every matrix row; one replay test per challenge (a table of events to expected milestones); the catalogue test; the no-secret-in-messages test
- [ ] docs and handoff rows as in the Code Map

**Acceptance Criteria:**
- Given the rules file, then all 11 challenges have M1, M2, M3, and each rule's event types and fields exist in the event schema.
- Given the example events of every challenge in turn, then M1, M2 and M3 are credited as the specs say (a table in the test names the event list per challenge).
- Given the C09 sequence, then M2 is credited only when there are 20 legacy failures, a success and no security event for that account inside the window and grace.
- Given a decoy, a flag of another instance, a stale-epoch flag or a bot event, then nothing is credited and the right integrity flag exists without a flag value in it.
- Given a reset, then milestones stay and M3 needs a flag of the new epoch.
- Given six wrong pastes, then the sixth is refused, even for the correct value, and no pasted text is stored anywhere.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_ingest_rules.py apps/api/tests/test_ingest_engine.py apps/api/tests/test_ingest_c09.py apps/api/tests/test_flags_submit.py` -- expected: pass
- `uv run --locked --package vulnmart-api pytest -q` -- expected: pass
- `node scripts/validate-events.mjs` and `node scripts/validate-catalog.mjs` -- expected: pass (unchanged)
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`, `uv run --locked --package vulnmart-api python scripts/check_table_owners.py` -- expected: pass

**Local only / developer runbook:** nothing live; the real `events`, `milestones`, `integrity_flags`, `flag_submissions` tables and the route and worker that call the engine are Akshay's (H-330). The live proof is story 4's local loop and T-32 on `vm-i`.

## Proposed (decided on the developer's delegation)

- **D-74 Milestone rules are data.** One JSON rules file with five rule kinds in the stream L folder, validated against the event schema in CI; the catalogue `signal` will carry a rule id later (additive IF-7 change by Sahil, T-30); best milestone once per attempt and challenge, kept across resets; bot and internal events never count; M3 only from a platform-recomputed flag or a correct paste; C09 uses a negative window on the platform arrival time with a 30 s grace.
- **D-75 C03 has one flag key.** IF-6 allows one flag per challenge key `C01..C11`, so the real `C03` flag is the part A flag (union injection); part B (stored XSS) gives M1 and M2 (`shop.ticket_markup_stored`, `collector.hit`) and the spec's "both parts for M3" waits for a second key (an IF-6 change). Needs the developer's confirmation.

## Open (not settled here)

- C03 two flags (D-75); C03 part A M2 ("response holds `<MARKER_C03A>`") has no event today (a marker would need an additive `proxy.marker_seen` type in IF-4: not proposed here), so part A reaches M3 straight from M1 or from M2 of part B.
- `auth.attempt` `result` is a free class in the schema: the rule assumes `failure` and `success` (confirm with Sahil, H-331); C01 M2's "or the target store's order" needs the Northwind store id of the instance, so only the distinct-count branch is encoded.
- `held` capture review (OI-38) has no owner yet: `ActivityGate` is a Protocol that answers allow or hold; the reviewer for held captures is a later task of the attempts epic (dev1-tanmay.md, OI-38).

## Implementation Notes

Built 2026-10-17 by the implementer session (not yet reviewed or closed; the main session commits and records the docs).

**Files (stream L, new):** `apps/api/src/vulnmart/ingest/{milestone_rules.json,rules.py,engine.py,stores.py,catalogue.py}`, `apps/api/src/vulnmart/flags/submit.py`; tests `apps/api/tests/{ingest_support.py,test_ingest_rules.py,test_ingest_engine.py,test_ingest_c09.py,test_flags_submit.py}`. **Changed (ports file, allowed by the plan):** `apps/api/src/vulnmart/ports/errors.py` (`FlagRateLimited`, code ATT-FLAG-RATE-LIMITED, `retry_after`).

**Real results** (raw output in `docs/assets/story-6-3-milestone-engine/test-output.txt`):
- the four story test files: 90 passed;
- whole api suite: 1102 passed, 7 skipped (Postgres tests, no DSN set);
- `node scripts/validate-events.mjs`: PASS; `node scripts/scan-secrets.mjs`: PASS;
- `node scripts/check-text-files.mjs`: one FAIL, in another agent's file (`services/sidecar/test/events.test.mjs:68`, replacement character); none in this story's files.
- Not run: `validate-catalog.mjs`, `check_table_owners.py`, `bmad-code-review`, `bmad-qa-generate-e2e-tests`.

**Deviations from the plan, and why:**
1. The rule language has two additions the plan did not list: the `where` operator `contains` (C03 `tags` is a list, `in` would read the wrong way) and, on `count`, the options `sum_field` and `then` (C07 backup: more than 500 failed confirms, then a completed reset). Both are validated and tested.
2. C07 backup branch encodes "above 500" as `at_least` 501 and accepts a completed reset of any role as the closing event.
3. The flag recompute runs for every `proxy.flag_seen` kind (real, decoy, foreign), not only `real`, because the sharing check needs `foreign`. Decoy integrity flags are written once per (attempt, challenge); sharing once per (attempt, other instance).
4. A correct flag pasted for another challenge than the one named answers `incorrect` (no oracle, counts toward the limit).
5. The C09 pending windows are held in engine memory; after a restart they are lost unless the success events are replayed (a replayed triple is a no-op, so the real worker should persist or rebuild them: part of H-330).
6. A pasted correct flag whose M3 is already credited answers `correct` / `credited` (idempotent replay); a rate-limited call is logged as `rate_limited`.

**Open problems found:**
- The event schema rejects the value `system:kyc-fallback` for `store.approved.approved_by` (`$defs/id` pattern has no colon), and the shipped example uses `system`. C11 M2 therefore cannot fire from a schema-valid event until Sahil changes the schema (additive: a `class`-style value such as `system_kyc_fallback`) or the rule value. The rule keeps the spec text. For H-331.
- C03 M3 stays flag-only (D-75 open); C03 part A M2 has no event; C01 M2's target-store branch is not encoded; `auth.attempt` `result` values `failure` and `success` are assumed (H-331).
- `held` captures have no reviewer yet (OI-38).
