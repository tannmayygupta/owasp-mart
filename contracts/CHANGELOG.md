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

## Orchestrator API (IF-5), `contracts/orchestrator/`

### 0.1.0 (2026-10-09, Tanmay, story L-04)
- First draft, a proposal for Akshay to confirm in the team chat (D-37): `orchestrator.openapi.yaml` (OpenAPI 3.1: the seven calls and the signed state report `POST /internal/v1/orch/state`), `orchestrator-api.md` (state machine, signing and replay rules, idempotence, errors, limits, 30 open points).
- Examples: 15 valid and 33 invalid (each invalid one with its expected error path in `examples/invalid/manifest.json`) and a fixed signing vector.
- Placeholder error codes `ORCH-*` and `INST-*` until the registry (IF-8, P-02) is merged.
- Python side: `InstanceHost` protocol, `FakeInstanceHost` and `HttpInstanceHost` in `apps/api/src/vulnmart/ports/` (IF-9). Mock: `contracts/mocks/fake-orchestrator/server.mjs`.
- Checked by `scripts/check_orchestrator_contract.py` (second half of `pnpm run contracts:check`) and by `apps/api/tests`.
- Review fixes (still 0.1.0, nothing was confirmed yet): added `ORCH-METHOD-NOT-ALLOWED` (405 with `Allow`) and `Retry-After` on 429; create of a destroyed id is 409 `ORCH-INSTANCE-EXISTS` and an old-epoch create is 409 `ORCH-STALE-EPOCH`; an oversize body is refused (413, connection dropped) before the signature check; a repeated query parameter and a `limit` that is not a plain number are 422 `ORCH-VALIDATION`; open points 24 to 30 added (reset capacity for L-13, nonce memory per process, nested forbidden names, and others).
- Status: awaiting optional confirmation by Akshay (consumer).