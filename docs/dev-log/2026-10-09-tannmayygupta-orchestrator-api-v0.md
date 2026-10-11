# Orchestrator API v0 (IF-5), InstanceHost protocol and fake orchestrator (story L-04, ticket 1.4)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay, based on 38a980f; committed locally, not pushed (sprint pull request after the 8 tasks) |
| Status | Built, reviewed (thorough, one round with four reviewers, fixes applied) and tested; Akshay's optional read of the 30 open points (D-37) and the CI run on a pull request are still open |
| Report tag | contracts, IF-5, IF-9, fake orchestrator, sprint 1 |

## Requirements covered
IF-5 and the `InstanceHost` port of IF-9 (architecture 07 sections 3.1, 3.3, 3.5, 3.6); FR-INS-07 (state machine), NFR-SEC-04 (template-id-only), NFR-ISO-03; security architecture lines on mTLS, signed bodies, timestamp and nonce (06). Traceability row LB-5. Decisions used: D-37 (review optional during initial development), Tanmay's three choices of 2026-10-09 recorded in the plan.

## Summary (plain language)
The platform worker and the orchestrator now have one written agreement for their eight calls (seven calls plus the signed state report): an OpenAPI 3.1 file, a text with the state machine, signing, idempotence and errors, and examples. On the Python side there is an `InstanceHost` protocol with two implementations: an in-memory fake and a real HTTP client. A small Node program acts as a fake orchestrator for the client to talk to. One test suite runs every matrix row against both views and passes.

## Why
Architecture 07 fixed only a list of calls. Without bodies, signing and error rules each side would invent its own, and the lab harness had no orchestrator to talk to. Story 1.4 of `epic-lab-baseline` (task L-04).

## What was built
- `contracts/orchestrator/orchestrator.openapi.yaml`: the eight calls, closed request and response schemas, problem-details errors, signing headers.
- `contracts/orchestrator/orchestrator-api.md`: state machine and rules per call, signing string, idempotence table, error table, limits, fake-service notes, 30 open points (all proposals).
- `contracts/orchestrator/examples/`: 15 valid, 33 invalid (each with its expected error path), `signing-vector.json`.
- `apps/api/` package `vulnmart-api`: `ports/instance_host.py` (protocol, data types, error classes), `fake_instance_host.py`, `http_instance_host.py` (client plus `sign_request` and `verify_request`). Standard library only at runtime. Only the package skeleton and these three modules, no kernel.
- `contracts/mocks/fake-orchestrator/server.mjs`: Node, no dependencies; state machine, signature and nonce checks, capacity limit, step delay, optional signed state reports, never stores or returns secrets.
- `scripts/check_orchestrator_contract.py`: the contract check, second half of `pnpm run contracts:check`.
- Tests in `apps/api/tests/`; CI `scripts` job now runs them.

## How it works
- The platform signs every request (HMAC-SHA256 over method, request target, timestamp, nonce, SHA-256 of the body). The receiver recomputes, checks 60 s skew and a 5-minute nonce memory, and answers 401 `ORCH-BAD-SIGNATURE` for any failure without saying which.
- Create is asynchronous (202, then `requested` advancing to `ready`), idempotent on `(instance_id, epoch)`. Request bodies are closed: an image, command, volume, port, network or env field gets 422 `ORCH-FIELD-FORBIDDEN` and nothing is created. Reset needs the next epoch and new secrets; access needs a growing access epoch.
- The fake service reduces a create body to a SHA-256 fingerprint, so it holds no flag, digest, seed or key. The `InstanceStatus` schema is closed, and the contract check walks every GET answer schema to prove no secret-looking property can appear.
- The shared protocol suite is parametrized: `FakeInstanceHost` in process, and `HttpInstanceHost` against a freshly started fake service process.

## Files changed
- `contracts/orchestrator/*` (new: yaml, md, 48 example files and 2 manifests, signing vector); `contracts/mocks/fake-orchestrator/server.mjs` (new); `.gitkeep` removed in `apps/api`, `contracts/orchestrator`, `contracts/mocks`.
- `apps/api/pyproject.toml`, `apps/api/src/vulnmart/__init__.py`, `ports/__init__.py`, `ports/instance_host.py`, `ports/fake_instance_host.py`, `ports/http_instance_host.py`, `apps/api/tests/{conftest,support,test_protocol,test_http_service,test_contract}.py` (new).
- `scripts/check_orchestrator_contract.py` (new); `scripts/e2e/contracts.e2e.test.mjs` (fresh-checkout test also runs the Python tests and the new check).
- `pyproject.toml` (workspace member, root pytest `testpaths`), `uv.lock`, `package.json` (`contracts:check`), `.github/workflows/ci.yml`, `README.md`, `contracts/CHANGELOG.md`, `CHANGELOG.md`, `docs/traceability.md` (row LB-5).

## Decisions made
No new ADR: the signing scheme, limits and codes are proposals listed in the open-points table, not locked decisions (CLAUDE.md rule 1). Tanmay's three choices (2026-10-09): OpenAPI checked with `openapi-spec-validator` 0.9.0 from Python tests; fake service in Node, dependency-free, separate process; protocol, fake and client in `apps/api/src/vulnmart/ports/`. Akshay still has to be told in the team chat that `apps/api` now has a package skeleton and these three modules (not done by Claude).

Choices made while building that the plan did not state (all visible in the open-points table or here): create carries `seed` (the IF-6 injection document needs it); a GET is signed too; `ORCH-INSTANCE-EXISTS`, `ORCH-INVALID-STATE`, `ORCH-STALE-EPOCH` and others were added to the names in the matrix; the fake accepts a second template `shop-fail-v0` and a loopback-only `/_fake/` activity endpoint for tests; the check script is Python (`scripts/check_orchestrator_contract.py`) rather than extending the Node validator, because the OpenAPI file is YAML and the plan fixed the validator to `openapi-spec-validator`.

## Tests
Real commands and results (2026-10-09, Windows 11, Node 24.11.0, uv 0.12.23, Python 3.14.8):
- `uv run --locked --package vulnmart-api pytest -v`: first run 115 passed in about 22 s; after the review fixes (section below) 204 passed in about 52 s (output in `docs/assets/l-04-orchestrator-api/pytest-verbose.txt`). Protocol suite: every matrix row on both views; HTTP-only tests: wrong key, changed body, changed query, stale and future timestamps, replayed nonce, missing headers, 12 forbidden field names, malformed bodies, oversize body, schema conformance of answers, signed state reports against a Python receiver, step delay; contract tests: OpenAPI validity, 9 negative tests of the check itself, Python and Node signers reproduce the vector.
- `pnpm run contracts:check`: exit 0; instance part "5 valid and 129 invalid examples PASS"; orchestrator part "8 operations, 15 valid and 33 invalid examples PASS" (`docs/assets/l-04-orchestrator-api/contracts-check.txt`).
- `node --test "scripts/*.test.mjs"`: 40 of 40 pass.
- `node --test "scripts/e2e/contracts.e2e.test.mjs"`: 7 of 7 pass, including the fresh-checkout test with `pnpm install --frozen-lockfile`, the script tests, the Python tests and `contracts:check` in a clean copy.
- `uv lock --check`: passes; `pnpm install --frozen-lockfile`: up to date; `pnpm audit`: no known vulnerabilities; `uv audit --locked`: no known vulnerabilities in 26 packages.
- Not run: the GitHub Actions workflow itself (no push made); `bmad-code-review` and `bmad-qa-generate-e2e-tests` are not part of this implementation step.
Traceability row: LB-5 in `docs/traceability.md`.

## QA end-to-end tests (2026-10-09)

`scripts/e2e/orchestrator.e2e.test.mjs` (11 tests, written by the QA step as an independent consumer: the fake orchestrator as a separate process, an own implementation of the signing rule checked against the signing vector, hand-checked answer schemas, plus the Python suite once): 11 of 11 pass; the 10 service tests are stable over 5 runs; with a deliberately wrong signing key in a temporary copy, 10 of 10 fail. Summary in `docs/bmad/initiative-lab/test-summary-l-04-orchestrator-api/`, output in `docs/assets/l-04-orchestrator-api/e2e-orchestrator.txt`.

## Evidence
All in `docs/assets/l-04-orchestrator-api/`, regenerated after the review fixes: `pytest-verbose.txt`, `contracts-check.txt`, `node-script-tests.txt`, `contracts-e2e-tests.txt`, `uv-lock-check.txt`, `pnpm-audit.txt`, `uv-audit.txt`.

## Review fixes (2026-10-09, after the first report)
A review found problems; fixed in six steps, each followed by the tests of the touched files.
1. Fake host parity: `FakeInstanceHost` now mirrors the service validation (limit ranges, host name, flag, decoy and digest shapes, reset epoch at least 2, malformed ids give `ValidationFailed` on `/instance_id`, cursor and label checks, `Access(access)` coercion, `!=` comparison). Create of a destroyed id and create with an older epoch are refused in both the fake host and the service (`ORCH-INSTANCE-EXISTS`, `ORCH-STALE-EPOCH`). New shared protocol cases run on both hosts.
2. Client: transport errors, read errors and `http.client` errors all become `OrchestratorUnavailable`; the instance id is checked and quoted before it reaches the path; an https URL needs an `ssl_context`, plain http only for loopback; the key must be 32 characters or more; responses are capped at 1 MiB; `Retry-After` is carried as `retry_after`; `ORCH-UNAVAILABLE` is in `ERRORS_BY_CODE`; the nonce cache has a lock and incremental expiry; a naive datetime is taken as UTC. A stub-server test class covers HTML, empty, unlisted-code, redirect, wrong-status, non-object, truncated and oversize answers. "A 200 where 202 is expected" was taken to mean a 202 answer to a call that only allows 200 (`get`), and an empty 200 to `create`; this is my reading of the instruction.
3. Fake service: a body over the cap is not read or hashed (413, connection dropped), so an oversize body with a wrong key is now 413 not 401 (the contract text says so); an unreadable calendar date fails the skew check; echoed keys are cut to 64 characters; state reports time out (default 5000 ms, `--report-timeout-ms`) and refused ones go to stderr; `limit` must be a plain whole number; a repeated query parameter is 422; a wrong method on a known path is 405 `ORCH-METHOD-NOT-ALLOWED`; bad numeric options exit 2; the activity control path does nothing when the state does not change. Tests for each.
4. Contract check: the "no secret in a GET answer" scan follows `$ref` responses, walks every media type and rejects free-form objects; malformed YAML, JSON, manifest entries or a vector without `body_sha256` give a FAIL line naming the file and exit 1 with no traceback. New tests, including a secret injected into a referenced GET response.
5. Test helper: the service's stderr goes to a temporary file, and the first stdout line is read with a 15 second timeout (a test proves a silent service fails fast).
6. Docs and tidy: a garbled word in the contract text (`pps/api/...`, an escape mistake of mine in a PowerShell string that also dropped some backticks) fixed and all new files scanned for control characters; open points 24 to 30 added; one pytest setting (root `pyproject.toml`); `py.typed` added; traceability wording corrected (built and tested, not closed).
Result after the fixes: 204 of 204 Python tests, 40 of 40 script tests, 7 of 7 contract end-to-end tests; `pnpm run contracts:check` PASS; `uv lock --check`, `pnpm audit` and `uv audit --locked` clean.
Problem met during the fixes (also see the follow-up below): PowerShell has an alias `R` for `Invoke-History`, so a first batch of helper-based edits did nothing; the edits were redone with the edit tool.

## Problems met and how they were fixed
- The first YAML parse failed: an unquoted description held ": " inside a mapping value. Reworded.
- Plain `pytest` from the repo root also collected the BMAD skill tests in `_bmad/` and failed. Added `testpaths = ["apps/api/tests"]` to the root `pyproject.toml`.
- PowerShell `Set-Content -Encoding utf8` wrote byte-order marks into two TOML files and a JS file; stripped them.
- Test helper returned response header names in their original case; the test looked for another case. Normalised to lower case.
- My own test expected 11 state reports when the machine makes 10 (create 4, reset 4, destroy 2). Fixed the count.
- The first fake service could not authenticate a body over 64 KiB (it needs the whole body to hash). It now hashes the body while streaming, so an oversize body with a bad signature is 401 and with a good one 413.

## Security notes
No intentionally vulnerable part. The contract protects the orchestrator boundary (TB-5): closed request schemas, no image, command, volume, port, network or env accepted (NFR-SEC-04), signed and replay-protected requests, no secret in any GET answer. All keys, flags, digests and seeds in examples and tests are obviously fake. mTLS is not exercised (plain HTTP on localhost in tests).

## Follow-up: gaps closed (2026-10-09, handoffs H-20, H-59, H-50)
Decisions by Tanmay, written as proposals (open points 31 to 33 of the orchestrator contract; nothing is confirmed by Akshay yet):
- IF-5 create body: new required `owner_hash` (64 lowercase hex, the opaque `vm.owner` label value, computed by the platform, proposal HMAC-SHA256 of the user id with a platform label key). The orchestrator stores it, applies it as the label and never returns it. A reset keeps the owner, so a reset body with `owner_hash` is refused (422 `ORCH-VALIDATION`, `/owner_hash`).
- IF-5 create and reset bodies: new required integer `first_seq` (at least 1), the first sequence number of the new sidecar (highest stored seq plus one, 1 at first create). Passed to the sidecar on standard input at start with the event key and the flag digests; the exact shape is left to L-06 and L-13. Part of the request fingerprint, never returned. A reset sends the same event key unless the platform raised the key version (proposal).
- IF-4: the import service never posts; the shop posts `import.job` on its behalf. IF-6: section 4 and 6 notes, open points 23 and 35.
Built: OpenAPI schemas `OwnerHash` and `FirstSeq`, 11 new invalid examples (44 in total), Python types and validation in `FakeInstanceHost`, serialisation in the client, validation in `server.mjs`, test builders, new shared protocol cases (bad owner hash, bad `first_seq` on create and reset, both fields in the request identity), service tests (JSON Pointer errors, reset refuses `owner_hash`, no GET answer holds the owner hash or either `first_seq`), and a case in `scripts/e2e/orchestrator.e2e.test.mjs`. The contract check now also treats `owner_hash` and `first_seq` as names a GET answer schema must not carry. `HANDOFFS.md` rows H-20, H-59 and H-50 now carry the proposals (status still `open`).
Results: `uv run --locked --package vulnmart-api pytest`: 244 passed; `pnpm run contracts:check`: PASS (orchestrator part: 8 operations, 15 valid and 44 invalid examples); `node --test "scripts/*.test.mjs"`: 82 of 82; `node --test` on the orchestrator, events and contracts end-to-end files: 30 of 30. Evidence regenerated in `docs/assets/l-04-orchestrator-api/` (`pytest-verbose.txt`, `contracts-check.txt`, `node-script-tests.txt`, `e2e-tests.txt`).
Problem met: the first full end-to-end run failed once, in the fresh-checkout copy, because the oversize-body test sometimes saw a connection reset instead of the 413 (the service drops the connection while the client is still sending). The test now retries a few times to see the real answer.

## Limitations and follow-ups
- All 30 open points are proposals. Akshay's reading is optional (D-37); tell him in the team chat, also about the new `apps/api` skeleton.
- The rate limit is only a proposal; the fake does not enforce it. The fake does not retry state reports. Fake-only extras: `shop-fail-v0`, `/_fake/` control path, codes `ORCH-ROUTE-UNKNOWN` and `ORCH-INTERNAL`.
- Error codes are placeholders until P-02. The CI job for contracts (L-07) is not built; the existing `scripts` job just runs these checks.
- Story state in the tracker, the tick of L-04 in `docs/dev/dev1-tanmay.md` and the Excel "Done = Yes" wait for the developer's confirmation (CLAUDE.md close step). Nothing is committed.
