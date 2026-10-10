# 0012. Monorepo layout and contract-first toolchain

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** (pending the user)
- **Requirements:** NFR-MNT-02, NFR-MNT-04, NFR-MNT-05, D-14, D-21

## Context
Three developers must work without blocking each other, meeting only at written contracts.

## Options considered
1. Monorepo with spec-first contract fragments (OpenAPI per stream, JSON Schema for events), bundled and committed, mocks and generated clients.
2. Polyrepo: harder cross-cutting changes and docs rule.
3. Code-first only (OpenAPI generated from FastAPI): contracts follow code, so a consumer waits for the provider.

## Decision (proposed)
Option 1: `contracts/` folder, one owner per file, mocks in the same pull request, CI checks for schema validity, breaking changes, generated artefacts, migrations (single head, table owners) and approvals. Tools from RS-D (uv, pnpm, Prism, oasdiff, Schemathesis, a generated TypeScript client) are proposals, not read in primary sources.

## Consequences
Sprint zero produces contracts, stubs and a lab harness first. CODEOWNERS accepts any one owner's approval; enforcement through branch protection on a private personal repo is unconfirmed, so a CI approval check backs it.

## Evidence
https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners (VERIFIED rules; plan availability UNVERIFIED); tools UNVERIFIED. See docs/architecture/07-repo-and-workstreams.md.

## Update 2026-10-08 (story L-02)
Ajv 8.20.0 and ajv-formats 3.0.1 (exact pins, repository dev dependencies) confirmed by Tanmay on 2026-10-08 as the JSON Schema validator for the contracts. Other tools in this record remain proposals.
Alternatives considered (versions checked on the npm and PyPI registries on 2026-10-08): Python jsonschema 4.26.0 and @hyperjump/json-schema 1.18.0. Ajv 8.20.0 was chosen because it is the most used validator, supports JSON Schema 2020-12, has four small dependencies, and is Node like the rest of the repository scripts.

## Update 2026-10-10 (story L-07, contract checks live in CI)
Decided by Tanmay on 2026-10-10 (recorded in the L-07 plan): verify oasdiff first, pin an exact version and checksum, use it for the OpenAPI files, and use our own script for the JSON Schemas. Status of the tools in this record:
- **oasdiff 1.33.0: adopted** for OpenAPI breaking changes. Verified on 2026-10-10: latest release v1.33.0, published 2026-10-01 (GitHub releases API, https://github.com/oasdiff/oasdiff/releases/tag/v1.33.0); licence Apache-2.0 (the LICENSE file inside the archive and the repository metadata); the release publishes `checksums.txt` and no signature or attestation file (the asset list holds archives, packages and `checksums.txt` only); `oasdiff breaking` accepts files, URLs or git refs, `--fail-on ERR|WARN`, `--allow-external-refs` (read from `oasdiff breaking --help` of the pinned binary). OpenAPI 3.1 was tested on our own `orchestrator.openapi.yaml` and `lab.openapi.yaml`: identical files compare clean, and a deliberately broken copy of the orchestrator file (a removed enum value of a query parameter and a lowered `maximum`) was reported as two level ERR changes with exit 1. With `--allow-external-refs=false` a spec with an external `$ref` is refused, not followed. The floors from the plan, above 1.26.1 and above 1.18.1 (advisories), are met and tested.
- Pin: `tools/oasdiff.json` holds the version, the sha256 of each release archive (equal to the release `checksums.txt`) and of each extracted binary (computed by extracting the five archives). `scripts/oasdiff.mjs` fetches the archive into the git-ignored `tools/.bin/`, refuses it if the archive checksum differs from the pin or from the release file, refuses the extracted binary if its checksum differs, and refuses to run an installed binary whose checksum changed. Because no signature exists, the trust anchor is the pin committed in this repository, not the release file alone.
- Known gap of the tool and how it is closed: by default oasdiff does not report a removed optional response property (level info), a removed request property or parameter (warning) or a removed response enum value (info) at level ERR, although the CHANGELOG rule counts every removal as breaking. `tools/oasdiff-severity.txt` (ids taken from `oasdiff checks changelog`, passed with `--severity-levels`) raises these seven checks to err: response-optional-property-removed, response-property-enum-value-removed, response-mediatype-enum-value-removed, response-non-success-status-removed, optional-response-header-removed, request-property-removed, request-parameter-removed. A test fails on the old behaviour (a removed optional response property exits 0 without the file and fails with it). Other checks keep oasdiff's own levels; the list is a choice that the team can extend.
- **JSON Schema breaking changes: own script** `scripts/schema-diff.mjs`, because oasdiff does not read bare JSON Schemas (IF-4, IF-6). It applies the CHANGELOG rule and is stricter on constraints (a new or changed pattern, bound or format counts as tightened).
- Docker image `tufin/oasdiff`: not used (tags not verified; a pinned release binary needs no container).
- Ajv and ajv-formats stay as in the 2026-10-08 update. Prism, Schemathesis and a generated TypeScript client remain proposals, not adopted here.
- Limitation of `scripts/schema-diff.mjs`: `oneOf` and `anyOf` branches are matched by deep equality (anywhere in the list), else compared with the branch at the same position, so a branch that moved and was edited at once is reported as removed or changed. An `if` change is flagged breaking conservatively because the diff does not evaluate which `then` or `else` applies. `{}` equals `true`; loosening a keyword (for example `uniqueItems` true to false) is not breaking.
- Robustness of the fetch: 60 s limit per try and two retries; the install writes a temporary file and renames it, so parallel test files never read a partial binary. There is still no cache and no mirror: a GitHub outage fails the run (deferred).

### Proposals made by story L-07, awaiting confirmation (not decided)
These shapes were chosen while building and are not locked: the registry fields of `contracts/registry.json` (`id`, `folders`, `schemas`, `openapi`, `changelog`, `mocks`, `noMock`, `conformance`, plus `reserved`, `generated`, `containers`, `mockRoot`); the mock waiver form `no mock change: <reason>` inside the new changelog entry; the rule that a removed or moved registered file is a breaking change; the COMPAT.md table (registry id, version `X.Y.Z`); and the bundle command `contracts:bundle:check`. They stay proposals until Tanmay confirms them and Akshay confirms the three that touch his streams (handoffs H-95 to H-98).
