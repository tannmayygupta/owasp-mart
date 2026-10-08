# Instance contract v0 (IF-6, story L-02)

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta |
| Branch / commit | shared-L-02 (early pull request, base 48f5da2; pull request not yet opened) |
| Status | Built, reviewed (two thorough rounds) and tested; waiting for Sahil's approval as consumer and for CI on the pull request before it is done |
| Report tag | contracts, IF-6, sprint zero |

## Requirements covered
IF-6 (architecture 07 section 3.2, sprint-zero row 3); touches F1, F3, FR-INS-02, FR-INS-05, FR-FLG-03, FR-SHP-15, NFR-ISO-03, D-02. Traceability row LB-3.

## Summary (plain language, 3-5 lines)
There is now one written, versioned description of what an instance looks like: a Markdown contract with the 11 topics of architecture 07 section 3.2, three JSON Schemas (injection document, flags file, instance template) and examples. A script checks all of it, so "the contract validates" is one command. Every value the architecture does not fix is marked "to confirm" in one table for Sahil and Akshay.

## Why
The shop (Sahil), the stub shop and the orchestrator (Tanmay) each needed the same description instead of inventing their own (story L-02).

## What was built
- `contracts/instance/instance-contract.md`: 11 sections, injector exit codes with placeholder `INST-*` names, versioning rule, flag-in-env exception mechanism, and an "Open points (to confirm)" table with 33 rows.
- Three schemas (JSON Schema 2020-12). 5 valid examples, 115 invalid examples (one per rule, each with its exact expected error path in `examples/invalid/manifest.json`).
- `scripts/validate-contracts.mjs` and `scripts/validate-contracts.test.mjs`; `contracts/CHANGELOG.md`.
- Ajv 8.20.0 and ajv-formats 3.0.1 as exact dev dependencies; script `contracts:check`; CI `scripts` job installs dependencies first.

## How it works
The validator compiles each schema, checks that every example file maps to a schema and that every invalid example has a manifest entry (and the reverse), runs the valid examples through the schema and the semantic rules, and requires each invalid example to fail at its expected path. Semantic rules cover what a schema cannot compare: duplicate flags or decoys, decoy equal to a flag, unique names, volumes declared, injector and shop sharing one memory-backed `/run/vm` volume (injector writes, others read-only), shop and import service sharing `/run/import`, label cross-checks, flag-in-env name. It also scans for flags that are not obviously fake, private keys, and byte-order marks, and checks the contract text has sections 1 to 11 and the open-points table. Exit code 0, 1 (check failed) or 2 (usage).

## Files changed
- Removed `contracts/instance/.gitkeep` (the folder now has real files)
- `contracts/instance/` (contract, 3 schemas, `examples/`), `contracts/CHANGELOG.md` (new)
- `scripts/validate-contracts.mjs`, `scripts/validate-contracts.test.mjs` (new)
- `package.json`, `pnpm-lock.yaml` (Ajv, ajv-formats, script), `.github/workflows/ci.yml` (pnpm install in the `scripts` job), `README.md` (one line), `docs/adr/0012-monorepo-and-contract-toolchain.md` (dated note), `CHANGELOG.md`, `docs/traceability.md`

## Decisions made
Ajv 8.20.0 and ajv-formats 3.0.1 confirmed by Tanmay on 2026-10-08; noted in ADR 0012 (no new ADR). Placeholders used for the unmerged error registry and catalogue (story note). Ajv `strictRequired` is switched off in the validator because `required` inside `if/then/else` refers to properties of the parent schema; all other strict checks stay on.

## Tests
- `node scripts/validate-contracts.mjs`: exit 0, "checked 3 schemas, 5 valid and 115 invalid examples", "contracts: PASS".
- `pnpm run contracts:check`: same result.
- `node --test "scripts/*.test.mjs"`: 40 tests, 40 pass, 0 fail (the existing `dev` tests plus 21 new ones, 21 of 21 pass in `validate-contracts.test.mjs`: the real contract, CLI exit codes, removing `epoch` from the schema, a template without the shop role, non-shared `/run/vm` volume, non-memory-backed volume, wrong expected path, orphan and missing-manifest examples, malformed JSON, non-compiling schema, missing files, missing sections, real-looking flag and private key, byte-order mark).
- `pnpm install --frozen-lockfile`: exit 0. `pnpm audit`: "No known vulnerabilities found".
- `node scripts/verify-skills.mjs`: OK, 217 files match.
- End-to-end tests (`scripts/e2e/contracts.e2e.test.mjs`, written by the QA step): 7 of 7 pass. They copy the repository to a temporary folder without `node_modules`, run `pnpm install --frozen-lockfile` and `node --test "scripts/*.test.mjs"` exactly like the CI `scripts` job (40 unit tests really run), run `pnpm run contracts:check`, break a rule in a copy (remove `epoch`; different `/run/vm` volumes; a real-looking flag) and expect exit 1, check `--help` (0), an unknown argument (2) and a missing folder (1), and check sections 1 to 11 and the open-points table.
- Not run: the Docker end-to-end tests of L-01 (`scripts/e2e/dev.e2e.test.mjs`), no Docker dependency in this story. CI was not run (no pull request yet).

## Evidence
Saved in `docs/assets/l-02-instance-contract/`: `contracts-check`, `unit-tests`, `e2e-contracts`, `pnpm-audit`, `pnpm-install-frozen` (all 2026-10-08).

## Problems met and how they were fixed
- `pnpm add` at the repository root needs `-w` (workspace root).
- Ajv strict mode rejected `required` inside `if/then/else` (strictRequired); fixed with the option above.
- The first version of the QA test passed without running anything: a `node --test` started inside a `node --test` inherits `NODE_TEST_CONTEXT` and prints no summary. A check that at least 30 unit tests ran caught it, and the test now clears that variable.
- A PowerShell text rewrite corrupted a byte-order-mark character in the test file; the test now builds it with `String.fromCharCode(0xfeff)`.
- First run showed the shop's Docker healthcheck pointed at `/healthz`; changed to `/readyz` because the orchestrator reads Docker health as readiness (architecture 07 section 3.2, topic 3).

## Security notes (vulnerable parts only)
No vulnerable code. The contract only fixes the safe runtime profile. All example flags are one repeated letter and the seed starts with FAKE; no real flag, key or secret is in the contract or examples.

## Review round 1 (coordinator)
After review the validator gained: role-based mount rules (only injector and shop mount /run/vm, only shop and import service mount /run/import), required-mount examples, unmounted volumes, label consistency, memory-backed sizes within memory_mb, healthcheck port, timeout, path and kind rules, repeated flag and decoy values, decoy without a flag, scanning of schemas and manifest, ignoring .DS_Store, Thumbs.db and .gitkeep. Schemas now use const 0.1 for schema_version and vm.schema. The example injector is now on the instance network (matches architecture 02; none is proposed in open point 29) and its /data tmpfs is 64 MB so it fits its 128 MB limit. Re-run results: validator PASS (3 schemas, 5 valid, 115 invalid); script tests 40 of 40 pass (validate-contracts tests 21 of 21).

## Limitations and follow-ups
- Open: how the placement files for the import service and mock-services reach those containers (only the shop and injector share `/run/vm` in v0), and how the patched snapshot gets from `/run/vm` into the shop's `/data` (proposal: the shop copies it). Listed in the open-points table, rows 15 and 16.
- Sahil must approve before merge; Akshay should check the instance id and owner-hash shapes.
- Markdown and schemas are tied only by section-heading checks; a deeper check is for L-07. Stub-shop conformance is L-06. Real limits come from spikes S-4 and S-5.
