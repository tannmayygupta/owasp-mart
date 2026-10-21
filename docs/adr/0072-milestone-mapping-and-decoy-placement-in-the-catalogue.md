# 0072. Milestone mapping and decoy placement live in the catalogue

- **Status:** Accepted (the leader instructed work package D on 2026-10-21)
- **Date:** 2026-10-21
- **Deciders:** the leader (Tanmay), with Claude Code
- **Requirements:** FR-FLG-07, FR-CHL-*, C01 to C11, OI-17, handoffs H-42, H-43, H-331, D-72, D-74

## Context
Two questions had stayed open since sprint zero. Which IF-4 event and field values earn each milestone (H-43, OI-17)? Where does a decoy go in the shop (H-42, H-331)? The platform rules file read event names the catalogue did not state, several milestone rules were looser than the challenge specs (C05 M2, C08, C10, C01 M2, C07 M1), and the C09 M2 negative observation had no event to count because the shop did not post `shop.security_event_written`.

## Options considered
1. **The catalogue `signal` text is the mapping, the platform rules file implements it, a test per build proves it (chosen).** No contract schema change.
2. Rule ids (`rule:cNN.mN`) in the `signal` field (proposed in H-334): an extra indirection with nothing gained; the event name and its field values already identify the rule.
3. A new `decoy_placement` schema field or a new IF-5 field: breaking or additive schema work for a list that is only documentation of the injector.

## Decision
- The milestone mapping is the `signal` text of each catalogue entry; `apps/api/src/vulnmart/ingest/milestone_rules.json` implements it; `apps/api/tests/test_ingest_shop_rules.py` feeds the events of the vulnerable and the fixed build.
- Decoy placement is the `decoys` list of each entry, with two kinds (`shop-db`, `service-file`); the shop injector plants the decoy values the platform sends. `decoy_placement` stays an optional string.
- The shop posts `shop.security_event_written` (fields `account_id`, `kind`) in the C09 pipeline, so the vulnerable build (legacy route skips the pipeline) shows zero of them for an attacked account and the fixed build one per attempt.
- C03 has a single flag key: both parts carry the same per-instance flag, so M3 is one `proxy.flag_seen`.
- Contract change: documentation and data only. IF-4 section 7 (1.0.1) and IF-7 (1.2.1) changelog entries; no schema, example or mock change.

## Consequences
- Scoring matches the catalogue and the specs; each loosened rule now needs the event the exploit really produces.
- A catalogue text edit that is not mirrored in the rules file is caught by the ingest tests only for the cases tested; the two must be changed together.
- Not done: COMPAT rows are not touched (the leader closes them).

## Evidence
- `apps/api/tests/test_ingest_shop_rules.py`, `challenges/tests/c09-logging-failures/c09.test.mjs`, `scripts/e2e-local-flags.mjs --docker` (the exploit produces the events each milestone reads).
