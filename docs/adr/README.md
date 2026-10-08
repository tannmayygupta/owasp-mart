# Architecture decision records

| No. | Title | Status |
|---|---|---|
| 0001 | [Record technical decisions as ADRs in the repo](0001-record-architecture-decisions.md) | Accepted |
| 0002 | [Browser-to-API path: same-origin through Vercel rewrites](0002-browser-to-api-path-vercel-rewrites.md) | Accepted (D-28), refinements Proposed |
| 0003 | [Instance addressing and TLS](0003-instance-addressing-and-tls.md) | Accepted (D-28); "never plain HTTP" reading Accepted (D-35); other refinements Proposed |
| 0004 | [Instance access gate at the edge](0004-instance-access-gate.md) | Proposed |
| 0005 | [Instance network topology and event path](0005-instance-network-and-event-path.md) | Accepted (D-28), refinements Proposed |
| 0006 | [Live updates: SSE hub on Valkey Streams with an outbox](0006-live-updates-sse-hub-valkey-streams.md) | Proposed |
| 0007 | [Host topology: one Oracle VM or two](0007-vm-topology-one-vm-or-two.md) | Accepted (D-34): two VMs |
| 0008 | [Platform data placement, backups, keystore and audit anchor](0008-platform-data-backups-and-audit-anchor.md) | Placement Accepted (D-28), rest Proposed |
| 0009 | [Key hierarchy and secret storage](0009-key-hierarchy-and-secrets.md) | Proposed; per-attempt key Accepted (D-35) |
| 0010 | [Orchestrator privileges and the host-side drop rule](0010-orchestrator-privileges-and-host-rule.md) | Proposed |
| 0011 | [Multi-architecture builds and image registry](0011-multi-arch-ci-builds-and-registry.md) | VM build Accepted (D-28), rest Proposed |
| 0012 | [Monorepo layout and contract-first toolchain](0012-monorepo-and-contract-toolchain.md) | Proposed |
| 0013 | [Three work-stream split](0013-three-work-stream-split.md) | Accepted (D-33): P, L, T; Tanmay L, Akshay P, Sahil T |
| 0014 | [Organization scoping: application filter plus RLS](0014-organization-scoping-app-filter-and-rls.md) | Proposed |
| 0015 | [Laptop fallback and developer engine](0015-laptop-fallback-engine.md) | Proposed |

New record: copy `0000-template.md` to `NNNN-<title>.md` and add a row here.
