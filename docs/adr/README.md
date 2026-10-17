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
| 0016 | [Per-consumer flag file delivery and injector network](0016-per-consumer-flag-file-delivery-and-injector-network.md) | Accepted (D-36) |
| 0017 | [Shop SQLite driver: Node built-in node:sqlite](0017-shop-sqlite-driver.md) | Accepted |
| 0018 | [Shop password hashing: Node built-in scrypt](0018-shop-password-hashing.md) | Accepted |
| 0019 | [Lab API conventions: route prefix, Node mock, scope](0019-lab-api-conventions.md) | Proposed (D-39) |
| 0020 | [Stub instance, lab harness and sidecar start input](0020-stub-instance-harness-and-sidecar-start-input.md) | Accepted (stub design, sidecar input); Proposed (volume keeper, stdin rule) |
| 0021 | [Oracle account, two Arm VMs, Terraform and keep-alive](0021-oracle-account-two-vms-terraform-and-keep-alive.md) | Superseded in part by 0022 (2026-10-11): provider, region, shape, keep-alive and alarm; Oracle kept as an unused option |
| 0022 | [Hosts on the AWS Free Plan in Sydney (supersedes the provider part of 0021)](0022-aws-free-plan-sydney-hosts.md) | Accepted (provider, region, tooling, sizing; applied and verified live 2026-10-11); Proposed (private ports, sizes, isolation) |
| 0023 | [Instance event contract: identity, signing, sources](0023-instance-event-contract-identity-signing-source.md) | Accepted (D-38) |
| 0024 | [Signing of platform-to-orchestrator requests](0024-orchestrator-request-signing.md) | Proposed |
| 0025 | [IF-4 event identity with epoch, seq lanes and per-epoch event keys](0025-if4-epoch-seq-lanes-and-event-keys.md) | Accepted (D-42) |
| 0026 | [Trusted base checker for the contract rules](0026-trusted-base-checker-for-contract-rules.md) | Accepted (D-46); not yet proven on GitHub |
| 0027 | [Labs host isolation, IAM guard and remote state](0027-labs-host-isolation-iam-guard-and-remote-state.md) | Accepted (D-43, D-44; applied and verified live); S3 state prepared (D-45) |
| 0028 | [IF-5 problem details, state report transition number, strict integers](0028-if5-problem-details-state-report-and-strict-seq.md) | Accepted (D-47) |
| 0029 | [Contract approvals checked by CI, and the tag procedure](0029-contract-approvals-by-ci-and-tag-procedure.md) | Proposed (decided on the developer's delegation 2026-10-11; open: the author-who-is-consumer rule and the branch protection fact) (D-48) |
| 0030 | [Certificates by lego on each host (DNS-01, DuckDNS)](0030-certificates-by-lego-on-the-host-dns-01.md) | Proposed (decided on the developer's delegation 2026-10-11) (D-49) |
| 0031 | [Vercel same-origin rewrite with an origin secret, checked in Caddy and in the application](0031-vercel-same-origin-rewrite-and-origin-secret-gate.md) | Proposed (decided on the developer's delegation 2026-10-11) (D-50) |
| 0032 | [Image builds in CI (amd64 now, arm64 behind a switch) and a human-run deploy script](0032-image-builds-in-ci-and-human-run-deploy.md) | Proposed (decided on the developer's delegation 2026-10-12) (D-51) |
| 0033 | [Orchestrator engine and Docker instance builder](0033-orchestrator-engine-docker-builder.md) | Proposed (D-52, decided on the developer's delegation 2026-10-12) |
| 0034 | [Orchestrator service: the IF-5 API over the engine](0034-orchestrator-service-fastapi-signing-mtls-reports.md) | Proposed (D-53, decided on the developer's delegation 2026-10-12) |
| 0035 | [Orchestrator reset, the reaper and the timing settings](0035-orchestrator-reset-reaper-and-timing-settings.md) | Proposed (D-54, decided on the developer's delegation 2026-10-15) |
| 0040 | [Email: Postgres outbox with a relay, retries in the row, Brevo as the first real provider](0040-email-outbox-relay-and-retries-in-the-row.md) | Proposed (provider answer of the developer 2026-10-17, OI-32; design for the developer to confirm) |
| 0041 | [Signup: Argon2id profile, hashed single-use links, fail-closed rate limits](0041-signup-argon2id-link-tokens-and-fail-closed-rate-limits.md) | Proposed (OI-29 answer of the developer 2026-10-17; design for the developer to confirm) |
| 0042 | [Sessions: hashed cookie value, HMAC CSRF token, origin check, login throttle](0042-sessions-hashed-cookie-hmac-csrf-and-login-throttle.md) | Proposed (the builder's design for the developer to confirm) |

New record: copy `0000-template.md` to `NNNN-<title>.md` and add a row here.
