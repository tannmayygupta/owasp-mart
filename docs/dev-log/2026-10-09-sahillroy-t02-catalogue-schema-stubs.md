# Challenge catalogue schema and 11 stub entries (T-02, IF-7)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | Sahil Roy |
| Branch / commit | shared-T-02 (EARLY PR) |
| Status | Done |
| Report tag | Target stream, Sprint 1, IF-7 contract deliverable |

## Requirements covered
TB-1 (challenge catalogue schema IF-7 and 11 stub entries exist and validate in CI). BMAD story 1.2 of `epic-target-baseline`. Contract IF-7 (architecture 07 sections 3.1 and 7.7). Related: FR-CHL-17 (tiers, D-32), FR-DET-05 (milestones, D-32).

## Summary (plain language, 3-5 lines)
Created the challenge catalogue contract (IF-7): a JSON Schema and 11 YAML stub entries, one per challenge C01 to C11. Each stub carries the OWASP 2021/2025 tags, CWE and ATT&CK ids, difficulty and tier, placeholder milestone summaries and three empty hint slots, and provisional flag placement and delivery. A validator and tests prove all 11 validate in CI. This lets the platform and lab render and score challenges before the real content exists; full content comes in T-30 and the per-challenge stories.

## Why
IF-7 is the contract the platform (dashboards, API) and the lab (scoring, injector) consume. Sprint zero requires the schema and 11 stub entries so those streams are not blocked. T-02 is an EARLY PR because Akshay's P-04 waits on it.

## What was built
- `contracts/catalog/challenge.schema.json` — the IF-7 entry schema (JSON Schema draft 2020-12). Encodes the tier↔difficulty mapping (D-32), ordered hint levels, and tag/id formats.
- `challenges/catalog/c01..c11.yaml` — 11 stubs, `status: stub`, tags from `docs/design/challenge-specs.md`.
- `scripts/validate-catalog.mjs` + `scripts/validate-catalog.test.mjs` — validator (schema plus semantic rules) and 13 tests.
- `contracts/catalog/README.md`, the IF-7 v0.1.0 entry in `contracts/CHANGELOG.md`, a `catalog:check` npm script, and `js-yaml` 4.1.0 as a pinned dev dependency.

## How it works
Each `cNN.yaml` is one challenge entry. `scripts/validate-catalog.mjs` loads the schema, validates every YAML entry with Ajv2020, and then applies the rules a per-entry schema cannot express: exactly 11 entries c01..c11, key matches filename, the exploit-test and fixed-build paths end with the entry's key, a flag delivered by `env` carries a written reason (FR-FLG-03), and no real flag value (`VM{...}`) appears. The CI `scripts` job already runs `node --test "scripts/*.test.mjs"`, so the catalogue tests run on every pull request with no new CI job.

## Files changed
- `contracts/catalog/challenge.schema.json`, `contracts/catalog/README.md` — new.
- `challenges/catalog/c01.yaml` … `c11.yaml` — new (11 stubs).
- `scripts/validate-catalog.mjs`, `scripts/validate-catalog.test.mjs` — new.
- `contracts/CHANGELOG.md` — IF-7 v0.1.0 entry.
- `package.json` — `catalog:check` script, `js-yaml` 4.1.0 dev dep; `pnpm-lock.yaml` updated.
- `README.md` — `catalog:check` row in the dev-commands table.

## Decisions made
No ADR. YAML for the data (architecture names `challenges/catalog/*.yaml`); the schema stays JSON like the instance contract. Tier is derived from difficulty (D-32: 1-2 Easy, 3 Medium, 4-5 Hard) and enforced both in the schema and the validator. The `flag.delivery: env` reason rule is enforced in the validator (not the schema) to avoid Ajv strict-mode friction with conditional `required`.

## Tests
Real commands and results:
- `node scripts/validate-catalog.mjs` → `OK: all 11 catalogue stubs validate` (exit 0).
- `node --test scripts/validate-catalog.test.mjs` → 13 passed, 0 failed.
- `node --test "scripts/*.test.mjs"` (the CI command) → 53 passed, 0 failed (40 existing + 13 catalogue).
- `corepack pnpm install --frozen-lockfile` → lockfile consistent.
Traceability row TB-1 updated in `docs/traceability.md`.

## Evidence
Captured outputs in the dev-log Tests section above. No screenshots needed (schema/data/CLI change, no UI).

## Problems met and how they were fixed
Ajv strict mode rejected two first attempts: numeric keywords (`maximum`/`minimum`) in the tier `if` clauses needed an explicit `type: integer`, and the `prefixItems` hint subschemas needed `type: object` beside `$ref`. A conditional `required: [reason]` tripped `strictRequired`, so the env-reason rule moved from the schema to the validator. All resolved; strict mode kept on.

## Security notes (vulnerable parts only)
None yet — these are stubs. The validator guards against a real flag value appearing in the catalogue (the `VM{...}` check), and `env` flag delivery requires a documented reason (FR-FLG-03). Real flag placement per challenge is confirmed in T-19..T-29.

## Limitations and follow-ups
- Stubs only: briefs, write-ups, decoy locations, filled hints and the official-site re-check of every id are T-30.
- Milestone signals are null placeholders; each challenge's real M1/M2 signals come with its own story.
- No `flag.placement`↔`flag.delivery` consistency rule yet (deferred; see `docs/bmad/initiative-target/deferred-work.md`), because placements are provisional and `env` delivery has no placement mapping.
