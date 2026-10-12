# 0033. Orchestrator engine and Docker instance builder

- **Status:** Proposed (D-52, decided on the developer's delegation 2026-10-12: "choose the best free option, least tokens"; to be confirmed)
- **Date:** 2026-10-12
- **Deciders:** Tanmay (by delegation to Claude Code, story "state machine and Docker instance builder", task L-13 part 1)
- **Requirements:** FR-INS-01, FR-INS-02, FR-INS-07, FR-INS-11, NFR-SEC-04; decisions K-13, ADR 0010; contracts IF-5 and IF-6; handoffs H-60, H-61, H-69, H-70, H-71

## Context
`apps/orchestrator` was empty. The platform's `InstanceHost` is a client port of IF-5, not a Docker driver. Nothing created an instance on Docker from an IF-6 template, waited for health and flag injection, or guaranteed that an instance is never ready before the injection finished. The engine is the part that can be wrong in a dangerous way (ready too early, leftovers, request-controlled containers), so it is built and tested alone before the HTTP service (story 3.2) wraps it.

## Options considered
1. **Docker CLI through subprocess** (what `scripts/harness.mjs` does). Easy, but parsing output, quoting and stdin feeding are fragile and `StdinOnce` cannot be set. Rejected for the product code; the harness stays the reference.
2. **Docker Compose files per instance.** A Compose container has no `StdinOnce`, and a request-built Compose file is exactly the path NFR-SEC-04 forbids. Rejected.
3. **Chosen: Docker SDK for Python (docker-py 7.1.0) behind a small `Backend` interface**, with an in-memory fake for unit tests. Free, proven, pinned in `uv.lock`, and the low-level API sets `StdinOnce`.
4. **A database for instance state.** Rejected for now: truth is Docker (labels), a reconciler (story 3.5) repairs differences.

## Decision
- **Builder (D1).** Containers come only from the validated template, the fixed runtime profile of IF-6 section 7 (constants in code, a template that deviates is refused) and an image allowlist (`{image:<role>}` to a digest; source is the release manifest of L-12, a JSON file with `images`, optional `entrypoints` and `commands`). A create request is parsed into a data-only `CreateSpec`; names such as image, command, env, ports, volumes are refused with ORCH-FIELD-FORBIDDEN, any other unknown name with ORCH-VALIDATION.
- **Order (D2).** Network and volumes, containers created, volume keeper started (it keeps the tmpfs volumes mounted, IF-6 OP 36), injector started with its document on standard input once, wait for exit 0, injector removed, then the other components (the sidecar gets its start document the same way), then wait for healthy. `ready` only after the injector exit 0 and every healthcheck healthy. Injector exit 10 to 13 or a crash gives `failed` with the placeholder `INST-INJECT-*` code, a health timeout `INST-HEALTH-TIMEOUT`, a Docker failure `INST-START-FAILED`; every object is removed before `failed` is recorded.
- **State (D3).** In memory plus Docker labels (nine IF-6 labels on every container, network and volume). Transitions are numbered per instance and epoch from 1. Create is idempotent (same body returns the same record; another body is ORCH-REQUEST-MISMATCH; lower epoch is ORCH-STALE-EPOCH). Destroy removes every object with the `vm.instance` label, works without a record, and a second destroy succeeds. A destroy that cannot finish stays `stopping` and a repeat retries.
- **Mirror (D4).** States and codes follow IF-5; a test compares them with the OpenAPI enum and code pattern.
- **Tests (D5, D6).** Fake backend for the matrix; real-Docker tests with the stub instance image (skipped without a daemon locally, failing in CI; `VULNMART_SKIP_DOCKER_TESTS=1` skips them inside `ci:linux`, which has no daemon). The package is a uv workspace member, run in the CI job `scripts` and in `ci:linux`.

## Consequences
- The request `limits` (memory, CPU, pids) are not used by the builder; the template numbers apply until a decision says otherwise.
- The sidecar start document marks decoy digests as `decoy` computed by the engine from the decoy values; the IF-5 body gives digests for real flags only.
- One lock serialises calls; the HTTP service decides how to run them in the background.

## Residual risks
- Healthchecks run `wget`, `nc` and `test` inside the container; product images must contain them (UNVERIFIED for T's images).
- Volume options verified on Docker Desktop only, not on the Oracle VMs (H-61).
- Images are not pulled; they must exist on the host. Reset (new epoch), reconciler, mTLS, signing and the socket proxy are not here (stories 3.2, 3.3, 3.5, L-14).
- Docker 29 and docker-py 7.1.0 worked together in the tests; docker-py 7.1.0 is old, watch for a newer release.

## Sources
- Docker SDK for Python documentation (low-level API: `create_container_config`, `attach_socket`, `create_host_config`), docker-py 7.1.0.
- Docker Engine API: container create (`StdinOnce`, `OpenStdin`), volumes (local driver tmpfs options).
- Repository: `contracts/instance/instance-contract.md` sections 1, 4, 5, 7; `contracts/orchestrator/orchestrator-api.md` section 3; `scripts/harness.mjs`; ADR 0010; ADR 0028.
