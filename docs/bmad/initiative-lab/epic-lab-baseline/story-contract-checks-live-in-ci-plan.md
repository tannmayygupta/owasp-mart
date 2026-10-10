---
title: 'Contract checks live in CI'
type: 'feature'
ticket: '6'
created: '2026-10-10'
status: 'in-progress'
baseline_revision: 'ca98486d52274b16b9180b20a3d4b95eb5304e64'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** CI validates each contract's own files, but nothing stops a pull request from breaking a contract silently: no breaking-change check, no rule that a contract change updates its changelog and its mock, and no checks for the shared rules the other streams rely on (table ownership, one Alembic head, the compatibility file, the bundle).

**Approach:** Add one rule set, read from a single contract registry, run by one command in a CI job. OpenAPI breaking changes are found by a pinned, checksum-verified oasdiff; JSON Schema breaking changes by our own diff that applies the CHANGELOG rule. Checks whose inputs do not exist yet are built against fixtures and switch on by themselves when the inputs appear.

## Boundaries & Constraints

**Always:** Decisions confirmed by the developer on 2026-10-10: build what is possible now and write the blocked checks against fixtures with a proposed format and handoff rows for Akshay; verify oasdiff first, pin an exact version and checksum, use it for the OpenAPI files, and use our own script for the JSON Schemas; update ADR 0012 with what was verified. The breaking rule is the one in `contracts/CHANGELOG.md`: rename, removal, retyping, optional to required and a removed enum value are breaking, and a breaking change needs a changelog entry marked BREAKING; before the tag it bumps the minor number. Every check ends in PASS, FAIL or NOT-APPLICABLE with the named reason (the input path does not exist yet); NOT-APPLICABLE is printed and counted in the job summary, is allowed only when the input path is absent, and a check whose input exists but cannot run fails. oasdiff runs with `--allow-external-refs=false` and `--fail-on ERR`, from a version above 1.26.1 and 1.18.1 (advisories). The base of a comparison is the pull request base ref (checkout with full history); once a `contracts-v*` tag exists, the latest tag. A new contract file or folder is not a breaking change. Real commands and results only; every check has a test that fails on a deliberately broken input and passes on a valid one. No new dependency except the pinned oasdiff binary, fetched by a script, checksum verified, never committed.

**Never:** No approvals check, CODEOWNERS or branch-protection work (L-09, EF-30). No bundler, no table-owners content, no migrations, no COMPAT.md content: those belong to Akshay (P-04 to P-06) and L-09. No change to a contract's meaning. No loosening of a check to make it pass; no skipped check without the printed reason. No push, no pull request. No secrets.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid additive change | new optional property, new endpoint, new enum value, with changelog and mock updated | all checks PASS | — |
| OpenAPI breaking | removed response property, removed path, optional to required in a request, removed enum value | oasdiff reports ERR, the run fails naming the file | exit 1 |
| JSON Schema breaking | removed or retyped property, optional to required, removed enum value, tightened pattern or bound, `additionalProperties` true to false | own diff fails naming file and path | exit 1 |
| Breaking but declared | the same change with a changelog entry marked BREAKING and the minor number raised | passes with a BREAKING notice | — |
| No changelog entry | contract file changed, `contracts/CHANGELOG.md` not | FAIL | names the contract |
| Mock not updated | contract changed, its mock paths unchanged, no `no mock change: <reason>` line in the changelog entry | FAIL | names the mock paths |
| Unregistered contract | new folder under `contracts/` without a registry entry | FAIL | asks for an entry |
| New file | spec not in the base ref | skipped as not breaking, reported | — |
| Table owners | `contracts/db/table-owners.yaml` absent | NOT-APPLICABLE: file does not exist yet | printed |
| Table owners | file present: unknown owner module, duplicate table, bad shape | FAIL | names the line |
| Alembic | `apps/api/migrations/versions` absent | NOT-APPLICABLE | printed |
| Alembic | present: two heads, a branch, duplicate revision, missing parent | FAIL | names the revisions |
| COMPAT.md | absent | NOT-APPLICABLE | printed |
| COMPAT.md | present: lists a contract version that does not exist in the changelog or tags | FAIL | names the row |
| Bundle | no bundle command yet | NOT-APPLICABLE | printed; FAIL if a bundle file exists but the command does not |
| oasdiff | binary missing or wrong checksum | FAIL | never runs an unverified binary |
| Real sprint diff | this branch against `origin/main` | PASS | — |

</frozen-after-approval>

## Code Map

- `contracts/CHANGELOG.md` (versioning rule lines 5-11, one section per contract, BREAKING marker, D-37 waiver wording) -- source of the breaking rule and of the entry format the checks read.
- `contracts/instance/*.schema.json`, `contracts/events/instance-events.schema.json` (+ derived posted schema), `contracts/orchestrator/orchestrator.openapi.yaml`, `contracts/api/lab/lab.openapi.yaml` -- the files under comparison; mocks in `contracts/mocks/{fake-ingest,fake-orchestrator,fake-lab,stub-instance}`.
- `package.json` (`contracts:check` composition), `scripts/validate-contracts.mjs`, `scripts/validate-events.mjs`, `scripts/check_orchestrator_contract.py`, `scripts/check_lab_contract.py` -- style and conventions; stay unchanged.
- `.github/workflows/ci.yml`, `scripts/ci-linux.mjs` (STEPS), `scripts/ci-linux.test.mjs` (both-direction guard) -- add the CI job and mirror it in STEPS.
- `docs/architecture/07-repo-and-workstreams.md` s3 and s5 lines 191-207, rules 3, 4, 8, 9 (lines 339-347) -- the check list and rules; `docs/adr/0012-monorepo-and-contract-toolchain.md` -- tool status to update; `.github/CODEOWNERS` -- owner modules.
- Handoffs read (rule 2b): H-73 (CI checks; its "no e2e" text is stale), H-84, H-81, H-91, H-07, H-80, H-82; answers written back.
- New: `contracts/registry.json` (one entry per contract: id, folders, schema or OpenAPI files, changelog heading, mock paths, conformance tests), `scripts/check-contract-rules.mjs` (+ tests and fixtures), `scripts/schema-diff.mjs` (JSON Schema breaking diff), `scripts/oasdiff.mjs` and `tools/oasdiff.json` (pinned version, per-platform checksums, installer into a git-ignored folder), `scripts/check_alembic_head.py` and a table-owners validator with a proposed `contracts/db/table-owners.schema.json`.
- oasdiff facts read 2026-10-10 (to re-verify in the build): latest v1.33.0, Apache-2.0, OpenAPI 3.1 supported since 1.15, `breaking` and `breaking-files` commands, `--fail-on ERR`, git-ref bases, checksums.txt published, no signing found, Docker image `tufin/oasdiff` (tags unverified).
- Do not touch: other developers' tracker folders, the contracts' meaning, `contracts/api/bundle`, `contracts/db` content except the proposed schema.

## Tasks & Acceptance

**Execution:**
- [ ] `tools/oasdiff.json`, `scripts/oasdiff.mjs` -- download the pinned release for the platform, verify sha256 against the pinned value and the release's checksums.txt, run with the fixed flags; test the failure paths; re-verify v1.33.0 facts and the 3.1 behaviour on copies of our own files first
- [ ] `contracts/registry.json`, `scripts/check-contract-rules.mjs` -- rules: changelog updated, mock updated or waived, breaking declared, unregistered contract, new files skipped; base ref logic
- [ ] `scripts/schema-diff.mjs` -- JSON Schema breaking-change diff with the CHANGELOG rule
- [ ] table ownership, Alembic head, COMPAT.md and bundle checks with proposed formats, fixtures and the PASS, FAIL and NOT-APPLICABLE logic
- [ ] tests and fixtures: temporary git repositories that commit a base and a changed contract, one case per matrix row; run the real sprint diff
- [ ] `.github/workflows/ci.yml`, `scripts/ci-linux.mjs`, `scripts/ci-linux.test.mjs`, `package.json` -- job `contract-rules` (full history, pull requests only) and the fixture tests in `scripts`; STEPS mirror
- [ ] `docs/adr/0012-...md` (verified facts with URLs, status), `docs/dev/HANDOFFS.md` (answer H-73; rows for Akshay: table-owners format, Alembic layout, bundle command, registry entry for IF-1; row for Sahil: registry and the mock rule), `contracts/CHANGELOG.md` note
- [ ] Documentation rule -- dev-log, CHANGELOG, traceability LB-7, evidence in `docs/assets/l-07-contract-checks/`; tick L-07 only after the developer confirms

**Acceptance Criteria:**
- Given a pull request with a breaking change to any registered contract, when CI runs, then job `contract-rules` fails and names the file and the change; with a valid additive change and a changelog and mock update it passes.
- Given each matrix row, when run on fixtures, then the stated result and exit code occur.
- Given the real branch against `origin/main`, when the checks run, then they pass.
- Given absent inputs, when the checks run, then each says NOT-APPLICABLE with its reason, and the same check fails when its input exists in a broken form.
- Given a changed CI step, when `ci-linux.test.mjs` runs, then STEPS and the workflow agree in both directions.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Why two diff engines: oasdiff covers OpenAPI deeply and is the industry tool; it does not read bare JSON Schemas (IF-4, IF-6), so the schema diff is ours. Why NOT-APPLICABLE is explicit: a skipped check that prints nothing looks green; naming the missing input keeps the gap visible until Akshay's files land. The mock rule uses one waiver form, a line `no mock change: <reason>` in the changelog entry.

## Verification

**Commands:**
- `node scripts/check-contract-rules.mjs --base origin/main` -- expected: PASS with the NOT-APPLICABLE list printed
- `node --test "scripts/*.test.mjs"` -- expected: all pass, including every matrix row on fixtures
- `pnpm run contracts:check` -- expected: PASS for all four contracts
- `pnpm run ci:linux` -- expected: all steps PASS in the Linux container
- `uv run --locked --package vulnmart-api pytest -q` -- expected: all pass
