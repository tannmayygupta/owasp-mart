# Shop boundaries and signed app events (T-10)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 2, instance boundaries + events (FR-SHP-14) |

## Requirements covered
FR-SHP-14 (the shop has no route to the platform database, Valkey, the orchestrator or other instances, and sends signed app events through the sidecar; the fake ingest accepts them). BMAD story 2.3 of `epic-shop-instance-integration`.

## Summary (plain language, 3-5 lines)
Proved end to end, in Docker with the real shop + the real sidecar + the fake ingest, that the shop sends its app events through the sidecar and the platform accepts them, and that the shop is network-isolated. The shop posts one event through its own code to the sidecar; the sidecar stamps `(instance_id, epoch, seq)` and signs it with the per-epoch event key; the fake ingest verifies the signature with the same key and stores it. The shop can reach the sidecar but has no route to a platform service on another network and no internet egress.

## Why
FR-SHP-14 is the instance's security boundary: a compromised shop must not reach the platform or other instances, and its telemetry must be signed so the platform trusts it. T-04 proved the shop posts a valid body to a fake sidecar; this proves the real signed chain and the real network boundary.

## What was built
- `apps/shop/instance-harness/shop-events-check.mjs` — a Docker orchestrator that runs the shop (real image, instance runtime profile) + the sidecar + the fake ingest (stub image, fed start documents on stdin) on an internal network, plus a decoy "platform" on a separate network. It has the shop post one event via its own `postEvent`, asserts the sidecar answers 202 and the fake ingest stores the event with `(instance_id, epoch, seq=1)` and the posted type, and checks the boundary (no route to the decoy by name or IP, no egress, no secret in the ingest read-out). `pnpm --filter @vulnmart/shop run instance:events`.
- `apps/shop/package.json` — `instance:events` script.
- No shop code change: the shop's `postEvent`/`shopEvent` (T-04) are the real emit path.

## How it works
The shop posts an unsigned body to `VM_SIDECAR_EVENTS_URL/v1/events`; the sidecar stamps identity, assigns the next `seq`, signs with the event key from its start document, and relays to the ingest, which verifies with the same key and stores. Secrets (the event key and fake flags) reach the sidecar/ingest on standard input only. The shop runs on an internal docker network (no gateway out); the decoy is on a separate network, so the shop has no route to it.

## Files changed
- `apps/shop/instance-harness/shop-events-check.mjs` — new.
- `apps/shop/package.json` — `instance:events` script.

## Decisions made
Reuse the stub sidecar + fake ingest (the real signing chain) rather than a stand-in. Omit the edge relay (a pass-through; the sidecar relays straight to the ingest). The shop posts through its own code run in-container. The decoy proves the network boundary; binding the shop's egress policy to the real instance network ACLs is L-13.

## Tests
Real commands and results:
- `pnpm --filter @vulnmart/shop run instance:events` (Docker 28.5.1) → **`shop-events: PASS (9 checks)`**: live-shop-up, live-sidecar-reachable, live-ingest-up, live-sidecar-accepts-event (202), **live-fake-ingest-accepts-shop-event** (stored with the right instance_id/epoch/seq=1/type), **live-ingest-rejects-unsigned** (401 — negative control proving the sidecar genuinely signs), live-no-route-to-platform (positive-controlled: a prober on the platform network reaches the decoy, the shop cannot, by name and IP), live-no-egress (positive-controlled, SKIP on an offline host), live-no-secret-in-ingest-readout.
- `node --test "apps/shop/test/**/*.test.mjs"` → 90 passed (unaffected).
- Traceability row FR-SHP-14 added in `docs/traceability.md`.

## Evidence
Harness output above; it drives the real shop and the real sidecar + fake ingest and reads the ingest's stored events.

## Problems met and how they were fixed
Three harness bugs, each found and fixed with real Docker: (1) the stdin-fed sidecar/ingest rejected an empty start document — containers must be created with `-i` (OpenStdin) for `docker start -i` to deliver stdin. (2) the event arrived at the ingest only after the delivery window — added an ingest-up wait so the sidecar's first relay succeeds, and widened the poll. (3) every `docker exec` into the ingest/sidecar failed because it used the shop's distroless path `/nodejs/bin/node`, but the stub image is a regular node image with `node` on PATH — parameterized the node binary. Added a `requireRunning` precheck that fails fast with a container's (scrubbed) logs when a stdin-fed service exits on a bad document.

The security review then found the boundary proof was weak: the decoy was a bare shop image that crashed (no seed in the instance image), so it never served, its IP was empty, and the by-IP branch short-circuited to a pass; the exec-based reach/egress checks failed open on a broken exec. Fixed: the decoy and a prober now run as instance containers that actually serve, with a positive control (the prober reaches the decoy) before concluding the shop's failure means isolation; the reach/egress checks use an explicit `REACHED`/`BLOCKED` sentinel (fail closed); an offline host makes no-egress a visible SKIP; and a new negative control asserts the ingest returns 401 for an unsigned event (so a stored event proves real signing).

## Security notes (vulnerable parts only)
No deliberate weakness — this proves the boundary. The shop posts unsigned (correct: the sidecar signs; the ingest verifies). Secrets reach the sidecar/ingest on stdin only, never a command line/env/`docker inspect`, and all error output is scrubbed. The ingest read-out carries only identity + type (no flag or key). The shop is confined to its internal network with the sidecar as its only peer.

## Limitations and follow-ups
- The network boundary is enforced by the harness's docker networks; binding it to the real instance network ACLs (and the real orchestrator) is L-13.
- The running shop does not yet autonomously emit events on real actions (the marketplace is not mounted in instance mode — tracked from T-09); the emit path is proven via the shop's own `postEvent`.
