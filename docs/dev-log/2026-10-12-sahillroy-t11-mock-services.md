# Mock services container (T-11)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 2, mock services (FR-SHP-13) |

## Requirements covered
FR-SHP-13 (one combined mock-services container per instance: payment gateway, KYC provider, metadata service, XSS collector; reachable only inside the instance network). BMAD story 2.4 of `epic-shop-instance-integration`.

## Summary (plain language, 3-5 lines)
Built the combined mock-services container: one hardened, Node-built-ins-only process running four small services on their instance ports (9101 payment, 9102 KYC, 9103 metadata, 9104 collector). Correct flow only — the gateway always signs its events, the KYC fails closed on bad input, the metadata service serves the per-instance C10 flag only from the injected read-only placement file, and the collector only records. Proven with unit tests per mock and a Docker reachability harness showing the mocks answer inside the instance network, have no route from outside, and are not published to the host.

## Why
FR-SHP-13 gives the challenges their external services: the payment gateway (C08), the KYC provider (C11), the metadata target (C10) and the XSS collector (C03). The deliberate weaknesses live in the shop's handling of these; the services themselves must be correct, so one fix in the shop does not accidentally change a mock.

## What was built
- `services/mock-services/src/server.mjs` — the four mocks as `http.Server` factories.
- `services/mock-services/src/main.mjs` — entrypoint, listens on 9101–9104.
- `services/mock-services/Dockerfile` — hardened distroless (non-root 65532, read-only, no deps), healthcheck on 9101.
- `services/mock-services/test/mock-services.test.mjs` — correct-flow behaviour per mock.
- `services/mock-services/instance-harness/mock-reach-check.mjs` — the Docker reachability proof.
- `.github/workflows/ci.yml` — the app-tests job now also runs `services/*/test/**`.

## How it works
One process starts four `http.Server`s. Payment `/charge` records a ledger entry and returns an HMAC-signed event (the shop is meant to verify this — skipping it is C08). KYC `/verify` returns verified/rejected for a valid tax id and a 400 for malformed input (fails closed — the fail-open that auto-approves a seller is C11, in the shop). Metadata `/rates` and `/latest/user-data` imitate an internal/metadata service; `/latest/user-data` serves the C10 flag only from `/run/placement/mock/C10.placement`, nothing when absent (the SSRF reaching it is C10, in the shop's importer). The collector records what it is sent (C03 is stored XSS in the shop). Hardened: non-root, read-only root, tmpfs only, no published ports; reachable only on the instance network.

## Files changed
- `services/mock-services/{src/server.mjs, src/main.mjs, Dockerfile, package.json, test/mock-services.test.mjs, instance-harness/mock-reach-check.mjs}` — new.
- `.github/workflows/ci.yml` — app-tests job glob widened to include `services/*/test/**`.

## Decisions made
Correct flow only; every deliberate weakness stays with the caller (gateway signs, KYC fails closed, metadata just serves, collector just records). Node built-ins only (no deps, fits distroless and the no-native-deps rule). The per-instance C10 flag comes only from the injected placement file. Event emission by the mocks (`gateway.ledger_entry`, `collector.hit`, `meta.request_served`) is recorded internally for now and wired to the sidecar in later work; the live compose wiring into an instance is L-13.

## Tests
Real commands and results:
- `node --test "services/mock-services/test/**/*.test.mjs"` → **6 passed**: payment charges + signs + ledgers (bad input 400), KYC fails closed (malformed → 400, never a silent verified), metadata serves rates + user-data with the placement flag (and none when absent), collector records and counts.
- `pnpm --filter @vulnmart/mock-services run reach:check` (Docker 28.5.1) → **`mock-services: PASS (6 checks)`**: all four ports reachable from a sibling on the instance network, no route from an outsider on another network (by name and IP), and no host port mapping.
- Traceability row FR-SHP-13 added in `docs/traceability.md`.

## Evidence
Test output above; the reachability harness runs the real mock image in real containers on real docker networks.

## Problems met and how they were fixed
Discovered that CI's app-tests job ran only `apps/*/test/**`, so `services/*` tests (this service and the next two) would not run in CI — widened the glob to include `services/*/test/**`. No other issues; the reachability harness reused the sentinel-probe pattern from T-10.

## Security notes (vulnerable parts only)
No deliberate weakness — correct mocks. The gateway always signs; the KYC fails closed; the metadata service serves the C10 flag only from the injected read-only placement file and nothing when absent; the collector never serves a flag. No real secret or flag is baked into source (the signing key is a non-secret dev default, overridable by env). Hardened container, no published ports, instance-network only.

## Limitations and follow-ups
- Mock event emission to the sidecar (`gateway.ledger_entry`, `collector.hit`, `meta.request_served`) is recorded internally for now; wiring it to the sidecar comes with the events/monitor work.
- The live docker-compose wiring of mock-services into a full instance (with the placement volume mounted) is L-13; T-11's reachability harness proves the container and its network boundary.
