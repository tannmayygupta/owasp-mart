# 0034. Orchestrator service: the IF-5 API over the engine

- **Status:** Proposed (D-53, decided on the developer's delegation 2026-10-12: "choose the best free option, least tokens"; to be confirmed)
- **Date:** 2026-10-12
- **Deciders:** Tanmay (by delegation to Claude Code, story "Orchestrator service: the IF-5 API with mTLS, signed requests and state reports", task L-13 part 2)
- **Requirements:** FR-INS-07, FR-INS-01, FR-INS-11, NFR-SEC-03, NFR-SEC-04; decisions D-52, D-47, ADR 0024, ADR 0028; contracts IF-5 and IF-6; handoffs H-57, H-58, H-59, H-66, H-67, H-113

## Context
The engine of story 3.1 (ADR 0033) had no network face. Nothing served the IF-5 calls, checked mutual TLS and signed requests, pushed state reports to the platform, or ran the existing contract suites against a real implementation. The engine also differed from the contract in some patterns and limits, and `create` blocked for about 90 seconds while Docker worked, which a request-answering service cannot do.

## Options considered
1. **Framework.** (a) FastAPI with a router per call: the router answers 404/405 before the signature and validates before the media type, which breaks the contract's order of checks. (b) Plain `http.server`: no TLS options, no async, hand-made everything. (c) **Chosen: FastAPI (already pinned for `apps/api`) with one catch-all route and the dispatch written by hand**, run by uvicorn (pinned too). Free, proven, no new dependency in the lockfile except the two pins on this package.
2. **JSON reading.** (a) Pydantic models: a float `1.0` becomes an `int` and a duplicate key is lost, which the contract forbids (section 2a). (b) **Chosen: the standard-library parser with `parse_int`, `parse_float`, `parse_constant` and `object_pairs_hook`** (`jsonstrict.py`): an integer above 2^53 - 1 and a float are marked values that the field checks refuse, a duplicate key and `NaN` are refused. One small module, no new dependency.
3. **mTLS.** (a) Terminate TLS in a proxy: a deployment choice that the service cannot test. (b) **Chosen: the service builds an `ssl.SSLContext` itself** (TLS 1.2 or higher, `CERT_REQUIRED`, the CA given by `--tls-ca`) and hands it to uvicorn through `ssl_context_factory`, with the same all-three-or-none options as the Node fake. A TLS 1.1 client, a missing, expired or foreign client certificate are refused by the handshake.
4. **Slow work.** (a) Run `create` in the request: 90 seconds of blocking, the platform times out. (b) A task queue: a new moving part. (c) **Chosen: split every slow call in accept and run.** `accept_*` checks everything the contract checks and answers; the returned `work` runs on a daemon thread. One lock per instance for the slow work, one short lock for the table and every state change. A destroy during a build cancels the build at its next step, then removes everything.
5. **Report delivery.** (a) Fire and forget (what the Node fake does): a down platform loses reports. (b) A database outbox: no database in the orchestrator (ADR 0033). (c) **Chosen: an in-memory queue with one sender thread**: in order per instance, retried until 204 or 200 with a growing pause (0.2 s to 5 s), bounded at 10000 (the oldest report that is not on the wire is dropped and a line says so), instances do not hold each other up. Standard-library HTTP only (no httpx dependency).
6. **Tests.** (a) New protocol tests for the service: a second copy that can drift. (b) **Chosen: the existing protocol, wire, http, report and mTLS suites of `apps/api` run against the service** (`VM_ORCH_SERVICE=python`), which already pin the contract against the Node fake. A test backend (`--backend fake`: in-memory Docker fake, the template `shop-fail-v0` that never becomes healthy, a step delay, a hold mode) lets them run without Docker. Reset and activity cases are skipped for this kind with the reason "story 3.4".

## Decision
- **Order of checks.** Body size (413, the connection is closed), signature (401, never says which check failed), rate limit (429, counted for signed requests only, so unsigned traffic cannot spend the platform's bucket), the call exists (404 `ORCH-ROUTE-UNKNOWN`, 405 with `Allow`), media type (415), path id and body shape (422), then the engine: template (422), existence (404), state and epoch (409), capacity (429 `ORCH-BUSY`, `Retry-After: 5`).
- **Errors.** RFC 9457 bodies (`problems.py`) with the IF-5 codes; `title` fixed per code, `detail` at most 500 characters; no exception message, stack, secret or body text. A template or image fault of the deployment is `ORCH-INTERNAL` with a generic text and a log line with the class name. Service-only codes (not in the OpenAPI list, like the fake's): `ORCH-ROUTE-UNKNOWN`, `ORCH-INTERNAL`, `ORCH-NOT-IMPLEMENTED`.
- **Signing.** Contract section 4 exactly: `v1`, 60 s skew, 5 minute nonce memory (per process, bounded at 200000 entries), constant-time compare, the request target as sent. The test vector of the contract is a unit test.
- **Strict JSON, limits, capacity.** As in the contract (`2a`, `7`); `cpu_limit` compared by value; the request fingerprint now includes all five limits. Capacity is the sum of `memory_mb` of instances that are not destroyed (`--capacity-mb`, default 8192); a tombstone holds none.
- **Engine alignment.** Template id, hostname and event key patterns and the limit ranges follow the contract; validation errors carry a JSON Pointer; all patterns use `fullmatch` (a trailing newline no longer passes).
- **Reset.** A marked placeholder: it validates the body, looks the instance up, checks state and epoch (404, 409), then answers 501 `ORCH-NOT-IMPLEMENTED` and changes nothing. Story 3.4 builds it. Idle detection and the activity control of the fake are not here either.
- **Rate limit.** Token bucket per client address, 20 per second, burst 40, `Retry-After` in whole seconds; `--rate-per-s 0` switches it off (the test harness does, because a test polls faster than any platform).
- **Image.** `apps/orchestrator/Dockerfile` follows `apps/api/Dockerfile` (digest-pinned bases, non-root, locked install). Port check as Docker health check, because every API call is signed. No compose service and no socket proxy wiring yet.

## Consequences
- The Python service and the Node fake must keep passing the same suites; a contract change shows in both.
- Keys come from `--key` / `--report-key` or `VM_ORCH_PLATFORM_KEY` / `VM_ORCH_REPORT_KEY` (the environment is preferred: a command line shows in the process list). A key shorter than 32 characters is refused at start.
- The report queue is lost with the process; the platform reads the missing numbers as a gap (IF-5 section 8) and the reconciler (story 3.5) repairs real state.
- Request `limits` other than memory are validated and part of the identity but not applied to containers (the template numbers apply).

## Residual risks
- The nonce memory is per process (H-58); the 60 s window is the only defence across a restart or two copies.
- The rate limit keys on the peer address; behind a proxy every client looks the same (deployment decides).
- A very large number of open connections is bounded only by uvicorn defaults and the host firewall.
- The destroy worker retries 5 times and then leaves the instance `stopping`; a repeated destroy call or the reconciler finishes it.
- The oversize-body refusal drops the connection while a client may still be sending, so a client can see a reset instead of the 413 (the contract says so).
- Not run on a real host or with real Docker through the service in this story; the real-Docker tests of the engine (story 3.1) are unchanged.

## Sources
- RFC 9457 (problem details), RFC 6901 (JSON Pointer), RFC 7493 (I-JSON, the 2^53 - 1 limit), RFC 2104 (HMAC), RFC 8259 (JSON).
- Python documentation: `json.loads` hooks (`parse_int`, `parse_float`, `parse_constant`, `object_pairs_hook`), `ssl.SSLContext` (`minimum_version`, `verify_mode`), `hmac.compare_digest`.
- uvicorn 0.54.0 `Config` (`ssl_context_factory`), read in the installed package; FastAPI 0.143.0 and Starlette `Request.stream`.
- Repository: `contracts/orchestrator/orchestrator-api.md` (sections 2, 2a, 3, 4, 5, 6, 7, 8), `orchestrator.openapi.yaml`, `examples/signing-vector.json`, `contracts/mocks/fake-orchestrator/server.mjs`, `apps/api/src/vulnmart/ports/http_instance_host.py`; ADR 0024, 0028, 0033.
