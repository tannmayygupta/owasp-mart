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
