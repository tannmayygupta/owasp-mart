# Orchestrator service: the IF-5 API with mTLS, signed requests and state reports (L-13 part 2, story 3.2)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | tannmayygupta |
| Branch / commit | shared-L-13 / not committed yet |
| Status | Partly done (service done; reset and idle detection are story 3.4, reconciler 3.5, cold-start measurement S-4 open) |
| Report tag | orchestrator, instance lifecycle, IF-5 service |

## Requirements covered
FR-INS-07 (state machine over the API, reports), FR-INS-01, FR-INS-11; NFR-SEC-03, NFR-SEC-04; D-53 (ADR 0034); handoffs H-57, H-58, H-59 answered, H-119 added; H-66 and H-67 built.

## Summary (plain language, 3-5 lines)
The engine now has a network face. `python -m vulnmart_orchestrator` serves the seven IF-5 calls: it checks the signature and the client certificate, answers a create at once (202) while a worker thread builds the instance, and tells the platform about every state change. The instance is still never ready before the flag injection. The same contract test suites that were written for the Node fake now also run against this service.

## Why
The contract fixed what the orchestrator must do. Until a service answered it, the platform could not be tested against the real behaviour, and the engine blocked for about 90 seconds in `create`. Running the existing suites against a second implementation means it cannot drift from the contract unnoticed.

## What was built
- `service.py` (FastAPI app with one catch-all route, check order of the contract, TLS and command line), `auth.py` (signing, nonce memory), `jsonstrict.py` (integer tokens only, no duplicate keys), `problems.py` (RFC 9457 bodies), `ratelimit.py` (20 per second, burst 40), `capacity.py` (memory sum), `reports.py` (ordered, retried state report sender), `__main__.py`.
- Engine: contract alignment (template id, hostname, event key patterns, all five limits, JSON Pointer in errors, `fullmatch`), accept and run split with one lock per instance, a destroy that cancels a running build, record fields (hostname, limits memory, access, health, times), access, list, host status, a transition hook.
- Test backend `--backend fake` (in-memory Docker fake, template `shop-fail-v0`, step delay, hold mode), `Dockerfile`, CI step and `ci:linux` step for the suites against the service.

## How it works
Every request goes through one handler: body size (413) then signature (401), rate limit (429), route (404/405), media type (415), then the call. The engine decides shape, template, existence, state and capacity before anything is created. `accept_create` registers the instance as `requested` and returns the work; a daemon thread runs it. Each transition goes to a queue; one sender thread posts it signed to the platform, keeps order per instance and retries until the platform answers 204 or 200. The reset route validates and answers 501 until story 3.4.

## Files changed
- `apps/orchestrator/src/vulnmart_orchestrator/` : new `service.py`, `auth.py`, `jsonstrict.py`, `problems.py`, `ratelimit.py`, `capacity.py`, `reports.py`, `__main__.py`; changed `engine.py`, `builder.py`, `states.py`, `backend.py`, `images.py`
- `apps/orchestrator/tests/` : new `test_engine_service.py`, `test_wire.py`, `test_reports.py`, `test_service.py`
- `apps/orchestrator/pyproject.toml`, `uv.lock` (fastapi 0.143.0, uvicorn 0.54.0, already in the lock), `apps/orchestrator/Dockerfile`
- `apps/api/tests/support.py`, `conftest.py` and the test files `test_protocol.py`, `test_reports.py`, `test_http_service.py`, `test_mtls.py` (the `VM_ORCH_SERVICE` switch and the `needs_reset` / `node_only` markers)
- `.github/workflows/ci.yml`, `scripts/ci-linux.mjs`, `scripts/ci-linux.test.mjs`
- `docs/adr/0034-orchestrator-service-fastapi-signing-mtls-reports.md`, `docs/adr/README.md`, `initial.md` (D-53), `docs/dev/HANDOFFS.md`, `docs/dev/dev1-tanmay.md`, `CHANGELOG.md`, `docs/traceability.md`, the story plan file, `docs/assets/orchestrator-service/test-output.txt`

## Decisions made
ADR 0034 (D-53). Alternatives rejected: a router per call (breaks the order of checks), Pydantic models for the body (cannot tell `1` from `1.0`), TLS in a proxy only, running `create` inside the request, a database outbox for reports, copying the protocol tests for the service.

## Tests
See `docs/assets/orchestrator-service/test-output.txt` (last lines of each run) and the numbers below, all run on this PC (Windows, Python 3.14.8, Docker Desktop available).
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests`: 218 passed (3 on real Docker, 50 s)
- `VM_ORCH_SERVICE=python uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_protocol.py apps/api/tests/test_wire_rules.py apps/api/tests/test_http_service.py apps/api/tests/test_reports.py apps/api/tests/test_mtls.py`: 375 passed, 18 skipped (249 s; both sides of the shared tests count: the in-memory host runs everything, the HTTP side skips the reset cases) (the skipped ones are the reset and activity cases, reason "story 3.4", and one test of the Node launcher)
- `uv run --locked --package vulnmart-api pytest -q` (the Node fake, unchanged behaviour): 789 passed (283 s)
- `uv lock --check` (resolved 67 packages), `node scripts/check-text-files.mjs` PASS, `node scripts/scan-secrets.mjs` PASS, `node --test scripts/ci-linux.test.mjs` 10 of 10.
- `node --test "scripts/*.test.mjs"`: 581 of 582 pass; the one failure is `generate-api-code.test.mjs` ("CRLF alone is not stale"), which also fails with this change stashed (already in `deferred-work.md`, from main).
- A Docker image build of `apps/orchestrator/Dockerfile` worked; a container of it ran with the fake backend and stayed up until stopped by hand (that is how the empty template folder was found, see Problems); the image was removed.
- Traceability rows FR-INS-01, FR-INS-07, D-53 updated.

## Evidence
`docs/assets/orchestrator-service/test-output.txt`.

## Problems met and how they were fixed
- Starlette gives a function route only the GET method, so an odd method (for example PROPFIND) got a plain 405 before the signature check. Found by review of the check order, fixed with an ASGI object route and a test.
- A test expected the header `Retry-After`; uvicorn sends header names in lower case, the test now lowercases.
- `ssl` reports a missing certificate file without its name, so the command line now checks the three TLS files and names the missing one.
- `--templates-dir` pointing at nothing started a service with no template; now exit 2 with a message (found when a container started and did not stop).
- The plan said tests first; the modules were drafted first and the tests written straight after each one. Recorded here, not hidden.
- A first PowerShell edit wrote a byte order mark and CRLF into `states.py`; both were removed before anything ran.

## Security notes (vulnerable parts only)
None of the challenge code. Service rules: no flag, seed, key or owner hash in an answer or a log line (a test creates, fails and lists instances and searches every answer and the whole log); an exception message is never sent or logged (class name only); the signature check never says which part failed; unsigned traffic does not spend the rate limit; forbidden fields create nothing.

## Limitations and follow-ups
Reset and idle detection are story 3.4 (the reset call answers 501 and the suites skip those cases). The nonce memory and the report queue are per process. The rate limit keys on the peer address. No read timeout on a slow body beyond uvicorn defaults. Request `limits` other than memory are validated but not applied to containers. No compose service and no socket proxy wiring yet. The service was not run through real Docker (the engine's real-Docker tests of story 3.1 still pass), nor on a real host. Handoff H-119 tells the platform side what the report sender does. The Excel tracker is updated by the developer by hand.
