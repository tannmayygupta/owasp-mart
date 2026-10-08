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
