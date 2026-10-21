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
| 0036 | [Orchestrator reconciler: Docker labels are the truth, tombstones in a small file](0036-orchestrator-reconciler-labels-and-tombstones.md) | Accepted (D-55, decided on the developer's delegation; confirmed by the developer 2026-10-17) |
| 0037 | [Isolation probe from inside an instance network](0037-isolation-probe-from-inside-an-instance-network.md) | Accepted (D-57, decided on the developer's delegation; confirmed by the developer 2026-10-17) |
| 0038 | [A socket proxy now, rootless Docker later (spike S-8 stays open)](0038-socket-proxy-before-rootless-docker.md) | Accepted (D-58, decided on the developer's delegation, story 4.2 "Docker socket behind a proxy for the orchestrator", 2026-10-16; confirmed by the developer 2026-10-17) |
| 0039 | [No warm pool for the first release; the numbers that would change it](0039-no-warm-pool-for-the-first-release.md) | Accepted (D-59, decided on the developer's delegation, story 3.6 "Concurrency, quotas, start failures, warm-pool decision", 2026-10-16; confirmed by the developer 2026-10-17) |
| 0040 | [Email: Postgres outbox with a relay, retries in the row, Brevo as the first real provider](0040-email-outbox-relay-and-retries-in-the-row.md) | Proposed (provider answer of the developer 2026-10-17, OI-32; design for the developer to confirm) |
| 0041 | [Signup: Argon2id profile, hashed single-use links, fail-closed rate limits](0041-signup-argon2id-link-tokens-and-fail-closed-rate-limits.md) | Proposed (OI-29 answer of the developer 2026-10-17; design for the developer to confirm) |
| 0042 | [Sessions: hashed cookie value, HMAC CSRF token, origin check, login throttle](0042-sessions-hashed-cookie-hmac-csrf-and-login-throttle.md) | Proposed (the builder's design for the developer to confirm) |
| 0043 | [Roles, admin creation and role-gated routes](0043-roles-admin-creation-and-role-gated-routes.md) | Proposed (the builder's design for the developer to confirm) |
| 0044 | [Password policy: rules, a bundled common-password list, an optional breach range check](0044-password-policy-bundled-list-and-optional-range-check.md) | Proposed (the builder's design for the developer to confirm) |
| 0045 | [TOTP second factor: sealed secret, keyed recovery codes, a restricted session for an admin without one](0045-totp-second-factor-sealed-secret-and-restricted-admin-session.md) | Proposed (the builder's design for the developer to confirm) |
| 0046 | [Append-only consent record, a notice text pinned to its version, a ConsentTargets port](0046-append-only-consent-record-pinned-notice-text-and-consent-targets-port.md) | Proposed (the builder's design for the developer to confirm) |
| 0047 | [The audit log on Postgres with pseudonymised subjects, and the key service over a separate keystore database](0047-audit-log-on-postgres-and-key-service-over-a-separate-keystore.md) | Proposed (the builder's design for the developer to confirm) |
| 0048 | [Recruiter signup, company states derived from the company, and two read-only exceptions to the organisation scope](0048-recruiter-signup-company-states-and-two-read-only-scope-exceptions.md) | Proposed (the builder's design for the developer to confirm) |
| 0049 | [Colleagues join by a domain claim, pinned data-processing terms, an invite cap, and the company in the session scope](0049-colleagues-join-by-domain-claim-pinned-terms-invite-cap-and-the-company-in-the-session.md) | Proposed (the builder's design for the developer to confirm) |
| 0050 | [Invites: a sealed recipient address, a company-prefixed token, rules copied onto the invite, and `sent` read from the mail](0050-invites-sealed-recipient-company-prefixed-token-and-lazy-sent-state.md) | Proposed (the builder's design for the developer to confirm) |
| 0051 | [Accepting invites: binding by verified address, the attempt id given out at binding, consent before the attempt, and generations for a re-invite](0051-accepting-invites-binding-by-verified-address-attempt-id-at-binding-and-generations.md) | Proposed (the builder's design for the developer to confirm) |
| 0052 | [Live updates: the event outbox in Postgres, a relay into one Valkey stream per audience, ids from one counter, and the hub in the API process](0052-live-updates-hub-outbox-relay-one-stream-per-audience-and-ids-from-one-counter.md) | Proposed (the builder's design for the developer to confirm) |
| 0053 | [Stream authorisation: the company's standing, passive session checks, and HTTP/2 through the front](0053-stream-authorisation-company-standing-passive-sessions-and-http2-through-the-front.md) | Proposed (the builder's design for the developer to confirm) |
| 0054 | [Retention: a scheduler with leased runs, two privileged purge functions, and the candidate's clock](0054-retention-scheduler-leased-runs-privileged-purge-functions-and-the-candidate-clock.md) | Proposed (the builder's design for the developer to confirm) |
| 0055 | [Deletion requests: the 7-day undo window, the company's part, and company-level view history](0055-deletion-requests-the-undo-window-the-company-s-part-and-company-level-view-history.md) | Proposed (the builder's design for the developer to confirm) |
| 0056 | [Instance containers run in gVisor (runsc)](0056-instances-run-in-gvisor.md) | Accepted (the developer's instruction in chat, 2026-10-20: implement the sandbox experiments and adopt what passes) |
| 0057 | [Admin operations: admin-only routes, a real quota port, and setting ranges](0057-admin-operations-admin-only-routes-a-real-quota-port-and-setting-ranges.md) | Proposed (the builder's design for the developer to confirm) |
| 0058 | [Candidate invite routes, and the dashboards as client pages over the same-origin API](0058-candidate-invite-routes-and-dashboards-as-client-pages.md) | Proposed (the builder's design for the developer to confirm) |
| 0059 | [Recruiter routes, and the recruiter dashboard over the lab's reviewer routes](0059-recruiter-routes-and-the-recruiter-dashboard.md) | Proposed (the builder's design for the developer to confirm) |
| 0060 | [Exports built on the server as audited zips](0060-exports-built-on-the-server-as-audited-zips.md) | Proposed (the builder's design for the developer to confirm) |
| 0061 | [The support bot runs page scripts in jsdom, one child process per visit](0061-support-bot-runs-page-scripts-in-jsdom.md) | Proposed (renumbered from a second 0058, handoff H-357) |
| 0062 | [Break-glass sessions and the admin's audit log](0062-break-glass-sessions-and-the-admin-audit-log.md) | Proposed (the builder's design for the developer to confirm) |
| 0063 | [Sequenced learner runs with a countdown per challenge](0063-sequenced-learner-runs-with-a-countdown-per-challenge.md) | Accepted (the developer answered the questions on 2026-10-20) |
| 0064 | [The team is the leader and Claude only](0064-the-team-is-the-leader-and-claude-only.md) | Accepted (the leader instructed it on 2026-10-21) |
| 0070 | [Browser tests run the production build of the dashboards against the real API app on a throw-away database](0070-browser-tests-run-the-real-api-app-on-a-throw-away-database.md) | Accepted (the leader asked for real browser tests on 2026-10-21; choices to review in the pull request) |
| 0071 | [Template settings, quotas and the attempt lifecycle in the lab](0071-template-settings-quotas-and-the-attempt-lifecycle.md) | Accepted (confirmed by the leader on 2026-10-21) |
| 0072 | [Milestone mapping and decoy placement live in the catalogue](0072-milestone-mapping-and-decoy-placement-in-the-catalogue.md) | Accepted (the leader instructed work package D on 2026-10-21) |
| 0073 | [Company administration, privacy workflows and real mail](0073-company-administration-privacy-workflows-and-real-mail.md) | Accepted (leader, 2026-10-21) |
| 0074 | [Production hardening of the deployed stack: dashboards, scheduler, real mail, fail-closed starts](0074-production-hardening-of-the-deployed-stack.md) | Accepted |
| 0075 | [Durable gate and sidecar state, and the platform's list of wanted instances](0075-durable-gate-and-sidecar-state-and-the-platform-s-wanted-instances.md) | Accepted |
| 0090 | [Edge, gate, ticket and strict hostname model](0090-edge-gate-ticket-and-hostname-model.md) | Proposed (decided on the developer's delegation; to be confirmed). D-61, D-65, D-66 are planned only: their stories are not built. |
| 0091 | [Attempt clock, expiry sequence and scoring rules](0091-attempt-clock-scoring-and-expiry.md) | Proposed (decided on the developer's delegation; to be confirmed) |
| 0092 | [Flag material, sidecar form, matching and milestone rules](0092-flags-sidecar-and-milestone-decisions.md) | Proposed (decided on the developer's delegation; to be confirmed). D-77 and D-78 are planned only: their story is not built. |
| 0094 | [Claude approves under the leader's standing authority](0094-claude-approves-under-the-leaders-standing-authority.md) | Accepted (the leader instructed it on 2026-10-21) |
| 0095 | [A sole maintainer passes the contract approvals rule](0095-sole-maintainer-passes-the-contract-approvals-rule.md) | Accepted (the leader instructed it on 2026-10-21; Claude approved under D-104) |
| 0096 | [Extra time for a running candidate attempt, and an open-attempts list for the admin](0096-extra-time-for-a-running-candidate-attempt.md) | Accepted (the leader instructed the refresh on 2026-10-21) |

New record: copy `0000-template.md` to `NNNN-<title>.md` and add a row here.
