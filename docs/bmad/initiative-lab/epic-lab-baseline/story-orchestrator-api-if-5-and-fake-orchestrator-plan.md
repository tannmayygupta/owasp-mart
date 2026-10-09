---
title: 'Orchestrator API (IF-5) and fake orchestrator'
type: 'feature'
ticket: '4'
created: '2026-10-09'
status: 'built'
baseline_revision: '38a980fd315371cd0599b899b1fe0b07f2f28281'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
  - '{project-root}/docs/architecture/05-key-flows.md'
  - '{project-root}/docs/architecture/06-security.md'
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/contracts/instance/instance-contract.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The platform worker (stream P) and the lab orchestrator (stream L) must call each other, but the architecture fixes only a list of seven calls: no request or response bodies, no authentication form, no state-report body, no error codes. Without one written contract each side invents its own, and the lab harness has no orchestrator to talk to.

**Approach:** Write the IF-5 contract in `contracts/orchestrator/`: an OpenAPI 3.1 file for the seven calls and the signed state report, a text with the state machine, authentication, idempotence and errors, and examples. Add the Python `InstanceHost` protocol (the platform-side port), an in-memory `FakeInstanceHost`, a real HTTP client that implements the protocol, and a stateful fake orchestrator service. A shared protocol test suite runs against the fake host and against the HTTP client talking to the fake service, so "the contract works" is a command.

## Boundaries & Constraints

**Always:** Version the contract 0.x with an entry in `contracts/CHANGELOG.md`. The orchestrator accepts instance ids, allow-listed template names, flags and digests, and never an image, command, volume, port, network or environment value (NFR-SEC-04). `GET` answers never contain a flag, decoy, digest, seed or event key. State follows the PRD state machine (FR-INS-07) and only the orchestrator writes it. Every value the architecture does not fix is a proposal in an "Open points (to confirm)" table. Use obviously fake keys, flags and ids in examples. Python 3.14 with versions from the registries pinned exactly.

**Never:** Docker or real container code; the real FastAPI orchestrator; the OpenAPI bundle, mock and generated clients of the browser API (P-04); the other IF-9 ports and the `apps/api` kernel (P-05, P-06); the error registry (P-02: use `ORCH-*` and `INST-*` names as placeholders); the CI contract job (L-07); key derivation (ADR 0009); changes to the IF-6 or IF-4 contract text.

**Decisions (Tanmay, 2026-10-09):** the contract files are authored as proposals for Akshay to confirm in the team chat (D-37). (1) The OpenAPI file is checked with `openapi-spec-validator` 0.9.0 from the Python tests. (2) The fake orchestrator service is Node and dependency-free, a separate process that the Python client tests call. (3) The `InstanceHost` protocol, the fake host and the HTTP client live in `apps/api/src/vulnmart/ports/`; only the package skeleton and those three modules are created, and Akshay is told in the team chat.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create | Valid body, new `(instance_id, epoch)` | 202, state `requested` then advancing | No error expected |
| Create again | Identical body | 200, current state | No error expected |
| Create conflict | Same id and epoch, different body | 409 `ORCH-REQUEST-MISMATCH` | Nothing changed |
| Unknown template | `template_id` not on the allow-list | 422 `ORCH-TEMPLATE-UNKNOWN` | Nothing created |
| Forbidden field | Body names an image, command, volume, port or env | 422 naming the field | Nothing created |
| Bad auth | Wrong signature, stale timestamp or replayed nonce | 401 `ORCH-BAD-SIGNATURE` | Nothing changed |
| Get | Known id | Current state, health, error code; no secrets | 404 `ORCH-INSTANCE-NOT-FOUND` if unknown |
| Reset | Instance in ready, active or idle | New epoch, state `resetting` then `provisioning` | 409 in other states |
| Access | `open`, `frozen` or `closed` with an access epoch | Applied; an older access epoch is refused | 409 `ORCH-STALE-ACCESS-EPOCH` |
| Destroy | Known or already destroyed | State `destroyed`; a repeat is 200 | No error expected |
| List and host | Label filter; host query | Matching instances (paged); capacity and health | 422 on an unknown label |
| Busy | Host has no capacity | 429 `ORCH-BUSY` | Nothing created |

</frozen-after-approval>

## Code Map

- `contracts/orchestrator/`, `contracts/mocks/`, `apps/api/` -- empty (`.gitkeep`); new files go here. `pyproject.toml` (uv workspace root, Python 3.14, no members), `uv.lock`, `package.json`, `.github/workflows/ci.yml` (no Python job) -- tooling to extend.
- `docs/architecture/07` sections 3.1 (IF-5, IF-9), 3.3 (the seven calls), 3.5 (ports), 3.6 (errors); `05` flows for provision, reset, access, destroy, reconcile; `06` lines 13, 27, 64, 84 (mTLS, signed body with timestamp and nonce, template-ID-only); `04` section 10.2 (state machine: requested, provisioning, starting, ready, active, idle, resetting, stopping, destroyed, failed; `access` is separate).
- `contracts/instance/instance-contract.md` and its schemas -- instance id `i-` plus 16 Base32, template names, flag and decoy formats, injection document; reuse the patterns.
- `scripts/validate-contracts.mjs`, `contracts/instance/examples/` -- the example and manifest style to follow; `scripts/e2e/contracts.e2e.test.mjs` -- fresh-checkout test to extend.
- `InstanceHost` is the platform-side port of 07 section 3.3 (implemented by the HTTP client, `FakeInstanceHost` and, as a service, the fake orchestrator); it is not a Docker driver.

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/orchestrator/orchestrator.openapi.yaml` -- OpenAPI 3.1: the seven calls and `POST /internal/v1/orch/state`; request and response schemas; problem-details errors with placeholder codes; the signing headers
- [ ] `contracts/orchestrator/orchestrator-api.md` -- state machine and transitions per call, authentication and replay rules, idempotence, errors, size and rate proposals, open-points table
- [ ] `contracts/orchestrator/examples/` -- one request and response example per call, invalid examples with expected error paths in a manifest
- [ ] `apps/api/pyproject.toml`, `src/vulnmart/__init__.py`, `src/vulnmart/ports/__init__.py`, `instance_host.py` (protocol, data types, error types), `fake_instance_host.py`, `http_instance_host.py` -- Python package `vulnmart-api` and its three modules; add it to the root workspace; only these files, nothing of the kernel
- [ ] `contracts/mocks/fake-orchestrator/` -- stateful fake service for all calls with the state machine, signature, nonce and timestamp checks, a capacity limit and step delay options; never returns secrets
- [ ] `apps/api/tests/` -- the shared protocol suite run against `FakeInstanceHost` and against `HttpInstanceHost` plus the fake service; tests for every matrix row; OpenAPI validity and example checks
- [ ] `package.json`, `pyproject.toml`, `uv.lock` -- exact pins; `contracts:check` runs the new check; `.github/workflows/ci.yml` -- `scripts` job also runs the Python tests
- [ ] `contracts/CHANGELOG.md`, `README.md`, dev-log, changelog, traceability row LB-5, evidence in `docs/assets/l-04-orchestrator-api/`

**Acceptance Criteria:**
- Given the repository, when the contract check runs, then the OpenAPI file is valid, every example matches its schema, every invalid example fails at its manifest path, and the exit code is 0.
- Given the fake orchestrator service, when the HTTP client creates, gets, resets, sets access on and destroys an instance, then the states follow the state machine and every matrix row answers as written.
- Given the same protocol test suite, when it runs against `FakeInstanceHost` and against the client plus fake service, then both pass.
- Given any `GET` answer, when searched, then it holds no flag, decoy, digest, seed or event key.
- Given a body naming an image, command, volume, port or environment value, when sent to create, then it is refused and nothing is created.
- Given a fresh checkout, when CI's `scripts` job runs, then the Python tests run too.

## Implementation Notes

## Plan Change Log

- Follow-up (2026-10-09, after the review fixes; requested by Tanmay): three gaps found while writing the handoff register (H-20, H-59, H-50). Amended: IF-5 create body gets a required `owner_hash` (64 lowercase hex, the opaque `vm.owner` label value, computed by the platform) and create and reset bodies get a required `first_seq` (the number the new sidecar starts counting from, so a reset never repeats a `seq` of an earlier epoch); IF-4 and IF-6 text state who uses them and that the import service never posts (the shop posts `import` events for it). KEEP everything else as built.

## Review Triage Log

Pass 1 (thorough: blind-hunter BH, edge-case-hunter EH, verification-gap VG, intent-alignment IA). The BH and VG lenses read only part of the diff. No bad_plan or intent_gap.

| Finding | Verdict | Route | Evidence / action |
|---|---|---|---|
| BH, VG, EH: `FakeInstanceHost` accepts bodies the service refuses (limits ranges, hostname, flag shapes, reset epoch below 2, malformed ids, cursor, epoch label); the shared suite does not pin this | medium | patch | Real: the "same suite on both" claim is weaker than written. Mirror the service validation in the fake and add shared-suite cases. |
| BH, EH: fake `set_access` compares with `is not` (a plain string looks different from the enum) | medium | patch | Coerce with `Access(...)`, compare with `!=`; also raise `ValidationFailed` for a bad value in the client. |
| BH: fake list ignores the `component` and `kind` filters | low | patch | Filter. |
| BH, EH: create repeated with an old epoch after a reset, or after destroy, answers 200 | medium | patch | Old epoch gives `ORCH-STALE-EPOCH`; an id that was destroyed gives 409 `ORCH-INSTANCE-EXISTS`; same in fake host and service; documented as a proposal. |
| VG: client fallbacks (non-JSON body, unknown code, 3xx, wrong status) untested | medium | patch | Stub-server tests. |
| EH: `IncompleteRead`, a read timeout inside the error handler, a bad instance id in the path, a naive datetime in `verify_request`, a bad `Access` value escape the client as raw exceptions | medium | patch | Map to `OrchestratorUnavailable` or `ValidationFailed`; quote the path. |
| BH: client accepts `https` without a client certificate and plain `http` for any host; no minimum key length; no response size cap; no 429 `Retry-After`; `ORCH-UNAVAILABLE` missing from the code map | medium | patch | Refuse `https` without a context and `http` to non-loopback hosts; minimum key length 32; cap responses at 1 MiB; carry `retry_after`; add the code. |
| BH, EH: `NonceCache` not thread-safe, rebuilds on every check | low | patch | Lock and incremental expiry; document the per-process limit. |
| BH: responses are not signed | low | patch | State in the contract that responses rely on mTLS; open point. |
| BH: signing scheme chosen without research or ADR | medium | patch | ADR 0018 (Proposed) with alternatives (RFC 9421, AWS SigV4) and sources. |
| VG, EH: the "no secret in GET answers" check skips `$ref` responses and non-JSON media types | medium | patch | Resolve references and walk every media type; extend the test. |
| EH, BH, VG: fake Node service: unbounded body read, an invalid timestamp passes the skew check (NaN), a long unknown key is echoed past the schema limit, state-report fetch has no timeout and non-2xx is dropped, strict `limit` and repeated query parameters, 405 for a wrong method, numeric CLI options, a same-state activity call emits a report | medium | patch | Fix each; add tests. |
| VG, EH: test helper never drains `stderr` and can hang on startup | medium | patch | Send stderr to a file, timeout on the first line. |
| EH: check script crashes on malformed YAML, manifest or vector | low | patch | Report a FAIL line naming the file. |
| IA, BH: text typo `pps/api/tests/test_protocol.py`; `runtime_checkable` docstring; `field` shadows the dataclass import; duplicate pytest settings; blank lines; no `py.typed`; traceability says Done while the changelog says awaiting | low | patch | Fix. Also scan the new files for other garbled letters. |
| BH: `contracts:check` needs `uv` with no friendly message | low | patch | README note. |
| EH(claim): nested forbidden names get `ORCH-VALIDATION`, not `ORCH-FIELD-FORBIDDEN` | low | rejected | The contract text says top level only; state it. |
| BH: `reset` skips the capacity check | low | defer | An open point for the real orchestrator (L-13). |
| BH: uv version pinned in three places; CI runs `contracts:check` right after pytest | low | defer | Revisit with L-07. |
| IA: no real orchestrator, worker, harness or mTLS exercised | info | defer | L-06, L-13 and the deployment epic. |

## Design Notes

Proposals to put in the open-points table: create answers 202 (asynchronous), repeat 200, conflict 409, unknown template 422; `Authorization` is mTLS in production and not modelled in the OpenAPI file; request signing by HMAC-SHA256 with headers `X-VM-Timestamp` (UTC, skew 60 seconds), `X-VM-Nonce` (128-bit random, remembered for 5 minutes) and `X-VM-Signature` `v1=<hex>` over method, path, timestamp, nonce and the SHA-256 of the body; limits object `{memory_mb, cpu_limit, pids_limit, idle_minutes, max_minutes}`; list is cursor-paged (default 100, label filters instance, epoch, component, template, kind); host answer `{host_id, kind, capacity_memory_mb, used_memory_mb, instances, health}`; the state report body `{instance_id, epoch, from_state, to_state, at, reason, error_code, health}` signed the same way; per-instance `access_epoch` integer that only grows; template allow-list names `shop-v0` first; step delay default 0 for tests.

## Verification

**Commands:**
- the contract check (name set by the implementer, wired into `pnpm run contracts:check`) -- expected: exit 0
- `uv run --package vulnmart-api pytest` -- expected: all pass
- `node --test "scripts/*.test.mjs"` and `pnpm install --frozen-lockfile`, `uv lock --check` -- expected: pass
- `pnpm audit` and an audit of the Python pins -- expected: no known vulnerabilities

**Manual checks (if no CLI):**
- Akshay reads the open-points table; under D-37 his approval is optional.
