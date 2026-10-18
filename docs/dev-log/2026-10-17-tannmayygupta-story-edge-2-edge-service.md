# Edge service: Caddy TLS in front of the gate, the event relay and a real Docker proof (edge story 2)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (commit of this story follows; not committed when this entry was written) |
| Status | Partly done: edge gate service, relay, Caddy config, compose services and the Docker Desktop end-to-end test built and passed locally; nothing run on vm-i, no real certificate, orchestrator not yet attaching the edge |
| Report tag | edge service, event relay, Caddy, FR-INS-10, NFR-ISO-04, S-15 local part, D-62, D-64 |

## Requirements covered
FR-INS-10, NFR-ISO-04 (local part), spike S-15 (local part); decisions D-62, D-64, D-67 (Proposed, in ADR 0040); handoffs H-75 (relay part answered), H-337 (new, shared with story 1). Tasks L-17 and L-18 (parts; both stay unticked).

## Summary (plain language, 3-5 lines)
The gate of story 1 is now a running edge: stock Caddy terminates TLS and accepts only the strict instance hostname, an own small gate service decides, and a relay forwards signed sidecar events to the ingest without holding any key. On Docker Desktop one gate was attached to 20 internal instance networks, each hostname reached only its own instance, and no instance container published a port. Nothing here ran on the real VM.

## Why
The gate was only a library. There was no TLS for instance hostnames, no routing into instance networks, no event relay, and the claim that one edge can sit on many instance networks (spike S-15) was untested.

## What was built
- `apps/edge/src/server.mjs` (player 8080, admin 9090, relay 8081 around story 1's gate and admin), `relay.mjs` (POST `/internal/v1/events` only, 16 KiB cap, `application/json`, header `X-VM-Signature` shape check only, per-peer limit 120 per 10 s, 10 s timeout, same bytes forwarded to `EDGE_INGEST_URL`, IF-8 problem bodies), `apps/edge/Dockerfile` (node 24 alpine, no dependencies, user 65532).
- `infra/caddy/Caddyfile.l` and services `edge-gate` and `edge-caddy` (profile `lab`) plus network `edge-public` in `infra/compose/compose.yaml`. Caddy image: same tag and digest as `infra/caddy/compose.p.yaml`. Matcher accepts only `^i-[a-z2-7]{16}\.<zone>$`, everything else a fixed 404, no security header, ticket query and cookies redacted in logs.
- `scripts/check-lab-compose-rules.mjs` (new rule `checkLabPorts`) and 5 new tests: in profile `lab` only `edge-caddy` may publish, only `443:443`; 8080, 8081 and 9090 are never published.
- Tests: `apps/edge/test/relay.test.mjs` (10), `server.test.mjs` (8), and `scripts/e2e/edge.e2e.test.mjs` (11, real Docker).

## How it works
Caddy checks the hostname and proxies to `edge-gate:8080`. The gate proxies allowed requests to `vm-<id lower>-e<epoch>-sidecar:8080` by its unique container name (the alias `sidecar` is the same in every network and would be ambiguous for a hub). Listener isolation is by bind alias: admin on `edge-gate-admin` (labs-core only), player on `edge-gate-player` (edge-public only); only the relay is on every leg. A name that does not resolve ends the process (fail closed). The relay holds no event keys; the ingest still verifies signatures.

## Files changed
- `apps/edge/src/{server,relay}.mjs`, `apps/edge/Dockerfile`, `apps/edge/test/{relay,server}.test.mjs` - new
- `infra/caddy/Caddyfile.l`, `infra/compose/compose.yaml` - new service definitions
- `scripts/check-lab-compose-rules.mjs`, `scripts/check-lab-compose-rules.test.mjs` - port rule and tests
- `scripts/e2e/edge.e2e.test.mjs` - new
- `docs/adr/0040-edge-gate-ticket-and-hostname-model.md`, `initial.md`, HANDOFFS, CHANGELOG, traceability, dev1 file
- `docs/assets/story-edge-2-edge-service/test-output.txt`

## Decisions made
D-62 (stock Caddy for TLS and host matching in front of an own gate service; Caddy `forward_auth` rejected because the cookie exchange needs a redirect and it adds a hop), D-64 (relay holds no keys, only shapes traffic), D-67 (local proof boundary). Decisions made while building, to confirm: key file format of the gate key is at least 64 hex characters (the contract only says 32 bytes; stream P must sign with the same bytes, H-337); `edge-caddy` runs as root with `cap_drop ALL` plus `NET_BIND_SERVICE`, like vm-p (the lego private key is root-only), not non-root as the plan wished; relay answers 401 `EVT-BAD-SIGNATURE` for a missing or malformed signature header, 422 `EVT-SCHEMA` for not-JSON or non-object bodies, and 500 `REQ-INTERNAL` for an unreachable or slow ingest (no 502 or 504 code exists); compose host paths default to `/opt/vulnmart/lab/certs/live` and `/opt/vulnmart/lab/secrets`, and `VULNMART_LABS_ZONE` defaults to `labs.invalid`; the e2e test builds the images itself and takes the run flags from the compose file.

## Tests
Raw output in `docs/assets/story-edge-2-edge-service/test-output.txt`.
- `docker build -f apps/edge/Dockerfile -t vulnmart-edge:local .`: exit 0.
- `node --test apps/edge/test/*.test.mjs`: tests 95, pass 95, fail 0 (77 of story 1 unchanged, 18 new).
- `node --test scripts/check-lab-compose-rules.test.mjs`: tests 13, pass 13; `node scripts/check-lab-compose-rules.mjs`: PASS (3 files).
- `node --test scripts/e2e/edge.e2e.test.mjs`: tests 11, pass 11, fail 0, about 64 s, on Docker Desktop (server 29.6.2). 20 internal networks were run (40 stub containers plus gate, ingest and Caddy; the gate on 22 networks). No fall-back to 6 was needed.
- Leftovers after the run: 0 containers and 0 networks with the test label, temp folder removed; built images stay in the local cache.
- `node scripts/scan-secrets.mjs`: PASS. `node scripts/check-text-files.mjs`: files of this story pass; the only FAIL was `services/sidecar/test/events.test.mjs:68` (replacement character), another agent's file in the same tree.
Recorded isolation results: relay port reachable on the own leg; own-leg 8080 and 9090 ECONNREFUSED; edge IPs on labs-core, edge-public and another instance network, and another instance's sidecar IP: ENETUNREACH; names of other legs' aliases, other instances and Caddy do not resolve (EAI_AGAIN).
Traceability rows: FR-INS-10, NFR-ISO-04, S-15, D-62, D-64, D-67.

## Evidence
`docs/assets/story-edge-2-edge-service/test-output.txt`. No screenshots.

## Problems met and how they were fixed
- First e2e run failed one assertion because a default parameter turned `secret: undefined` into the real secret (a test bug, fixed with `null`).
- Node returns `set-cookie` as an array (fixed in a unit test).

## Security notes (vulnerable parts only)
Not a vulnerable part; this is platform isolation. Residual risk to keep visible: the orchestrator is not yet attaching the edge, so the one-network-per-instance residual (D-61, planned) is not yet exercised outside the test.

## Limitations and follow-ups
- Not proved here: Linux iptables behaviour on vm-i, the wildcard certificate, DuckDNS resolution (S-16), the private link to vm-p, a real browser.
- The rate limit default (120 per 10 s per peer address) is a guess. The relay supports `http` ingest URLs only (private link).
- `edge-gate` binding by alias needs the orchestrator (planned story 3 of the epic) to keep the alias `edge-gate-admin` on labs-core.
- `restart: unless-stopped` plus the alias wait means a start before the networks exist retries for 10 s then exits and compose restarts it.
- Handoffs for the key file format and the secret and certificate paths: H-337.
