---
type: epic
title: "Attempts, scores, time and integrity are fair and explainable"
parent: initiative-lab
covers: [FR-SES-01, FR-SES-02, FR-SES-03, FR-SES-04, FR-SES-05, FR-SES-06, FR-SES-07, FR-SES-08, FR-SES-09, FR-SES-10, FR-SCR-01, FR-SCR-02, FR-SCR-03, FR-SCR-04, FR-SCR-05, FR-SCR-06, FR-SCR-07, FR-SCR-08, FR-SCR-09, FR-SCR-10, FR-TIM-01, FR-TIM-02, FR-TIM-03, FR-TIM-04, FR-TIM-05, FR-ACH-01, FR-ACH-02, FR-ACH-03, FR-ACH-04, FR-ACH-05, FR-ACH-06, FR-ACH-07]
after: []
assignee: "Tanmay Gupta"
risk: high
---

# Attempts, scores, time and integrity are fair and explainable

## Description

The attempt state machine and server clock run assessments (start, expiry, auto-submit, freeze, destroy, reset, withdrawal, one attempt), scores are computed server-side from signed events, time is shown beside the score, and integrity signals are held for a human and never auto-zero anyone.

## Outcome

Recruiters get comparable, objective, explainable results; the signal is FR-SES, FR-SCR, FR-TIM and FR-ACH passing and the PRD Appendix A examples reproduced.

## Requirements

Numbered source: docs/prd/PRD.md sections 5.4, 5.9, 5.10 and 5.12 (FR-SES-01 to 10, FR-SCR-01 to 10, FR-TIM-01 to 05, FR-ACH-01 to 07). Open: clock start (OI-22), cohort board and tie-breaks (OI-26), held-capture reviewer (OI-38), tuning numbers (OI-25).

## Done when

1. An attempt moves through its states without skipping; at expiry it auto-submits, freezes for 15 minutes and is then destroyed; a lost connection never stops the clock.
2. The scoring tests reproduce every PRD Appendix A example, including the per-challenge hint floor at zero.
3. Held captures stay out of the score until a named reviewer decides, and the decision is audited.
4. The event log of FR-TIM-04 is complete and holds only ids and metadata.
5. Deployed and verified on the VMs through epic-environments-and-deployment.

## Boundaries

The attempt engine, scoring, time and anti-cheat. Not the consent screen and invites (initiative-platform) and not the dashboards.

## References

- parent, docs/bmad/initiative-lab/initiative-lab.md
- prd, docs/prd/PRD.md, sections 5.4, 5.9, 5.10, 5.12 and Appendix A
- decision, initial.md D-22, D-32

## Notes

- Handoff: provides AttemptPort and ReportPort to stream P; consumes AuditPort, OutboxPort, KeyPort, ScopePort.
- Open question: when the 120-minute clock starts (OI-22).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
