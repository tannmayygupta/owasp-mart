---
title: 'Mock services container'
type: 'feature'
ticket: '4'
created: '2026-10-12'
status: 'built'
baseline_revision: 'e2ac9fb'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/contracts/instance/instance-contract.md'
  - '{project-root}/docs/research/RS-F-challenges-07-11.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-SHP-13 requires one combined mock-services container per instance — a payment gateway, a KYC provider, a fake metadata service and an XSS collector — reachable only inside the instance network. None exists (`services/mock-services/` is a placeholder).

**Approach:** Build a single hardened container running the four mocks on their instance ports (9101 payment, 9102 KYC, 9103 metadata, 9104 collector), Node built-ins only, correct flow only. Prove with unit tests (each mock's behaviour) and a Docker reachability harness (reachable inside the instance network, unreachable from outside, not published to the host).

**Correct flow only:** the deliberate weaknesses live in the callers, not here — C08 is the shop's webhook skipping signature checks (the gateway always signs), C11 is the shop's onboarding failing OPEN on a KYC error (the KYC fails CLOSED), C10 is the shop's importer reaching the metadata service (the service just serves), C03 is stored XSS in the shop (the collector just records).

## Boundaries & Constraints

**Always:** One container, four mocks on 9101–9104, Node built-ins only (no deps), hardened (non-root 65532, read-only root, tmpfs only). The per-instance C10 flag comes only from the read-only placement file `/run/placement/mock/C10.placement`; nothing is served when it is absent. Stay in `services/mock-services/`.

**Never:** No deliberate weakness in a mock (gateway always signs; KYC fails closed). No real secret or flag baked in source. No published host ports. No egress needs.

## I/O & Edge-Case Matrix

| Mock | Endpoints | Correct behaviour |
|------|-----------|-------------------|
| payment 9101 | `/healthz`, `POST /charge`, `/ledger` | charges a valid order, records a signed ledger entry; bad input → 400 |
| kyc 9102 | `/healthz`, `POST /verify` | verifies a valid tax id; malformed/odd input → 400 (fails CLOSED, never a silent verified) |
| metadata 9103 | `/healthz`, `/rates`, `/latest/user-data` | serves rates and user-data; the C10 flag only from the injected placement file |
| collector 9104 | `/healthz`, `POST /`, `/hits` | records what it is sent; never serves a flag |

| Reachability | Expected |
|---|---|
| sibling on the instance network → each port | reachable |
| outsider on another network → mock (name + IP) | no route |
| host port mapping | none (not published) |

</frozen-after-approval>

## Code Map

- `services/mock-services/src/server.mjs` -- new; `createPayment`/`createKyc`/`createMetadata`/`createCollector` (+ `createMockServices`, `PORTS`).
- `services/mock-services/src/main.mjs` -- new; container entrypoint, listens on the four fixed ports.
- `services/mock-services/Dockerfile` -- new; hardened distroless, no deps, healthcheck on 9101.
- `services/mock-services/test/mock-services.test.mjs` -- new; correct-flow behaviour per mock.
- `services/mock-services/instance-harness/mock-reach-check.mjs` -- new; the Docker reachability proof. `pnpm --filter @vulnmart/mock-services run reach:check`.
- `.github/workflows/ci.yml` -- the `apps` test job now also runs `services/*/test/**`.

## Tasks & Acceptance

**Execution:**
- [x] The four mocks (correct flow), entrypoint, hardened Dockerfile.
- [x] Unit tests per mock (incl. KYC fail-closed and the gateway signature).
- [x] Reachability harness (inside reachable, outside no route, not published).
- [x] CI runs `services/*/test/**`.

**Acceptance Criteria:**
- Each mock answers its endpoints correctly inside the instance; no deliberate weakness leaks into a mock.
- The four mocks are reachable from a sibling on the instance network, have no route from another network, and are not published to the host.
- No real secret/flag in source; the C10 flag comes only from the injected placement file.

## Implementation Notes

Mocks post events (`gateway.ledger_entry`, `collector.hit`, `meta.request_served`, source `mock`) in later work; T-11 records them internally and exposes read endpoints (`/ledger`, `/hits`) that the monitor/events layer will use. The live docker-compose wiring of mock-services into a full instance is L-13.

## Plan Change Log

## Review Triage Log

### 2026-10-12 — security/correctness review (Opus)

The review confirmed the correct-flow axes all hold (KYC fails closed, the gateway always signs with no sandbox bypass, no baked secret/flag, the C10 flag only from the injected placement file, the reach harness fail-closed). Fixed robustness issues:

**Fixed:**
- **DoS: an oversized request could crash all four mocks** — `readJson` destroyed the request on over-cap, which could tear the socket down before the 413 and throw an unhandled rejection in the shared process. Now it reports over-cap without destroying, resolves once, and handles `aborted`/`close`; `sendJson` never writes to a torn-down socket; and `main.mjs` adds an `unhandledRejection`/`uncaughtException` safety net. New test: a >16 KB request → 413 and the service stays up.
- **Hardcoded placement filename** — the C10 flag file's NAME comes from the catalogue (IF-7); only the directory is fixed by IF-6. The metadata service now serves whichever single file is in `/run/placement/mock`, not a hardcoded `C10.placement`.
- Nits: compute the gateway signature once; explicit `USER 65532:65532` in the Dockerfile (don't rely on the caller's `--user`).

**Acknowledged — handoffs (challenge-epic decisions, not baked into the correct mock):**
- **C11 (H-120):** RS-F has the KYC provider reply **500** on malformed input so the shop's `try/catch` fails open; the correct mock returns a clean **400** (fail closed). The C11 story must decide whether the mock should 500 on the specific malformed shapes it abuses, or the shop's fail-open path treats a 400 as an error. Recorded in `deferred-work.md`.
- **C10 (H-121):** RS-F's primary C10 detection is a `meta.request_served` event / a logged request with the importer's UA; the correct mock records internally but does not yet emit that event. Emission comes with the events/monitor work. Recorded in `deferred-work.md`.

## Design Notes

One process, four `http.Server`s, so a single container and a single healthcheck. Ports are fixed by the instance contract; tests listen on ephemeral ports. The reachability harness mirrors the sentinel-probe pattern from T-10 (fail-closed REACHED/BLOCKED).

## Verification

**Commands:**
- `node --test "services/mock-services/test/**/*.test.mjs"` -- expected: 6 pass.
- `pnpm --filter @vulnmart/mock-services run reach:check` (needs Docker) -- expected: `mock-services: PASS (6 checks)`.
