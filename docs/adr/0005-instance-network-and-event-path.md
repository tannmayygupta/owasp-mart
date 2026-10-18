# 0005. Instance network topology and event path

- **Status:** Accepted by the user (D-28); my naming and relay details are Proposed refinements
- **Date:** 2026-10-08
- **Deciders:** the user (D-28)
- **Requirements:** D-23, NFR-ISO-01, 04, 07; FR-DET-04, FR-INS-10

## Context
Instance networks are internal with no route out, yet the edge must reach every instance and the sidecar must send signed events upward.

## Options considered
1. Two internal networks per instance; the edge is attached into the second network, which also carries the sidecar's event call.
2. One shared ingress network for all sidecars: lateral paths between sidecars.
3. Event relay through a host port with an INPUT exception: weakens the host drop rule.
4. One central WAF instead of per-instance sidecars: contradicts D-23.

## Decision
Option 1 (D-28). D-28 names the networks `app` and `ctl` and attaches a platform-side edge and a separate event collector into `ctl`. My design names them `inst-<id>` and `front-<id>` and lets the **edge itself relay** events on a non-published listener to the platform's private ingest, instead of a separate collector. Reason: one fewer container attached to every network, and the relay is a single path-restricted route. Acceptable because the edge already sits on that network and the route accepts only the event path with size limits; ingest still verifies per-instance signatures. If you prefer D-28's separate collector, the relay moves to its own container with no other change. Docker's address pool is enlarged (spike S-15).

## Consequences
No lateral path between instances; the edge is a hub, so it stays minimal and patched.

## Evidence
https://docs.docker.com/reference/cli/docker/network/create/ (VERIFIED); https://caddyserver.com/docs/caddyfile/directives/reverse_proxy (VERIFIED). See docs/architecture/03-origins-and-access.md section 4.

## Update 2026-10-17 (edge story 3, D-61 and D-66; Proposed, decided by Claude Code on the developer's delegation, not yet confirmed by the developer)
- **D-61 single internal network per instance for now.** The orchestrator keeps one internal network per instance (`vm-<id>-e<epoch>-net`) and connects the one configured edge container to it (`--edge-container`), with no network alias: the edge is addressed by its container name. The two-network design above (Option 1) is deferred. Residual risk, written down on purpose: the shop of an instance can reach the edge's player and relay listeners on its own network. It has no cookie (the gate refuses it) and no event key (the ingest refuses unsigned events), and the edge's other networks are not reachable from an instance network (measured in edge story 2, `docs/assets/story-edge-2-edge-service/`).
- **Order.** The edge is connected after the sidecar is healthy and before `ready` is reported; a failed connect is a start failure (retried by the existing retry). The edge is disconnected inside the sweep before the network is removed (a network with an endpoint cannot be removed). A crash in between leaves nothing: the sweep disconnects and removes.
- **D-66 proxy rules.** The socket proxy gains exactly `POST /networks/vm-*/connect` and `POST /networks/vm-*/disconnect` (`infra/compose/docker-proxy/rules.cfg`). The body (which container) cannot be restricted by the proxy; the second line is the orchestrator, which only ever connects the configured edge name.
- **D-63 push before record.** The orchestrator is the only writer of gate state. It pushes `{hostname, instance_id, epoch, owner, access, access_epoch}` at ready (create and reset), on every access change (gate first, record second; a failed push fails the IF-5 call and changes nothing), a `closed` push when destruction starts, a delete after the sweep, and a full sync at start and after every reconcile pass that repaired something.
- Proof: `apps/orchestrator/tests/test_edge_fake.py` (fake backend), `test_gate_port.py` (HTTP client), `test_edge_attach.py` and the proxy test in `test_docker_integration.py` (Docker Desktop). Nothing was run on vm-i.
