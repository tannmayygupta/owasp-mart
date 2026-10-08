---
type: initiative
title: "Lab: instances, flags, detection and the assessment engine"
parent: none
covers: [FR-SES-01, FR-SES-02, FR-SES-03, FR-SES-04, FR-SES-05, FR-SES-06, FR-SES-07, FR-SES-08, FR-SES-09, FR-SES-10, FR-SES-11, FR-INS-01, FR-INS-02, FR-INS-03, FR-INS-04, FR-INS-05, FR-INS-06, FR-INS-07, FR-INS-08, FR-INS-09, FR-INS-10, FR-INS-11, FR-FLG-01, FR-FLG-02, FR-FLG-03, FR-FLG-04, FR-FLG-05, FR-FLG-06, FR-FLG-07, FR-FLG-08, FR-FLG-09, FR-DET-01, FR-DET-02, FR-DET-03, FR-DET-04, FR-DET-05, FR-DET-06, FR-DET-07, FR-DET-08, FR-DET-09, FR-SCR-01, FR-SCR-02, FR-SCR-03, FR-SCR-04, FR-SCR-05, FR-SCR-06, FR-SCR-07, FR-SCR-08, FR-SCR-09, FR-SCR-10, FR-TIM-01, FR-TIM-02, FR-TIM-03, FR-TIM-04, FR-TIM-05, FR-ACH-01, FR-ACH-02, FR-ACH-03, FR-ACH-04, FR-ACH-05, FR-ACH-06, FR-ACH-07]
after: []
assignee: "Tanmay Gupta"
risk: high
---

# Lab: instances, flags, detection and the assessment engine

## Description

The lab is the instance plane and the assessment engine: it creates and guards each user's private shop copy, creates and verifies flags, detects exploitation, and runs attempts, scoring, time and anti-cheat. It owns the orchestrator, the edge and gate, the Coraza sidecar, event ingest, the workers for provisioning and scoring, the deployment of both Oracle VMs and the lab harness the other streams use. It is the hub of the three streams (ADR 0013).

## Outcome

A user's private instance starts on demand, can be attacked safely, and every exploit is detected and scored fairly and explainably; the signal is every PRD area FR-SES, FR-INS, FR-FLG, FR-DET, FR-SCR, FR-TIM and FR-ACH passing its acceptance criteria on the deployed VMs.

## Requirements

The numbered source is the PRD (`docs/prd/PRD.md`): sections 5.4 (sessions), 5.5 (instances), 5.7 to 5.10 (flags, detection, scoring, time) and 5.12 (anti-cheat). The ids in `covers` are its requirement ids. Non-functional requirements that bind this stream (NFR-SEC-02, 04, 06, NFR-ISO-01 to 07, NFR-PRF-01 to 03, NFR-AVL-01 to 04, NFR-POR-01 to 03, NFR-EXT-02, 04, NFR-MNT-04, NFR-CST-01, NFR-OBS-02) are cited as constraints in References, not covered.

## Done when

1. Every requirement in `covers` passes its PRD acceptance criteria on the two deployed VMs, not only on a laptop.
2. From inside an instance the internet, the LAN, cloud metadata, other instances, the platform and the host (gateway IP and host services) are unreachable, tested on the VM (NFR-ISO-01, NFR-ISO-02).
3. Every challenge flag is unique per instance and captured automatically, and no flag appears in an image, a log or another user's view.
4. Killing the orchestrator mid-provision leaves no orphan containers or networks after the reconciler runs (spike S-13).
5. Scoring reproduces the PRD Appendix A examples and keeps held captures out of the score until a human decides.

## Boundaries

Follows the stream boundary of ADR 0013: everything driven by instance events and the instance lifecycle. Not the dashboards, accounts, privacy and admin (initiative-platform) and not the shop or challenge content (initiative-target). Tracer path: an instance of the stub shop starts through the fake orchestrator, one planted flag is captured and shown as an event.

- Touch point: the shop and its services, consumed through the instance contract IF-6 and the event schema IF-4; owner: initiative-target epics
- Touch point: platform modules (audit, outbox, keys, scope, settings) consumed through ports; owner: initiative-platform epic-platform-baseline and epic-privacy-audit-and-keys
- Touch point: the challenge catalogue (IF-7) consumed by scoring and the injector; owner: initiative-target epic-target-baseline
- Touch point: Docker Engine, Caddy, Coraza and the OWASP Core Rule Set, configured not built; owner: epic-isolation-and-hardening and epic-edge-gate-and-event-path

## References

- prd, docs/prd/PRD.md, sections 5.4, 5.5, 5.7 to 5.10, 5.12 and 6.2
- architecture, docs/architecture/07-repo-and-workstreams.md, sections 3, 7.3 and 7.7; docs/architecture/02-deployment-and-network.md; docs/architecture/03-origins-and-access.md sections 2 to 4
- decision, initial.md Section 15: D-33 (split), D-34 (two VMs), D-23 (isolation), D-22 (scoring), D-28, D-35
- constraint, docs/architecture/06-security.md (orchestrator privileges, compromised-instance assumptions)

## Notes

- Decision: three streams by contract boundary; this initiative is stream L, assigned to Tanmay Gupta (user, 2026-10-08, D-33). Two Oracle VMs (D-34).
- Shared decisions and their homes: the instance contract, event schema, orchestrator API and the lab-side fragment of the platform API (IF-2) are authored here in epic-lab-baseline and adopted by the other streams; the web address (OI-9) is settled in epic-environments-and-deployment (LE-2); the clock start (OI-22) is decided in epic-attempts-scoring-and-integrity.
- Assumption: a closing epic, epic-integration-and-demo-readiness, runs the cross-stream end-to-end suite and the demo rehearsal; the user has not confirmed it.
- Out of scope here, already in place: the documentation rule, the BMAD trackers and the Excel workbook (D-14, D-29 to D-31).
- Open question: where the platform database runs is settled (self-hosted on VM-P, D-28); still open: instance quotas (OI-21), clock start (OI-22), idle candidate instances (OI-23), start retries (OI-24), tuning numbers (OI-25), Oracle shape actually granted (OI-36), account owner (OI-8).
- Unknown: many spikes sit in this stream: S-1 to S-4, S-6 to S-8, S-11, S-13 to S-17, S-22.
- Assumption: epic order below is a proposal for the user to approve.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
