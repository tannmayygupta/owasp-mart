---
type: epic
title: "Flags are unique and every exploit is detected"
parent: initiative-lab
covers: [FR-FLG-01, FR-FLG-02, FR-FLG-03, FR-FLG-04, FR-FLG-05, FR-FLG-06, FR-FLG-07, FR-FLG-08, FR-FLG-09, FR-DET-01, FR-DET-02, FR-DET-03, FR-DET-04, FR-DET-05, FR-DET-06, FR-DET-07, FR-DET-08, FR-DET-09]
after: []
assignee: "Tanmay Gupta"
risk: high
---

# Flags are unique and every exploit is detected

## Description

Flags are derived per instance with a key that never enters an instance, injected at start and verified by recomputing; a Coraza sidecar in detect-only mode with the OWASP Core Rule Set sees traffic, spots flags in responses and sends signed events; the milestone engine turns events into milestones for every challenge.

## Outcome

Every exploit is detected automatically and credited fairly, with evidence kept; the signal is FR-FLG-01 to 09 and FR-DET-01 to 09 passing and the classifier accuracy measured (spike S-6).

## Requirements

Numbered source: docs/prd/PRD.md sections 5.7 and 5.8 (FR-FLG-01 to 09, FR-DET-01 to 09) and the event catalogue in docs/design/challenge-specs.md section 10.

## Done when

1. Two instances of the same challenge hold different flags, a reset invalidates the old ones, and a CI scan finds no flag pattern in any image layer or log.
2. A valid flag in a response to the owning player is credited within the live-update target, and a decoy or another instance's flag is not.
3. The sidecar never blocks traffic (`DetectionOnly`) and its form (Caddy plugin or a small Go program) is decided by spike S-7.
4. Milestones M1 to M3 for all 11 challenges are credited from the events defined in the challenge specs, including the negative-observation rule for C09.
5. Decoy flags exist at the locations listed in the catalogue and are not credited (FR-FLG), and Deployed and verified on the VMs through epic-environments-and-deployment.

## Boundaries

Flag derivation, injection protocol, sidecar, signed events, ingest and the milestone engine. Not scoring formulas (epic-attempts-scoring-and-integrity) and not the shop's own app events (initiative-target).

## References

- parent, docs/bmad/initiative-lab/initiative-lab.md
- prd, docs/prd/PRD.md, sections 5.7 and 5.8
- design, docs/design/challenge-specs.md, sections 2 and 10
- decision, initial.md D-01, D-02, D-07, D-23, D-32

## Notes

- Handoff: until initiative-platform delivers KeyPort, a fake KeyPort is used for evidence and flag-key storage.
- Unknown: CRS rule tag names beyond `attack-sqli` and `attack-ssrf` (spike S-6); the sidecar form (S-7); flag matcher with JSON escaping and gzip (S-9).
- Handoff: milestone events and names come from stream T's catalogue (IF-7) and the event catalogue; agree changes through the contract rules.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
