---
id: 21
type: story
title: "Scenario matrix with evidence, ASVS requirement by requirement, and the live role journeys"
parent: none
covers: ["L-30", "L-31", "P-32", "NFR-SEC-01", "D-102"]
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# Scenario matrix with evidence, ASVS requirement by requirement, and the live role journeys

## Description
Tracker audit 2026-10-21 items 8 and 9: the end-to-end suite had no invite, assessment or recruiter report (L-30), the demo rehearsal never ran (L-31), and the ASVS table was at chapter level only (P-32).

## Acceptance Criteria
1. Every one of the 145 scenarios of `docs/audit/2026-10-21-role-scenarios.md` has a row in `docs/audit/2026-10-21-scenario-matrix.md` with a status, a named passing test (for VERIFIED) and, for what is missing, the owning package; a test checks the matrix.
2. `docs/security/asvs-checklist.md` has one row per ASVS 5.0.0 requirement (345) with applies, status, evidence, owner and note; `scripts/check-asvs.mjs` runs in CI.
3. `scripts/e2e-live-journeys.mjs` walks recruiter, candidate and admin against a deployed base URL with credentials from the environment, has `--dry-run`, a unit test with a fake server and a local variant; the runbook gives the exact command.
4. `docs/runbooks/demo-rehearsal.md` holds the checklist and the record form; no rehearsal is claimed.

## References
- docs/audit/2026-10-21-tracker-audit.md (P-32, L-30, L-31, items 8 and 9), docs/audit/2026-10-21-role-scenarios.md