---
type: epic
title: "Lab baseline and sprint-zero contracts"
parent: initiative-lab
covers: []
after: []
assignee: "Tanmay Gupta"
risk: high
---

# Lab baseline and sprint-zero contracts

## Description

The repository skeleton, tooling, CI and Compose profiles exist and work on every developer machine, the lab contracts (instance contract, instance events, orchestrator API) exist with mocks, and a harness starts one full instance of a stub shop on a laptop. This is the opening epic of the whole project: the other two streams wait on its first stories.

## Outcome

All three streams can build and test against stable contracts, fakes and stubs; the signal is contracts-v1.0.0 tagged and the lab harness running one full stub instance on a laptop.

## Requirements

- LB-1: Monorepo skeleton with uv and pnpm workspaces, tool versions pinned from the registries on the day, CI skeleton, CODEOWNERS and Compose profiles with `scripts/dev.mjs` (docs/architecture/07-repo-and-workstreams.md sections 1, 2, 6; ADR 0012; NFR-MNT-04, NFR-POR-03).
- LB-2: The developer environment is verified on Tanmay's PC: WSL and Docker data moved to D:, memory capped in `.wslconfig`, a test container runs (K-10).
- LB-3: Instance contract v0 (IF-6): containers, env, health, labels, injection protocol, runtime profile (docs/architecture/07-repo-and-workstreams.md section 3.2).
- LB-4: Instance event schema (IF-4) and the app-event name list (docs/architecture/07-repo-and-workstreams.md section 3.1).
- LB-5: Orchestrator API (IF-5) and a fake orchestrator (docs/architecture/07-repo-and-workstreams.md section 3.3).
- LB-6: A stub shop, a fake ingest and a lab harness that starts one full instance on a laptop (docs/architecture/07-repo-and-workstreams.md section 4).
- LB-7: Contract checks run in CI: schema validity, breaking change, bundle current, mock validity, provider conformance, migrations, table ownership, compatibility file (docs/architecture/07-repo-and-workstreams.md section 5).
- LB-8: Contracts v1.0.0 are tagged with COMPAT.md and the change rules in force (docs/architecture/07-repo-and-workstreams.md sections 7.7 and 7.8).
- LB-9: The lab-side fragment of the platform API (IF-2): the endpoints stream L provides to stream P (attempts, instances, reports), authored here so stream P builds the dashboards against it (docs/architecture/07-repo-and-workstreams.md section 3.3).

## Done when

1. The repository skeleton, CI skeleton and Compose profiles are merged and used by all three streams.
2. The lab harness starts one full instance with the stub shop, a fake ingest and a fake orchestrator on Tanmay's PC with one command.
3. Contract checks are required in CI and a breaking change to a contract fails the build.
4. Contracts v1.0.0 are tagged after the owners of every contract approved them and each stream recorded the versions it builds against.
5. The lab fragment of the platform API (IF-2) is merged so stream P can build against it.

## Boundaries

The opening epic and platform baseline for the whole repository: scaffold, environments, CI and the lab contracts. Not the platform contracts (initiative-platform epic-platform-baseline) or the catalogue schema (initiative-target epic-target-baseline), which stream P and T provide.

## References

- parent, docs/bmad/initiative-lab/initiative-lab.md
- architecture, docs/architecture/07-repo-and-workstreams.md, sections 1 to 7 (contracts, mocks, CI, sprint zero)
- decision, initial.md D-33, D-14, D-31

## Notes

- Tracer bullet: entry 1, the thinnest path: `node scripts/dev.mjs` starts a hello container on the developer machine and a CI run goes green on a pull request.
- Assumption: this epic holds the shared-decision home for contracts IF-2 (lab fragment), IF-4, IF-5 and IF-6; the other streams adopt them through the contract rules.
- Assumption: the closing integration epic (epic 8) owns the cross-stream end-to-end suite, so this epic needs none.
- Decision: harness uses pass-through stubs for the sidecar, edge and gate in this epic; the real components arrive in epic-edge-gate-and-event-path and epic-flags-detection-and-sidecar (placeholders are separate stories by the slicing rule).
- Decision: no closing end-to-end suite here; the contract checks in CI play that role (2026-10-08).
- Unknown: whether branch protection with required code-owner review works on a private repository owned by a personal GitHub Free account (EF-30); if not, a CI check `contract-approvals` enforces approvals.
- Unknown: whether Docker runs on Windows 11 Home with WSL2 on this PC (EF-26 conflicting); entry 1 settles it.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
