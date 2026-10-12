---
title: 'Orchestrator service: the IF-5 API with mTLS, signed requests and state reports over the engine'
type: 'feature'
ticket: '2'
created: '2026-10-12'
status: 'built'
baseline_revision: 'b471cd7b3391ee19202c5d56d84ff55af83c444b'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The engine of story 3.1 has no network face. Nothing serves the IF-5 API (create, get, list, access, destroy, host), verifies mutual TLS and signed requests, pushes state reports to the platform, or runs the existing protocol suite against a real service. The engine also differs from the contract in places and blocks for about 90 seconds in `create`.

**Approach:** A FastAPI service in `apps/orchestrator` that serves IF-5 over the engine: the signing and error rules of the contract, strict JSON, size, media-type and rate limits, 202 with background provisioning, capacity answers, and an in-order state-report pusher. The existing protocol, wire, http, report and mTLS suites run against it as another kind. Reset and idle detection belong to story 3.4; the reset route is a marked placeholder until then.

## Boundaries & Constraints

**Always:** Decisions (developer, 2026-10-12: best free option, least tokens): D1 The contract is the source: signing string `v1`, 60 s skew, 5 minute nonce memory, constant-time compare, check order (413, 401, 404/405, 415, 422, 404, 409, 429), RFC 9457 problem bodies with the IF-5 codes, no message, stack or secret in any answer or log. D2 Strict JSON: integer tokens only, at most 2^53-1, no duplicate keys, `cpu_limit` by value. D3 The engine is aligned with the contract before the service uses it: template id, hostname and event key patterns, limits (memory 64 to 8192, pids 16 to 4096, idle and max minutes 1 to 1440), JSON Pointer in validation errors, a canonical fingerprint that includes the limits. D4 `create` is split into accept (validate, capacity, register as requested, synchronously) and run (a worker thread), with one lock per instance; transitions feed a report queue. D5 State reports go to `report_url/internal/v1/orch/state`, signed with the orchestrator key, in order per instance and epoch, retried until accepted (409 for an identical `(instance, epoch, transition)` counts as done only on 204 or 200), bounded queue, no secret logged. D6 mTLS: TLS 1.2 or higher, client certificate required, all three TLS options or none (the CLI of the Node fake). D7 Rate limit 20 per second per client, burst 40, 429 with `Retry-After`. D8 Capacity is the sum of `memory_mb` of non-destroyed instances against `--capacity-mb`: 429 `ORCH-BUSY`. D9 The tests reuse the protocol suites: a test backend (`--backend fake`) reproduces `shop-fail-v0` (health timeout), a step delay and a hold mode; reset tests are skipped for this kind with the reason "story 3.4". D10 A Dockerfile for the service follows `apps/api/Dockerfile`; no compose service and no socket proxy wiring yet (deployment is later).

**Never:** change IF-5, its examples or the Node fake; touch other streams' code beyond the test harness hook; a secret in a log or answer; run anything against the live hosts; push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Signature | missing, wrong, stale timestamp, replayed nonce | 401 `ORCH-BAD-SIGNATURE`, nothing changes | never says which |
| Body | over 64 KiB; not JSON media type; float or duplicate key | 413; 415; 422 with a JSON Pointer | problem body |
| Create | valid, then the same, then another body | 202, 200, 409 `ORCH-REQUEST-MISMATCH` | problem body |
| Request fields | image, command, port, env, volume | 422 `ORCH-FIELD-FORBIDDEN` | nothing created |
| Provisioning | accepted create | answered at once; ready only after injection | failures become failed with a code |
| Capacity | memory over the limit | 429 `ORCH-BUSY` with `Retry-After` | none |
| Rate | over 20 per second | 429 `ORCH-RATE-LIMITED` with `Retry-After` | none |
| List | filters, limit, cursor | ordered by id, canonical cursor, 422 on bad input | problem body |
| Access | growing `access_epoch` | 200; older epoch 409 `ORCH-STALE-ACCESS-EPOCH` | problem body |
| Destroy | any known state, twice | 202 then 200, tombstone stays | unknown 404 |
| Reset | any | marked placeholder (story 3.4), no state change | tests skipped |
| Reports | each transition | pushed in order, retried until 204 or 200, restarts at 1 per epoch | no secret logged |
| mTLS | no or wrong client certificate, TLS 1.1 | refused | none |

</frozen-after-approval>

## Code Map

- `contracts/orchestrator/orchestrator-api.md` (sections 1, 2, 2a, 4, 6, 8) and `orchestrator.openapi.yaml`; the reference behaviors in `contracts/mocks/fake-orchestrator/server.mjs` and the reference signer in `apps/api/src/vulnmart/ports/http_instance_host.py` (lines 58-149, `loads_strict`).
- `apps/orchestrator/src/vulnmart_orchestrator/engine.py`, `builder.py` (`parse_create` differs from the contract), `states.py`, `backend.py` (fake backend), `templates.py`; `apps/orchestrator/pyproject.toml` (no FastAPI, uvicorn or httpx yet; pins in `apps/api/pyproject.toml`).
- Tests: `apps/api/tests/support.py` (`ServiceProcess`, `make_harness`, `Pki`, `ReportReceiver`), `conftest.py`, `test_protocol.py`, `test_wire_rules.py`, `test_http_service.py`, `test_reports.py`, `test_mtls.py`; `scripts/e2e/orchestrator.e2e.test.mjs` (hard-wired to the Node fake: unchanged).
- CI: `.github/workflows/ci.yml` job `scripts` (orchestrator pytest line), `ci-linux` mirror; `apps/api/Dockerfile` as the pattern.
- New: `src/vulnmart_orchestrator/{service,auth,jsonstrict,problems,reports,ratelimit,capacity}.py`, tests in `apps/orchestrator/tests/`, a service switch in the api test harness (environment variable), `apps/orchestrator/Dockerfile`, ADR 0034, D-53, handoff rows H-57 to H-59 answered, traceability FR-INS-07.

## Tasks & Acceptance

**Execution:**
- [ ] `builder.py`, `states.py`, `engine.py`, tests (tests first) -- contract alignment, accept and run split, per-instance locks, record fields (hostname, limits, access, times, health), list, capacity, access -- D3, D4, D8
- [ ] `auth.py`, `jsonstrict.py`, `problems.py`, `ratelimit.py`, tests -- signing check with the vector, strict JSON, problem bodies, rate limit -- D1, D2, D7
- [ ] `service.py` and the CLI -- routes, check order, size limit, TLS options, background runner, `--backend fake` test backend -- D1, D6, D9
- [ ] `reports.py`, tests -- ordered, retried push -- D5
- [ ] api test harness switch and the CI line -- the protocol, wire, http, report and mTLS suites against the Python service; reset kinds skipped with the reason -- D9
- [ ] `apps/orchestrator/Dockerfile`, ADR 0034, D-53, handoffs, dev-log, CHANGELOG, traceability -- D10 and the documentation rule

**Acceptance Criteria:**
- Given the Python service, when the protocol, wire, http, report and mTLS suites run against it, then they pass except the skipped reset cases.
- Given any request, when it carries an image, command, port, env or volume, then nothing is created and no secret appears in any answer or log.
- Given an accepted create, when the engine is slow, then the answer is immediate and the instance is ready only after the injection.

## Implementation Notes

Built 2026-10-12. All six execution tasks done. New modules `service`, `auth`, `jsonstrict`, `problems`, `reports`, `ratelimit`, `capacity`, `__main__` in `apps/orchestrator`; the engine, builder, states, backend and images were extended (contract alignment, accept and run split, per-instance locks, capacity, access, list, report hook, test backend). Choices the plan left open: (1) the whole service is one catch-all FastAPI route, because a router would break the contract's order of checks; (2) the rate limit is counted after the signature check, so unsigned traffic cannot spend the platform's bucket, and `--rate-per-s 0` switches it off (the harness polls faster than 20 per second); (3) the reset call validates, checks existence, state and epoch, then answers 501 `ORCH-NOT-IMPLEMENTED` (a service-only code, like the fake's `ORCH-ROUTE-UNKNOWN`); (4) reports use the standard library HTTP client, so no httpx dependency; (5) the api test harness picks the service with `VM_ORCH_SERVICE=python` and starts it with `sys.executable -m vulnmart_orchestrator` and `PYTHONPATH=apps/orchestrator/src`; tests that need reset or the activity control carry `@pytest.mark.needs_reset` and are skipped on the HTTP side with the reason "story 3.4"; (6) `fullmatch` replaced `match` in the builder patterns (a trailing newline used to pass). Tests were written right after each module, not before the first draft of the service (honest note: the plan said tests first). Story not marked done: waits for the review and the developer.

## Plan Change Log

## Review Triage Log

## Design Notes

Why the service reuses the existing suites: they already pin the contract against the Node fake, so a second implementation that passes the same tests cannot drift from it. The test backend lives in the package behind a flag so the suites need no Docker.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests` and the protocol suites against the service (the command the implementer wires into CI) -- expected: pass
- `uv lock --check`, `node --test "scripts/*.test.mjs"`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass