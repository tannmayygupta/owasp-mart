# Contracts changelog

Every change to a contract under `contracts/` adds an entry here (architecture 07 section 3, rule 4).

## Versioning rule

- Contracts are `0.x` until the tag `contracts-v1.0.0` (story L-09).
- Additive change (new optional field, new endpoint, new event type, new error code, new allowed value): **minor** bump.
- Rename, removal, retyping, or making an optional field required: **breaking**. It needs approval from every consumer and an expand-then-contract path. Before v1.0.0 it bumps the minor number and is declared here with a bullet line that starts with `BREAKING:` and a reason (exact case; "no BREAKING changes" does not count); from v1.0.0 it is a major bump.
- Tags are `contracts-vX.Y.Z`.
- CI enforces these rules with `node scripts/check-contract-rules.mjs` (story L-07, job `contract-rules`), reading `contracts/registry.json`: a change to a registered contract needs a new line in its own section below; a change to a schema or OpenAPI file also needs a change under its mock paths, or a line `no mock change: <reason>` in the new entry; a breaking change (deleting a whole contract included) needs a `BREAKING:` line and a raised version in the same section; a pull request that changes the registry, the checker, the diff scripts, the oasdiff pins or the workflows needs a new line `registry change: <reason>` (story 1.15, D-46); a new folder under `contracts/` needs a registry entry.

## Platform API (IF-1), `contracts/api/platform/`

### 0.1.0 (2026-10-11, Akshay, story P-04)
- registry change: IF-1 is registered in `contracts/registry.json` (new contract; `contracts/api/platform` was a reserved folder, now owned by stream P with its OpenAPI file, mock, conformance scripts and generated code).- First draft: `platform.openapi.yaml` (OpenAPI 3.1, 25 operations on 21 paths under `/api/v1/`): health; account creation and e-mail verification; session (sign in, MFA step, read, sign out); profile, password and MFA enrolment; password reset; consent notice and record; challenge catalogue; own attempts; live stream (`GET /live` as SSE, `GET /live/snapshot`, `POST /live/ticket` marked `x-pending` until story S-14). Session cookie `__Host-vm_session`, CSRF header `X-CSRF-Token` on every authenticated unsafe call (public ones have no session and no token, but the Origin check and a rate limit), every error is the closed IF-8 body (`application/problem+json`), public operations say `security: []`, every answer says `Cache-Control: private, no-store`. Every authenticated state-changing route that takes a body also declares 429.
- Bundle: `contracts/api/bundle/openapi.json` (43 operations: this fragment plus IF-2, written by `node scripts/bundle-openapi.mjs`, proven current by `pnpm run contracts:bundle:check`). IF-2 components that differ from a platform component of the same name are renamed with the prefix `Lab`; IF-2 keeps its own error bodies in the bundle (see the change request to stream L).
- Generated code, checked in CI (`pnpm run api:check`): `packages/ts-client/src/api.d.ts` and `packages/py-models/src/vulnmart_models/api.py`, from the bundle by `scripts/generate-api-code.mjs`. In the Python models an e-mail address is a plain string, and an object that must have at least one member is not expressed; the bundle and the API validate both.
- Mock: `contracts/mocks/platform-mock/server.mjs` (a Node server of the bundle: cookies, CSRF, origin and size checks, another declared answer through `Prefer: code=NNN` or `Prefer: example=NAME`, a fake SSE stream, an optional fake lab) with `scripts/platform-mock.test.mjs`.
- Checked by `scripts/check_platform_contract.py` (fragment and bundle rules, 14 valid and 21 invalid request examples), `scripts/check_api_models.py` and the type test of the client.
- Status: awaiting review by Tanmay (lab prefix in the bundle, IF-2 error bodies) and Sahil (catalogue fields the dashboards read).

## Domain events (IF-3), `contracts/domain-events/`

### 0.1.0 (2026-10-11, Akshay, story P-03)
- registry change: IF-3 is registered in `contracts/registry.json` (new contract in its own folder: `contracts/events/` is IF-4's folder in the registry, so the architecture's path `contracts/events/domain-events.schema.json` moved to `contracts/domain-events/`; `docs/architecture/07-repo-and-workstreams.md` is updated).
- First draft: `domain-events.schema.json` (one closed JSON Schema, seven types: `instance.state_changed`, `attempt.state_changed`, `attempt.milestone_reached`, `attempt.flag_captured`, `attempt.score_updated`, `attempt.hint_unlocked` and the control event `stream.resync`), `audiences.json` (who may receive what by attempt mode: learner practice never reaches a company; the candidate does not receive their own milestones, captures or score while OI-15 is open), the SSE wire format and the `Last-Event-ID` and `resync` rules (README), `fixtures/session.json` (18 ordered records), 8 valid and 25 invalid example events. The schema rejects impossible dates and a failed instance without an `error_code` (or a code on another state).
- State vocabularies and id shapes are copied from IF-2 and IF-5; `INST-*` codes come from IF-8. Handoff H-22 answered: `seq` is 64-bit, orchestrator and platform events use a reserved range from 2^40 up to 2^53 - 1, an infrastructure fault is shown as `instance.state_changed` with state `failed`. Stream layout (`live:user:<id>`, `live:org:<id>`, `live:admin`, one `event` field per entry), delivery rules and the `resync` loop are in the README.
- Checked by `scripts/validate-domain-events.mjs` and `scripts/replay-domain-events.mjs` (`pnpm run domain-events:check`, in CI) with tests.
- no mock change: the fixtures and the replay script are the stub of this contract (`noMock` in the registry).
- Status: awaiting review by Tanmay (publisher side, `stream.resync`, audience table).

## Error codes and error format (IF-8), `contracts/errors/`

### 0.3.0 (2026-10-11, Akshay, story P-04, code review)
- Additive: `AUTH-MFA-STATE` (409: the second factor is already active, or an admin turns it off) and `ATT-CONSENT-STALE` (409: the consent notice the person saw is not the current one). They replace the use of `ATT-INVALID-STATE` for these two cases in IF-1. Constants regenerated (56 codes).
- BREAKING: none in substance, see 0.2.0 (the rules engine flags any change to `error-codes.yaml`). Checked by hand: 2 added, 0 removed, 0 changed.
- no mock change: the generated constants are the stub of this contract (`noMock` in the registry).

### 0.2.0 (2026-10-11, Akshay, story P-04)
- Additive: five codes for the platform routes of IF-1: `AUTH-EMAIL-NOT-VERIFIED` (403), `AUTH-INVALID-CREDENTIALS` (401), `AUTH-MFA-INVALID` (401), `AUTH-TOKEN-INVALID` (400) and `REQ-RATE-LIMITED` (429, the generic rate limit that the deferred-work list of P-02 named). Constants regenerated (54 codes).
- BREAKING: none in substance. This line only satisfies the rules engine, which cannot compare `error-codes.yaml` (a YAML file outside `schemas` and `openapi`) and flags any change to it as breaking on the safe side. Checked by hand against `origin/main`: 5 codes added, 0 removed, 0 changed.
- no mock change: the generated constants are the stub of this contract (`noMock` in the registry).

### 0.1.0 (2026-10-11, Akshay, story P-02)
- registry change: IF-8 is registered in `contracts/registry.json` (new contract; `contracts/errors` was a reserved folder, now owned by stream P with its schemas, conformance scripts and a stated reason for having no mock).
- First draft: `error-codes.yaml` (49 codes in six families: `AUTH`, `ATT`, `EVT`, `INST`, `ORCH`, `REQ`; every code named in the merged contracts and in stream L's in-flight branches, under the names those contracts use), `error-codes.schema.json`, `problem.schema.json` (RFC 9457 members `type`, `title`, `status` plus `code`, `request_id`, optional `field` and `errors`; closed shape), 7 valid and 24 invalid example bodies, and `README.md`.
- `ATT-GONE` (410) is in the seed because IF-2 0.2.0 uses it (`att_gone`).
- Generated constants: `packages/py-models/src/vulnmart_models/error_codes.py` and `packages/ts-client/src/error-codes.ts` (`node scripts/generate-error-codes.mjs`).
- Checked by `scripts/validate-errors.mjs` and `scripts/generate-error-codes.mjs --check` (`pnpm run errors:check`, in CI) with tests.
- The injector exit codes 10 to 13 are `exit_code` on the four `INST-INJECT-*` codes.
- Streams L and T move their error bodies to this shape in their own stories: see `docs/reviews/2026-10-11-if8-change-request-for-stream-l.md`.
- Status: awaiting review by Tanmay (statuses, titles, the body shape change for IF-2, IF-4 and IF-5).

## Instance contract (IF-6), `contracts/instance/`

### 0.2.0 (2026-10-11, Tanmay, story 1.15, decision D-42)
- BREAKING: `first_seq` is removed from the sidecar start document (`sidecar-start.schema.json`: no longer required, no longer allowed); the sidecar restarts its sequence counter at 1 in every epoch and stamps the `epoch` of the start document on every event (IF-4 0.2.0). The `event_key` in the document is now the 43-character base64url key derived per `(instance, epoch)`; the accepted shape (32 to 128 printable ASCII characters) is unchanged.
- Section 6 and open point 35 updated; the sidecar keeps its write-ahead counter in a file in its own `/tmp` (`/tmp/vm-sidecar-seq.json`). No new mount, volume or path is added to the template; a lost sidecar container loses the file (IF-4 open point 32).
- Examples: the two valid sidecar-start examples lose `first_seq`; the two `first-seq-*` invalid examples are replaced by `first-seq-removed` (a document that still has `first_seq` is refused).
- Mocks changed with it: `contracts/mocks/stub-instance` (sidecar counter, state file, epoch stamp, fixtures, ingest wrapper); it uses the shared key derivation in `contracts/mocks/fake-ingest/event-key.mjs`, which its image already copies with the fake-ingest folder.

### 0.1.0 (2026-10-08, Tanmay, story L-02)
- First draft: `instance-contract.md` (the 11 topics of architecture 07 section 3.2, injector exit codes with placeholder `INST-*` names, versioning rule, table of open points to confirm).
- JSON Schemas 2020-12: `injection-document.schema.json`, `flags-file.schema.json`, `instance-template.schema.json`.
- Examples: 5 valid and 129 invalid, each invalid one with its expected error path in `examples/invalid/manifest.json`.
- Two more memory-backed volumes, `vm-placement-import` at `/run/placement/import` and `vm-placement-mock` at `/run/placement/mock`, carry the flag files for the import service and mock-services (injector read-write, one consumer each read-only). The injector has `network_mode: none`.
- Checked by `scripts/validate-contracts.mjs` (`pnpm run contracts:check`).
- Status: merged in pull request #2 with all CI checks green; Sahil's consumer approval waived (D-37); the open-points table is still to be confirmed by Sahil and Akshay in the team chat.

### 0.1.1 (2026-10-09, Tanmay, story L-03)
- Section 6 and open point 22 now point at IF-4 and name the event path `/v1/events` (changed in substance, not only editorial: the path and the event body are now fixed by IF-4). Approval of this change is waived under D-37.

### 0.1.2 (2026-10-09, Tanmay, story L-04 follow-up)
- Additive, no schema change: section 4 notes that the `vm.owner` label value comes from the required `owner_hash` of the IF-5 create body (handoff H-20); section 6 says the orchestrator gives the sidecar the event key, flag digests and `first_seq` on standard input at start (handoff H-59); open points 23 updated and 35 added (sidecar start input).

### 0.1.3 (2026-10-10, Tanmay, story L-06)
- Additive: new schema `sidecar-start.schema.json` (the start document of the sidecar: `schema_version`, `instance_id`, `epoch`, `first_seq`, `event_key`, `flag_digests`), 2 valid and 24 invalid examples, one semantic rule in `contracts/mocks/stub-instance/semantic.mjs`, shared by `scripts/validate-contracts.mjs` and the stub (no repeated digest, one real digest per challenge key). Section 6 describes it; open point 35 is now a proposal with a shape (handoff H-59, for L-13 and L-20). Decided by Tanmay on 2026-10-10 as a proposal; Akshay and the orchestrator story confirm it.
- Additive note in section 7 and new open point 36: a Docker tmpfs volume is lost when its last container stops, so something must keep the four volumes mounted while the injector exits and the shop starts (found while building the L-06 harness).
- No change to the other three schemas, to IF-4, IF-5, IF-1 or IF-2.

### 0.2.0 (2026-10-11, Tanmay, story 1.15, instance template hardening; a minor step because it is breaking before v1.0.0)
- `instance-template.schema.json` now closes the holes found in the audit. Component `name` is one of the six role names and equals its role; `image` is exactly `{image:<role>}`; `network_mode` is fixed per role (`instance` for the shop, sidecar, mock-services and bot controller, `none` for the injector and import service); the injector has no `ports` and no `healthcheck`; the shop healthcheck path is `/readyz` (the contract text always said `/readyz`; the schema did not check it); `user` is exactly `65532:65532`; `memory_mb` 16 to 1024, `cpu_limit` above 0 up to 2, `pids_limit` 1 to 512, volume `size_mb` up to 64, tmpfs `size_mb` up to 512 (maxima are about twice the largest example and are proposals, to confirm after spikes S-4 and S-5); each `env` name has a value pattern or fixed value (URLs, socket, database and snapshot paths, `TZ`, log level, `PORT`) and `env` is not empty; `vm.expires` is a token or a UTC date-time with a valid month, day, hour, minute and second; `flag_delivery_env.reason` must be a real sentence (no run of four equal characters, no double whitespace, at least three words).
- `scripts/validate-contracts.mjs` adds three semantic rules: `PORT` is one of `ports`, `vm.expires` is a real calendar date, a flag-in-env `reason` has at least 8 different letters or digits. Section 7 and open point text of `instance-contract.md` describe them.
- 40 new invalid examples under `examples/invalid/instance-template/` (each with its path in `examples/invalid/manifest.json`); no valid example changed.
- BREAKING: a template that used another run user than 65532:65532, a component name or image other than the role's own, network_mode other than the role's fixed value, a shop healthcheck path other than /readyz, limits above the new maxima, an env value outside its pattern or an empty env is now invalid
- no mock change: the stub instance mock (`contracts/mocks/stub-instance`) does not read `instance-template.schema.json`; the checkers that use it are `scripts/validate-contracts.mjs` and `scripts/check-instance-conformance.mjs`, both changed here with tests.
- `scripts/check-instance-conformance.mjs`: the helper-name allowlist (`ingest`, `volume-keeper`) is frozen and no longer a way to skip rules (new rule `harness-helpers-minimal`; `no-outside-network` now covers helpers too).

## Lab API (IF-2), `contracts/api/lab/`

### 0.2.0 (2026-10-11, Tanmay, story 1.15 part B4, which also carries story 1.12 for IF-2; to be confirmed by Akshay)
- BREAKING: the timeline is paged by an opaque forward cursor keyed by `(epoch, seq)` instead of a decimal offset; entries are sorted by that key, a cursor of version 0.1.0 (a base64url decimal offset) is now 422 `req_validation` with field `/cursor`, and the cursor never moves back (a client that wants a late IF-4 event of a smaller key reads again from the start, `cursor` left out). The Timeline answer gains the required boolean `has_more`.
- BREAKING: error answers are RFC 9457 problem details with the media type `application/problem+json`: new required members `type` (`https://vulnmart.invalid/problems/<code>`), `title`, `status`, `detail`, `instance` (`urn:vulnmart:request:<request_id>`); `code`, `request_id` and `field` stay as extension members. The member `message` is removed (it is `detail`), the `code` values are renamed to lower-case words with underscores (`att_not_found` for `ATT-NOT-FOUND`), and the Problem schema is open (unknown members are ignored by clients). Same form as IF-5 (the orchestrator side is changed by its own entry).
- BREAKING: the flag result the submitter sees is only `correct` or `incorrect`: the values `wrong`, `decoy`, `other_instance` and `stale_epoch` are removed from `FlagResult` (and from the timeline `result`), so the answer is not an oracle; the reason stays on the server. Every incorrect submission, whatever the reason, now counts for the rate limit of 5 per 10 minutes. The owner of a learner attempt no longer sees integrity flags of type `decoy` or `sharing`.
- BREAKING: every list answer gains the required boolean `has_more` (challenges, hints, evidence, integrity flags, timeline); `listEvidence` and `listIntegrityFlags` take `limit` (default 100, maximum 100, 422 above it); the timeline `limit` keeps default 50 and maximum 200 and 422 above it.
- Added (not breaking): 410 `att_gone` for the derived reads of a withdrawn or cancelled attempt, a proposal to confirm; a deleted attempt is the same 404 as a missing one; `getAttempt` shows the state for withdrawn and cancelled. The role table of section 1 is written out; where nothing is decided it says proposal, to confirm. Order of checks stated and made the same in the mock: the content type (415) comes before the lookup (404). A repeated correct flag is answered before the rate limit (the text said so; the mock now does).
- Examples (38 valid, 101 invalid now): 23 problem examples (11 valid, 12 invalid including old-style bodies), `flags.result.incorrect` replaces the four reason examples, `timeline.last-page`, 4 invalid examples of oracle reasons, list examples with `has_more`. Open points 8 and 30 changed, 32 to 36 added.
- Mock changed with it: `contracts/mocks/fake-lab` (cursor by `(epoch, seq)`, the test hook `POST /_fake/late-event`, problem details, `has_more` and `limit`, oracle collapse with the reason kept server side, role and state rules, three seed attempts in states withdrawn, cancelled and deleted). `scripts/check_lab_contract.py` forbids an oracle reason in `FlagResult` and ties `type`, `instance` and `code` together; tests in `apps/api/tests/test_lab_contract.py`, `scripts/fake-lab.test.mjs` and `scripts/e2e/lab.e2e.test.mjs`.

### 0.1.0 (2026-10-09, Tanmay, story L-05)
- First draft, a proposal for Akshay to confirm in the team chat (D-37): `lab.openapi.yaml` (OpenAPI 3.1, 18 operations under `/api/v1/`: instances request, get, open ticket, reset, stop; attempts get, start (pending OI-22), submit; flag submit; score; challenges; hints list and unlock; evidence; integrity flags with review decisions; per-candidate report; timeline) and `lab-api.md` (scope and ownership, shared enums, auth and cross-cutting rules, error placeholders, 30 open points).
- Instance states, access and health are identical to IF-5 (handoff H-78). Placeholder error codes `AUTH-*`, `ATT-*`, `INST-*`, `REQ-*` until the registry (IF-8, P-02) is merged.
- Examples: 38 valid and 82 invalid (each invalid one with its expected error path in `examples/invalid/manifest.json`). Mock: `contracts/mocks/fake-lab/server.mjs` (Node, no dependency, not Prism).
- Checked by `scripts/check_lab_contract.py` (last part of `pnpm run contracts:check`), `apps/api/tests/test_lab_contract.py` and `scripts/e2e/lab.e2e.test.mjs`.
- Platform-owned routes are not in this file; they are listed in handoff H-86. No change to IF-1, IF-4, IF-5 or IF-6.
- Status: awaiting optional confirmation by Akshay (consumer; handoffs H-84 to H-89).

## Orchestrator API (IF-5), `contracts/orchestrator/`

### 0.3.0 (2026-10-11, Tanmay, story 1.15, review findings of pull request 3; decided on the developer's delegation, ADR 0028; to be confirmed)
- BREAKING: `StateReport` has a new required member `transition` (integer from 1 to 2^53 - 1), assigned by the orchestrator per `(instance_id, epoch)` (1, 2, 3 ... without gaps; a reset starts again at 1). The identity of a report is `(instance_id, epoch, transition)`; the platform answers 204 for a new one, 200 for an identical repeat, 409 `ORCH-REQUEST-MISMATCH` for another body, and keeps a lower number as history without moving the state back. A real re-entrant change (the same state twice) has its own number. `at` orders nothing. The platform answers of `POST /internal/v1/orch/state` gain 200, 409 and 415. A sender that does not send `transition` is refused with 422.
- BREAKING: every integer of the contract is an integer token on the wire, in the OpenAPI as `type: integer`, `format: int64`, a `minimum` and a `maximum` of at most 2^53 - 1 (9007199254740991; `index`, `limits.memory_mb`, `pids_limit`, `idle_minutes`, `max_minutes`, `epoch`, `access_epoch`, `transition`, the host numbers, the `epoch` and `limit` query parameters, `Problem.status`). `1.0`, `1e0`, a boolean, `NaN` and a number above 2^53 - 1 are 422 `ORCH-VALIDATION` with the field pointer; before, `1.0` and `1e0` were accepted by some readers and not by others. `limits.cpu_limit` stays a `number` (`format: double`) and is compared by value (`2` and `2.0` are one request). New section 2a of `orchestrator-api.md`.
- BREAKING: the error body is RFC 9457 problem details, media type `application/problem+json`: new required standard members `type` (`https://vulnmart.invalid/problems/` plus the lower-case code), `title`, `status`, `detail` and `instance` (`urn:vulnmart:request:` plus the `request_id`); `code`, `request_id` and `field` stay as extension members. The `message` member is removed (use `detail`). The `Problem` schema is now open (no `additionalProperties: false`): a client ignores members it does not know, so a member can be added later without a breaking change; `message`, `stack` and `trace` stay refused. Every error response of the file is `application/problem+json` and nothing else.
- Additive: new error codes `ORCH-UNSUPPORTED-MEDIA-TYPE` (415, a body that is not `application/json`) and `ORCH-CURSOR-INVALID` (422, a list cursor that this orchestrator did not hand out; the `Cursor` pattern is now exactly 24 characters, the base64url of an instance id). The order of checks is now stated: signature, the call exists, media type (415), shape (422), template, existence (404), state (409), capacity (429); 415 comes before 404, and a malformed body is 422 before an unknown instance is 404 (the mock used to look the instance up first).
- Examples: `transition` in the valid state report; new valid problem examples (cursor, media type, an extension member) and rewritten valid error examples; 29 new invalid examples (missing, `0`, negative, `1.0`, `1e0`, string, boolean and huge `transition`; integer fields written as floats or booleans; old-style, `message`, `stack`, `trace`, wrong `type`, string and float `status` problems). The check script reads the examples with a strict integer rule and checks int64 ranges, the open `Problem` schema and the media type of every error response.
- Mocks changed with it: `contracts/mocks/fake-orchestrator` (a strict JSON number reader, problem details on every 4xx and 5xx, transition numbers in the reports, the 415 check and the new order, the cursor check); Python side `apps/api/src/vulnmart/ports/` (`StateReport`, `ReportIngest`, strict integers in `FakeInstanceHost` and `HttpInstanceHost`, problem details parsing, a TLS context that does not verify is refused).

### 0.2.0 (2026-10-11, Tanmay, story 1.15, decision D-42; only the `first_seq` and `event_key` lines; other IF-5 changes of this story are listed by their own entries)
- BREAKING: `first_seq` is removed from the create body and the reset body (`CreateInstanceRequest` and `ResetInstanceRequest` no longer list or allow it; the `FirstSeq` schema is gone). Every epoch restarts the sidecar counter at 1; event identity is `(instance_id, epoch, seq)` (IF-4 0.2.0). A body that still has `first_seq` is refused (422 `ORCH-VALIDATION`, field `/first_seq`).
- `event_key` stays in create and reset, and its meaning is now defined: the platform derives it per `(instance_id, epoch)` with HKDF-SHA256 (IF-4 section 4), so a reset always carries a new key. The accepted shape is unchanged (32 to 128 URL-safe characters; the derivation gives 43). Open points 11, 31 and 33 of `orchestrator-api.md` reworded.
- Examples: `first_seq` removed from the valid create and reset examples and from the other invalid ones; the six first-seq invalid examples are replaced by `create-first-seq-removed` and `reset-first-seq-removed`.
- Mocks changed with it: `contracts/mocks/fake-orchestrator` (no `first_seq` in the validation); Python side `apps/api/src/vulnmart/ports/` (`CreateRequest` and `ResetRequest` lose `first_seq`).

### 0.1.0 follow-up notes (2026-10-09, Tanmay, story L-04 follow-up; still the 0.1.0 draft, nothing was confirmed yet)
- Create body: new required `owner_hash` (64 lowercase hex, the opaque `vm.owner` label value, computed by the platform, never returned) and required `first_seq` (integer of at least 1). Reset body: new required `first_seq`; no `owner_hash` (the owner stays). Both are part of the request fingerprint; no GET answer returns either. Open points 31 to 33 added (sidecar start input, owner hash computation, event key across a reset). Handoffs H-20 and H-59.

### 0.1.0 (2026-10-09, Tanmay, story L-04)
- First draft, a proposal for Akshay to confirm in the team chat (D-37): `orchestrator.openapi.yaml` (OpenAPI 3.1: the seven calls and the signed state report `POST /internal/v1/orch/state`), `orchestrator-api.md` (state machine, signing and replay rules, idempotence, errors, limits, 30 open points).
- Examples: 15 valid and 33 invalid (each invalid one with its expected error path in `examples/invalid/manifest.json`) and a fixed signing vector.
- Placeholder error codes `ORCH-*` and `INST-*` until the registry (IF-8, P-02) is merged.
- Python side: `InstanceHost` protocol, `FakeInstanceHost` and `HttpInstanceHost` in `apps/api/src/vulnmart/ports/` (IF-9). Mock: `contracts/mocks/fake-orchestrator/server.mjs`.
- Checked by `scripts/check_orchestrator_contract.py` (second half of `pnpm run contracts:check`) and by `apps/api/tests`.
- Review fixes (still 0.1.0, nothing was confirmed yet): added `ORCH-METHOD-NOT-ALLOWED` (405 with `Allow`) and `Retry-After` on 429; create of a destroyed id is 409 `ORCH-INSTANCE-EXISTS` and an old-epoch create is 409 `ORCH-STALE-EPOCH`; an oversize body is refused (413, connection dropped) before the signature check; a repeated query parameter and a `limit` that is not a plain number are 422 `ORCH-VALIDATION`; open points 24 to 30 added (reset capacity for L-13, nonce memory per process, nested forbidden names, and others).
- Status: awaiting optional confirmation by Akshay (consumer).

## Instance events (IF-4), `contracts/events/`

### 0.2.0 (2026-10-11, Tanmay, story 1.15, decision D-42, decided on the developer's delegation; to be confirmed)
- BREAKING: new required wire field `epoch` (integer at least 1) in `instance-events.schema.json`; event identity is now `(instance_id, epoch, seq)` instead of `(instance_id, seq)`. Every epoch restarts the sidecar counter at 1. The posted schema does not contain `epoch` (the sidecar stamps it; a poster that sends it gets 422).
- BREAKING: the signing string of `X-VM-Signature` (label stays `v1` while the contracts are 0.x) is now `instance_id`, newline, `epoch`, newline, `seq`, newline, hex SHA-256 of the body. The three signed envelope examples are signed again.
- BREAKING: `seq` lanes per source are enforced by the schema (all below 2^53): sidecar, shop, import, mock, bot 1 to 2^40-1; orchestrator 2^40 to 2^41-1; platform 2^41 to 2^42-1. The valid orchestrator examples (`instance.flags_injected`, `infrastructure_fault`) move into their lane.
- Ingest rules (section 5 and 6): duplicates on `(instance_id, epoch, seq)` (same body 200, other body 409); after the signature check an `epoch` above the instance's current epoch is 401, an equal or lower one is accepted and stored under its own epoch (a late event of an old epoch is history, never credited to the new epoch); order by `(epoch, seq)`.
- Event key derivation defined (section 4, closes open point 2 as a proposal): HKDF-SHA256 (RFC 5869) from the platform master `K_evt`, salt `vm-evt-salt-v1`, info `vm-event-key-v1` 0x00 `instance_id` 0x00 decimal `epoch`, 32 bytes, base64url (43 characters); one key per `(instance, epoch)`. New `examples/event-key-vector.json` (fake master) checked by `scripts/validate-events.mjs` and, with an independent HKDF, by `scripts/e2e/events.e2e.test.mjs`.
- Sidecar counter: write-ahead state file in the sidecar's own `/tmp`, so a restart of the sidecar process inside one epoch never reuses a `seq`; new sidecar answer 503 when it cannot number an event. Open points 1, 2, 6, 8, 9, 20, 21, 25 reworded and 29 to 33 added.
- Examples: `epoch` added to every wire example; new invalid examples `epoch-missing`, `epoch-zero`, `epoch-string`, `orchestrator-seq-1`, `sidecar-seq-in-reserved-lane`, `platform-seq-in-orchestrator-lane`, `orchestrator-seq-in-platform-lane` and the posted `includes-epoch`.
- Mocks changed with it: `contracts/mocks/fake-ingest` (epoch, lanes, `--master`, `--epoch`, `POST /_fake/epoch`, per-epoch dedup), the shared `contracts/mocks/fake-ingest/event-key.mjs`, and `contracts/mocks/stub-instance` (sidecar).

### 0.1.0 follow-up notes (2026-10-09, Tanmay, story L-04 follow-up; still the 0.1.0 draft)
- The import service never posts: the shop posts `import.job` (source `import`) on its behalf after it has the job result over the unix socket (section 3 and the catalogue row; the posted schema and the examples do not change; handoff H-50).
- Sequence rules (section 6, open points 8 and 9): the platform gives the sidecar its first `seq` through the required `first_seq` of the IF-5 create and reset bodies; the event key is the same on a reset unless the key version is raised (proposal; handoff H-59).

### 0.1.0 (2026-10-08, Tanmay, story L-03)
- First draft: `app-events.md` (identity `(instance_id, seq)`, wire event, shop-to-sidecar and sidecar-to-ingest transport, signing, ingest answers, size caps, catalogue of 29 event types, table of 28 open points to confirm) and `instance-events.schema.json` (JSON Schema 2020-12, one data rule per type).
- Examples: 29 valid (one per type, the evidence one shows the `[FLAG-REDACTED]` marker), 3 signed requests, 6 valid and 10 invalid posted bodies, 51 invalid events, each invalid one with its expected error path in `examples/invalid/manifest.json`.
- `instance-events.posted.schema.json`: the body a shop, import service, mock service or bot posts to the sidecar, derived from the wire schema by `node scripts/validate-events.mjs --write-posted` (the check fails when it is stale); a posted evidence body is at most 2 KiB.
- Review fixes: signature over the raw bytes; same HMAC work for unknown instances; duplicate `(instance_id, seq)` with a different body answers 409 `EVT-DUPLICATE-MISMATCH`; the fake ingest keeps at most 100000 events (503); the flag-like check ignores case and sees `VM%7B` (best effort); `session_kind` `internal` only for import, orchestrator and platform; `proxy.flag_seen` envelope and data `challenge_key` must agree; bounded body read, timeout and option checks in the fake ingest server.
- Fake ingest in `contracts/mocks/fake-ingest/` (verifies signature, size, schema and duplicates; answers 202, 200, 401, 413, 422) with a signing helper.
- Checked by `scripts/validate-events.mjs` (`pnpm run events:check`; `pnpm run contracts:check` runs both checks).
- The challenge specs' `event_id` is dropped; `proxy.flag_seen` carries `kind` and `challenge_key`; `source` has seven values (decisions of 2026-10-08).
- Pointer changes in `contracts/instance/instance-contract.md` (see the IF-6 section above, 0.1.1).
- Status: names and open points await Sahil's review (optional under D-37) and Akshay's note on the `EVT-*` placeholders.

## Table owners (DB), `contracts/db/`

### 0.1.0 (2026-10-10, Tanmay, story L-07)
- First draft, a proposal for Akshay to confirm (tasks P-05 and P-06): `table-owners.schema.json`, the shape of `contracts/db/table-owners.yaml` (a `tables` list of `table` and `owner`, the owner being a module folder of `apps/api/src/vulnmart/` named in CODEOWNERS). The YAML file itself is Akshay's and does not exist yet; `scripts/check_table_owners.py` reports NOT-APPLICABLE until it does, then checks shape, owner names and duplicate tables.
- The registry has no mock for this contract (`no mock change: nothing runs against it`).

## Challenge catalogue (IF-7), `contracts/catalog/` and `challenges/catalog/`

### 0.1.0 (2026-10-09, Sahil, story T-02)
- First draft: `contracts/catalog/challenge.schema.json` (JSON Schema 2020-12, one challenge entry) and a short `contracts/catalog/README.md`.
- 11 stub entries `challenges/catalog/c01..c11.yaml` (`status: stub`): OWASP 2021/2025 tags, CWE and ATT&CK ids, difficulty and tier, placeholder milestone summaries and three empty hint slots, provisional flag placement/delivery, start-state, exploit-test and fixed-build paths.
- Validator `scripts/validate-catalog.mjs` (`pnpm run catalog:check`) and tests `scripts/validate-catalog.test.mjs`: schema plus semantic rules (tier matches difficulty per D-32, key matches filename, exactly 11 entries, no real flag value). `js-yaml` 4.1.0 added as a pinned dev dependency.
- Full content (briefs, write-ups, decoys, filled hints, official-site id re-check) is T-30; each challenge's real milestone signals and confirmed flag placement come with its own story.

## Contract rules engine (L-07), `scripts/check-contract-rules.mjs`

### 2026-10-11 (Tanmay, story 1.15)
- registry change: IF-7 (challenge catalogue, owner T) is registered and `contracts/catalog` is no longer reserved; the checker, its registry, the oasdiff pins and the workflow now run from the base commit (trusted checker, ADR 0026); deleting a whole contract is a breaking change; the marker is the exact line `BREAKING:`.
