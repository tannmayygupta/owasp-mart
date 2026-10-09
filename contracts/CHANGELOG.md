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

## Challenge catalogue (IF-7), `contracts/catalog/` and `challenges/catalog/`

### 0.1.0 (2026-10-09, Sahil, story T-02)
- First draft: `contracts/catalog/challenge.schema.json` (JSON Schema 2020-12, one challenge entry) and a short `contracts/catalog/README.md`.
- 11 stub entries `challenges/catalog/c01..c11.yaml` (`status: stub`): OWASP 2021/2025 tags, CWE and ATT&CK ids, difficulty and tier, placeholder milestone summaries and three empty hint slots, provisional flag placement/delivery, start-state, exploit-test and fixed-build paths.
- Validator `scripts/validate-catalog.mjs` (`pnpm run catalog:check`) and tests `scripts/validate-catalog.test.mjs`: schema plus semantic rules (tier matches difficulty per D-32, key matches filename, exactly 11 entries, no real flag value). `js-yaml` 4.1.0 added as a pinned dev dependency.
- Full content (briefs, write-ups, decoys, filled hints, official-site id re-check) is T-30; each challenge's real milestone signals and confirmed flag placement come with its own story.
