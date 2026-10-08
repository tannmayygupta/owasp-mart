---
type: initiative
title: "Target: the vulnerable marketplace and its 11 challenges"
parent: none
covers: [FR-CHL-01, FR-CHL-02, FR-CHL-03, FR-CHL-04, FR-CHL-05, FR-CHL-06, FR-CHL-07, FR-CHL-08, FR-CHL-09, FR-CHL-10, FR-CHL-11, FR-CHL-12, FR-CHL-13, FR-CHL-14, FR-CHL-15, FR-CHL-16, FR-CHL-17, FR-SHP-01, FR-SHP-02, FR-SHP-03, FR-SHP-04, FR-SHP-05, FR-SHP-06, FR-SHP-07, FR-SHP-08, FR-SHP-09, FR-SHP-10, FR-SHP-11, FR-SHP-12, FR-SHP-13, FR-SHP-14, FR-SHP-15]
after: []
assignee: "Sahil Roy"
risk: high
---

# Target: the vulnerable marketplace and its 11 challenges

## Description

The target is the vulnerable marketplace every user attacks, with its supporting services and the 11 challenges. It is a believable online marketplace with six roles, about 20 tables and 7 state machines, running inside each instance, plus the challenge catalogue, hints, write-ups and the exploit tests that prove every challenge works on the vulnerable build and fails on a fixed one.

## Outcome

Every user gets a believable marketplace that hides 11 independently solvable vulnerabilities; the signal is all 11 exploit tests passing on the vulnerable build and failing on the fixed build, in CI and on the deployed instance VM.

## Requirements

The numbered source is the PRD (`docs/prd/PRD.md`): sections 5.6 (the 11 challenges) and 5.19 (the shop), with the detailed designs in `docs/design/challenge-specs.md`. The ids in `covers` are its requirement ids. Non-functional requirements that bind this stream (NFR-EXT-03, NFR-ISO-03, NFR-ISO-07, NFR-SEC-07) are cited as constraints in References, not covered.

## Done when

1. All 11 exploit tests pass on the vulnerable build and fail on the fixed build, in CI and on the deployed instance VM.
2. Solving one challenge never captures another challenge's flag, checked with the cross-challenge tests from the specification (FR-CHL-13).
3. The shop runs inside an instance under the runtime profile (non-root, read-only filesystem, no egress) and meets the instance contract.
4. Every shop role carries at least one challenge per D-27 and the seeded accounts work in a fresh instance.
5. No challenge allows code execution or file read in the shop container.

## Boundaries

Follows the stream boundary of ADR 0013: the shop, its services and the challenge content. Not the platform (initiative-platform) and not the instance plane, sidecar, scoring and flags engine (initiative-lab). Tracer path: the shop skeleton starts in the lab harness, answers health and serves one planted flag.

- Touch point: the instance contract IF-6 and the event schema IF-4, consumed; owner: initiative-lab epic-lab-baseline
- Touch point: the Coraza sidecar classifies shop traffic; the catalogue references its rule ids; owner: initiative-lab epic-flags-detection-and-sidecar
- Touch point: the dashboards render the catalogue (IF-7); owner: initiative-platform epic-dashboards-and-exports
- Touch point: the flag injector protocol, called by the orchestrator at instance start; owner: initiative-lab epic-orchestrator-and-instance-lifecycle

## References

- prd, docs/prd/PRD.md, sections 5.6 and 5.19
- design, docs/design/challenge-specs.md (all sections)
- architecture, docs/architecture/07-repo-and-workstreams.md, sections 3.2, 7.4 and 7.7
- research, docs/research/RS-G-shop-domain.md, RS-E-challenges-01-06.md, RS-F-challenges-07-11.md
- decision, initial.md Section 15: D-33 (split), D-24 (shop), D-26 (catalogue), D-32 (challenge decisions), D-18, D-20, D-27, D-35

## Notes

- Decision: three streams by contract boundary; this initiative is stream T, assigned to Sahil Roy (user, 2026-10-08, D-33).
- Waits on initiative-lab epic-lab-baseline entries 2, 3 and 5 (instance contract, instance events, lab harness) and on initiative-lab epic-environments-and-deployment for the deployed checks; until then verification runs in the lab harness.
- Out of scope here, already in place: the documentation rule, the BMAD trackers and the Excel workbook (D-14, D-29 to D-31).
- Handoff: epics 5 to 7 each supply their challenges' content (flags, hints, write-ups, decoy locations) and epic-catalogue-hints-and-verification owns the set-level checks.
- Decision: the C03 read-only catalogue is a second read-only SQLite file, not a container (D-35); sprint zero must confirm SQL injection cannot reach other data.
- Unknown: spikes belonging here: S-5 (bot memory), S-9 (C06 input on Node 24, flag matcher), SQLite ATTACH and load_extension behavior.
- Assumption: epic order below is a proposal for the user to approve.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
