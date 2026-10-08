---
title: 'Instance contract v0 (IF-6)'
type: 'feature'
ticket: '2'
created: '2026-10-08'
status: 'built'
baseline_revision: '48f5da2d402c038868ee9556cd0dfebeb5a8928d'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 1
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The shop (Sahil, stream T), the stub shop and the orchestrator (Tanmay, stream L) each need one written, versioned description of what a VulnMart instance looks like. None exists, so each side would invent its own.

**Approach:** Write the instance contract v0 in `contracts/instance/` following architecture 07 section 3.2: a Markdown contract plus JSON Schemas for the machine-checkable parts (injection document, flags file, instance template), with valid and invalid examples. Add a validation script and tests so "the contract validates" is a command.

## Boundaries & Constraints

**Always:** Version the contract 0.x and keep a `contracts/CHANGELOG.md` entry. Mark every value the architecture does not fix as "to confirm" and list them in one table for Sahil and Akshay. Use obviously fake flags and keys in examples. No key and no flag in environment variables (except `flag_delivery: env`, which needs a written reason). Node and Ajv only; works on Windows, macOS and Linux.

**Never:** The event body and event names (IF-4, L-03). The orchestrator API (L-04). The catalogue schema (T-02) or error registry (P-02): refer to their fields and `INST-*`, `ORCH-*`, `EVT-*` code families by name only. The stub shop (L-06) and the CI job for contract checks (L-07). Injector or orchestrator code. Real image names.

**Decisions (Tanmay, 2026-10-08):** placeholders are used for the unmerged error registry and catalogue stubs (story note). Sahil approves the contract as consumer before merge. The JSON Schema validator is Ajv 8.20.0 with ajv-formats 3.0.1, pinned exactly, as repository dev dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid injection document | Example with schema version, epoch, flags, decoys, seed | Validates | No error expected |
| Bad flag format | Flag not matching `VM{` plus 24 Base32 characters `}` | Rejected | Validator names the path |
| Missing epoch | Document without `epoch` | Rejected | Validator names the path |
| Unsafe instance template | `privileged: true`, a host mount, or no `cap_drop: ALL` | Rejected | Validator names the path |
| Secret in environment | Env key `VM_FLAG_*` or `*_KEY` in the shop | Rejected | Validator names the path |
| Bad label | `vm.owner` that looks like an email | Rejected | Validator names the path |
| Valid template | Example shop template | Validates | No error expected |

</frozen-after-approval>

## Code Map

- `contracts/instance/` -- empty (`.gitkeep`); new files go here.
- `docs/architecture/07-repo-and-workstreams.md` section 3.2 -- the 11 numbered topics to write up; section 3.6 error families.
- `docs/architecture/04-data-and-state.md` sections 11.1 and 11.3 -- flag format `VM{` plus Base32 (24 characters) `}`; decoy label; digests go to the sidecar, not the injector.
- `docs/design/challenge-specs.md` sections 8.1, 8.2 (flag placement, accounts), 10 (events) -- placement kinds: database seed, catalogue store, sentinel table, file in import service, file in mock-services.
- `package.json`, `pnpm-lock.yaml` -- add Ajv; `scripts/dev.mjs` and `scripts/*.test.mjs` -- style to follow; `contracts/CHANGELOG.md` does not exist yet.
- Do not change `contracts/catalog`, `contracts/errors`, `contracts/events`. `.github/workflows/ci.yml` changes only as the Execution list says (the existing `scripts` job must stay green; the contract-check job is L-07).
- `.github/CODEOWNERS` line 11 already makes Sahil an owner of `/contracts/instance/`.
- `docs/adr/0012-monorepo-and-contract-toolchain.md` -- records the proposed tools; add a dated note that Ajv is confirmed.

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/instance/instance-contract.md` -- the contract: the 11 topics of section 3.2, injector exit codes mapped to placeholder `INST-*` names, port and user-id proposals, `issued_at` and the seed rules, the flag-in-env exception mechanism, and an "Open points (to confirm)" table that lists EVERY invented value (limits, lengths, ports, paths, volume names, marker path, flag length)
- [ ] `contracts/instance/injection-document.schema.json`, `flags-file.schema.json`, `instance-template.schema.json` -- JSON Schema 2020-12 with the rules in Design Notes
- [ ] `contracts/instance/examples/` -- valid: full six-role template, a template using `flag_delivery_env`, injection document, flags file. Invalid: one example per rule of every schema (list in Design Notes), each with an exact expected error path
- [ ] `contracts/CHANGELOG.md` -- entry 0.1.0 for IF-6 and the versioning rule (additive = minor, rename or removal = breaking, tag v1.0.0 in L-09)
- [ ] `scripts/validate-contracts.mjs`, `scripts/validate-contracts.test.mjs` -- see Design Notes (checks, semantic checks, orphan and malformed-file handling, `import.meta.main`)
- [ ] `package.json`, `pnpm-lock.yaml` -- Ajv and ajv-formats at exact versions, script `contracts:check`; no byte-order mark in any file
- [ ] `.github/workflows/ci.yml` -- add `pnpm/action-setup` and `pnpm install --frozen-lockfile` to the existing `scripts` job only, because the new tests import Ajv
- [ ] `docs/adr/0012-monorepo-and-contract-toolchain.md` -- one dated line: Ajv 8.20.0 and ajv-formats 3.0.1 confirmed by Tanmay on 2026-10-08; record the real `pnpm audit` result in the dev-log
- [ ] `README.md` -- one line for `pnpm run contracts:check`

**Acceptance Criteria:**
- Given the repository, when `node scripts/validate-contracts.mjs` runs, then every schema is valid, every example file maps to a schema, every valid example passes, every invalid example fails at its expected path, the semantic checks pass, and the exit code is 0.
- Given the contract, when Sahil reads it, then each of the 11 topics of section 3.2 has a section, and every invented value is listed in the open-points table.
- Given a change that removes `epoch` from the injection schema, or a template without the shop role, when the script runs, then it exits non-zero.
- Given a template whose injector and shop do not share one memory-backed `/run/vm` volume, when checked, then it is rejected.
- Given the contract and examples, when searched, then they hold no real flag, key or secret, and every flag-like example value is obviously fake.
- Given a fresh checkout, when CI's `scripts` job runs after the install step, then the tests run (no missing module).

## Implementation Notes

## Plan Change Log

- Pass 1 (2026-10-08). Triggers: the first build let the shop and injector each have their own `/run/vm` memory mount, so the injector's files and "ready" marker could never reach the shop (BH1); the shop did not mount the import socket volume (BH2); the valid template lacked four of the six roles and no schema rule required them (BH3, EH, VG); the Ajv-importing tests would break the existing CI `scripts` job (VG1). Amended: Code Map, Execution, Acceptance Criteria and Design Notes (frozen block untouched). Known-bad state avoided: a contract whose own example cannot work. KEEP: the three-schema split and file names, `examples/valid` and `examples/invalid` layout, the test style that copies the directory and mutates it, the 11-section contract structure, placeholder `{image:...}` and `{instance_id}` tokens, fake flags made of one repeated letter, the open-points table idea, the `contracts:check` script name.

## Review Triage Log

Pass 1 (thorough: blind-hunter BH, edge-case-hunter EH, verification-gap VG, intent-alignment IA). Verdicts after checking each claim against the files.

| Finding | Verdict | Route | Evidence / action |
|---|---|---|---|
| BH1: shop and injector have separate `/run/vm` tmpfs, nothing is shared | high | bad_plan | Real: example template, both components list their own tmpfs. Needs shared memory-backed named volumes (new template field), so a plan amendment. |
| BH2, EH(volume): import socket volume mounted on one side only; volume not memory-backed; anonymous volume allowed | medium | bad_plan | Real. Same root as BH1: volume model. |
| BH3, EH(roles), VG, IA: valid template has 3 of 6 roles; nothing requires roles, unique names, `network_mode`, healthcheck, ports | medium | bad_plan | Real. Full six-role example and role rules. |
| BH4, EH1, EH2: user check passes `00:0` and `65532:0` | medium | patch (in re-derivation) | Real. Pattern `^[1-9][0-9]*:[1-9][0-9]*$`. |
| BH5, EH6, EH(claim): env allowlist not enforced; values unchecked | medium | patch | Real. Allowlist from contract section 2, value must not look like a flag. |
| BH6, EH7: `flag_delivery_env` has no mechanism, example or tight rules | medium | patch | Real. Document mechanism, add valid example and invalid examples. |
| BH7: runtime profile lacks process limit | medium | patch | `pids_limit` required (architecture 06 names process limits). Seccomp, restart and host pid or ipc fields: low, deferred. |
| BH8: `mounts` and `tmpfs` overlap | low | patch | Single `mounts` list, no `tmpfs` array (part of the volume model). |
| BH9, EH(injection): duplicate keys, decoy equals flag, duplicate decoy index | medium | patch | Real; schema cannot express it, so semantic checks in the script. |
| BH10, EH: `issued_at` in schema but not in text | low | patch | Document it as optional with the replay note. |
| BH11: seed is a secret but treated as plain | medium | patch | Seed length and secrecy rules; never in env or logs. |
| BH12, VG2: invalid-example coverage thin | medium | patch | One invalid example per rule. |
| BH13, VG, IA: weak test assertions | medium | patch | Exact expected path per example, flags-file examples asserted, fake-flag scan over all examples. |
| BH14, EH: validator gaps (orphans, malformed JSON, compile cause, `--help`, entry guard) | medium | patch | Real. `import.meta.main`, orphan check, malformed-file handling. |
| BH15: no ADR note, no audit record, counts, `$id`, versioning rule | low | patch | Documentation steps added. Sahil approval "only prose": false, CODEOWNERS line 11 exists. |
| EH(path): mount target `/data/../etc` | medium | patch | Exact allowed paths only. |
| EH(duplicates), EH(labels): duplicate mounts; `vm.component` and `vm.template` not cross-checked; label placeholders unchecked | low | patch | Semantic checks in the script. |
| EH(limits): no maximum on limits | low | defer | Real numbers come from spikes S-4 and S-5. |
| EH(claim): invented values missing from open-points table | medium | patch | Table must list every invented value. |
| VG1: existing CI `scripts` job has no install, so tests importing Ajv fail | high | patch | Real; CI step added. |
| VG(deferred): shared `$defs` between schemas | low | defer | Revisit when contracts share more. |
| VG(deferred): Markdown and schemas tied by a check | low | defer | Needs a parser; revisit in L-07. |
| IA: validation checks only own examples, not a real consumer | info | defer | Stub-shop conformance is L-06. |

Counts: 1 high bad_plan group, 2 medium bad_plan, 12 patch, 4 deferred.

Pass 2 (same four lenses on the re-derived code; the 82 invalid example files were left out of the reviewers' diff and are covered by the manifest). No bad_plan or intent_gap this time.

| Finding | Verdict | Route | Evidence / action |
|---|---|---|---|
| EH, VG2: only the shop may mount `/run/vm` and only shop and import-service `/run/import`, but the validator checks other roles only partly | medium | patch | Real; extend the checks to every role, add examples. |
| EH, contract text says injector has no network, schema allows `instance` (architecture 02 puts the injector on the instance network) | medium | patch | Text and schema disagree. Make the text match the schema and architecture, and add an open-point row proposing `none`. |
| VG1: no invalid example for missing `/tmp` (injector, shop, import-service) or shop missing `/run/import` | medium | patch | Real; four examples. |
| EH: flag values may collide across challenge keys, duplicate decoy values, decoy key absent from flags | medium | patch | Semantic checks. |
| EH, BH: `vm.schema` not equal to `schema_version`; `vm.expires` pattern accepts nonsense; `schema_version` accepts any 0.x | medium | patch | `const "0.1"` and an ISO timestamp pattern. |
| EH: declared volume never mounted; instance-wide labels may differ between components | low | patch | Semantic checks. |
| BH, EH: memory-backed sizes may exceed `memory_mb`; healthcheck port not in ports, timeout above interval, `..` in path; kind not tied to role | medium | patch | Semantic and schema checks. |
| BH: invalid-example gaps (more than 11 flags, empty flags, seed length or characters, negative decoy index, cpu 0, memory below 16, port range, duplicate port, unknown healthcheck kind, tmpfs `read_only`, extra property, `vm.kind: front`, duplicate role) | medium | patch | One example per listed gap. |
| BH, VG: dead `void shopRun`; six-role check only for files named `shop-template`; duplicate roles hidden by `byRole` | low | patch | Remove dead code, check every template example. |
| BH, VG: overstated test name; alternation regex for the epoch test | low | patch | Rename or delete, exact path. |
| EH: `scanSecrets` skips schemas and manifest; `.DS_Store` and `Thumbs.db` cause orphan failures (Akshay uses a Mac) | low | patch | Scan more files, ignore OS metadata files. |
| BH: no evidence files; traceability row incomplete; ADR 0012 has no alternatives; contract silent on restart and data loss, networks' labels, start order, `issued_at` use, stdin limits | medium | patch | Evidence files, row IDs and link, ADR alternatives with registry versions, and open-point rows for each prose gap (OI-23). |
| BH: root CHANGELOG heading style | false | rejected | The file already uses variant headings. |
| BH: CI installs scripts; `pnpm/action-setup` has no version | false | rejected | pnpm ignores dependency install scripts by default and the version comes from `packageManager`. |
| BH, EH: no maximum on limits, sizes, decoys; `import-service` may declare ports; injector may declare a healthcheck; restart policy, ulimit, seccomp, log driver, network objects | low | defer | Numbers wait for spikes S-4 and S-5; the rest are later design. |
| EH: symlinked or unreadable example file crashes the validator; flags file not cross-checked with the injection document | low | defer | Unlikely in daily use; separate documents. |
| BH, EH: an invalid example may fail for an extra unrelated reason too | low | defer | Needs the manifest to list every path; not worth the complexity now. |
| IA, BH: rules live in the validator, prose tied to schemas only by headings, `contracts:check` not in CI | info | defer | L-07 builds the CI contract check; L-06 the stub-shop conformance. |
| EH: BOM test covers only some files | low | rejected | The validator scans the contract directory; other files were scanned by hand. |

## Design Notes

Template rules for the re-derivation:
- Top-level `volumes`: list of `{name, memory_backed: true, size_mb}`. Mounts of type `volume` need a `source` that exists in `volumes`; every volume must be memory-backed. `/run/vm` is one volume shared by injector (read-write) and shop (read-only), `/run/import` is one volume shared by shop and import-service. `/data` and `/tmp` are per-component tmpfs mounts. No `tmpfs` array.
- Mount targets exactly `/tmp`, `/data`, `/run/vm`, `/run/import`, unique per component.
- Required roles, each once with a unique name: shop, sidecar, injector, import-service, mock-services, bot-controller. `network_mode` required (`instance` or `none`); import-service must be `none`. `healthcheck` required except for the injector; `ports` required for shop, sidecar, mock-services, bot-controller. `pids_limit` required. `vm.component` equals `name`, `vm.template` equals `template_id`.
- `user` `^[1-9][0-9]*:[1-9][0-9]*$`. Env names from the contract section 2 allowlist only; values at most 512 characters and not matching `VM\{`.
- `flag_delivery_env`: `env_name` equals `VM_FLAG_` plus `challenge_key`, `reason` non-blank and at least 20 characters; the orchestrator sets the value from the injection document at container create (visible to `docker inspect`, accepted and written down).
- Injection `seed`: at least 32 characters, random, a secret like the flags.
- Invalid examples, one per rule: root user, `65532:0`, `egress: true`, `read_only: false`, `no_new_privileges: false`, `privileged`, bind mount, traversal target, anonymous volume, non-memory-backed volume, missing shop role, duplicate role, missing network_mode, import-service on instance network, missing healthcheck, missing limits, unlisted env name, each secret suffix, flag in env value, bad owner label, bad flag_delivery_env, bad flag format, missing epoch, bad schema_version, bad instance_id, short seed, non-numeric epoch, bad issued_at, duplicate challenge_key, decoy equal to flag, duplicate decoy index.

Proposals to put in the open-points table: instance id `i-` plus 16 Base32 characters; user `65532:65532`; mock ports 9101 payment, 9102 KYC, 9103 metadata, 9104 collector, bot 9200; injector exit codes 0 ok, 10 bad document, 11 snapshot patch failed, 12 placement write failed, 13 marker write failed; healthcheck as in the hello container (interval 2 s, 15 retries) until spike S-4; import service has no network and uses a unix socket (T to confirm); decoy placement field `decoy_placement` (T to define).

## Verification

**Commands:**
- `node scripts/validate-contracts.mjs` -- expected: exit 0, lists every schema and example
- `node --test "scripts/*.test.mjs"` -- expected: all pass
- `pnpm install --frozen-lockfile` -- expected: exit 0

**Manual checks (if no CLI):**
- Sahil reviews the pull request and approves.
