---
title: 'Local end-to-end demo of sprints 1 and 2 for the guide meeting'
type: 'feature'
ticket: '17'
created: '2026-10-13'
status: 'built'
baseline_revision: '0a2a43b'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'developer asked for minimal tokens'
lenses_ran: []
review_loop_iteration: 0
context: ['docs/bmad/initiative-lab/epic-lab-baseline/tickets.toml']
---

## Intent
**Problem:** The guide meeting needs proof that the work of all three streams runs together on one machine, with one command and a clear result.
**Approach:** `node scripts/dev.mjs demo [--keep] [--stub-only] [--no-web]` starts the platform stack (own Compose project name), builds the stub and the real shop image, starts the real Python orchestrator on a free loopback port with a random temporary key and a reduced two-component template, drives it with the platform's own `HttpInstanceHost` client (`scripts/demo_client.py`), prints a PASS/FAIL step table, saves redacted evidence, and removes everything in a finally block. The real shop is tried in the shop role and the stub is the automatic fallback.
**Never:** touch containers or volumes not named or labelled by this project (the machine has an unrelated volume `n8n_data`); print or save keys, flags, addresses; push or commit; edit tickets.toml or the task list.

## Done when
`node scripts/dev.mjs demo` runs to the end on the developer machine with every step PASS and nothing left over (docker ps, networks, volumes labelled vm.*); the runbook `docs/runbooks/local-demo.md` lists what to show and say; the pure parts are unit tested.
## Implementation notes (2026-10-13)
- Built as planned; see docs/dev-log/2026-10-13-tannmayygupta-local-demo.md. Real run: every step PASS in 141 s, nothing left over. The real shop works in the shop role (the manifest `healthchecks` entry gives it a node check, the distroless image has no wget); the stub is used only if the shop image fails to build or reach ready. Review and e2e skills not run.
- Not done: the review and the e2e test generation steps; the developer confirms and closes the story.
