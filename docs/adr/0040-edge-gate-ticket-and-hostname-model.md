# 0040. Edge, gate, ticket and strict hostname model

- **Status:** Proposed (decided on the developer's delegation; to be confirmed). D-61, D-65, D-66 are planned only: their stories are not built.
- **Date:** 2026-10-17
- **Deciders:** Tanmay (by delegation to Claude Code)
- **Requirements:** FR-INS-10, FR-SES-04, FR-SES-11, NFR-ISO-04, NFR-SEC-04, D-60 to D-68; ADR 0004 (accepted for Option 1 by this decision), ADR 0005, ADR 0009; spike S-15; handoffs H-75, H-336, H-337, H-338

## Context
Only the owner may reach an instance, a frozen or closed instance must refuse requests, a newer login must cut the older browser session, and one edge must serve many instance networks without publishing any instance port. The stub gate allowed everything and no ticket, cookie or push format existed. Stories built so far: gate core (library, admin handlers, contract `GATE` 0.1.0) and the edge service (Caddy, gate service, relay, compose, Docker Desktop end-to-end test). The orchestrator attaching the edge (D-61, D-66), the ingest verifier and the one-session story are planned, not built.

## Options considered
1. **Ticket and host-only cookie checked by an own small gate service behind stock Caddy (chosen, D-60, D-62).** Caddy has no ticket or epoch logic; its `forward_auth` would add a second hop and the cookie exchange needs a redirect, so the gate is the single decision point.
2. **Caddy `forward_auth` to a decision service.** Extra hop, redirect handling split in two places.
3. **mTLS, hostname only, or proxying through the API.** Already rejected in ADR 0004.
4. **Aliased upstream `sidecar:8080`.** Rejected: the alias is the same in every network and ambiguous for a hub; the gate routes to the unique container name `vm-<id lower>-e<epoch>-sidecar:8080` instead (D-68).

## Decision
- **D-60** ADR 0004 Option 1 with refinements (fail closed, single-use ticket in memory, owner hash, two keys for rotation).
- **D-62** Stock Caddy for TLS and strict host matching in front of an own gate service; Caddy adds no security header to shop responses (architecture 03 section 2.4).
- **D-63** The orchestrator pushes access state to the gate through admin handlers (`PUT` and `DELETE /internal/v1/gate/instances/{id}`, `PUT /internal/v1/gate/sync`) protected by a secret read from a file; bodies validated strictly; the access epoch only grows (an equal epoch with another value is 409, like IF-5); contract in `contracts/edge/gate-ticket.md` (id `GATE`, 0.1.0). Planned part: push before record, so a gate failure never leaves the platform believing an instance is open; the orchestrator is the only writer of gate state.
- **D-64** The event relay holds no keys and only shapes traffic: POST `/internal/v1/events` only, one JSON object, at most 16 KiB, content type `application/json`, a small per-peer limit, a 10 s timeout, forwarded unchanged to the ingest URL. The ingest still verifies signatures.
- **D-65 (planned)** The access epoch is the only session-binding mechanism at the gate: the platform bumps it on open and on login; the gate never learns about platform sessions or accounts.
- **D-61 (planned)** One internal network per instance with the edge attached to it; the two-network split of ADR 0005 is deferred. Residual risk: the shop of an instance can talk to the edge's player and relay listeners on its own network; it has no cookie and no key, and the ingest refuses unsigned events.
- **D-66 (planned)** Docker proxy rules for network connect and disconnect; the body cannot be restricted.
- **D-67** Local proof boundary: loopback plain HTTP and a throwaway self-signed certificate; the wildcard certificate, DuckDNS (S-16), vm-i firewall behaviour, the private link and a real browser are runbook steps and stay open until the developer runs them.
- **D-68** Only `^i-[a-z2-7]{16}\.<zone>$` (already lower case, no port, no trailing dot, no userinfo, only the `Host` header) is accepted; anything else is refused before any lookup with the same answer as an unknown instance.

## Consequences
- Easier: one decision point; freeze closes the door at once; refusals look the same for bad ticket, wrong owner and unknown instance.
- Harder: a gate restart closes everything until the orchestrator syncs; freeze, thaw and close each need a higher access epoch, so a cookie from before a freeze does not survive the thaw; listener isolation relies on bind aliases (`edge-gate-admin`, `edge-gate-player`) that the orchestrator must keep.
- To watch: contract `GATE` at 0.1.0 conflicts with tag precondition 5 (every contract 1.0.0) and needs a second listed person (Akshay as consumer) before the tag; 403 versus 410 can be told apart; the relay rate limit default (120 per 10 s per peer) is a guess; `edge-caddy` runs as root with `cap_drop ALL` plus `NET_BIND_SERVICE` because the lego private key is root-only (H-115).
- Not proved: anything on vm-i, the wildcard certificate, Linux iptables behaviour, a real browser. The local Docker Desktop run covers routing, refusal, 20 attached networks and no published host port only.

## Evidence
Local tests only: `docs/assets/story-edge-1-gate-core/test-output.txt` (77 of 77 edge tests, contract checks), `docs/assets/story-edge-2-edge-service/test-output.txt` (95 of 95 edge tests, 11 of 11 end-to-end tests on Docker Desktop with 20 internal networks). No outside source was read for this decision; the cookie `__Host-` prefix, `SameSite` and Caddy behaviour rest on general knowledge and the local tests (UNVERIFIED against vendor documents in this session).
