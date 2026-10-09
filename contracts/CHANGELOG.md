# Contracts changelog

Every change to a contract under `contracts/` adds an entry here (architecture 07 section 3, rule 4).

## Versioning rule

- Contracts are `0.x` until the tag `contracts-v1.0.0` (story L-09).
- Additive change (new optional field, new endpoint, new event type, new error code, new allowed value): **minor** bump.
- Rename, removal, retyping, or making an optional field required: **breaking**. It needs approval from every consumer and an expand-then-contract path. Before v1.0.0 it bumps the minor number and is marked BREAKING here; from v1.0.0 it is a major bump.
- Tags are `contracts-vX.Y.Z`.

## Instance contract (IF-6), `contracts/instance/`

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

## Orchestrator API (IF-5), `contracts/orchestrator/`

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
