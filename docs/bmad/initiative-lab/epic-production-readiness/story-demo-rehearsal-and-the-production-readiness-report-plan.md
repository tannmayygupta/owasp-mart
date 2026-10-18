---
title: 'Demo rehearsal and the production-readiness report'
type: 'feature'
ticket: '6'
created: '2026-10-18'
status: 'in-progress'
baseline_revision: 'b0f11dd'
route: 'full'
risk: 'medium'
---

## Intent
Rehearse the demo on the deployed system and the laptop fallback, record the problems, and write the readiness report.

## Result (honest state, 2026-10-18)
The readiness report is written: docs/audit/2026-10-18-lab-stream-audit.md (six blockers, majors, per-task verdicts, what Akshay and Sahil must deliver, fix plan). Blocker B2 (certificate renewal hook) is fixed and deployed. The rehearsal itself has not been run (a human step). Stays in progress until it is, and until blockers B1 and B3 to B6 are fixed or accepted.

CI of the audit pull request needed a second round (tests that pinned the old renewal hook, the shared cloud-init template); see the dev-log of the audit.

Audit blockers B1 (activity to the orchestrator) and B6 (activity gate on pasted flags) are fixed in code with tests (docs/dev-log/2026-10-19-tannmayygupta-audit-fixes-b1-b6.md); live proof follows. B2 was fixed on 2026-10-18.
