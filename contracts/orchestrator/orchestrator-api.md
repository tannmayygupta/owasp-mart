# Orchestrator API v0 (IF-5)

- **Version:** 0.4.0 (draft, 0.x until the tag `contracts-v1.0.0` in story L-09). See [../CHANGELOG.md](../CHANGELOG.md).
- **Owner:** stream L (Tanmay). Consumer: the platform workers (stream P, Akshay). Under D-37 the review by Akshay is optional during initial development; the proposals below are for him to confirm in the team chat.
- **Source:** `docs/architecture/07-repo-and-workstreams.md` sections 3.1, 3.3, 3.5 and 3.6 (the seven calls, the ports, the errors), `05-key-flows.md` (provision, reset, access, destroy, reconcile), `06-security.md` (mTLS, signed body with timestamp and nonce, template-ID-only, TB-5), `04-data-and-state.md` section 10.2 (the instance state machine).
- **Machine-checkable part:** [orchestrator.openapi.yaml](orchestrator.openapi.yaml) (OpenAPI 3.1), examples in `examples/`. Check it: `pnpm run contracts:check` (the second half of that command) or `uv run --package vulnmart-api python scripts/check_orchestrator_contract.py`.

Plain terms: the **orchestrator** is the service on the instance VM that builds and removes instances. The platform worker asks it to do things (seven calls) and the orchestrator tells the platform what happened (one signed report). The architecture fixed only the list of calls. This document and the OpenAPI file add the bodies, the signing, the state rules and the errors. Every value the architecture does not fix is a proposal, listed in the table at the end ("Open points (to confirm)").

What this contract does not cover: the browser API (IF-1, IF-2), the other internal ports (IF-9 `InstancePort` and the rest), the error registry (IF-8, `contracts/errors/error-codes.yaml`: the `ORCH-*` and `INST-*` names here are the registry's), key derivation (ADR 0009), the instance contract (IF-6) and the instance events (IF-4).

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
| `POST /internal/v1/orch/state` | orchestrator to platform API | 204 new, 200 identical repeat | Signed state transition report with a `transition` number |

Python side: the `InstanceHost` protocol in `apps/api/src/vulnmart/ports/instance_host.py` has one method per call. Three things implement it: `HttpInstanceHost` (the real client), `FakeInstanceHost` (in memory) and, as a service, the fake orchestrator in `contracts/mocks/fake-orchestrator/` that `HttpInstanceHost` can talk to. One shared test suite (`apps/api/tests/test_protocol.py`) runs against `FakeInstanceHost` and against `HttpInstanceHost` talking to the fake service.

## 2. What the orchestrator accepts (NFR-SEC-04)

A create or reset body holds only: instance id, allow-listed template name, epoch, flags, decoys, flag digests, event key, seed, owner hash (create only), host name (create only) and limits (create only). It never holds an image, a command, an entrypoint, a volume, a mount, a port, a network or an environment value. The request and answer schemas are closed (`additionalProperties: false`); only the error body `Problem` is open (section 6). A body that names one of those is refused with **422 `ORCH-FIELD-FORBIDDEN`** and the `field` of the error names it; any other unknown or malformed field is **422 `ORCH-VALIDATION`**. Only top-level names are matched against the forbidden list; a forbidden name nested inside an object (for example inside `limits`) is just an unknown field and is reported as `ORCH-VALIDATION` (open point 28). Nothing is created in either case. A template name that is well-formed but not on the allow-list is **422 `ORCH-TEMPLATE-UNKNOWN`**. The allow-list maps names to image digests in the signed release manifest; that map is the orchestrator's, never part of a request.

**`owner_hash` (create, required).** The opaque value of the `vm.owner` label of the instance contract (section 4): 64 lowercase hex characters, never an email or a user id (FR-INS-05). The platform computes it, so the orchestrator never sees a user id; the proposal is HMAC-SHA256 of the user id with a platform label key, written as hex (key handling per ADR 0009, open point 32). The orchestrator stores it and applies it as the `vm.owner` label of every container and network of the instance. A reset keeps the owner of the instance: the reset body has no `owner_hash`, and one that names it is 422 `ORCH-VALIDATION`. No GET answer returns it.

**No `first_seq` (decision D-42, removed in 0.2.0).** The sequence number is not given by the platform any more. Event identity is `(instance_id, epoch, seq)` and the sidecar restarts its counter at 1 in every epoch (event contract IF-4 section 6); the `epoch` of this body is the one the sidecar stamps on its events. Nothing in a create or reset body is about sequence numbers.

**Event key across a reset (decision D-42, open point 33 closed).** The platform derives the `event_key` per `(instance_id, epoch)`: HKDF-SHA256 (RFC 5869) from its master `K_evt`, salt `vm-evt-salt-v1`, info `vm-event-key-v1` 0x00 `instance_id` 0x00 decimal `epoch`, 32 bytes, base64url (43 characters); the exact rule, a test vector and the fake ingest are in IF-4 (`contracts/events/app-events.md` section 4). The epoch is in the info, so a reset always sends a new key and the key of an old epoch cannot sign events of a new one. The orchestrator does not derive or choose it, it passes it on standard input to the sidecar.

## 2a. Numbers on the wire (decision of 2026-10-11, story 1.15, ADR 0028)

Every integer of this contract (`epoch`, `access_epoch`, `transition`, `index`, `limits.memory_mb`, `pids_limit`, `idle_minutes`, `max_minutes`, every number of the host answer, the integer query parameters, `status` of an error body) is written as a JSON **integer token**: digits with an optional leading minus, no fraction, no exponent, no `+`, no leading zero, inside the range the schema gives and never above **2^53 - 1** (9007199254740991; I-JSON, RFC 7493 section 2.2, so every language reads it back exactly). `1.0`, `1e0`, `1E0`, `true`, `"1"`, `NaN` and `9007199254740993` are all refused, by the orchestrator and by the platform, with **422 `ORCH-VALIDATION`** and the JSON Pointer of the field. A client that reads an answer with such a token treats the answer as unusable (the Python client raises `OrchestratorUnavailable`).

Why this needs saying: a JSON Schema validator calls `1.0` an integer, and Node reads `1.0` and `1` as the same number while Python keeps them apart, so the same body could mean one thing to one side and another to the other (and a signing string built from the number would differ between languages). So the schema says `type: integer`, `format: int64`, a `minimum` and a `maximum`, and the receiver must check the token itself (the fake orchestrator has a small JSON reader for this; the Python side tells a real `int` from a `float` and from a `bool`). `scripts/check_orchestrator_contract.py` reads the examples with the same rule.

The one number that is not an integer is `limits.cpu_limit` (over 0 up to 8). Any JSON number is accepted there, it is compared **by value** (`2`, `2.0` and `2e0` are the same request, section 5), and it is not part of the integer rule.

The `owner_hash` is part of the request fingerprint (section 5): a repeat with another `owner_hash` is a different request.

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
| create | 200, current state. Identity is `(instance_id, epoch)`; "identical" means the same canonical JSON body (SHA-256 of the body with keys sorted and numbers by value, so `cpu_limit` 2 and 2.0 are one request; every other number is an integer token, section 2a; `owner_hash` is part of it, so a repeat with another value is a different request) | same id and epoch, other body: 409 `ORCH-REQUEST-MISMATCH`. Same id, other epoch above the current one: 409 `ORCH-INSTANCE-EXISTS` (use reset); epoch below the current one: 409 `ORCH-STALE-EPOCH`; an id that was destroyed: 409 `ORCH-INSTANCE-EXISTS`, even with an identical body |
| reset | 200, current state (identity is the new epoch plus the same body) | same new epoch, other body: 409 `ORCH-REQUEST-MISMATCH`; epoch not current plus one: 409 `ORCH-STALE-EPOCH` |
| access | 200 when the access epoch equals the stored one and the value is the same | older access epoch, or the same epoch with another value: 409 `ORCH-STALE-ACCESS-EPOCH` |
| destroy | 200 | none |

A retry after a network error should send the same body with a **new nonce and timestamp**; a replayed nonce is refused (section 4), which is not a conflict with idempotence.

## 6. Errors

Every error answer is the **closed IF-8 body** (schema `contracts/errors/problem.schema.json`, RFC 9457 style; decision M1 of ADR 0019; moved to IF-8 in version 0.4.0, story "IF-8 error bodies"), media type `application/problem+json`:

| Member | Kind | Meaning |
|---|---|---|
| `type` | standard | `urn:vulnmart:error:` plus the code (for example `urn:vulnmart:error:ORCH-STALE-EPOCH`) |
| `title` | standard | The registry's fixed text for the code, the same for every answer with this code |
| `status` | standard | The HTTP status, as an integer token (400 to 599); the registry fixes it per code |
| `code` | extension | A code of the registry (upper-case words joined by hyphens); the Python client picks its exception from it |
| `request_id` | extension | Opaque id for the log; what happened this time is written to the log under this id, never into the answer |
| `field` | extension, optional, 422 only | One JSON Pointer built from names of the request, never from a value: `/image` for `ORCH-FIELD-FORBIDDEN`, `/limits/memory_mb` for `ORCH-VALIDATION`, `/query/cursor` for a bad cursor, `/path/instance_id` for a bad id in the path |
| `errors` | extension, optional, 422 only | Several problems: up to 50 entries `{ "pointer", "detail" }`, never together with `field` |

There is **no `detail`, no `instance` and no `message`**: no free text, path or submitted value reaches a client. The `Problem` schema is **closed** (version 0.3.0 had it open); `detail` and `instance` are removed (breaking, before the tag). The check script requires every error response of the OpenAPI file to be `application/problem+json` with this schema, and the schema to equal the IF-8 one. The codes are final: they are in the IF-8 registry (IF-8 0.4.0 added ORCH-CURSOR-INVALID, ORCH-UNSUPPORTED-MEDIA-TYPE and ORCH-NOT-IMPLEMENTED, the last one for the reset placeholder of the Python service only). The title and the status of a code come from the registry.

| HTTP | Code | When |
|---|---|---|
| 401 | `ORCH-BAD-SIGNATURE` | wrong or malformed signature, stale timestamp, replayed nonce |
| 404 | `ORCH-INSTANCE-NOT-FOUND` | unknown instance id (get, reset, access, destroy) |
| 405 | `ORCH-METHOD-NOT-ALLOWED` | a known path with a method that path does not have; the `Allow` header lists the right ones |
| 409 | `ORCH-REQUEST-MISMATCH` | same identity, different body (for a state report: the same `(instance_id, epoch, transition)` with another body) |
| 409 | `ORCH-INSTANCE-EXISTS` | create for an existing instance with another epoch |
| 409 | `ORCH-INVALID-STATE` | reset outside ready, active or idle; access on a destroyed instance |
| 409 | `ORCH-STALE-EPOCH` | reset epoch is not current plus one |
| 409 | `ORCH-STALE-ACCESS-EPOCH` | access epoch older, or equal with another value |
| 413 | `ORCH-BODY-TOO-LARGE` | body over 64 KiB |
| 415 | `ORCH-UNSUPPORTED-MEDIA-TYPE` | a body that is not sent as `application/json` (parameters such as `charset` are allowed; a request without a body needs no media type) |
| 422 | `ORCH-FIELD-FORBIDDEN` | body names an image, command, volume, port, network or environment value; `field` is its pointer |
| 422 | `ORCH-TEMPLATE-UNKNOWN` | template not on the allow-list |
| 422 | `ORCH-LABEL-UNKNOWN` | list with a query parameter that is not a label filter |
| 422 | `ORCH-VALIDATION` | any other malformed value, a number that is not an integer token included (section 2a); `field` is a JSON Pointer |
| 422 | `ORCH-CURSOR-INVALID` | a list `cursor` that this orchestrator did not hand out: wrong length or characters, not the base64url of an instance id, or not spelled the canonical way; `field` is `/query/cursor` |
| 429 | `ORCH-BUSY` | no capacity; nothing created |
| 429 | `ORCH-RATE-LIMITED` | request rate over the limit (section 7) |
| any | `INST-*` | an instance failure appears in `error_code` of a `failed` instance, for example `INST-HEALTH-TIMEOUT` |

Order of checks: body size (a body over the limit is not read further or hashed, the answer is 413 and the connection is dropped; a client that sends a body over 64 KiB may see the connection reset before it reads the 413, and must treat that as a refusal or as unavailable, not as success), signature, **the call exists** (unknown path 404, wrong method 405), **media type (415)**, path id and body shape (422), template allow-list (422), **existence (404)**, state and epoch (409), capacity (429). So apart from an oversize body, a bad signature is always 401, whatever else is wrong; an unsupported media type is 415 even when the instance does not exist (415 before 404); and a malformed body is 422 even when the instance does not exist (shape before existence; decided 2026-10-11, the fake orchestrator used to look the instance up first and no longer does). A query parameter given twice, or a `limit` that is not a plain whole number from 1 to 500, is 422 `ORCH-VALIDATION`.

## 7. Limits (proposals)

- Body size: 64 KiB. Larger: 413.
- Rate: 20 requests per second per platform client, burst 40; over the limit: 429 `ORCH-RATE-LIMITED`. The fake orchestrator does not enforce the rate.
- List: default page 100, maximum 500, ordered by instance id, opaque cursor. Filters are the instance-contract labels: `instance`, `epoch`, `component`, `template`, `kind` (`inst` or `front`).
- `limits` object of create: `memory_mb` 64 to 8192, `cpu_limit` over 0 up to 8, `pids_limit` 16 to 4096, `idle_minutes` 1 to 1440, `max_minutes` 1 to 1440.
- Audit: every call is written to the audit log with a system actor (architecture 06). That is the orchestrator's job and is not visible in this API.

## 8. State reports

`POST /internal/v1/orch/state`, orchestrator to platform API, signed with the same scheme and the orchestrator key (the signature covers the whole raw body, `transition` included). Body: `{instance_id, epoch, transition, from_state, to_state, at, reason, error_code, health}`. `from_state` is null only for the first report of an instance.

**`transition` (required, decision of 2026-10-11, story 1.15, ADR 0028).** An integer token of at least 1, **assigned by the orchestrator**, counted per `(instance_id, epoch)`: the first state change of an epoch is 1, then 2, 3 ... without gaps, and a reset (new epoch) starts at 1 again. The identity of a report is `(instance_id, epoch, transition)`. `at` has whole-second resolution, two changes can carry the same `at`, and it orders nothing: `transition` does. A real re-entrant change (for example `active` to `idle` twice) is a new report with a new number, so it is not a duplicate of the first one.

What the platform does with a report:

| Case | Answer | Effect |
|---|---|---|
| new `(instance_id, epoch, transition)` | 204 | stored; becomes the current state when its `(epoch, transition)` is the highest seen for the instance |
| the same identity, an identical body | 200 | nothing changes (at-least-once delivery) |
| the same identity, another body | 409 `ORCH-REQUEST-MISMATCH` | nothing changes |
| a lower `(epoch, transition)` than the highest seen (late, out of order) | 204 | stored as history; the current state does not move backwards |
| malformed (missing or non-integer `transition`, `0`, a float token, a string, above 2^53 - 1) | 422 `ORCH-VALIDATION` | nothing stored |

The platform treats a report as a claim and checks it against the state machine; what it does with an impossible transition (log, alert, ignore) is the platform's choice. If the platform is unreachable the orchestrator keeps the reports and retries in order (proposal; the fake orchestrator does not retry). Python side: `StateReport` and `ReportIngest` in `apps/api/src/vulnmart/ports/instance_host.py` implement the table; the shared tests run the same cases against the fake host and against the fake service.
## 9. Fake orchestrator and fake host

- **Fake service** (`contracts/mocks/fake-orchestrator/server.mjs`, Node, no dependencies): all eight calls, the state machine, the signature, nonce and timestamp checks, a capacity limit, a step delay (`--step-delay-ms`, default 0), optional state reports (`--report-url`, `--report-key`). It stores no secret: the create body is checked and then reduced to a SHA-256 fingerprint. Extras that are **not part of the contract**: a second template name `shop-fail-v0` that ends in `failed` with `INST-HEALTH-TIMEOUT`, and a test-control path `POST /_fake/v1/instances/{id}/activity` (unsigned, localhost only) that moves an instance between `ready`, `active` and `idle`. Unknown routes answer 404 `ORCH-ROUTE-UNKNOWN` and a crash of the fake answers 500 `ORCH-INTERNAL`; both are fake-only codes, and both are RFC 9457 problems like every other answer.
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
| 11 | Reset body carries the new epoch (current plus one) and the new secrets (a new `event_key` derived for that epoch); template, limits and owner stay (no `owner_hash` in a reset) | Architecture says "destroy and recreate with a new epoch" only |
| 12 | A new instance starts with access `closed` and access epoch 0; the platform opens it | ADR 0004 gate; start value not fixed |
| 13 | An access request with the same epoch and another value is refused as stale | Equal-epoch rule not fixed |
| 14 | Destroy of an unknown id answers 404; destroyed instances stay visible as tombstones (retention not set) | Matrix says "known or already destroyed" |
| 15 | List is cursor-paged (default 100, maximum 500, ordered by id); filters instance, epoch, component, template, kind | Architecture says "list by label" |
| 16 | Host answer is `{host_id, kind (vm, laptop, fake), capacity_memory_mb, used_memory_mb, instances, health (ok, degraded, down)}`; capacity is counted in memory only | Not fixed (ADR 0015 for the laptop engine) |
| 17 | State report body `{instance_id, epoch, transition, from_state, to_state, at, reason, error_code, health}`; the platform answers 204 (200 for an identical repeat, see row 34); at-least-once delivery | Not fixed |
| 18 | Instance health is `unknown`, `healthy` or `unhealthy` | Not fixed |
| 19 | Body limit 64 KiB; rate 20 per second per client, burst 40 | Architecture says "oversize bodies" and "rate-limited" without numbers |
| 20 | Error code names `ORCH-FIELD-FORBIDDEN`, `ORCH-VALIDATION`, `ORCH-INSTANCE-EXISTS`, `ORCH-INVALID-STATE`, `ORCH-STALE-EPOCH`, `ORCH-LABEL-UNKNOWN`, `ORCH-BODY-TOO-LARGE`, `ORCH-RATE-LIMITED`, `ORCH-UNSUPPORTED-MEDIA-TYPE`, `ORCH-CURSOR-INVALID` (added to the names in the matrix) | Registered in IF-8 0.4.0 (final) |
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
| 31 | Sidecar start input: one JSON document on standard input with `instance_id`, `epoch`, `event_key` and the flag digests (shape in `contracts/instance/sidecar-start.schema.json`, IF-6 open point 35). `first_seq` was removed in D-42: every epoch restarts the sidecar counter at 1 | Handoff H-59. Shape defined by L-06 |
| 32 | Create carries `owner_hash` (64 lowercase hex characters, required), the opaque `vm.owner` label value; the platform computes it, proposal HMAC-SHA256 of the user id with a platform label key, hex; the orchestrator stores it, applies it as the label and never returns it; a reset keeps the owner | Handoff H-20. Key handling per ADR 0009, to confirm with Akshay |
| 33 | The event key is derived per `(instance_id, epoch)` with HKDF-SHA256 (IF-4 section 4), so a reset sends a new `event_key`. Closed by D-42 (proposal until confirmed) | Handoff H-59 |
| 34 | State reports carry a required `transition` number (per instance and epoch, assigned by the orchestrator) and the platform dedups on `(instance_id, epoch, transition)`: same body 200, other body 409, a lower number is history (section 8) | Reports were identified by their body and `at` only; two changes in the same second could not be ordered. Handoff for Akshay (the platform ingest) |
| 35 | Every integer is an integer token, at most 2^53 - 1; `1.0`, `1e0` and booleans are 422; `cpu_limit` is the one non-integer and is compared by value (section 2a) | One reading of a body in every language; JSON Schema alone cannot say it |
| 36 | Errors are the closed IF-8 body (`type` is `urn:vulnmart:error:<CODE>`, no `detail`, no `instance`, a closed `Problem` schema; section 6) | Decided 2026-10-09 (M1 of ADR 0019), moved to IF-8 on 2026-10-12 (condition F-2 of the contracts sign-off) |
| 37 | Order of checks: signature, call exists, media type 415, shape 422, template, existence 404, state 409, capacity 429; a body that is not `application/json` is 415 `ORCH-UNSUPPORTED-MEDIA-TYPE` | The mock looked an instance up before reading the body; no media type check existed |
| 38 | A list cursor is the base64url of an instance id; anything else is 422 `ORCH-CURSOR-INVALID` | The two hosts treated garbage cursors differently |
