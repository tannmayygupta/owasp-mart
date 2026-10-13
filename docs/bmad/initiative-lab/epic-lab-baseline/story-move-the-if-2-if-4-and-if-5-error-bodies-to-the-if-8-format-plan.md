---
title: 'Move the IF-2, IF-4 and IF-5 error bodies to the IF-8 format (condition F-2 of the contracts sign-off)'
type: 'feature'
ticket: '16'
created: '2026-10-12'
status: 'done'
baseline_revision: '4005bfd'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'developer asked for minimal tokens'
lenses_ran: []
review_loop_iteration: 0
context: ['docs/reviews/2026-10-11-if8-change-request-for-stream-l.md']
---

## Intent
**Problem:** Stream P signs contracts v1.0.0 only if IF-2, IF-4 and IF-5 answer errors in the closed IF-8 body. After the tag this would be a breaking change.
**Approach:** Follow the change request file exactly (it lists every difference). Change contracts, schemas, examples, Node fake orchestrator and ingest, the Python client, the Python orchestrator service and all tests; bump contract versions and changelog per the contract rules.
**Never:** touch Akshay's apps/web or table owners; invent codes (use the registry `contracts/errors/error-codes.yaml`, add new ones there only if the change request says so); change the signing or states.

## Done when
Every error answer of the fake orchestrator, the Python service, the fake ingest and the mock validates against `contracts/errors/problem.schema.json`; contract-rules 0 FAIL; orchestrator, api and script tests pass (known unrelated failure: generate-api-code CRLF).

## Implementation notes (2026-10-12/13)
- Built as planned; see docs/dev-log/2026-10-12-tannmayygupta-if8-error-bodies.md. Versions: IF-2 0.3.0, IF-4 0.3.0, IF-5 0.4.0 (BREAKING, 0.x), IF-6 0.3.2 (wording), IF-8 0.4.0 (3 codes added: ORCH-CURSOR-INVALID, ORCH-UNSUPPORTED-MEDIA-TYPE, ORCH-NOT-IMPLEMENTED).
- Real results: contract rules 25 PASS 0 FAIL; orchestrator tests 225 passed, 1 timing failure (rate limit test, same at base); python-service api suites 393 passed 18 skipped; default api suite 953 passed 2 failed then fixed (re-run of those tests passed); node scripts 705 pass 0 fail; e2e and platform-mock 53 pass; text-files and secrets PASS.
- Not done: stub sidecar answers on /v1/events keep their shape; platform-api.md (stream P) still says IF-2 keeps its own error bodies; Approvals stay pending.
