---
title: 'Shop boundaries and signed app events'
type: 'feature'
ticket: '3'
created: '2026-10-12'
status: 'done'
baseline_revision: 'db4444b'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/contracts/events/app-events.md'
  - '{project-root}/contracts/instance/instance-contract.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-SHP-14 requires the shop, inside an instance, to have no route to the platform database, Valkey, the orchestrator or other instances, and to send its app events through the sidecar so the platform (fake ingest) accepts them. T-04 proved the shop posts a schema-valid body to a fake sidecar; the real sidecar→sign→ingest chain and the network boundary were not yet proven.

**Approach:** A shop-owned Docker harness runs the real shop + the real sidecar + the fake ingest (both from the stub image, fed their start document on stdin), has the shop post one event through its own code (`src/instance/instance.mjs` `postEvent`), and asserts the fake ingest accepts and stores it signed with `(instance_id, epoch, seq)`; plus boundary checks: the shop can reach the sidecar but has no route to a platform decoy on another network and no internet egress.

## Boundaries & Constraints

**Always:** The shop posts unsigned to the sidecar (the sidecar stamps identity and signs, verified by the ingest with the same per-epoch key). Secrets (event key, fake flags) reach the sidecar/ingest on stdin only — never a command line, env or `docker inspect`. Internal docker network for the instance; a separate network for the decoy. Stay in `apps/shop/`.

**Never:** No signing in the shop. No `/_stub` routes in the real shop. No real secrets. No changes to Tanmay's harness or the mocks.

## I/O & Edge-Case Matrix

| Check | Expected |
|-------|----------|
| Shop → sidecar events port | reachable |
| Shop posts one event | sidecar answers 202 |
| Fake ingest | stores exactly that event with `(instance_id, epoch, seq=1)` and the posted type |
| Shop → platform decoy (other network, by name and IP) | no route |
| Shop → internet (positive-controlled) | blocked |
| Ingest read-out | carries only identity + type; no flag or key |

</frozen-after-approval>

## Code Map

- `apps/shop/instance-harness/shop-events-check.mjs` -- new; the Docker orchestrator (shop + sidecar + fake ingest + decoy) that proves the signed event chain and the network boundary. `pnpm --filter @vulnmart/shop run instance:events`.
- `apps/shop/package.json` -- `instance:events` script.
- (reuses the shop's `postEvent`/`shopEvent` from `src/instance/instance.mjs`, T-04; no shop code change.)

## Tasks & Acceptance

**Execution:**
- [x] Harness: real shop posts one event → real sidecar signs → fake ingest accepts; assert stored identity/type.
- [x] Boundary checks: sidecar reachable; no route to a platform decoy (name + IP); no egress (positive-controlled); no secret in the ingest read-out.

**Acceptance Criteria:**
- Given the real shop in the instance, when it posts one app event, then the sidecar answers 202 and the fake ingest stores exactly that event with `(instance_id, epoch, seq=1)` and the posted type.
- The shop can reach the sidecar but has no route to a service on another network and cannot reach the internet.
- No flag or key appears in the ingest read-out.

## Implementation Notes

The shop posts through its own code run in-container (`import('/app/src/instance/instance.mjs')`), so this exercises the real emit path. The sidecar/ingest are the stub image (a regular node image: `node` on PATH, unlike the distroless shop's `/nodejs/bin/node`). Stdin-fed containers are created with `-i` (OpenStdin) so the start document is delivered. The decoy proves "no route to the platform/orchestrator/other instances" at the network level; binding the shop's egress policy to the real instance network ACLs is L-13 / the real orchestrator.

## Plan Change Log

## Review Triage Log

### 2026-10-12 — security/correctness review (Opus)

The review confirmed the signed-chain proof is sound (the fake ingest verifies the HMAC with the same per-epoch key both sidecar and ingest get on stdin; a stored event implies a verified signature; fresh instance_id + fresh ingest per run rule out stale events; seq=1 is genuine). But the **boundary** checks were weak, now fixed:

**Fixed:**
- **`live-no-route-to-platform` was effectively a guaranteed pass.** The decoy was the shop image with no env, which crashes (the seed import is not in the instance image), so it never served; its IP came back empty and the by-IP branch short-circuited to `true`; the by-name probe failed on DNS NXDOMAIN (not proof of no route). Now the decoy and a **prober** run as instance containers that actually serve `/healthz` on a separate network; a **positive control** asserts the prober reaches the decoy by IP before concluding the shop's failure means isolation; a missing IP or unreachable decoy now **fails** instead of vacuously passing.
- **Exec-based boundary checks failed open.** `canReach`/`live-no-egress` decided on `docker exec` exit status, so a broken exec passed. Now they use an explicit `REACHED`/`BLOCKED` stdout sentinel (`ERROR` ≠ `BLOCKED`), so they fail closed.
- **no-egress silently un-tested on an offline host** — now surfaced as a `SKIP` (counted in the summary), never a hidden pass.
- **Added a signature negative control** (`live-ingest-rejects-unsigned`): an event posted straight to the ingest with no `X-VM-Signature` must get 401, so a stored event proves the sidecar genuinely signed it.
- Robustness: feeder children now use `stdio:['pipe','ignore','ignore']` (no pipe-fill stall) + a `child.on('error')` handler; `requireRunning` exits fast when a container dies and scrubs the whole log before slicing.

**Acknowledged:** the network boundary is enforced by the harness's own `--internal` docker network, so it proves isolation at the docker level, not a product/compose network policy — binding it to the real instance network ACLs is L-13 (stated in the dev-log and traceability).

## Design Notes

Reuses the stub sidecar + fake ingest rather than re-implementing them; the sidecar signs with the event key from its start document and the ingest verifies with the same key, so acceptance proves the real signed chain (not a stand-in). The edge relay is a pass-through and is omitted (the sidecar relays straight to the ingest's `/internal/v1/events`).

## Verification

**Commands:**
- `pnpm --filter @vulnmart/shop run instance:events` (needs Docker) -- expected: `shop-events: PASS (8 checks)`.
