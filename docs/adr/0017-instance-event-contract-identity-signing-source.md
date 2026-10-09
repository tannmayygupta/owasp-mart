# 0017. Instance event contract: identity, signing, sources and flag sightings (IF-4)

- **Status:** Accepted (D-38)
- **Date:** 2026-10-09
- **Deciders:** Tanmay (stream L). Consumers to confirm: Akshay (ingest, events table), Sahil (shop events).
- **Requirements:** FR-DET-04, FR-DET-08, FR-DET-09, FR-FLG-04, FR-FLG-09, FR-TIM-04; D-23, D-28, D-35; IF-4 (`contracts/events/app-events.md`)

## Context
Three documents described an instance event differently: architecture 07 section 3.2 item 6 (shop body with `name`, sidecar adds `instance_id`, `seq`, `source: app`), challenge specs section 10 (envelope with `event_id`, `source` of shop, import, mock or bot, `session_kind`, `user_id`), and architecture 04 (the `events` table keyed by `(instance_id, seq)`, `source` of sidecar, app, orchestrator or platform). A fourth, older layout sat in research note RS-B. Signing was described only as "covers instance ID and seq". Sidecar, shop, mock services, bot and ingest could not be built against each other.

## Options considered
1. **Identity:** (a) `(instance_id, seq)` only; (b) `seq` plus a uuid `event_id`.
2. **`proxy.flag_seen` content:** (a) union of `kind` (real, decoy, foreign), `challenge_key` and the candidate's SHA-256; (b) challenge specs only (hash and hint); (c) architecture 04 only (kind and challenge).
3. **`source` values:** (a) fine-grained (sidecar, shop, import, mock, bot, orchestrator, platform); (b) coarse (sidecar, app, orchestrator, platform).
4. **Signature:** HMAC-SHA256 with the per-instance event key over `instance_id`, `seq` and the SHA-256 of the raw body (header `X-VM-Signature: v1=<hex>`), verified at ingest only.

## Decision
1(a), 2(a), 3(a) (chosen by Tanmay on 2026-10-08) and option 4 as the signing form. An event is one JSON document with `type` (not `name`); the sidecar numbers events and signs them; the shop's body is unsigned, POST-only and carries no `instance_id`, `seq` or `source` of the sidecar; evidence and flag-like values are redacted by the sidecar before sending. Ingest answers 202 (new), 200 (identical duplicate), 409 (same key, different body), 401, 413, 422. All sizes, clock skew and `EVT-*` codes are proposals in the open-points table.

## Consequences
Easier: one contract that every component can be built and tested against; a fake ingest and a check command exist before any real component. Harder: Akshay widens the `events.source` column and drops `event_id` from the milestones reference in a migration; the sidecar must number events across resets without repeating a `seq` (open points 8 and 9). Challenge specs section 10 still shows the older envelope; IF-4 supersedes it (the file itself was not edited by this task).

## Evidence
- Architecture 02, 03, 04 (events table, section 11), 05 (lines 160 to 185), 06, 07 section 3.2 item 6 and 3.6; challenge specs section 10; ADR 0005 and 0009; `docs/research/RS-B-isolation-orchestration.md` lines 166 to 175 (HMAC header idea, research only).
- HMAC over a body digest with an instance-scoped key is the usual signed-webhook pattern; no primary source was read for it. UNVERIFIED: the exact key derivation (ADR 0009), clock skew and size caps.
