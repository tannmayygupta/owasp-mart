# Contracts changelog

Every change to a contract under `contracts/` adds an entry here (architecture 07 section 3, rule 4).

## Versioning rule

- Contracts are `0.x` until the tag `contracts-v1.0.0` (story L-09).
- Additive change (new optional field, new endpoint, new event type, new error code, new allowed value): **minor** bump.
- Rename, removal, retyping, or making an optional field required: **breaking**. It needs approval from every consumer and an expand-then-contract path. Before v1.0.0 it bumps the minor number and is marked BREAKING here; from v1.0.0 it is a major bump.
- Tags are `contracts-vX.Y.Z`.
- CI enforces these rules with `node scripts/check-contract-rules.mjs` (story L-07, job `contract-rules`), reading `contracts/registry.json`: a change to a registered contract needs a new line in its own section below; a change to a schema or OpenAPI file also needs a change under its mock paths, or a line `no mock change: <reason>` in the new entry; a breaking change needs a line marked BREAKING and a raised version in the same section; a new folder under `contracts/` needs a registry entry.

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

### 0.1.3 (2026-10-10, Tanmay, story L-06)
- Additive: new schema `sidecar-start.schema.json` (the start document of the sidecar: `schema_version`, `instance_id`, `epoch`, `first_seq`, `event_key`, `flag_digests`), 2 valid and 24 invalid examples, one semantic rule in `contracts/mocks/stub-instance/semantic.mjs`, shared by `scripts/validate-contracts.mjs` and the stub (no repeated digest, one real digest per challenge key). Section 6 describes it; open point 35 is now a proposal with a shape (handoff H-59, for L-13 and L-20). Decided by Tanmay on 2026-10-10 as a proposal; Akshay and the orchestrator story confirm it.
- Additive note in section 7 and new open point 36: a Docker tmpfs volume is lost when its last container stops, so something must keep the four volumes mounted while the injector exits and the shop starts (found while building the L-06 harness).
- No change to the other three schemas, to IF-4, IF-5, IF-1 or IF-2.

## Lab API (IF-2), `contracts/api/lab/`

### 0.1.0 (2026-10-09, Tanmay, story L-05)
- First draft, a proposal for Akshay to confirm in the team chat (D-37): `lab.openapi.yaml` (OpenAPI 3.1, 18 operations under `/api/v1/`: instances request, get, open ticket, reset, stop; attempts get, start (pending OI-22), submit; flag submit; score; challenges; hints list and unlock; evidence; integrity flags with review decisions; per-candidate report; timeline) and `lab-api.md` (scope and ownership, shared enums, auth and cross-cutting rules, error placeholders, 30 open points).
- Instance states, access and health are identical to IF-5 (handoff H-78). Placeholder error codes `AUTH-*`, `ATT-*`, `INST-*`, `REQ-*` until the registry (IF-8, P-02) is merged.
- Examples: 38 valid and 82 invalid (each invalid one with its expected error path in `examples/invalid/manifest.json`). Mock: `contracts/mocks/fake-lab/server.mjs` (Node, no dependency, not Prism).
- Checked by `scripts/check_lab_contract.py` (last part of `pnpm run contracts:check`), `apps/api/tests/test_lab_contract.py` and `scripts/e2e/lab.e2e.test.mjs`.
- Platform-owned routes are not in this file; they are listed in handoff H-86. No change to IF-1, IF-4, IF-5 or IF-6.
- Status: awaiting optional confirmation by Akshay (consumer; handoffs H-84 to H-89).

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

## Table owners (DB), `contracts/db/`

### 0.1.0 (2026-10-10, Tanmay, story L-07)
- First draft, a proposal for Akshay to confirm (tasks P-05 and P-06): `table-owners.schema.json`, the shape of `contracts/db/table-owners.yaml` (a `tables` list of `table` and `owner`, the owner being a module folder of `apps/api/src/vulnmart/` named in CODEOWNERS). The YAML file itself is Akshay's and does not exist yet; `scripts/check_table_owners.py` reports NOT-APPLICABLE until it does, then checks shape, owner names and duplicate tables.
- The registry has no mock for this contract (`no mock change: nothing runs against it`).
