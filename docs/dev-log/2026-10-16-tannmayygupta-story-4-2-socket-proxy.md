# Docker socket behind a proxy for the orchestrator (story 4.2)

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-2-tanmay-b`, baseline `1ee5c01` (commit of this story follows) |
| Status | Partly done: proxy service, compose rule exception and tests built and passed on Docker Desktop; the vm-i run (runbook Part E) was not run, it is the developer's |
| Report tag | socket proxy, NFR-SEC-02, NFR-SEC-04, NFR-ISO-04, D-58 |

## Requirements covered
NFR-SEC-02, NFR-SEC-04, NFR-ISO-04, decision D-58 (new, delegated, to be confirmed), ADR 0010 (updated), ADR 0038 (Proposed), spike S-8 (stays open), handoff H-125 (new).

## Summary (plain language, 3-5 lines)
The orchestrator used to need the Docker socket directly, which is root on the host. There is now a small proxy container that is the only one holding the socket (read-only) and passes on only the calls the orchestrator really makes. The stock proxy image could not block "run a command inside a container", so the service uses its own filter file. A test starts the proxy and runs create, reset and destroy of a stub instance through it, and checks that other calls get 403.

## Why
ADR 0010 proposed a socket proxy; none existed. NFR-SEC-04 and NFR-SEC-02 want a bug or a break-in of the orchestrator not to be a free root shell.

## What was built
- Compose service `docker-proxy` (profile `lab`): digest-pinned image, read-only root, tmpfs, `cap_drop ALL`, `no-new-privileges`, limits, health check, network `vulnmart-labs-core`, port `127.0.0.1:2375`, read-only socket mount, own rules file.
- `infra/compose/docker-proxy/rules.cfg`: deny by default, then the exact method and path pairs of `SdkBackend`.
- `scripts/check-lab-compose-rules.mjs`: one named exception for `docker-proxy`; new test file `scripts/check-lab-compose-rules.test.mjs`.
- Three tests in `apps/orchestrator/tests/test_docker_integration.py`: 403 list, lifecycle through the proxy, proxy down.
- Runbook `docs/runbooks/deploy.md` Part E (eight numbered steps for the developer on vm-i).
- Docs: ADR 0010 updated, ADR 0038, D-58 in `initial.md`, handoff H-125, changelog, traceability, evidence.

## How it works
The orchestrator's backend (`SdkBackend`) already accepts `--docker-host`. Pointed at `tcp://127.0.0.1:2375` it speaks to HAProxy, which checks the method and path of every request against the allow list and forwards it to the socket, or answers 403. No orchestrator source file changed. The request body is not looked at: that is still the job of the orchestrator's template-id-only rule and the host rule.

### Docker API calls `SdkBackend` really makes (read from `backend.py`, then confirmed by the test passing)
- `GET /version` (the SDK's version negotiation on connect) and `GET /_ping`.
- Containers: `GET /containers/json` (list, scan, find), `GET /containers/{id}/json` (state, scan), `POST /containers/create`, `POST /containers/{id}/attach` (start with standard input), `POST /containers/{id}/start`, `DELETE /containers/{id}` (force, with volumes flag).
- Networks: `GET /networks` (list with label filter), `POST /networks/create`, `GET /networks/{id}` (the SDK inspects a network right after creating it; found only when the first test run failed with 403), `DELETE /networks/{id}`.
- Volumes: `GET /volumes`, `POST /volumes/create`, `GET /volumes/{id}` (same re-read after create), `DELETE /volumes/{id}`.
- Not used: exec, stop, restart, kill, wait, logs, events, images, build, info, system, swarm, archive.

## Files changed
- `infra/compose/compose.yaml` - service `docker-proxy`, network `labs-core`, config `docker-proxy-rules`
- `infra/compose/docker-proxy/rules.cfg` - new, the HAProxy allow list
- `scripts/check-lab-compose-rules.mjs` - exception for `docker-proxy` and its rules
- `scripts/check-lab-compose-rules.test.mjs` - new, 5 tests
- `apps/orchestrator/tests/test_docker_integration.py` - proxy fixture and 3 tests
- `docs/runbooks/deploy.md` - Part E
- `docs/adr/0010-orchestrator-privileges-and-host-rule.md`, `docs/adr/0038-socket-proxy-before-rootless-docker.md`, `initial.md` (D-58), `docs/dev/HANDOFFS.md` (H-125), `CHANGELOG.md`, `docs/traceability.md`
- `docs/bmad/initiative-lab/epic-isolation-and-hardening/story-docker-socket-behind-a-proxy-for-the-orchestrator-plan.md` - status `built`

## Decisions made
D-58, ADR 0010 (updated), ADR 0038 (Proposed). Alternatives: stock image with switches only (measured, rejected: exec is forwarded), rootless Docker now (kept open, S-8), own proxy (rejected).

## Tests
Real commands and results (the counts below are from the second round; first-round counts were 5 and 9) (Docker Desktop 29.6.2, 2026-10-16), outputs in `docs/assets/story-4-2-socket-proxy/`:
- `node --test scripts/check-lab-compose-rules.test.mjs` - 8 tests, 8 pass (second round, after the YAML-parse rewrite).
- `node scripts/check-lab-compose-rules.mjs` - `PASS lab compose rules: 3 file(s) checked ...`.
- `node --test scripts/infra-isolation.test.mjs` (holds the older compose lint test) - 13 pass, 0 fail.
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests/test_docker_integration.py` - 11 passed in 80 s (6 older, 5 new through the proxy, second round); `test_backend_sdk_kwargs.py` (no Docker) 1 passed; together 12 passed. The run prints two `PytestUnraisableExceptionWarning` lines about a closed HTTP response; they are not failures and I did not trace which call leaves a response open (the test helper I wrote closes its own).
- `docker compose -f infra/compose/compose.yaml --profile lab --profile platform --profile web --profile hello config -q` - exit 0.
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs` - both PASS (run after the code changes, before the docs; see the final result in the commit step).
- Manual probe of 18 paths against the running proxy: all denied paths 403, the five allowed paths 200 (`proxy-status-codes.txt`).
Not run: the orchestrator service itself with `--docker-host` (the lifecycle test uses `SdkBackend` pointed at the proxy, which is the same code path); the vm-i steps; `bmad-code-review` (self-review only in this session); `bmad-qa-generate-e2e-tests`. Traceability rows updated: NFR-SEC-02 / NFR-SEC-04, NFR-ISO-04.

## Evidence
`docs/assets/story-4-2-socket-proxy/`: `proxy-status-codes.txt`, `pytest-docker-integration.txt`, `compose-rules-test.txt`, `compose-rules-check.txt`.

## Problems met and how they were fixed
- Plan says the image is MIT; the image labels say Apache-2.0. Recorded as Apache-2.0 in the ADRs.
- First start failed: `Cannot create pidfile /run/haproxy.pid` with a read-only root. Fixed with a tmpfs on `/run`.
- With the stock switches, `POST /containers/x/exec` answered 400 from the daemon (not 403), as did stop and kill: the image's `containers` rule covers every path under `/containers`. Fixed with an own rules file (deny by default).
- A first attempt put the rules inline in the Compose file (`configs: content:`); Compose refuses that for a read-only service ("`file` is the sole supported option"). Moved to a file; the Compose `configs` file mount is not a `volumes` bind, so the lint's "no other bind" rule still holds.
- First lifecycle run failed with INST-START-FAILED: the proxy denied `GET /networks/{id}`, which the Docker SDK calls right after creating a network (and the same for volumes). Allowed method GET on those two.
- `networks:` with `internal: true` cannot publish a port, so `labs-core` is a normal bridge; the proxy is the only service on it.
- Compose rule edge: my first test helper chained `[0]` on a single string and took the first character; fixed with `@(...)[0]`.

## Review fixes (2026-10-16, second round)
- The compose lint now parses the YAML with js-yaml (anchors and merge keys resolved) for the socket rules: quoted, anchored or flow-style service names, flow-style volumes and ports, long-form ports without host_ip, volumes_from, extends, include, devices, binds of /, /var, /var/run, /run, and the pinned image, command, user, read_only and capabilities of docker-proxy are all checked and tested. The old line scan stays for the privileged and host-network rules (and their line numbers). File names `docker-*.yml` are covered.
- `rules.cfg` is tighter: start, attach and DELETE only for `vm-*` names, container create only with `name=vm-*`, no dot-only segment, strict version prefix, no HEAD, case sensitive method and path. Networks and volumes are created by name in the body, so that one cannot be restricted by name.
- New tests: odd paths and methods (`//containers/json`, `..`, `%2e%2e`, lowercase method) answer 403; delete, start and attach on a container, volume and network named `foreign-probe-*` answer 403 and the objects remain; a no-Docker test (`test_backend_sdk_kwargs.py`) shows `SdkBackend.create_container` never sends privileged, host binds, host pid or network mode, or cap_add.
- Plain-words limits are in ADR 0010 and 0038: create is root-equivalent, inspect reads the environment of any container, only vm-* objects can be driven, the loopback port has no login.
- `docs/architecture/06-security.md` section 4 no longer lists stop and events as exposed.
## Security notes (vulnerable parts only)
This is infrastructure, not a vulnerable part. Residual risk: the proxy does not read request bodies, so a compromised orchestrator could still ask for a privileged container; the container process runs as root inside (socket ownership). No flag, secret or address appears here.

## Limitations and follow-ups
- The vm-i run (runbook Part E, handoff H-125) is the developer's.
- (done in the second round) `docs/architecture/06-security.md` section 4 was aligned with the built proxy.
- The orchestrator is not in Compose; where it runs (host or container) is L-12/L-13.
- A request that the Docker SDK adds later (a new endpoint) is denied by default and shows as a failing test.
- Rootless Docker (S-8, L-29) stays open.
