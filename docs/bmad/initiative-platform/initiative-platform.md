---
type: initiative
title: "Platform and dashboards: people, companies, assessments and results"
parent: none
covers: [FR-ACC-01, FR-ACC-02, FR-ACC-03, FR-ACC-04, FR-ACC-05, FR-ACC-06, FR-ACC-07, FR-ACC-08, FR-ACC-09, FR-ACC-10, FR-ACC-11, FR-ORG-01, FR-ORG-02, FR-ORG-03, FR-ORG-04, FR-ORG-05, FR-ORG-06, FR-ORG-07, FR-ORG-08, FR-ASM-01, FR-ASM-02, FR-ASM-03, FR-ASM-04, FR-ASM-05, FR-ASM-06, FR-HNT-01, FR-HNT-02, FR-HNT-03, FR-DSH-01, FR-DSH-02, FR-DSH-03, FR-DSH-04, FR-DSH-05, FR-DSH-06, FR-LIV-01, FR-LIV-02, FR-LIV-03, FR-LIV-04, FR-LIV-05, FR-LIV-06, FR-EXP-01, FR-EXP-02, FR-EXP-03, FR-EXP-04, FR-PRV-01, FR-PRV-02, FR-PRV-03, FR-PRV-04, FR-PRV-05, FR-PRV-06, FR-PRV-07, FR-PRV-08, FR-PRV-09, FR-PRV-10, FR-PRV-11, FR-PRV-12, FR-PRV-13, FR-PRV-14, FR-PRV-15, FR-PRV-16, FR-PRV-17, FR-PRV-18, FR-PRV-19, FR-PRV-20, FR-ADM-01, FR-ADM-02, FR-ADM-03, FR-ADM-04, FR-ADM-05, FR-ADM-06, FR-ADM-07, FR-ADM-08, FR-NTF-01, FR-NTF-02, FR-NTF-03, FR-NTF-04]
after: []
assignee: "Akshay Gupta"
risk: medium
---

# Platform and dashboards: people, companies, assessments and results

## Description

The platform is the people-and-data half of VulnMart: accounts, companies and approval, assessments and invites, consent, privacy and audit, live updates, the four dashboards and the admin tools. It is the set of API modules owned by stream P plus the Next.js dashboards on Vercel, and it meets the lab (stream L) and the target (stream T) only at written contracts (ADR 0013, decision D-33).

## Outcome

Learners, candidates, recruiters and admins use VulnMart safely end to end (sign up, get approved, run assessments, see live results, control their data); the signal is every PRD area from FR-ACC to FR-NTF passing its acceptance criteria on the deployed site.

## Requirements

The numbered source is the PRD (`docs/prd/PRD.md`): sections 5.1 to 5.3 (accounts, companies, assessments), 5.11 and 5.13 to 5.18 (hints in the UI, dashboards, live updates, exports, privacy, admin, notifications). The ids in `covers` are its requirement ids. Non-functional requirements that bind this stream (NFR-SEC-01, 03, 05, 08, NFR-PRI, NFR-UX, NFR-EXT-01, NFR-MNT-05, NFR-CST-02, NFR-OBS, NFR-AVL-05) are cited as constraints in References, not covered.

## Done when

1. Every requirement in `covers` passes its PRD acceptance criteria on the deployed site (Vercel plus the platform VM), not only on a laptop.
2. Automated tests that try to read another user's or another company's data with every role all fail (FR-DSH-06, NFR-SEC-08).
3. A candidate completes consent, assessment hand-off, results, export and deletion, and the retention jobs delete on schedule (SM-8).
4. A milestone reaches a connected dashboard live within the target fixed by spike S-2, and a reconnect loses nothing (D-17).
5. The ASVS 5.0 level 2 checklist (level 3 for admin, the key service and the audit log) is filled with real test results.

## Boundaries

Follows the stream boundary of ADR 0013: dashboards, platform API modules (accounts, orgs, assessments, privacy, admin, notifications, live) and the shared kernel. Not the lab (instances, flags, scoring, orchestrator) and not the shop or the challenges. Tracer path: a learner signs up, verifies the email, starts an instance (through the lab mock) and sees its status live.

- Touch point: lab modules (attempts, instances, scoring, ingest, flags) in the shared API codebase, consumed through the ports AttemptPort, ReportPort and InstancePort; owner: initiative-lab epic-orchestrator-and-instance-lifecycle and epic-attempts-scoring-and-integrity
- Touch point: challenge catalogue (IF-7), rendered by the dashboards; owner: initiative-target epic-target-baseline
- Touch point: Oracle VM-P, the DuckDNS names, TLS and the Vercel project settings, configured here and built by the lab stream; owner: initiative-lab epic-environments-and-deployment

## References

- prd, docs/prd/PRD.md, sections 5.1 to 5.3, 5.11, 5.13 to 5.18 and 6
- architecture, docs/architecture/07-repo-and-workstreams.md, sections 3 and 7.2
- decision, initial.md Section 15: D-33 (split), D-19 (roles), D-25 (privacy), D-17 (SSE), D-28 (design traps), D-34, D-35
- constraint, docs/architecture/06-security.md (ASVS scope and platform threats)

## Notes

- Decision: three streams by contract boundary; this initiative is stream P, assigned to Akshay Gupta (user, 2026-10-08, D-33).
- Out of scope here, already in place: the documentation rule (D-14), the BMAD trackers (D-29 to D-31) and the manually maintained Excel workbook (D-30).
- Shared decisions and their homes: the web address (OI-9) is settled in initiative-lab epic-environments-and-deployment (LE-2); the 120-minute clock start (OI-22) is decided in initiative-lab epic-attempts-scoring-and-integrity and adopted by epic-assessments-and-invites; the shop-to-platform event path (DC-11) is owned by initiative-lab epic-lab-baseline entry 3.
- Waits on initiative-lab epic-environments-and-deployment because every epic here is verified on the deployed site (Done when 1); until then verification is local or against mocks.
- Assumption: stream P owns the platform edge Caddy configuration (architecture K-02, under infra/caddy/platform) and stream L deploys it; the user has not confirmed this.
- Assumption: each epic fills the ASVS 5.0 checklist rows for its own requirements and stream P compiles them in docs/traceability.md.
- Waits on initiative-lab epic-environments-and-deployment (LE-5) because the backup restore test of epic-privacy-audit-and-keys needs the backup it builds; UX and cost constraints (NFR-UX, NFR-CST-02) are checked in epic-dashboards-and-exports.
- Open question: web address route (OI-9), free email rule (OI-10), re-apply wait (OI-11), break-glass duration (OI-12), recruiter MFA (OI-13), write-up and result timing (OI-14, OI-15), cohort board (OI-26), recruiter export (OI-27), CAPTCHA (OI-29), browsers and accessibility (OI-30), consent language (OI-31), email provider (OI-32), incident procedure (OI-34), consent record retention (OI-37), held-capture reviewer (OI-38); each waits in its epic.
- Assumption: epic order below is a proposal for the user to approve.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
