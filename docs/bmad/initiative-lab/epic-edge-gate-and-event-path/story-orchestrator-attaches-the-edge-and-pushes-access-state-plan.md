---
title: 'Orchestrator attaches the edge to instance networks and pushes access state to the gate'
type: 'feature'
ticket: '3'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/adr/0005-instance-network-and-event-path.md', '{project-root}/docs/adr/0010-docker-socket-proxy.md']
---

<frozen-after-approval reason="human-owned intent, do not modify unless human renegotiates">

## Intent

**Problem:** The orchestrator builds one internal network per instance (`vm-<id>-e<epoch>-net`, `builder.py:415`) and never connects an edge to it, and nothing tells the gate who owns an instance or whether its access is open, frozen or closed. `set_access` only changes the orchestrator's own record (`engine.py:636-648`).

**Approach (D-61, D-63, D-66):** One internal network per instance stays (the two-network design of ADR 0005 is deferred; the shop can reach the edge's legs on its own network, which is acceptable because the gate needs a cookie and the relay needs an event key, and is written down as residual risk). New settings, all off by default so current behaviour and tests do not change: `--edge-container NAME` (the container to connect) and `--gate-url URL` plus `--gate-admin-key-file`. Backend: two methods `connect_edge(network)` and `disconnect_edge(network)` (SdkBackend through the Docker API `connect_container_to_network` and `disconnect_container_from_network`, no alias, the edge is addressed by its container name; the fake backend records the calls). Engine: connect after the sidecar is started and healthy and before `ready` is reported (a failed connect is a start failure, retried by the existing retry); disconnect inside `_sweep` before `remove_network` (a network with an endpoint cannot be removed). A `GatePort` (HTTP client of story 1's admin API, 3 s timeout, no retry inside the call, key from the file, never logged) pushes `{hostname, instance_id, epoch, owner (owner_hash), access, access_epoch}` on: ready after create, ready after reset (new epoch), `set_access` (push first, then change the record; a push failure fails the IF-5 call with the existing backend-error problem and changes nothing), destroy (DELETE), and once at start from the reconciler pass (full `sync` of every record) and again after every reconcile that repaired something. The docker-proxy rules (`infra/compose/docker-proxy/rules.cfg`) gain exactly `POST /networks/vm-*/connect` and `.../disconnect`; the body (which container) cannot be restricted by the proxy, so the second line is the orchestrator itself, which only ever connects the configured edge name (stated in ADR 0010).

## Boundaries & Constraints

**Always:** With no edge setting the engine behaves exactly as now and all existing tests pass unchanged. The edge is attached with no network alias. A crash between connect and ready leaves nothing: the sweep disconnects and removes. `GatePort` bodies are validated with the story-1 shape; the gate's 409 (stale epoch) is treated as success when the gate already holds an equal or higher epoch with the same value, otherwise as a failure. `closed` is pushed when an instance moves to `stopping`, before objects are removed. Reconcile may push, never open: a record adopted as `ready` has access `closed` (engine.py:282-298) and is pushed as closed until the platform opens it.

**Never:** IF-5 or other contract changes (the push is not a platform-facing call); the edge container's definition (story 2); the platform API, `apps/api` (handoffs only, story 5); AWS, VM-I, SSH; `.github/workflows/**`; commits and pushes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No edge settings | defaults | no connect, no push | none |
| Create | edge set, stub instance | edge connected, gate holds the record with access closed, `ready` | connect failure = INST-START-FAILED, retried once, nothing left |
| Open | `access open, epoch n+1` | gate updated, then record updated | gate down: call fails, record unchanged |
| Freeze, close | `frozen`, `closed` | gate refuses at once | as above |
| Reset | new epoch | old objects removed (edge disconnected first), gate gets the new epoch and container name | none |
| Destroy | any state | gate record removed, edge disconnected, nothing left, `find` empty | a disconnect error counts as a sweep error and a repeat retries |
| Restart | orchestrator restarts with live instances | reconcile pushes a full sync, all closed or as recorded | gate down: logged, retried on the next pass |
| Proxy | connect and disconnect for `vm-*` | allowed | `platform-*` or any other network: 403 |

</frozen-after-approval>

## Code Map

- `apps/orchestrator/src/vulnmart_orchestrator/backend.py:55-70` (the backend protocol), `:253` (`create_network`), `:259-285` (`create_container`), `:356-358` (`remove_network`); the fake backend near `:204-238` -- add the two methods.
- `apps/orchestrator/src/vulnmart_orchestrator/engine.py:404` (`_run`), `:451` (`_wait_healthy`), `:636-648` (`set_access`), `:689-715` (`_run_destroy`, `_sweep`), `:282-298` (`register_found`), `:269-280` (`reconcile`); `lifecycle.py` `Settings` (60 lines) -- settings.
- `apps/orchestrator/src/vulnmart_orchestrator/service.py:372-374` (`_access`), `:454-477` (command line) -- three new options; `reports.py:32-68` (the pattern of a signed, loopback-or-TLS HTTP client with a timeout) -- model for `gate.py` (new `apps/orchestrator/src/vulnmart_orchestrator/gate.py`).
- `infra/compose/docker-proxy/rules.cfg:32-35` (network ACLs) and `:46-49` (allow lines) -- add connect and disconnect ACLs.
- `apps/orchestrator/tests/test_docker_integration.py:42-125` (fixtures, `make`, `reduced_template`) -- new `test_edge_attach.py` using a tiny fake gate (a Python http.server in the test) and a throwaway edge container on the Docker daemon; tests for the proxy rules next to the story-2 proxy tests.
- Docs: ADR 0005 text (D-61 and D-66 recorded as Proposed), ADR 0010 sentence, dev-log, CHANGELOG, traceability FR-INS-10, FR-SES-04, NFR-SEC-04, evidence `docs/assets/story-5-3-orchestrator-edge/`, handoffs H-64 (answer: unrelated, stays), new row for the gate secret and `--edge-container` in `docs/runbooks/deploy.md` as a numbered section.

## Tasks & Acceptance

**Execution:**
- [ ] `gate.py` -- `GatePort` (HTTP client) and `NullGate`
- [ ] `backend.py`, `engine.py`, `lifecycle.py`, `service.py` -- connect, disconnect, pushes, settings, options
- [ ] `rules.cfg` -- connect and disconnect for `vm-*` only, with tests
- [ ] `apps/orchestrator/tests/test_edge_attach.py` and fake-backend unit tests -- matrix rows
- [ ] docs -- as listed, story `built`

**Acceptance Criteria:**
- Given Docker Desktop and the stub image, when create, open, freeze, reset and destroy run with the edge container and the fake gate, then the gate saw exactly the expected pushes in order and `docker network ls` and `docker ps -a` show no `vm-` object after destroy.
- Given the gate is down, when an access call is made, then it fails and the recorded access is unchanged.
- Given no edge setting, then the whole existing orchestrator suite passes unchanged.

## Design Notes

Proposed (decided on the developer's delegation): D-61 single internal network per instance with the edge attached to it, two-network split deferred (residual: the shop of an instance can talk to the edge's player and relay listeners on its own network; it has no cookie and no key; the relay refuses unsigned events at the ingest); D-66 proxy rules for connect and disconnect, body not restrictable; D-63 push before record so a gate failure never leaves the platform believing an instance is open when the gate is not. The orchestrator is the only writer of gate state; the platform never talks to the gate.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests` -- expected: pass (Docker running; the new file included)
- `node --test scripts/check-lab-compose-rules.test.mjs` -- expected: pass
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass

## Follow-up 2026-10-17 (story edge-6)
H-343 decided by the developer: the orchestrator runs as a container on labs-core. Compose service orchestrator added and proven locally (30 checks PASS, re-run by the coordinator); dev-log 2026-10-17-tannmayygupta-story-edge-6-orchestrator-container.md; open points in H-347.

## Follow-up 2026-10-17 (story edge-7)
State reports: platform receiver built in the lab runtime and proven locally (27 checks, receiver restart); dev-log 2026-10-17-tannmayygupta-story-edge-7-state-reports.md. Live vm-p and vm-i use is the developer's run.

Follow-up 2026-10-17: live-check helpers for state reports (make-test-certs.ps1, orch_smoke.py), dev-log 2026-10-17-tannmayygupta-live-check-helpers-state-reports.md.
Follow-up 2026-10-18: make-test-certs.ps1 fixed for a Windows openssl without a config file.
Follow-up 2026-10-18: state reports proven live on vm-i and vm-p (H-347 point 1 closed); dev-log 2026-10-18-tannmayygupta-h147-state-reports-live.md.

Follow-up 2026-10-18: main merged into the branch; handoff ids of stream L renumbered to H-327..H-347 (see dev-log 2026-10-18-tannmayygupta-merge-main-and-handoff-renumbering.md).
