# Orchestrator attaches the edge to instance networks and pushes access state to the gate (edge story 3)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (not committed when this entry was written) |
| Status | Partly done: built and passed locally (fake backend and Docker Desktop); nothing run on vm-i; one open point on how the host-run orchestrator reaches the gate admin listener (H-143) |
| Report tag | orchestrator, edge attach, gate push, socket proxy, FR-INS-10, FR-SES-04, D-61, D-63, D-66 |

## Requirements covered
FR-INS-10, FR-SES-04, NFR-SEC-04; decisions D-61, D-63, D-66 (Proposed, delegated, not confirmed by the developer); handoffs H-64 (re-answered, unchanged), H-143 (new).

## Summary (plain language, 3-5 lines)
The orchestrator can now connect the edge container to each instance network and tell the gate who owns an instance and whether it is open, frozen or closed. The gate is told first and the orchestrator's own record changes only after, so a gate that is down fails the access call and nothing changes. All of it is off unless `--edge-container` and `--gate-url` are given.

## Why
The edge could not reach any instance network and the gate knew nothing about instances (story plan, Problem). Required for FR-INS-10 (only the owner reaches an instance) and FR-SES-04 (a frozen instance accepts no player requests).

## What was built
When this session started, the working tree already held the engine, backend, `gate.py`, reconcile, service and proxy-rule changes and the unit tests `test_edge_fake.py` and `test_gate_port.py` (work of the same story by an earlier session). I read them, ran them and did not change them. Added in this session: `apps/orchestrator/tests/test_edge_attach.py` (the real-Docker row of the matrix with the real `GatePort` against a small real HTTP gate), the ADR text, the runbook and the handoff rows.

## How it works
Connect after the sidecar is healthy and before `ready` (a failure is a start failure, retried). `GatePort` pushes `{hostname, instance_id, epoch, owner, access, access_epoch}` at ready (create and reset), on every access change (gate first), a `closed` push when destroy starts, a delete after the sweep, and a full sync at start and after any reconcile pass that repaired something. The sweep disconnects the edge before removing a network. The proxy allows `POST /networks/vm-*/connect` and `/disconnect` only.

## Files changed
- Already in the tree, verified: `apps/orchestrator/src/vulnmart_orchestrator/{gate,backend,engine,reconcile,service}.py`, `infra/compose/docker-proxy/rules.cfg`, `apps/orchestrator/tests/{test_edge_fake,test_gate_port}.py`, connect/disconnect tests in `test_docker_integration.py`
- New in this session: `apps/orchestrator/tests/test_edge_attach.py`, `docs/runbooks/edge-vm-i.md`, `docs/assets/story-edge-3-orchestrator-edge/test-output.txt`
- Text: `docs/adr/0005-instance-network-and-event-path.md`, `docs/adr/0010-orchestrator-privileges-and-host-rule.md`, `docs/dev/HANDOFFS.md` (H-64 note, H-143)

## Decisions made
D-61 one internal network per instance with the edge attached, D-63 gate push before the record, D-66 proxy connect and disconnect rules; written in ADR 0005 and ADR 0010 as Proposed. Alternative not taken: the two-network design of ADR 0005 (deferred).

## Tests
Raw summary in `docs/assets/story-edge-3-orchestrator-edge/test-output.txt`.
- `uv run --locked --package vulnmart-orchestrator pytest apps/orchestrator -q`: 458 passed, 4 warnings (193 s). 457 at the start plus the new `test_edge_attach.py`.
- `uv run --locked --package vulnmart-orchestrator pytest apps/orchestrator/tests/test_edge_attach.py -q`: 1 passed. It runs create, open, freeze, reset, destroy with a throwaway edge container and checks the exact order of pushes, no `vm-` object left, and that a dead gate fails the access call and leaves the record unchanged.
- `node --test scripts/check-lab-compose-rules.test.mjs`: 13 passed. `node --test --test-concurrency=1 scripts/e2e/edge.e2e.test.mjs`: 11 passed.
- `node scripts/scan-secrets.mjs`: PASS on rerun (first run failed on another agent's file). `check-text-files.mjs`: files of this story pass.
Traceability rows (for the developer to add): FR-INS-10, FR-SES-04, NFR-SEC-04.

## Evidence
`docs/assets/story-edge-3-orchestrator-edge/test-output.txt`.

## Problems met and how they were fixed
First attempt at the new integration test passed at once; I added the check of the push order afterwards so it does not pass vacuously. A BOM in files written by PowerShell failed `check-text-files.mjs`; removed. Dead end found while writing the runbook: the gate admin listener has an alias only on the compose network, so an orchestrator that runs on the host (Part E of `deploy.md`) cannot reach it (H-143, not solved).

## Security notes (vulnerable parts only)
Not a vulnerable part (platform isolation). Residual risk: the shop of an instance can reach the edge's listeners on its own network; it has no cookie and no event key (ADR 0005). The proxy cannot restrict which container is connected (ADR 0010).

## Limitations and follow-ups
Nothing run on vm-i. H-143 must be decided before the live attach. The gate's 409 handling and the reconcile sync are covered by the fake-backend tests only, not by Docker.