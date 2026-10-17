---
title: 'Docker socket behind a proxy for the orchestrator'
type: 'feature'
ticket: '2'
created: '2026-10-16'
status: 'built'
baseline_revision: '1ee5c019bb1ede4ec4d587476f05023ed514ad17'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/adr/0010-docker-socket-proxy.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The orchestrator talks to the Docker socket directly, so a bug or compromise of the orchestrator is a root shell on the host (NFR-SEC-04, NFR-SEC-02). ADR 0010 proposes a socket proxy but none exists in the repository.

**Approach:** Add a socket proxy service (the free, MIT-licensed `tecnativa/docker-socket-proxy`, image pinned by digest) in the `lab` Compose profile. It is the only place that mounts the socket (read-only mount of the socket file, no published port except loopback) and lets through only the API sections the orchestrator needs (containers, networks, volumes, POST and DELETE on those, attach, `_ping`, version); exec, images, build, commit, swarm, secrets, services, plugins, system and auth stay off. The orchestrator uses it with `--docker-host`. Decided on the developer's delegation, recorded as D-58, ADR 0010 updated to Accepted-with-conditions text and a new ADR 0038 (Proposed) for the choice of the proxy over rootless Docker for now (S-8 stays open).

## Boundaries & Constraints

**Always:** Find out first which Docker API paths `SdkBackend` (`apps/orchestrator/src/vulnmart_orchestrator/backend.py`) really calls (read the code, and record the list in the dev-log) and allow exactly those sections; deny everything else. The proxy container is hardened as far as it works (read-only root with tmpfs, no-new-privileges, cap_drop ALL, no ports on the host except `127.0.0.1`), has no network shared with any instance and sits on a network only the orchestrator joins. `scripts/check-lab-compose-rules.mjs` keeps rejecting the socket and host networking in every service except one named exception: the service `docker-proxy`, and only a read-only bind of `/var/run/docker.sock` with no other bind; add tests for both sides. The orchestrator's Docker host option (`--docker-host`) already exists: prove it works through the proxy and document it; nothing changes in how instances are built. The proxy image is pulled by digest; record the digest and its source in the ADR (no secret). A test starts the proxy locally, runs the real-Docker orchestrator test through it (create, reset, destroy of a stub instance) and checks that denied calls answer 403 (exec, images, build, system, a container create is allowed because the sections are coarse: the orchestrator's own template-ID-only rule and the host rule are the second line, say so in the ADR).

**Never:** Running anything on AWS, VM-I or over SSH; changing terraform or `infra/hosts/**`; `.github/workflows/**`; `contracts/**`; adding the orchestrator itself to Compose (its deployment unit is L-12/L-13 live work); the Excel tracker; pushes and commits. No `privileged: true`, no `network_mode: host`, no docker group changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Allowed call | orchestrator creates, starts, attaches, removes via the proxy | works as on the socket | none |
| Denied section | `POST /containers/{id}/exec`, `GET /images/json`, `POST /build`, `GET /info`, `POST /swarm/init` | HTTP 403 from the proxy | test asserts the status |
| Compose rule | any service other than `docker-proxy` mounts the socket | `check-lab-compose-rules` FAIL | names the service |
| Compose rule | `docker-proxy` mounts the socket read-only | PASS | none |
| Compose rule | `docker-proxy` also binds a host path or publishes 0.0.0.0 | FAIL | names the rule |
| Proxy down | proxy stopped | orchestrator calls fail with a backend error, create ends `failed` INST-START-FAILED, nothing is left | as create failure |
| Docker missing | no daemon | tests skip | none |

</frozen-after-approval>

## Code Map

- `infra/compose/compose.yaml` -- profiles `platform`, `web`, `lab`, `mocks` (lab is empty); add service `docker-proxy` in `lab` (internal network `labs-core`, loopback port for the local test).
- `scripts/check-lab-compose-rules.mjs` and its test -- rejects privileged, host networking and the socket today; add the single exception and the tests.
- `apps/orchestrator/src/vulnmart_orchestrator/backend.py:200-300` (`SdkBackend`) and `service.py:408` (`--docker-host`) -- which Docker calls are made; no change expected beyond what the test shows is needed.
- `apps/orchestrator/tests/test_docker_integration.py` -- the real-Docker tests; add a variant that sets the Docker host to the proxy (skip when no daemon).
- `docs/adr/0010-docker-socket-proxy.md` (update), new `docs/adr/0038-*.md`, `initial.md` D-58, `docs/architecture/06-security.md:76-89` (read), dev-log, evidence `docs/assets/story-4-2-socket-proxy/`, `CHANGELOG.md`, traceability rows NFR-SEC-02, NFR-SEC-04, NFR-ISO-04, handoff answers (a row for the live step: deploy the proxy and point the orchestrator at it on VM-I, in `docs/runbooks/deploy.md` as a new numbered section).

## Tasks & Acceptance

**Execution:**
- [ ] `infra/compose/compose.yaml` -- `docker-proxy` service, digest-pinned, hardened, allowed sections only
- [ ] `scripts/check-lab-compose-rules.mjs` + test -- the one exception and both-side tests
- [ ] `apps/orchestrator/tests/test_docker_integration.py` -- the through-the-proxy test and the 403 checks
- [ ] `docs/runbooks/deploy.md` -- the VM-I steps (numbered, for the developer)
- [ ] docs -- ADR 0010 update, ADR 0038, D-58, CHANGELOG, traceability, dev-log, evidence, story `built`

**Acceptance Criteria:**
- Given the proxy is running locally, when the orchestrator tests run with the Docker host set to it, then create, reset and destroy of a stub instance pass and no object is left.
- Given the proxy, when exec, images, build, info or swarm are called through it, then each answers 403.
- Given the compose rules test, then the socket is accepted only in `docker-proxy` read-only and refused anywhere else.
- Given `node scripts/check-lab-compose-rules.mjs` on `infra/compose/compose.yaml`, then PASS.

## Implementation Notes

- Built 2026-10-16. The stock proxy image forwards container exec when containers and POST are on, so the service loads its own deny-by-default HAProxy file (`infra/compose/docker-proxy/rules.cfg`); start, attach and remove are limited to names starting with `vm-`.
- The compose lint parses the YAML (js-yaml) for the socket exception; the line scan stays for the privileged and host-network rules.
- Tests: compose rules 8 of 8, real-Docker file 11 of 11, no-Docker kwargs test 1 of 1 (outputs in `docs/assets/story-4-2-socket-proxy/`). The vm-i run is the developer's (deploy runbook Part E, H-125).
- Files written without control characters or a byte order mark (checked with `node scripts/check-text-files.mjs`).
## Plan Change Log

## Review Triage Log

Pass 1 (2026-10-16, one focused security review lens; static reading, the integration tests were run by the implementer and again in the final verification).

| Verdict | Route | Finding and evidence |
|---|---|---|
| high | patch | The compose rule was line based: a service named `"evil":`, `evil: &a` or `evil: {...}` stayed attributed to `docker-proxy`, flow-style volumes and ports passed, long-form ports without `host_ip`, `volumes_from`, `extends`, `include`, `devices` and binds of `/`, `/var`, `/var/run`, `/run` were not checked, and `docker-proxy`'s image and command were not pinned. Rewritten on a real YAML parse (anchors and merge keys resolved), 8 tests, one per shape and both sides of the exception. |
| high | patch | The proxy filtered by method and path only, so the orchestrator could remove or drive the platform's own containers, volumes and networks: start, attach and DELETE now work only for `vm-*` names, create needs `?name=vm-`; inspect and list stay open; network and volume create cannot be restricted by name (the name is in the body). Foreign-object tests (403, object still there). |
| medium | patch | Docs understated the attacker's reach: ADR 0010, ADR 0038, the dev-log, deploy.md Part E and `06-security.md` now state that create is root-equivalent, inspect reads any container's environment and the loopback port has no login. |
| medium | patch | No test that the create payload never carries privileged, host binds or host namespaces: `test_backend_sdk_kwargs.py` over every component of the shop plan. |
| low | patch | Dot-only id segments, `/v../` version prefix, HEAD allowed, case-insensitive paths: tightened; bypass shapes (`//`, `..`, `%2e%2e`, lowercase method) tested with 403. |
| low | defer | Two `PytestUnraisableExceptionWarning` lines about an unclosed HTTP response (not traced); rootless Docker (S-8, L-29). |

## Design Notes

The proxy filters by API section, not by request body, so a caller that may create containers can still ask for a bad container. The second line is the orchestrator itself: it accepts a template id only, builds every container from the fixed profile (IF-6 section 7) and the host rule drops instance-to-host traffic. Rootless Docker (S-8) would remove the root risk; it stays open for L-29.

## Verification

**Commands:**
- `node --test scripts/check-lab-compose-rules.test.mjs` and `node scripts/check-lab-compose-rules.mjs` -- expected: pass
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests/test_docker_integration.py` -- expected: pass (Docker running), including the proxy variant
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass
