---
title: 'Orchestrator engine: state machine and Docker instance builder (create from a template, never ready before injection)'
type: 'feature'
ticket: '1'
created: '2026-10-12'
status: 'done'
baseline_revision: '5d526b62be95cfd88b00726f6df505f7cb2cb948'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [coordinator-read]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The real orchestrator does not exist (`apps/orchestrator` is empty). The existing `InstanceHost` is the platform's client port of IF-5, not a Docker driver. Nothing yet creates an instance on Docker from an IF-6 template, waits for health and flag injection, or guarantees that an instance is never ready before the injection finished.

**Approach:** A new workspace package `apps/orchestrator` (FastAPI and the Docker SDK per K-13 and ADR 0010) with the engine only: the state machine with numbered transitions, a template-to-container builder, a Docker backend behind a small interface (fake for unit tests, SDK for real Docker) and the create and destroy flow. The HTTP service is story 3.2.

## Boundaries & Constraints

**Always:** Decisions (developer, 2026-10-12: choose the best free option, least tokens): D1 Containers are built only from the validated template and the fixed runtime profile of IF-6 section 7, images only from an allowlist (`{image:<role>}` to a digest; the real source is the release manifest of L-12, a JSON file); nothing from a request can add an image, command, volume, port or env. D2 Order: volume keeper, injector (the injection document on stdin once), then the other components only after the injector exited 0; ready only when the injector exited 0 and the shop is healthy (`/readyz`); injector exit 10 to 13 or a crash gives failed with the placeholder `INST-INJECT-*` code, a health timeout gives `INST-HEALTH-TIMEOUT`. D3 State is in memory plus Docker labels (truth is Docker, no orchestrator database; the reconciler is story 3.5); every transition is numbered per instance and epoch and restarts at 1 with a new epoch, as in IF-5. D4 The engine states and error codes mirror the IF-5 contract and a test compares them with the OpenAPI enums. D5 Docker SDK pinned in the lock file; real-Docker tests run when a daemon is available (skipped locally without Docker, failing in CI like `require_openssl`); everything else runs on a fake backend. D6 The package is a uv workspace member with its own tests, wired into the CI `scripts` job and the `ci:linux` mirror.

**Never:** Claude runs nothing against live hosts or AWS; no secret, flag, seed or event key in an environment variable, a log line or a label; no change to the IF-5 or IF-6 contracts, to `apps/api` or other streams' code; no push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create | valid template, material, allowlisted images | transitions 1.. requested, provisioning, starting, ready; the injector gets the document once; ready only after exit 0 and health | none |
| Early health | shop healthy before the injector exits | not ready | none |
| Injector fails | exit 10 to 13 or crash | failed with the `INST-INJECT-*` code, objects removed | failure report |
| Health timeout | shop never healthy | failed `INST-HEALTH-TIMEOUT`, objects removed | failure report |
| Unknown template or image | not in the allowlist | refused before any container exists | `TEMPLATE-UNKNOWN` style error |
| Repeat | same create again | no new work, same result | none |
| Destroy | any state | all objects with the instance label removed; a second destroy succeeds | none |
| Request tries to add fields | image, command, port, env in the request | never reach the builder | refused |

</frozen-after-approval>

## Code Map

- `contracts/instance/instance-contract.md` (sections 1, 2, 4, 5, 6, 7), `instance-template.schema.json`, `examples/valid/instance-template/`; `contracts/orchestrator/orchestrator-api.md` lines 53-68 (state machine), `orchestrator.openapi.yaml` (enums, error codes); `infra/compose/harness.yaml` and `scripts/harness.mjs` 145-265 (start order, stdin feeding, health poll) as the reference of what the engine reproduces; `contracts/mocks/stub-instance/` (images for the real-Docker tests).
- `apps/api/src/vulnmart/ports/instance_host.py` (states, errors, `StateReport`) and `fake_instance_host.py` (`_step`, fingerprints) for the semantics to mirror; `apps/api/tests/support.py` `require_openssl` (skip locally, fail in CI).
- `pyproject.toml` (workspace members, testpaths), `apps/api/pyproject.toml` (deps and build backend to copy), `uv.lock` (no `docker` yet; `uv lock --check` runs in CI), `.github/workflows/ci.yml` job `scripts` (pytest line), `scripts/ci-linux.mjs` and its test (mirror).
- New: `apps/orchestrator/` (`pyproject.toml`, `src/vulnmart_orchestrator/{states,images,builder,backend,engine}.py`, `tests/`), ADR 0033, D-52, handoff answers (H-60, H-61, H-69, H-70, H-71).

## Tasks & Acceptance

**Execution:**
- [x] `pyproject.toml`, `apps/orchestrator/pyproject.toml`, `uv.lock`, CI `scripts` job, `scripts/ci-linux.mjs` and test -- workspace member with the Docker SDK, tests collected in CI -- scaffold
- [x] `states.py`, `images.py`, tests -- states and codes mirrored from IF-5 and checked against the OpenAPI, allowlist loader -- D1 and D4
- [x] `builder.py`, tests (tests first) -- template to container, network, volume and label specs with the runtime profile; the matrix rows about requests and images -- D1
- [x] `backend.py` (interface, fake and SDK backends), `engine.py`, tests -- create, destroy, order, numbered transitions, failure paths, idempotency -- D2 and D3
- [x] real-Docker integration test with the stub instance image -- start order, never ready early, destroy leaves nothing -- D5
- [x] ADR 0033, D-52, handoff answers, dev-log, CHANGELOG, traceability FR-INS-01, 02, 11 -- documentation rule

**Acceptance Criteria:**
- Given the fake backend, when the matrix is run, then every row behaves as written.
- Given a Docker daemon, when the integration test runs, then the stub instance reaches ready only after the injector exit and destroy removes every labelled object.
- Given the builder, when fed any request field, then no image, command, volume, port or env of the container can come from it.

## Implementation Notes

Done 2026-10-12. Package `apps/orchestrator` (states, images, builder, backend, engine, templates). 92 tests pass, 3 on real Docker with the stub image. Choices not in the plan: the sidecar gets its own start document on stdin and decoy digests are computed by the engine; request `limits` are not applied (template numbers are); `VULNMART_SKIP_DOCKER_TESTS=1` skips the Docker tests inside `ci:linux` (no daemon there). Extra codes: `INST-START-FAILED`. Documentation: ADR 0033, D-52, handoffs, dev-log, changelog, traceability. Story not marked done: waits for the developer.

## Plan Change Log

## Review Triage Log

Pass 1 (quick: the coordinator read the engine and the request parser; token-limited by the developer). No intent_gap, no bad_plan.

| # | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|
| 1 | Only the two known exception types are caught in `create`: an unwrapped SDK error or a KeyError leaves the instance stuck in `provisioning` with objects leaked | medium | patch (done) | `except Exception` sweeps and records failed with START_FAILED and no message text; a test raises RuntimeError carrying a seed and a flag |
| 2 | The dead `injected` flag and guard suggested a second check that does not exist | low | patch (done) | removed; the comment says the ordering is the guard |
| 3 | One lock for the whole provisioning blocks every other create and destroy | medium | defer | the concurrency story 3.6 needs a lock per instance; logged in deferred-work.md |
| 4 | `scripts/generate-api-code.test.mjs` fails on this Windows checkout ("CRLF alone is not stale") | medium | reject (not this change) | none of its files is touched by this branch; it comes from main (P-04); told to the developer for Akshay |
| 5 | Request parsing is an allowlist (ALLOWED_FIELDS) with forbidden names reported separately | n/a | kept | matches decision D1 |

## Design Notes

Why an engine first and the HTTP service later: the engine is the part that can be wrong in a dangerous way (ready too early, leftovers, request-controlled containers), so it is tested alone on a fake and on real Docker before the API wraps it. The socket proxy, mTLS and signing arrive with story 3.2.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests` -- expected: all pass (the Docker test runs here, Docker Desktop is available)
- `uv lock --check`, `node --test "scripts/*.test.mjs"`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass