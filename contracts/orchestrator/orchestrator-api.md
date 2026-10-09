# Orchestrator API v0 (IF-5)

- **Version:** 0.1.0 (draft, 0.x until the tag `contracts-v1.0.0` in story L-09). See [../CHANGELOG.md](../CHANGELOG.md).
- **Owner:** stream L (Tanmay). Consumer: the platform workers (stream P, Akshay). Under D-37 the review by Akshay is optional during initial development; the proposals below are for him to confirm in the team chat.
- **Source:** `docs/architecture/07-repo-and-workstreams.md` sections 3.1, 3.3, 3.5 and 3.6 (the seven calls, the ports, the errors), `05-key-flows.md` (provision, reset, access, destroy, reconcile), `06-security.md` (mTLS, signed body with timestamp and nonce, template-ID-only, TB-5), `04-data-and-state.md` section 10.2 (the instance state machine).
- **Machine-checkable part:** [orchestrator.openapi.yaml](orchestrator.openapi.yaml) (OpenAPI 3.1), examples in `examples/`. Check it: `pnpm run contracts:check` (the second half of that command) or `uv run --package vulnmart-api python scripts/check_orchestrator_contract.py`.

Plain terms: the **orchestrator** is the service on the instance VM that builds and removes instances. The platform worker asks it to do things (seven calls) and the orchestrator tells the platform what happened (one signed report). The architecture fixed only the list of calls. This document and the OpenAPI file add the bodies, the signing, the state rules and the errors. Every value the architecture does not fix is a proposal, listed in the table at the end ("Open points (to confirm)").

What this contract does not cover: the browser API (IF-1, IF-2), the other internal ports (IF-9 `InstancePort` and the rest), the error registry (IF-8, story P-02: `ORCH-*` and `INST-*` names here are placeholders), key derivation (ADR 0009), the instance contract (IF-6) and the instance events (IF-4).

## 1. The calls

| Call | Direction | Answer on success | Meaning |
|---|---|---|---|
| `POST /v1/instances` | platform to orchestrator | 202 new, 200 identical repeat | Create from allow-listed template and flag material; idempotent on `(instance_id, epoch)` |
| `GET /v1/instances/{id}` | platform to orchestrator | 200 | Current state, health, error code; no secrets |
| `POST /v1/instances/{id}/reset` | platform to orchestrator | 202 new, 200 repeat | Destroy and recreate with the next epoch and new flag material |
| `POST /v1/instances/{id}/access` | platform to orchestrator | 200 | Set `open`, `frozen` or `closed` with an access epoch |
| `POST /v1/instances/{id}/destroy` | platform to orchestrator | 202 new, 200 repeat | Remove everything |
| `GET /v1/instances` | platform to orchestrator | 200 | List by label (cursor-paged) for the reconciler and the Admin view |
| `GET /v1/host` | platform to orchestrator | 200 | Capacity and health |
| `POST /internal/v1/orch/state` | orchestrator to platform API | 204 | Signed state transition report |

Python side: the `InstanceHost` protocol in `apps/api/src/vulnmart/ports/instance_host.py` has one method per call. Three things implement it: `HttpInstanceHost` (the real client), `FakeInstanceHost` (in memory) and, as a service, the fake orchestrator in `contracts/mocks/fake-orchestrator/` that `HttpInstanceHost` can talk to. One shared test suite (`apps/api/tests/test_protocol.py`) runs against `FakeInstanceHost` and against `HttpInstanceHost` talking to the fake service.

## 2. What the orchestrator accepts (NFR-SEC-04)

A create or reset body holds only: instance id, allow-listed template name, epoch, flags, decoys, flag digests, event key, seed, host name and limits. It never holds an image, a command, an entrypoint, a volume, a mount, a port, a network or an environment value. The OpenAPI schemas are closed (`additionalProperties: false`). A body that names one of those is refused with **422 `ORCH-FIELD-FORBIDDEN`** and the `field` of the error names it; any other unknown or malformed field is **422 `ORCH-VALIDATION`**. Only top-level names are matched against the forbidden list; a forbidden name nested inside an object (for example inside `limits`) is just an unknown field and is reported as `ORCH-VALIDATION` (open point 28). Nothing is created in either case. A template name that is well-formed but not on the allow-list is **422 `ORCH-TEMPLATE-UNKNOWN`**. The allow-list maps names to image digests in the signed release manifest; that map is the orchestrator's, never part of a request.

No `GET` answer contains a flag, a decoy, a digest, a seed or an event key. The `InstanceStatus` schema is closed so that none of them can appear, and the contract check walks every GET answer schema to prove it.

## 3. State machine

The states are those of architecture 04 section 10.2 (FR-INS-07): `requested`, `provisioning`, `starting`, `ready`, `active`, `idle`, `resetting`, `stopping`, `destroyed`, `failed`. **Only the orchestrator writes the state.** The platform reads it and records what the orchestrator reports. `access` (`open`, `frozen`, `closed`) is a separate field.

| From | To | Cause |
|---|---|---|
| (none) | `requested` | create accepted |
| `requested` | `provisioning` | orchestrator starts work |
| `provisioning` | `starting` | networks and containers created |
| `starting` | `ready` | health ok and flags injected |
| `ready` | `active` | first player request |
| `active` | `idle` | no request for a while |
| `idle` | `active` | a request |
| `ready`, `active`, `idle` | `resetting` | reset |
| `resetting` | `provisioning` | new epoch begins |
| `provisioning`, `starting` | `failed` | error or timeout (`error_code` set) |
| `failed` | `provisioning` | orchestrator retry (the limit is OI-24, not set here) |
| `failed` | `destroyed` | retries used up, or destroy |
| `ready`, `active`, `idle`, `provisioning`, `starting`, `requested`, `failed` | `stopping` | destroy (or expiry or inactivity, decided by the platform or the orchestrator limits) |
| `stopping` | `destroyed` | everything removed |

Rules per call:

- **create**: new `(instance_id, epoch)` is accepted if the host has capacity; state `requested`, access `closed`, access epoch 0 (proposal, see open points). It then advances on its own. An id that was used and destroyed cannot be created again (409 `ORCH-INSTANCE-EXISTS`), and a create with an epoch below the instance's current epoch is 409 `ORCH-STALE-EPOCH` (proposals 24 and 25).
- **reset**: only from `ready`, `active` or `idle`. The body carries the new epoch, which must be the current epoch plus one, and the new secrets. Any other state is **409 `ORCH-INVALID-STATE`**. A wrong epoch is **409 `ORCH-STALE-EPOCH`**. The state becomes `resetting`, then `provisioning`. The memory reserved for the instance is kept; in v0 a reset has no capacity check of its own (open point 26, for story L-13).
- **access**: any state except `destroyed` (then 409 `ORCH-INVALID-STATE`). The access epoch only grows, see section 5.
- **destroy**: from any state except `destroyed` and `stopping` it answers 202 and the state becomes `stopping`, then `destroyed`. A repeat answers 200. The memory is released when the state reaches `destroyed`. A destroyed instance stays visible (tombstone) so that a repeat and a late GET still have an answer.
- **host**: capacity is counted in memory (`limits.memory_mb`). When the sum would pass the capacity, create answers **429 `ORCH-BUSY`** and nothing is created.

Every transition is reported to the platform (section 8).

## 4. Authentication and replay protection

Transport: mutual TLS on the private link between VM-P and VM-I (TB-5). mTLS is a deployment matter and is not modelled in the OpenAPI file.

On top of mTLS **every request, also a GET, is signed**:

| Header | Value |
|---|---|
| `X-VM-Timestamp` | UTC time of signing, `YYYY-MM-DDTHH:MM:SSZ`, whole seconds |
| `X-VM-Nonce` | 128 random bits, 32 lowercase hex characters |
| `X-VM-Signature` | `v1=` plus lowercase hex of HMAC-SHA256(key, signing string) |

Signing string (UTF-8, joined by a line feed, no trailing line feed):

```
v1
<METHOD in upper case>
<request target: path plus the query string exactly as sent>
<X-VM-Timestamp>
<X-VM-Nonce>
<lowercase hex SHA-256 of the raw body bytes; of the empty string when there is no body>
```

The receiver recomputes the string from the bytes it received, compares the signature in constant time, then checks the timestamp (accepted within 60 seconds of its own clock, either way) and the nonce (refused if seen in the last 5 minutes, else remembered for 5 minutes). Any failure is **401 `ORCH-BAD-SIGNATURE`**; the body of the answer never says which of the checks failed. Nothing changes. `examples/signing-vector.json` is a fixed request with its signature for both sides to test against; the key in it is fake.

Responses are protected by mTLS and are not signed (open point 6). The nonce memory is per process: a replay across an orchestrator restart or across two instances of the service is not caught by the nonce alone, and the 60-second timestamp window is what limits it (open point 27).

Two keys, one per direction: the platform signs calls to the orchestrator with the platform key, the orchestrator signs state reports with the orchestrator key. Key distribution and rotation follow ADR 0009 and are not set here.

## 5. Idempotence

| Call | Repeat of an accepted request | A different request with the same identity |
|---|---|---|
| create | 200, current state. Identity is `(instance_id, epoch)`; "identical" means the same canonical JSON body (SHA-256 of the body with keys sorted) | same id and epoch, other body: 409 `ORCH-REQUEST-MISMATCH`. Same id, other epoch above the current one: 409 `ORCH-INSTANCE-EXISTS` (use reset); epoch below the current one: 409 `ORCH-STALE-EPOCH`; an id that was destroyed: 409 `ORCH-INSTANCE-EXISTS`, even with an identical body |
| reset | 200, current state (identity is the new epoch plus the same body) | same new epoch, other body: 409 `ORCH-REQUEST-MISMATCH`; epoch not current plus one: 409 `ORCH-STALE-EPOCH` |
| access | 200 when the access epoch equals the stored one and the value is the same | older access epoch, or the same epoch with another value: 409 `ORCH-STALE-ACCESS-EPOCH` |
| destroy | 200 | none |

A retry after a network error should send the same body with a **new nonce and timestamp**; a replayed nonce is refused (section 4), which is not a conflict with idempotence.

## 6. Errors

Body: `application/problem+json` with `code`, `message`, `request_id` and an optional `field` (never a stack trace, NFR-SEC-03). Codes are placeholders until IF-8 is merged.

| HTTP | Code | When |
|---|---|---|
| 401 | `ORCH-BAD-SIGNATURE` | wrong or malformed signature, stale timestamp, replayed nonce |
| 404 | `ORCH-INSTANCE-NOT-FOUND` | unknown instance id (get, reset, access, destroy) |
| 405 | `ORCH-METHOD-NOT-ALLOWED` | a known path with a method that path does not have; the `Allow` header lists the right ones |
| 409 | `ORCH-REQUEST-MISMATCH` | same identity, different body |
| 409 | `ORCH-INSTANCE-EXISTS` | create for an existing instance with another epoch |
| 409 | `ORCH-INVALID-STATE` | reset outside ready, active or idle; access on a destroyed instance |
| 409 | `ORCH-STALE-EPOCH` | reset epoch is not current plus one |
| 409 | `ORCH-STALE-ACCESS-EPOCH` | access epoch older, or equal with another value |
| 413 | `ORCH-BODY-TOO-LARGE` | body over 64 KiB |
| 422 | `ORCH-FIELD-FORBIDDEN` | body names an image, command, volume, port, network or environment value; `field` names it |
| 422 | `ORCH-TEMPLATE-UNKNOWN` | template not on the allow-list |
| 422 | `ORCH-LABEL-UNKNOWN` | list with a query parameter that is not a label filter |
| 422 | `ORCH-VALIDATION` | any other malformed value; `field` is a JSON Pointer |
| 429 | `ORCH-BUSY` | no capacity; nothing created |
| 429 | `ORCH-RATE-LIMITED` | request rate over the limit (section 7) |
| any | `INST-*` | an instance failure appears in `error_code` of a `failed` instance, for example `INST-HEALTH-TIMEOUT` (placeholder) |

Order of checks: body size (a body over the limit is not read further or hashed, the answer is 413 and the connection is dropped), signature, body shape, template allow-list, existence and state, capacity. So apart from an oversize body, a bad signature is always 401, whatever else is wrong. A query parameter given twice, or a `limit` that is not a plain whole number from 1 to 500, is 422 `ORCH-VALIDATION`.

## 7. Limits (proposals)

- Body size: 64 KiB. Larger: 413.
- Rate: 20 requests per second per platform client, burst 40; over the limit: 429 `ORCH-RATE-LIMITED`. The fake orchestrator does not enforce the rate.
- List: default page 100, maximum 500, ordered by instance id, opaque cursor. Filters are the instance-contract labels: `instance`, `epoch`, `component`, `template`, `kind` (`inst` or `front`).
- `limits` object of create: `memory_mb` 64 to 8192, `cpu_limit` over 0 up to 8, `pids_limit` 16 to 4096, `idle_minutes` 1 to 1440, `max_minutes` 1 to 1440.
- Audit: every call is written to the audit log with a system actor (architecture 06). That is the orchestrator's job and is not visible in this API.

## 8. State reports

`POST /internal/v1/orch/state`, orchestrator to platform API, signed with the same scheme and the orchestrator key. Body: `{instance_id, epoch, from_state, to_state, at, reason, error_code, health}`. `from_state` is null only for the first report of an instance. The platform answers 204. It treats the report as a claim and checks it against the state machine; what it does with an impossible transition (log, alert, ignore) is the platform's choice. The same report may arrive twice (at-least-once); applying it again changes nothing. If the platform is unreachable the orchestrator keeps the reports and retries in order (proposal; the fake orchestrator does not retry).

## 9. Fake orchestrator and fake host

- **Fake service** (`contracts/mocks/fake-orchestrator/server.mjs`, Node, no dependencies): all eight calls, the state machine, the signature, nonce and timestamp checks, a capacity limit, a step delay (`--step-delay-ms`, default 0), optional state reports (`--report-url`, `--report-key`). It stores no secret: the create body is checked and then reduced to a SHA-256 fingerprint. Extras that are **not part of the contract**: a second template name `shop-fail-v0` that ends in `failed` with `INST-HEALTH-TIMEOUT`, and a test-control path `POST /_fake/v1/instances/{id}/activity` (unsigned, localhost only) that moves an instance between `ready`, `active` and `idle`. Unknown routes answer 404 `ORCH-ROUTE-UNKNOWN` and a crash of the fake answers 500 `ORCH-INTERNAL`; both are fake-only codes.
- **FakeInstanceHost** (`apps/api/src/vulnmart/ports/fake_instance_host.py`): the same rules in memory, for platform tests that need no process.
- A protocol suite (`apps/api/tests/test_protocol.py`) runs every matrix row against both.

## Open points (to confirm)

Each row is a proposal made while writing the contract. None is decided; Akshay confirms in the team chat (D-37: optional during initial development).

| # | Proposal | Why it is open |
|---|---|---|
| 1 | Create answers 202 (asynchronous); an identical repeat answers 200; same identity with another body 409 `ORCH-REQUEST-MISMATCH`; unknown template 422 | Architecture says only "idempotent on (instance_id, epoch)" |
| 2 | Request signing: HMAC-SHA256, headers `X-VM-Timestamp`, `X-VM-Nonce`, `X-VM-Signature: v1=<hex>`, signing string over method, request target, timestamp, nonce and body SHA-256 | Architecture says "signed body with timestamp and nonce" only |
| 3 | Timestamp skew 60 seconds; nonce remembered 5 minutes; nonce is 128 bits as 32 hex characters | Numbers not fixed |
| 4 | The signing string includes the query string (the request target) | So list filters cannot be changed in transit |
| 5 | GET requests are signed too | Architecture lists "signed bodies" only; a GET has no body |
| 6 | Responses are protected by mTLS and are not signed | Not fixed; a signed response would also protect against a man in the middle if mTLS is ever off |
| 7 | Two signing keys, one per direction | Not fixed; depends on ADR 0009 |
| 8 | `limits` is `{memory_mb, cpu_limit, pids_limit, idle_minutes, max_minutes}` with the ranges in section 7 | Architecture names `limits` without fields |
| 9 | Create also carries `seed` | The injection document of IF-6 needs a seed; the architecture list of create fields omits it |
| 10 | `event_key` is 32 to 128 URL-safe characters; a flag digest is 64 lowercase hex characters | Shapes not fixed (ADR 0009) |
| 11 | Reset body carries the new epoch (current plus one) and the new secrets; template and limits stay | Architecture says "destroy and recreate with a new epoch" only |
| 12 | A new instance starts with access `closed` and access epoch 0; the platform opens it | ADR 0004 gate; start value not fixed |
| 13 | An access request with the same epoch and another value is refused as stale | Equal-epoch rule not fixed |
| 14 | Destroy of an unknown id answers 404; destroyed instances stay visible as tombstones (retention not set) | Matrix says "known or already destroyed" |
| 15 | List is cursor-paged (default 100, maximum 500, ordered by id); filters instance, epoch, component, template, kind | Architecture says "list by label" |
| 16 | Host answer is `{host_id, kind (vm, laptop, fake), capacity_memory_mb, used_memory_mb, instances, health (ok, degraded, down)}`; capacity is counted in memory only | Not fixed (ADR 0015 for the laptop engine) |
| 17 | State report body `{instance_id, epoch, from_state, to_state, at, reason, error_code, health}`; the platform answers 204; at-least-once delivery | Not fixed |
| 18 | Instance health is `unknown`, `healthy` or `unhealthy` | Not fixed |
| 19 | Body limit 64 KiB; rate 20 per second per client, burst 40 | Architecture says "oversize bodies" and "rate-limited" without numbers |
| 20 | Error code names `ORCH-FIELD-FORBIDDEN`, `ORCH-VALIDATION`, `ORCH-INSTANCE-EXISTS`, `ORCH-INVALID-STATE`, `ORCH-STALE-EPOCH`, `ORCH-LABEL-UNKNOWN`, `ORCH-BODY-TOO-LARGE`, `ORCH-RATE-LIMITED` (added to the names in the matrix) | Registry is P-02 |
| 21 | Template allow-list starts with `shop-v0`; the fake adds `shop-fail-v0` for failure tests only | Names set with stream T |
| 22 | A timed-out or retried reset: the orchestrator retries `failed` instances itself; the retry limit is left to OI-24 | OI-24 is open |
| 23 | Instance id pattern `i-` plus 16 Base32 characters, host name as a DNS name | Taken from the instance contract, itself a proposal |
| 24 | An id that was used and destroyed cannot be created again: 409 `ORCH-INSTANCE-EXISTS`, also for an identical body | Tombstones keep the answer simple; whether an id may be reused is not fixed |
| 25 | A create whose epoch is below the instance's current epoch answers 409 `ORCH-STALE-EPOCH` | Not fixed |
| 26 | A reset has no capacity check in v0 (it keeps the memory the instance already holds) | Open for story L-13 (capacity) |
| 27 | The nonce memory is per process and is lost on restart | A shared store is not set; the 60-second timestamp window is the limit |
| 28 | A forbidden name nested inside an object (for example `limits.env`) is reported as 422 `ORCH-VALIDATION`; only top-level names get `ORCH-FIELD-FORBIDDEN` | Depth of the forbidden-name check is not fixed |
| 29 | A known path with a wrong method answers 405 `ORCH-METHOD-NOT-ALLOWED` with an `Allow` header | Not fixed |
| 30 | `Retry-After` (seconds) accompanies 429 `ORCH-BUSY` and `ORCH-RATE-LIMITED`; the client exposes it as `retry_after` | Not fixed |
