---
title: 'Cold-start time and memory per instance on vm-i (spike S-4)'
type: 'feature'
ticket: '3'
created: '2026-10-12'
status: 'built'
baseline_revision: 'd8ebce3'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'none'
review_source: 'developer asked for minimal tokens'
lenses_ran: []
review_loop_iteration: 0
context: []
---

## Intent
Scripts and a runbook for the developer to measure cold start and memory per instance on `vm-i`, and to record the result (S-4).

## Built (2026-10-12)
- `apps/orchestrator/src/vulnmart_orchestrator/measure.py` (tool), `apps/orchestrator/tests/test_measure.py` (6 tests), `docs/runbooks/measure-instances.md`, `docs/research/s4-cold-start-and-memory.md` (table pending).

## Not done (developer's)
The run on `vm-i` and pasting its redacted output; then the research table, `docs/assets/orchestrator-measure/` and the defaults for story 3.4 are filled. Story stays `built`, not `done`, until then.
