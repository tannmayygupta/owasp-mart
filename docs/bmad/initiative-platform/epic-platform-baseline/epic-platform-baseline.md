---
type: epic
title: "Platform baseline and sprint-zero contracts"
parent: initiative-platform
covers: []
after: []
assignee: "Akshay Gupta"
risk: medium
---

# Platform baseline and sprint-zero contracts

## Description

The platform stack runs locally on Windows and macOS, the contracts that stream P provides exist with mocks, and the dashboards are deployed on Vercel through the same-origin rewrite. This is the opening epic: scaffold, environment, contracts and the first deployment.

## Outcome

Every platform developer and both other streams can build against stable contracts and a running skeleton; the signal is contracts-v1.0.0 tagged with stream P's contracts merged, and the skeleton running on a Vercel preview.

## Requirements

- PB-1: Error codes and the problem-details format exist as one registry contract (docs/architecture/07-repo-and-workstreams.md section 3.6; NFR-SEC-03).
- PB-2: The domain event schema (IF-3) exists with fixtures and a replay script (docs/architecture/07-repo-and-workstreams.md section 3.1).
- PB-3: The platform and lab API fragments (IF-1, IF-2) exist with examples, a bundle, a Prism mock and a generated typed client and models (docs/architecture/07-repo-and-workstreams.md section 3.4; NFR-MNT-02).
- PB-4: Ports between P and L exist as Python Protocols with in-memory fakes, and a table ownership file with a CI check (IF-9, IF-10).
- PB-5: The API skeleton exists: kernel (settings, session and organization scope, audit, outbox, key service stubs), request IDs and structured logs, health, readiness and version endpoints (NFR-OBS-01, 02), skeleton entrypoints for ingest, live hub, worker and scheduler, and one Alembic history (NFR-MNT-05); the single-head check in CI is owned by initiative-lab epic-lab-baseline entry 6.
- PB-6: The dashboards skeleton works same-origin locally through a proxy, with the origin secret header, no-store on authenticated responses and security headers (D-28; EF-02; NFR-SEC-03); deploying it to Vercel and checking the real VM belongs to initiative-lab epic-environments-and-deployment (LE-3).
- PB-7: The platform Compose profile (Postgres 18, Valkey, Mailpit, API) starts with one command on Windows and macOS (NFR-POR-03).
- PB-8: The developer environment is verified on the Mac (NFR-POR-03, Q-24).
- PB-9: Stream P signs contracts v1.0.0 as provider and consumer (docs/architecture/07-repo-and-workstreams.md section 7.7).

## Done when

1. PB-1 to PB-5 are merged, each with its mock or fake and its conformance check running in CI.
2. One command starts the platform profile on Akshay's Mac and a page shows the API health through the same-origin proxy.
3. The dashboards skeleton proxies `/api/*` to the API locally with the origin secret header, and two different users never receive each other's response in a local caching test (EF-02).
4. Contracts v1.0.0 are tagged after all three owners signed off, and stream P has recorded the contract versions it builds against.

## Boundaries

Stream P's share of sprint zero. Not the repository skeleton, Compose layout and CI skeleton (initiative-lab epic-lab-baseline entry 1), not the lab contracts (IF-4, IF-5, IF-6), not the catalogue (IF-7).

## References

- parent, docs/bmad/initiative-platform/initiative-platform.md
- architecture, docs/architecture/07-repo-and-workstreams.md, sections 3, 4, 5 and 7.7 (sprint zero)
- architecture, docs/architecture/03-origins-and-access.md section 1 (browser path)
- decision, initial.md D-28 and D-33

## Notes

- Tracer bullet: entry 1, the thinnest path through every layer: dashboards page, same-origin proxy, API health, Postgres and Valkey, on a developer machine.
- Assumption: deployment and environments for all three streams sit in initiative-lab epic-environments-and-deployment, so this baseline is verified locally.
- Assumption: sequencing follows the contract order of the architecture (error registry, event schema, API fragments, ports, kernel, dashboards).
- Tracer note: the tracer bullet has no Vercel layer; entry 7 completes the same-origin proxy locally and LE-3 completes Vercel.
- Decision: no closing end-to-end suite for this epic; the contract checks in CI play that role (2026-10-08).
- Waits on initiative-lab epic-lab-baseline entry 1 (repository skeleton, Compose profile layout, `scripts/dev.mjs`) because the platform profile lives in its layout; entry 1 here carries that as an unknown.
- Entry 4 consumes the lab API fragment (IF-2) that stream L authors (initiative-lab epic-lab-baseline entry 9). Spike S-14 (SSE through a Vercel rewrite) and the real-VM check move to initiative-lab epic-environments-and-deployment (LE-3).
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
