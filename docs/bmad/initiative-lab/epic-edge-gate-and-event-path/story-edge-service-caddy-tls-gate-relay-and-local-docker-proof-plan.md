---
title: 'Edge service: Caddy TLS in front of the gate, the event relay and a real Docker proof'
type: 'feature'
ticket: '2'
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
context: ['{project-root}/docs/adr/0005-instance-network-and-event-path.md', '{project-root}/docs/architecture/03-origins-and-access.md']
---

<frozen-after-approval reason="human-owned intent, do not modify unless human renegotiates">

## Intent

**Problem:** The gate of story 1 is a library. There is no running edge: no TLS for instance hostnames, no routing into instance networks, no event relay, and the claim that one edge can sit on many instance networks (spike S-15) and route only a strict hostname is untested.

**Approach:** Two containers in the `lab` compose profile. (1) `edge-caddy`: stock Caddy, same image digest as `infra/caddy/compose.p.yaml`, TLS from certificate files (wildcard file names read from a mounted folder), a host matcher that accepts only `^i-[a-z2-7]{16}\.<zone>$` and proxies everything else to a fixed 404; it sends matched requests to `edge-gate:8080` and adds no security header (D-62). (2) `edge-gate`: `apps/edge/src/server.mjs` runs the gate of story 1 (player listener 8080, admin listener 9090 on `labs-core` only, relay listener 8081 not published). Player proxying goes to `vm-<id>-e<epoch>-sidecar:8080` by its unique container name (the alias `sidecar` is the same in every network and would be ambiguous for a hub, D-62). The relay (D-64) accepts only `POST /internal/v1/events`, one JSON body of at most 16 KiB, content type `application/json`, a small per-peer rate limit, a 10 s timeout, and forwards the bytes unchanged to the configured ingest URL (private link in production, the fake ingest locally); it holds no event keys. No instance container publishes a host port: the edge is the only one with `ports`, and the lab compose rules check (`scripts/check-lab-compose-rules.mjs`) gets a test for that. In this story the test itself attaches the edge to instance networks with `docker network connect` (the orchestrator does it in story 3).

## Boundaries & Constraints

**Always:** Edge images pinned by digest, non-root where Caddy allows it, read-only root with tmpfs, `cap_drop ALL` (Caddy only `NET_BIND_SERVICE`), `no-new-privileges`, memory and pid limits. `edge-gate` has no Docker socket and no route to the platform except the ingest URL. Ports: 443 published for Caddy (and 80 not published, D-28), 8080 and 9090 and 8081 never published. Plain HTTP between Caddy and the gate and between gate and sidecar on private Docker networks (architecture 03 section 2.5, D-35). Local TLS test uses a throwaway self-signed certificate made in a temp folder by openssl (skip with a message without openssl), like `scripts/e2e/caddy-origin.e2e.test.mjs`. Stub instances in the test are the existing stub image (`contracts/mocks/stub-instance/Dockerfile`) run as sidecar and shop with the container names the builder would give (`vm-<id lower>-e1-sidecar`), on `--internal` networks.

**Never:** Orchestrator, API or docker-proxy changes (story 3); real certificates, DuckDNS, AWS, VM-I, SSH; `.github/workflows/**`; `contracts/**` except what story 1 added; commits and pushes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner path | ticket, cookie, state open, edge on the instance network | shop page of that instance only | none |
| Second account | other owner hash in the ticket | refused | gate page |
| Edited hostname | cookie of A sent to host of B | refused, B's sidecar not touched | gate page |
| Foreign Host or IP access | `Host: localhost`, bare IP, wrong zone | Caddy answers 404, gate not reached | none |
| Frozen then closed | admin push | 423 then 410 at once, no stub request seen | none |
| 20 networks | 20 stub instances, edge attached to all | each hostname reaches its own instance (unique marker per instance) | none |
| Instance cannot reach the edge's other legs | stub shop tries `edge-gate:9090` of another network | not reachable (no route between networks) | recorded as result |
| Relay good | one signed stub-sidecar event | forwarded unchanged, fake ingest answers 202 | none |
| Relay bad | wrong path, GET, two events in an array, body over 16 KiB, wrong content type | 404, 405, 422-style refusal, 413, 415 and the ingest never sees them | problem body (IF-8 format) |
| Host port | any instance container | no published port (inspect shows none) | assert |

</frozen-after-approval>

## Code Map

- `apps/edge/src/server.mjs` (new, wires story 1) and `apps/edge/src/relay.mjs` (new); `contracts/mocks/stub-instance/edge.mjs:14-24` (the stub relay filter to match: exact path, 404 otherwise) and `common.mjs` `passThrough`/`sendProblem` (behaviour reference).
- `infra/compose/compose.yaml` lines 7-9 (profile comment: `lab` lists orchestrator, socket proxy, edge, gate) -- add `edge-caddy` and `edge-gate` under `lab`, network `labs-core` (the story-2 `docker-proxy` already uses it) plus `edge-public`; build `edge-gate` from `apps/edge/Dockerfile` (new).
- `infra/caddy/Caddyfile.p`, `origin-gate.caddy`, `compose.p.yaml` (read, same Caddy digest and TLS-from-files shape); new `infra/caddy/Caddyfile.l` (labs edge) with the host regex matcher.
- `scripts/check-lab-compose-rules.mjs` and its test -- add: only `edge-caddy` may publish a port and only `443`; no `8080`, `8081`, `9090` published.
- `scripts/e2e/caddy-origin.e2e.test.mjs` (read: the pattern for Docker, openssl and temp secrets) -> new `scripts/e2e/edge.e2e.test.mjs`.
- `contracts/mocks/fake-ingest/server.mjs` (the relay target) and `contracts/mocks/stub-instance/sidecar.mjs:60` (`relayUrl`, default `http://edge:8081/internal/v1/events`; the real name is set by the test).
- Docs: dev-log, CHANGELOG, traceability FR-INS-10, NFR-ISO-04 (S-15 local part), evidence `docs/assets/story-5-2-edge-service/`, handoff answers H-75 (relay part).

## Tasks & Acceptance

**Execution:**
- [x] `apps/edge/src/server.mjs`, `relay.mjs`, `Dockerfile` -- listeners, relay rules, image
- [x] `infra/caddy/Caddyfile.l` and the compose services -- TLS, host matcher, 404 default, hardening
- [x] `scripts/check-lab-compose-rules.mjs` + test -- the port rule
- [x] `scripts/e2e/edge.e2e.test.mjs` -- the matrix on real Docker (20-network case parameterised; fall back to 6 if Desktop is slow, and record the number actually run)
- [ ] docs -- dev-log with real output, CHANGELOG, traceability, evidence, story `built`

**Acceptance Criteria:**
- Given Docker Desktop, when the e2e test runs, then every matrix row passes and the test leaves no container, network or temp folder.
- Given `node scripts/check-lab-compose-rules.mjs`, then PASS and a test shows a service that publishes `8080` fails.
- Given the relay and the fake ingest, then one event is 202 at the ingest and each bad request never reaches it.

## Design Notes

Proposed (decided on the developer's delegation): D-62 the edge is stock Caddy for TLS and host matching in front of an own small gate service (Caddy has no ticket or epoch logic; `forward_auth` would add a second hop and the cookie exchange needs a redirect, so the gate is the single decision point); D-64 the relay holds no keys and only shapes traffic. What this proves locally: routing, refusal, many networks on one Docker Desktop daemon, no host ports. What it does not prove: Linux iptables behaviour on vm-i, the wildcard certificate, DuckDNS name resolution, the private link to vm-p (story 5 runbook).

## Verification

**Commands:**
- `docker build -f apps/edge/Dockerfile -t vulnmart-edge:local .` -- expected: success
- `node --test apps/edge/test/*.test.mjs` -- expected: pass
- `node --test scripts/e2e/edge.e2e.test.mjs` -- expected: pass (Docker Desktop running; openssl for the TLS test)
- `node --test scripts/check-lab-compose-rules.test.mjs` and `node scripts/check-lab-compose-rules.mjs` -- expected: pass
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass

## Implementation Notes

Built 2026-10-17 (implementer agent; review, docs, evidence screenshots, handoff row H-75 and the commit are the main session's). Not yet reviewed, not committed.

**Built:**
- `apps/edge/src/relay.mjs` (the relay of D-64: POST `/internal/v1/events` only, 16 KiB cap exact and counted for chunked bodies too, `application/json`, a header `X-VM-Signature` of the shape `v1=<64 hex>` (shape only, no key), body must be one JSON object, per-peer fixed-window limit 120 per 10 s, 10 s limit, forwards the same bytes and the same signature header to `EDGE_INGEST_URL`; IF-8 problem bodies, titles checked against `contracts/errors/error-codes.yaml` by a test), `apps/edge/src/server.mjs` (player 8080, admin 9090, relay 8081 around the gate and admin of story 1; reads keys and the admin secret from files; proxies to `vm-<id lower>-e<epoch>-sidecar:8080` by name, strips the gate cookie, logs method and status only), `apps/edge/Dockerfile` (node 24.21.0-alpine, same digest as the stub and vm-p probe, no dependencies, user 65532).
- `infra/caddy/Caddyfile.l` and, in `infra/compose/compose.yaml`, services `edge-gate` and `edge-caddy` (profile `lab`) plus network `edge-public`. Caddy image: `caddy:2.10-alpine@sha256:4c6e91c6...530d`, the same tag and digest as `infra/caddy/compose.p.yaml`. Matcher: `host *.{$EDGE_ZONE}` AND `header_regexp Host ^i-[a-z2-7]{16}\.{$EDGE_ZONE}$`, everything else a fixed 404, no security header, ticket query and cookies redacted in the logs.
- `scripts/check-lab-compose-rules.mjs` (new rule `checkLabPorts`) and 5 new tests in its test file: in a service with profile `lab` only `edge-caddy` may publish, only `443:443`, and 8080, 8081 and 9090 are never published.
- Tests: `apps/edge/test/relay.test.mjs` (10) and `server.test.mjs` (8), both without Docker; `scripts/e2e/edge.e2e.test.mjs` (11) on real Docker.

**Decisions made while building (for the main session to record or the developer to change):**
1. Listener isolation by bind alias, not by 0.0.0.0. The edge is attached to many instance networks; a listener on 0.0.0.0 is reachable from each of them. So `EDGE_ADMIN_BIND_HOST=edge-gate-admin` (alias on labs-core only) and `EDGE_PLAYER_BIND_HOST=edge-gate-player` (alias on edge-public only) are resolved at start and bound to that one address; only the relay is on every leg. A name that does not resolve ends the process (fail closed). The e2e test proves an instance gets ECONNREFUSED on 8080 and 9090 on its own leg and ENETUNREACH to every other leg.
2. Key file format of the gate key: at least 64 hex characters in one file (the contract only says 32 bytes). Stream P must sign with the same bytes; a handoff row is needed (the contract file was not touched).
3. `edge-caddy` runs as root with `cap_drop ALL` + `NET_BIND_SERVICE`, like vm-p, because the lego private key is root-only (H-115); the plan said "non-root where Caddy allows it". `edge-gate` is non-root (65532), read-only, no Docker socket.
4. Relay refusal of a missing or malformed signature header is 401 `EVT-BAD-SIGNATURE` (shape only; the ingest still verifies); not-JSON and non-object bodies are 422 `EVT-SCHEMA`; an unreachable or slow ingest is 500 `REQ-INTERNAL` (no 502/504 code exists in the registry; the sidecar retries on it).
5. Compose host paths for certificates and secrets default to `/opt/vulnmart/lab/certs/live` and `/opt/vulnmart/lab/secrets` (overridable by `VULNMART_EDGE_CERTS`, `VULNMART_EDGE_SECRETS`); story 5 (runbook) must confirm. `VULNMART_LABS_ZONE` defaults to `labs.invalid` so `docker compose config` works without setup.
6. The e2e test builds the stub image (`vulnmart-stub-instance:local`) and the edge image (`vulnmart-edge:local`) itself, and starts the edge and Caddy with the run flags read from `infra/compose/compose.yaml` (single source). Differences from compose: 443 published on `127.0.0.1` with a free host port, networks made by the test, the stub shop is given a marker through its stub flags file (a throwaway string, not a flag).

**Real results (raw output: `docs/assets/story-edge-2-edge-service/test-output.txt`):**
- `docker build -f apps/edge/Dockerfile -t vulnmart-edge:local .`: exit 0.
- `node --test apps/edge/test/*.test.mjs`: tests 95, pass 95, fail 0 (77 of story 1 unchanged, 18 new).
- `node --test scripts/check-lab-compose-rules.test.mjs`: tests 13, pass 13; `node scripts/check-lab-compose-rules.mjs`: PASS (3 files).
- `node --test scripts/e2e/edge.e2e.test.mjs`: tests 11, pass 11, fail 0, about 64 s, on Docker Desktop (server 29.6.2). **20 internal networks** run (20 stub instances = 40 containers, plus gate, ingest, Caddy; the gate on 22 networks). No fall-back to 6 was needed.
- Leftovers: the test's own `after` check and a manual `docker ps -a` and `docker network ls` with `label=vm.kind=edge-test` show 0 containers and 0 networks, temp folder removed. Built images stay in the local cache.
- `node scripts/scan-secrets.mjs`: PASS. `node scripts/check-text-files.mjs`: files of this story pass; the only FAIL is `services/sidecar/test/events.test.mjs:68` (replacement character), a file of another agent's work in the same tree, not touched here.
- Recorded isolation results (from the test): relay port reachable on the own leg; own-leg 8080 and 9090 ECONNREFUSED; edge IPs on labs-core, edge-public and another instance network, and another instance's sidecar IP: ENETUNREACH; names of other legs' aliases, other instances and Caddy do not resolve (EAI_AGAIN).
- Dead ends: first e2e run failed one assertion because a default parameter turned `secret: undefined` into the real secret (test bug, fixed with `null`). Node gives `set-cookie` as an array (unit test fix).

**Not proved here (as in the plan):** Linux iptables behaviour on vm-i, the wildcard certificate, DuckDNS, the private link to vm-p.

**Open problems:** (a) handoff for the key file format (decision 2) and for the secret and certificate paths (decision 5) to stream P and the runbook story; (b) the rate limit default (120 per 10 s per peer address) is a guess; (c) `edge-gate` binding by alias needs the orchestrator (story 3) to keep the alias `edge-gate-admin` on labs-core; (d) the relay supports `http` ingest URLs only (private link); (e) the Docker `restart: unless-stopped` plus the alias wait means a start before the networks exist retries for 10 s then exits, compose restarts it.