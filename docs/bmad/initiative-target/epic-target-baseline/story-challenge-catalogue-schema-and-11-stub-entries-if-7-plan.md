---
title: 'Challenge catalogue schema and 11 stub entries (IF-7)'
type: 'feature'
ticket: '2'
created: '2026-10-09'
status: built
baseline_revision: 'd139072'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
  - '{project-root}/docs/design/challenge-specs.md'
  - '{project-root}/contracts/instance/instance-contract.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** IF-7, the challenge catalogue contract, does not exist yet. The platform dashboards and API (P) and the lab's scoring and injector (L) need a schema and 11 committed entries so they can render and score challenges before the real challenge content exists (architecture 07 sections 3.1/7.7, deliverable "eleven stub entries"). T-02 is an EARLY PR because P-04 (Akshay) waits on it.

**Approach:** Add a JSON Schema at `contracts/catalog/challenge.schema.json` (draft 2020-12, matching the instance contract) and 11 YAML stub entries at `challenges/catalog/c01..c11.yaml`, each carrying the OWASP 2021/2025 tags, CWE and ATT&CK ids, difficulty and tier, placeholder milestone (M1/M2/M3) and three hint slots, and the instance-dependent fields (flag placement/delivery, start-state, exploit-test and fixed-build paths). Add a validator and a test so CI proves all 11 validate. Full briefs, write-ups, decoy locations and re-checked ids are T-30.

## Boundaries & Constraints

**Always:** Schema is JSON Schema draft 2020-12 validated with Ajv2020 (as `scripts/validate-contracts.mjs` does). Tier follows D-32's mapping of difficulty 1-5: 1-2 Easy, 3 Medium, 4-5 Hard (the validator enforces it). Tags come from `docs/design/challenge-specs.md` section 2. Every stub carries `status: stub`. No real flag value anywhere (reuse the `VM{...}` guard). Stay in `contracts/catalog/`, `challenges/catalog/`, and shared tooling I co-own (`scripts/`, root `package.json`, `contracts/CHANGELOG.md`).

**Never:** Do not write briefs, write-ups, decoy flag locations, or re-verified ATT&CK/CWE evidence — those are T-30. Do not invent milestone detection signals beyond the placeholders the specs already give. Do not edit another stream's folders. Do not set a real flag, seed, or secret.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid stub | a well-formed `cNN.yaml` | validates against the schema | n/a |
| Tier mismatch | difficulty 4 tagged tier `Easy` | validator fails with a clear message | semantic check, not schema |
| Wrong key/filename | `key: c05` in `c06.yaml` | validator fails (key must match filename) | cross-file check |
| Missing challenge | only 10 files present | validator fails (expects exactly 11, c01..c11) | cross-file check |
| Flag-like string | a `VM{...}` value in any stub | validator fails (no real flags in the catalogue) | guard check |

</frozen-after-approval>

## Code Map

- `contracts/catalog/challenge.schema.json` -- new; the IF-7 schema (one challenge entry). My lane (CODEOWNERS `/contracts/catalog/`).
- `challenges/catalog/c01.yaml` … `c11.yaml` -- new; 11 stub entries. My lane (`/challenges/`).
- `contracts/catalog/README.md` -- new; one short note: what the catalogue is, that entries are stubs, and where full content lands (T-30).
- `scripts/validate-catalog.mjs` -- new; loads the schema and every `challenges/catalog/*.yaml`, validates each and runs the cross-file checks. Mirrors `scripts/validate-contracts.mjs`. Shared `scripts/` (co-owned).
- `scripts/validate-catalog.test.mjs` -- new; node:test asserting all 11 stubs valid, the tier/key/count/flag checks fail as intended. Picked up by the existing CI `scripts` job (`node --test "scripts/*.test.mjs"`).
- `package.json` (root) -- add `js-yaml` 4.1.0 (dev) for the validator and a `catalog:check` script. Co-owned.
- `contracts/CHANGELOG.md` -- add the IF-7 v0 entry (contract versioning rule).
- `docs/design/challenge-specs.md` -- READ ONLY; per-challenge difficulty, tags, milestone signals.
- `contracts/instance/instance-contract.md` -- READ ONLY; `flag_placement`, `flag_delivery`, `start_state`, exploit-test and fixed-build fields the instance depends on (section 3.2 item 11, section 5).

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/catalog/challenge.schema.json` -- define the entry schema: `schema_version`, `key`, `title`, `status`, `owasp.{2021,2025}`, `cwe.{primary,related}`, `attack[]`, `difficulty`, `tier`, `flag.{placement,delivery}`, `start_state`, `milestones.{m1,m2,m3}` (placeholder text nullable), `hints[3]` (text nullable), `exploit_test`, `fixed_build`; `additionalProperties:false` -- the IF-7 contract.
- [ ] `challenges/catalog/c01.yaml`..`c11.yaml` -- one stub per challenge with the real tags/difficulty/tier from the specs and placeholder milestones/hints -- the committed stub data.
- [ ] `contracts/catalog/README.md` + `contracts/CHANGELOG.md` -- document IF-7 v0 and version it.
- [ ] `scripts/validate-catalog.mjs` + `scripts/validate-catalog.test.mjs` -- validator and tests (schema + cross-file checks) -- proves the 11 stubs validate in CI.
- [ ] `package.json` -- add pinned `js-yaml` dev dep and a `catalog:check` script.

**Acceptance Criteria:**
- Given the 11 stubs, when `node scripts/validate-catalog.mjs` runs, then all pass and the exit code is 0.
- Given a deliberately broken stub (tier mismatch, wrong key, 12th file, flag-like string), when validated, then the validator fails with a specific message.
- Given the CI `scripts` job, when it runs `node --test "scripts/*.test.mjs"`, then the catalogue tests run and pass.
- Given any stub, when inspected, then it contains no real flag, seed, or secret, and its OWASP 2021/2025 tags match `docs/design/challenge-specs.md`.

## Implementation Notes

- 2026-10-09: Added `contracts/catalog/challenge.schema.json` (JSON Schema 2020-12) and a `contracts/catalog/README.md`. 11 stubs `challenges/catalog/c01..c11.yaml` generated from a data table built off `docs/design/challenge-specs.md` (tags, difficulty, milestone summaries); milestone signals and hint text are null placeholders, flag placement/delivery provisional, `status: stub`.
- Validator `scripts/validate-catalog.mjs` (schema + semantic checks: tier↔difficulty, key↔filename, exactly 11 entries, no `VM{...}` flag) and tests `scripts/validate-catalog.test.mjs` (7). Added `js-yaml` 4.1.0 (dev) and a `catalog:check` script to the root package.json. IF-7 v0.1.0 recorded in `contracts/CHANGELOG.md`.
- Results: `node scripts/validate-catalog.mjs` OK (11/11); `node --test "scripts/*.test.mjs"` 47 passed, 0 failed (40 existing + 7 catalogue); catalogue file alone 7/7; `pnpm install --frozen-lockfile` consistent.
- The CI `scripts` job runs `node --test "scripts/*.test.mjs"`, so the catalogue tests run on every PR without a new CI job (unlike T-01's app tests).

## Plan Change Log

- 2026-10-09 (review loop): applied 9 patches from the code review and deferred 1 (placement↔delivery coupling, to the challenge stories). Schema gained the tier↔difficulty mapping, ordered hint levels, `attack` minItems, and an optional `flag.reason`; the validator gained the env-reason rule, key-matched path checks, richer error messages, and IO/arg guards; tests grew to 13. After the fixes: validator 11/11 OK, script suite 53 passed, frozen install consistent.

## Review Triage Log

## Code Review

### 2026-10-09 — 9 patch, 1 defer, 2 rejected

- [x] [Review][Patch] Added optional `flag.reason`; the validator requires it when `delivery` is `env` (FR-FLG-03). Kept in the validator, not the schema, to avoid Ajv strict-mode friction with conditional `required`.
- [x] [Review][Patch] Validator now checks `exploit_test`/`fixed_build` end with the entry's own key.
- [x] [Review][Patch] `hints` pinned to levels 1,2,3 in order via `prefixItems` + `items:false`.
- [x] [Review][Patch] Validator error messages now include the offending property (`e.params`) via `formatAjvError`.
- [x] [Review][Patch] Added tests for `main()` CLI (`--help`/unknown→2/missing value→2/valid run), `owasp.2021:null`, malformed OWASP tag, env-reason, wrong-key path, hints order.
- [x] [Review][Patch] `attack` now has `minItems:1`.
- [x] [Review][Patch] Validator guards schema load, directory read, file read, and missing arg values (clean errors / exit 2).
- [x] [Review][Patch] Added the `catalog:check` row to root `README.md`.
- [x] [Review][Patch] tier↔difficulty (D-32) encoded in the schema via `allOf`/`if`-`then`, so a consumer validating against IF-7 alone gets it (the validator's semantic check stays as a clearer-message backstop).
- [x] [Review][Defer] No `flag.placement`↔`flag.delivery` consistency rule [contracts/catalog/challenge.schema.json] — deferred: placements are provisional stubs and the `env` delivery has no placement mapping; the real coupling is confirmed per challenge in T-19..T-29.

Rejected:
- `FLAG_LIKE` hardcodes `VM{24 Base32}` (blind-hunter): low — it matches the instance contract's canonical flag format and there is no shared module to import; refactor is out of scope.
- No `.gitattributes` line-ending control (blind-hunter): false — `.gitattributes` already sets `* text=auto` and `*.mjs eol=lf`, so the CRLF warning is working-copy only and the flag regex is not line-ending sensitive.

## Design Notes

YAML over JSON for the data: architecture 07 names `challenges/catalog/*.yaml`, and challenge stubs are hand-authored, so YAML (comments, readability) fits; `js-yaml` parses them for Ajv. The schema itself stays JSON, like the instance contract. Tags are copied from `docs/design/challenge-specs.md`, which already records each id's verification status; re-checking ids against the official OWASP/CWE/ATT&CK pages is explicitly T-30, so stubs carry the specs' values and `status: stub`.

Tier is derived, not free: the validator recomputes tier from `difficulty` (1-2 Easy, 3 Medium, 4-5 Hard, D-32) and rejects a mismatch, so the catalogue cannot drift from the scoring rule.

## Verification

**Commands:**
- `corepack pnpm install` -- expected: adds `js-yaml`, updates the lockfile.
- `node scripts/validate-catalog.mjs` -- expected: `OK` and exit 0 for all 11 stubs.
- `node --test "scripts/*.test.mjs"` -- expected: catalogue tests pass alongside the existing ones.
- `corepack pnpm install --frozen-lockfile` -- expected: lockfile consistent (CI uses this).
