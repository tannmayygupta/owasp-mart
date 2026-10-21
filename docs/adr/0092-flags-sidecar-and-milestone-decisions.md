# 0092. Flag material, sidecar form, matching and milestone rules

- **Status:** Proposed (decided on the developer's delegation; to be confirmed). D-77 and D-78 are planned only: their story is not built.
- **Date:** 2026-10-17
- **Deciders:** Tanmay (by delegation to Claude Code)
- **Requirements:** FR-FLG-01 to FR-FLG-09, FR-DET-01, FR-DET-04 to FR-DET-06, D-02, D-23, D-32, OI-17, OI-38, spikes S-7 and S-9, D-70 to D-79; handoffs H-63, H-76, H-77, H-94, H-330 to H-335

## Context
The orchestrator injected whatever flags it was given, but nothing on the platform side built them, classified a candidate flag, detected a flag in a response, or turned events into milestones. The only sidecar was a test stub. Built so far: flag material and checker with a leak scan, the Node sidecar with its image, and the milestone engine with the paste service. Not built: the Coraza and CRS helper, the evidence-through-KeyPort story (D-77, D-78), the real tables and routes.

## Options considered
1. **Sidecar form (S-7): Node program plus a small Go helper for Coraza only (chosen, D-70).** Behaviour already exists and is tested in the stub; Node 24 is the runtime of the rest of the instance.
2. **Caddy plugin:** rejected for maintenance risk R-6, and flag matching, signing and `seq` would still need a Go module.
3. **Full Go rewrite:** rejected, about two days of work for no gain the demo needs and no Go toolchain on the dev PC.
4. **Milestone logic as per-challenge code (rejected for D-74):** hard to review and to keep in step with the specs; one JSON rules file validated against the event schema is checked in tests.
5. **Reading the catalogue `signal` text as a rule (rejected):** it is null today; a rule id may be added later by Sahil (T-30).

## Decision
- **D-70** Sidecar form as option 1 above.
- **D-71** No new package; flag code in `apps/api/src/vulnmart/flags/`, milestone, evidence and activity code in `apps/api/src/vulnmart/ingest/`; pure functions and Protocols with no database import.
- **D-72** Flag format unchanged (`VM{` plus 24 Base32 characters plus `}`); two decoys per challenge by default; digests of real flags only in IF-5; classification order correct, decoy, stale epoch, other instance, wrong; verification is always a recompute and the key never enters an instance.
- **D-73** The sidecar scans a bounded copy (1 MiB) after decoding gzip, deflate, brotli, JSON escapes, HTML entities and percent encoding, looks up SHA-256 digests and reports once per candidate; what it cannot see is covered by the paste channel (FR-FLG-06). Candidates are sent only as `candidate_sha256`.
- **D-74** Milestone rules are data: one JSON rules file with five rule kinds (plus `any`), best milestone once per attempt and challenge and kept across resets, bot and internal events never count, M3 only from a platform-recomputed flag or a correct paste, C09 uses a negative window on the platform arrival time with a 30 s grace.
- **D-75** C03 has one flag key: IF-6 allows one flag per challenge key, so the real C03 flag is the part A flag (union injection); part B (stored XSS) gives M1 and M2; the spec's "both parts for M3" waits for a second key (an IF-6 change). Needs the developer's confirmation.
- **D-76** Everything on the player port is the owning player (`session_kind` `player`, `user_id` null); the bot and the mock services never use the player port. If the bot must use it, it needs a marker the sidecar can trust (open, H-332).
- **D-77 (planned)** The sidecar builds the evidence capture; the platform seals it per attempt with `KeyPort.encrypt` (AAD binds instance, epoch, challenge and request) only when the flag was credited or held; everything else is dropped.
- **D-78 (planned)** Everything measured on Docker Desktop is labelled local; live runs are runbook steps; per-challenge active time is shown as estimated and assessment-level only until classifier accuracy (S-6) is verified and the developer accepts it.
- **D-79** Until the real KeyPort lands (P-17) the composition root passes `FakeKeyPort`; library code takes the Protocol only; a test fails if library code imports the fake.

## Consequences
- Easier: flags and milestones are testable in plain pytest; the sidecar is one small image (53,073,687 bytes locally); a new challenge rule is a JSON edit.
- Harder: decoy placement has no field in IF-5 or the catalogue (H-331); the event schema rejects `system:kyc-fallback` so C11 M2 cannot fire (H-334); C03 M3 is flag-only; C09 pending windows live in engine memory and must be persisted by the real worker (H-333); held captures have no reviewer (OI-38).
- To watch: a bot visit on the player port would be classed as a player (H-332); the matcher cannot see base64, hex, reversed or split flags, responses above 1 MiB or undecodable encodings (S-9 table).
- Not proved: any live run on vm-i, the full harness with the product image, Coraza and classifier accuracy (S-6), a scan of a full orchestrator-made instance.

## Evidence
Local tests: `docs/assets/story-6-1-flag-material/test-output.txt` (39 and 1012 passed), `docs/assets/story-6-2-sidecar/test-output.txt` (49 of 49) and `s9-matcher-channels.md` (27 channel rows, 0 mismatches), `docs/assets/story-6-3-milestone-engine/test-output.txt` (90 and 1102 passed). Sources are the PRD, `docs/design/challenge-specs.md`, IF-4, IF-5, IF-6 and the stub sidecar's tests; no outside research was cited by the plans.
