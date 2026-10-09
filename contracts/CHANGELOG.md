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
- Status: awaiting approval by Sahil (consumer) before merge.

### 0.1.1 (2026-10-09, Tanmay, story L-03)
- Section 6 and open point 22 now point at IF-4 and name the event path `/v1/events` (changed in substance, not only editorial: the path and the event body are now fixed by IF-4). Approval of this change is waived under D-37.

## Instance events (IF-4), `contracts/events/`

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
