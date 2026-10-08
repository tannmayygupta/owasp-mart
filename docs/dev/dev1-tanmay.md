# Developer 1: Tanmay, Lab stream

Tanmay owns the instance plane and the assessment engine: contracts and the lab harness, the two Oracle VMs, the orchestrator, isolation, the edge and gate, flags, detection, attempts, scoring and anti-cheat, and the final end-to-end checks.

| | |
|---|---|
| Ticket tree | `docs/bmad/initiative-lab/` |
| Excel tracker | `docs/bmad/VulnMart-Tracker.xlsx`, sheet "1 Tanmay (Lab)" (updated by hand) |
| Tasks | 31 tasks in 4 weekly sprints |
| Status | Draft plan written 2026-10-08 by Claude Code; not yet approved by the team |

## How to work from this file

1. Take the next unticked task whose "Waits on" items are done. If a wait is on another developer, use the mock or fake named in the task and carry on; do not stop.
2. Create the story with `bmad-ticket`, build it with `bmad-build`, review it, test it. A task that is too big may become more than one story.
3. When the tests have really passed: tick the box below, update the story state in `docs/bmad/initiative-lab/`, write the dev-log entry, changelog line and traceability rows, then commit.
4. Update the Excel sheet by hand (Done = Yes).

Sprint dates are a proposal: the final submission is in the first week of November (exact date not yet given). The exact acceptance criteria of each task are written when the task starts. Open questions named in a task (OI-xx) must be answered by the team before that part is built.

## Sprint overview

| Sprint | Dates | Goal | Tasks |
|---|---|---|---|
| 1 | 8 Oct to 14 Oct 2026 | Contracts v1, the lab harness and the two Oracle VMs exist, so the other two streams can build against stable contracts and fakes. | L-01 to L-08 (8) |
| 2 | 15 Oct to 21 Oct 2026 | Instances start, reset, tear down and are isolated; the deployment pipeline works (Vercel, certificates, image builds). | L-09 to L-16 (8) |
| 3 | 22 Oct to 28 Oct 2026 | The edge and gate, event relay, flags, the detection sidecar, the attempt engine and scoring work end to end. | L-17 to L-24 (8) |
| 4 | 29 Oct to 4 Nov 2026 | Time metrics, anti-cheat, isolation proof, the end-to-end suite, the load check and the demo rehearsal. | L-25 to L-31 (7) |

## Sprint 1 (8 Oct to 14 Oct 2026)

Goal: Contracts v1, the lab harness and the two Oracle VMs exist, so the other two streams can build against stable contracts and fakes.

- [ ] **L-01. Repository skeleton and tooling run end to end (tracer bullet)**
  - Epic: `epic-lab-baseline`
  - Build: Monorepo with uv and pnpm workspaces and pinned tools, CI skeleton, CODEOWNERS, Compose profiles and `scripts/dev.mjs`; check Docker on your PC (WSL and Docker data on D:, memory cap).
  - Covers: LB-1, LB-2
  - Waits on: Nothing. This is the first task of the whole project.
  - Done when: `node scripts/dev.mjs hello` starts a hello container on your PC and the CI skeleton runs green on a pull request.

- [ ] **L-02. Instance contract v0 (IF-6)**
  - Epic: `epic-lab-baseline`
  - Build: Write the contract every in-instance service obeys: containers, env, health, labels, injection protocol and runtime profile.
  - Covers: LB-3
  - Waits on: L-01.
  - Done when: The contract validates and Sahil has approved it as consumer.

- [ ] **L-03. Instance event schema (IF-4), app-event names and fake ingest**
  - Epic: `epic-lab-baseline`
  - Build: Define the signed events that sidecars and the shop send to ingest, the list of app-event names, and a fake ingest that validates them.
  - Covers: LB-4
  - Waits on: L-02.
  - Done when: Every example event validates and the fake ingest rejects a malformed or oversize one.

- [ ] **L-04. Orchestrator API (IF-5), InstanceHost protocol and fake orchestrator**
  - Epic: `epic-lab-baseline`
  - Build: Write the orchestrator HTTP contract, the InstanceHost protocol the orchestrator drives, and a fake orchestrator with a FakeInstanceHost.
  - Covers: LB-5
  - Waits on: L-01.
  - Done when: A client built from the contract creates, resets and destroys instances against the fake, and the fake host passes the protocol tests the real one must pass later.

- [ ] **L-05. Lab fragment of the platform API (IF-2) with a mock**
  - Epic: `epic-lab-baseline`
  - Build: Write the endpoints the lab provides to the platform (attempts, instances, reports) as an API fragment and a mock.
  - Covers: LB-9
  - Waits on: L-01.
  - Done when: The fragment validates, the mock answers every endpoint and Akshay has reviewed it as consumer.

- [ ] **L-06. Stub shop, fake ingest and lab harness**
  - Epic: `epic-lab-baseline`
  - Build: A tiny stub shop that meets the instance contract, and a Compose harness that starts one full instance with pass-through sidecar, edge and gate stubs and an injection step.
  - Covers: LB-6
  - Waits on: L-02, L-03, L-04.
  - Done when: One command starts a full stub instance on a laptop: it answers health, becomes ready only after the injection marker, serves a planted flag, emits one app event the fake ingest validates, and passes the contract conformance check.

- [ ] **L-07. Contract checks live in CI**
  - Epic: `epic-lab-baseline`
  - Build: Add the contract checks to CI (schema validity, breaking change, bundle current, mock validity, provider conformance, migrations, table ownership, compatibility file), including the ownership and single-Alembic-head checks the other streams rely on.
  - Covers: LB-7
  - Waits on: L-02, L-03, L-04.
  - Done when: A deliberately breaking contract change fails CI and a valid one passes.

- [ ] **L-08. Oracle account, two VMs, private link and firewall**
  - Epic: `epic-environments-and-deployment`
  - Build: Create VM-P and VM-I, a private link between them, key-only SSH and only ports 80 and 443 public; keep-alive and budget alert; send the Oracle terms-of-service email.
  - Covers: LE-1, LE-6; spikes S-11, S-17
  - Waits on: Decision on who owns the Oracle account (Q-32).
  - Done when: Both VMs are reachable by key-only SSH, only 80, 443 and SSH are open, the private link works, and the account owner, budget alert and keep-alive routine are written down.

## Sprint 2 (15 Oct to 21 Oct 2026)

Goal: Instances start, reset, tear down and are isolated; the deployment pipeline works (Vercel, certificates, image builds).

- [ ] **L-09. Tag contracts v1.0.0 and start the change rules**
  - Epic: `epic-lab-baseline`
  - Build: Collect every contract owner approval, write COMPAT.md, tag `contracts-v1.0.0` and turn the change rules on. Settle branch protection on the private repository (EF-30) or use the CI approvals check.
  - Covers: LB-8
  - Waits on: L-05, L-06, L-07 and the sign-offs of Akshay (P-08) and Sahil (T-03).
  - Done when: The tag exists, COMPAT.md lists the versions every stream targets and the approvals check is active.

- [ ] **L-10. DuckDNS names and certificates**
  - Epic: `epic-environments-and-deployment`
  - Build: Register the platform and labs DuckDNS names, issue a certificate for the platform host and a wildcard certificate for the labs name (DNS-01), automatic renewal.
  - Covers: LE-2; spike S-16
  - Waits on: L-08.
  - Done when: Real certificates are issued and renew automatically; the S-16 result (wildcard resolution) is recorded.

- [ ] **L-11. Vercel project, same-origin rewrite and live-stream check**
  - Epic: `epic-environments-and-deployment`
  - Build: Create the Vercel project with the rewrite config from Akshay, the origin secret and the origin-secret check in the platform Caddy; run the SSE-through-rewrite test on the real VM.
  - Covers: LE-3; spike S-14
  - Waits on: L-10 and Akshay's dashboards skeleton (P-07).
  - Done when: The Vercel site reaches the API through `/api/*`, direct access to the VM without the secret is refused, and the S-14 result is recorded.

- [ ] **L-12. Image builds for amd64 and arm64 and deploy pipelines**
  - Epic: `epic-environments-and-deployment`
  - Build: CI builds images for amd64 and natively for arm64 on the VM, and a deploy step puts them on both VMs.
  - Covers: LE-4
  - Waits on: L-08, L-07.
  - Done when: A hello stack from CI runs on both VMs and on the laptop.

- [ ] **L-13. Orchestrator creates an instance from a template**
  - Epic: `epic-orchestrator-and-instance-lifecycle`
  - Build: Create a private instance on request from a template, wait for health and flag injection, track its state in a state machine.
  - Covers: FR-INS-01, 02, 07, 11; spike S-4
  - Waits on: L-04, L-08.
  - Done when: An instance is never shown ready before flag injection finished and the cold-start time is measured and recorded (S-4).

- [ ] **L-14. Reset, teardown, timing defaults and reconciler**
  - Epic: `epic-orchestrator-and-instance-lifecycle`
  - Build: Reset with new flags, tear down at expiry or inactivity, and a reconciler that repairs any difference between recorded and real state.
  - Covers: FR-INS-03, 04, 05; spike S-13
  - Waits on: L-13.
  - Done when: Learner instances stop after 60 minutes idle or 4 hours total; killing the orchestrator mid-provision leaves no orphans after the reconciler runs.

- [ ] **L-15. Instance isolation and hardening**
  - Epic: `epic-isolation-and-hardening`
  - Build: Internal networks with no route out, a host rule that drops instance-to-host traffic, hardened containers, the Docker socket behind a proxy, template-ID-only orchestrator requests.
  - Covers: NFR-ISO-01 to 04, NFR-SEC-02, 04; spikes S-3, S-15
  - Waits on: L-13.
  - Done when: From inside an instance the internet, LAN, cloud metadata, other instances, the platform, the gateway IP and host services are unreachable, tested on VM-I.

- [ ] **L-16. Concurrency, quotas, start failures and warm-pool decision**
  - Epic: `epic-orchestrator-and-instance-lifecycle`
  - Build: Start many instances at once without manual work, enforce per-user, per-company and global quotas through QuotaPort (a fake until Akshay's P-28), handle start failures, decide whether a warm pool is needed.
  - Covers: FR-INS-06, 08, 09
  - Waits on: L-13, L-14.
  - Done when: The measured number of concurrent instances and memory per instance are recorded, quotas are enforced against the fake port and failed starts are handled.

## Sprint 3 (22 Oct to 28 Oct 2026)

Goal: The edge and gate, event relay, flags, the detection sidecar, the attempt engine and scoring work end to end.

- [ ] **L-17. Edge and gate for instance access**
  - Epic: `epic-edge-gate-and-event-path`
  - Build: The labs edge terminates TLS for instance hostnames; a gate admits only the owner with a ticket and a host-only cookie, routes to the right sidecar and blocks frozen or closed instances.
  - Covers: FR-INS-10
  - Waits on: L-10, L-13, L-15.
  - Done when: A second account or an edited hostname cannot reach another user's instance, a frozen instance refuses requests, and no instance publishes a host port.

- [ ] **L-18. Event relay, ingest and one active browser session**
  - Epic: `epic-edge-gate-and-event-path`
  - Build: The edge relays signed sidecar events to ingest without giving instances a route to the platform; enforce one active browser session per candidate.
  - Covers: FR-SES-11, FR-DET-04
  - Waits on: L-03, L-17.
  - Done when: A signed event reaches ingest, a forged or replayed one is rejected, and a second browser session for the same candidate is handled as FR-SES-11 requires.

- [ ] **L-19. Flag derivation, injection and secrecy**
  - Epic: `epic-flags-detection-and-sidecar`
  - Build: Derive a unique flag per instance with a key that never enters an instance, inject at start, verify by recomputing, place decoys, keep flags out of images and logs.
  - Covers: FR-FLG-01, 02, 03, 07, 08
  - Waits on: L-13. Use a fake KeyPort until Akshay delivers the real one.
  - Done when: Two instances of the same challenge hold different flags, a reset invalidates old ones, and a CI scan finds no flag pattern in any image layer or log.

- [ ] **L-20. Coraza sidecar, automatic capture and paste**
  - Epic: `epic-flags-detection-and-sidecar`
  - Build: Coraza sidecar in detect-only mode with the OWASP Core Rule Set, flag-in-response matching, automatic capture and paste submission, fixed tags and technique detection.
  - Covers: FR-FLG-04, 05, 06, FR-DET-01, 02; spikes S-6, S-7, S-9
  - Waits on: L-18, L-19.
  - Done when: A valid flag in a response to the owning player is credited automatically, a decoy is not, the sidecar never blocks, and classifier accuracy is measured (S-6).

- [ ] **L-21. Milestone engine and evidence capture**
  - Epic: `epic-flags-detection-and-sidecar`
  - Build: Turn events into milestones M1 to M3 for all 11 challenges, negative-observation rules, evidence capture, activity metadata and bot visit evidence.
  - Covers: FR-DET-03, 05, 06, 07, 08, 09
  - Waits on: L-20 and the catalogue (Sahil, T-02).
  - Done when: Milestones fire from the events in the challenge specs for every challenge, including the C09 negative-observation rule, and evidence is stored through KeyPort.

- [ ] **L-22. Attempt state machine and server clock**
  - Epic: `epic-attempts-scoring-and-integrity`
  - Build: Attempt start, server-side clock, time warnings, expiry with auto-submit, 15-minute freeze and destroy, manual submit, no pause, one attempt, cancel.
  - Covers: FR-SES-01 to 08, FR-TIM-05
  - Waits on: L-18. Clock start (OI-22) needs your decision first.
  - Done when: An attempt moves through its states without skipping, expiry auto-submits and freezes, and a lost connection never stops the clock.

- [ ] **L-23. Scoring engine**
  - Epic: `epic-attempts-scoring-and-integrity`
  - Build: Server-side scoring from signed events: hiring formula, milestone credit, hint cost, time shown not scored, no penalty for wrong submissions, learner progress, held captures excluded.
  - Covers: FR-SCR-01 to 06, 09, 10
  - Waits on: L-21, L-22.
  - Done when: The tests reproduce every PRD Appendix A example and held captures stay out of the score until a human decides.

- [ ] **L-24. Backups, laptop fallback and remaining spikes**
  - Epic: `epic-environments-and-deployment`
  - Build: Encrypted backups to Oracle Object Storage with a restore test, the laptop fallback start procedure, and the remaining spike write-ups (S-1).
  - Covers: LE-5, LE-7, LE-8
  - Waits on: L-12 and the database from Akshay (P-06).
  - Done when: A restore test succeeds and the laptop fallback is tested on your PC.

## Sprint 4 (29 Oct to 4 Nov 2026)

Goal: Time metrics, anti-cheat, isolation proof, the end-to-end suite, the load check and the demo rehearsal.

- [ ] **L-25. Time metrics, event log and sharing signal**
  - Epic: `epic-attempts-scoring-and-integrity`
  - Build: Headline time to capture, estimated active time, resets and retries, the attempt event log (ids and metadata only), and the flag-sharing signal.
  - Covers: FR-TIM-01 to 04, FR-FLG-09
  - Waits on: L-21, L-22.
  - Done when: Time is shown beside the score, resets are counted and the event log holds only ids and metadata.

- [ ] **L-26. Reset and withdrawal during an assessment**
  - Epic: `epic-attempts-scoring-and-integrity`
  - Build: Handle a reset and a withdrawal in the middle of an assessment attempt.
  - Covers: FR-SES-09, 10
  - Waits on: L-14, L-22.
  - Done when: Both are recorded in the event log and handled as FR-SES-09 and FR-SES-10 require.

- [ ] **L-27. Anti-cheat signals and held-capture review**
  - Epic: `epic-attempts-scoring-and-integrity`
  - Build: Submission limits, activity-versus-capture check, timing anomalies, write-up similarity review, integrity signals as evidence for a human, review of held captures.
  - Covers: FR-ACH-01 to 07
  - Waits on: L-21, L-23. Reviewer for held captures (OI-38) needs a decision.
  - Done when: Held captures stay out of the score until a named reviewer decides, the decision is audited and nobody is auto-zeroed.

- [ ] **L-28. Cohort board and ranking aid**
  - Epic: `epic-attempts-scoring-and-integrity`
  - Build: The cohort view for recruiters and the ranking aid, with no global leaderboard.
  - Covers: FR-SCR-07, 08
  - Waits on: L-23. Open question OI-26: ask before building.
  - Done when: The board and aid work as the decision on OI-26 says.

- [ ] **L-29. Isolation proof and extra hardening on VM-I**
  - Epic: `epic-isolation-and-hardening`
  - Build: Add user namespaces, rootless Docker or gVisor only where tests pass; raise Docker address pools; write up spikes S-3, S-8 and S-15.
  - Covers: NFR-ISO-05 to 07; spikes S-3, S-8, S-15
  - Waits on: L-15, L-17.
  - Done when: The isolation tests pass on VM-I and the spike results record what worked and what did not.

- [ ] **L-30. End-to-end suite and load check**
  - Epic: `epic-integration-and-demo-readiness`
  - Build: An end-to-end suite for signup, instance start, a captured flag, an assessment attempt, scoring and a recruiter report on the deployed system, plus a load check.
  - Covers: LX-1, LX-2
  - Waits on: Akshay (P-32) and Sahil (T-32) deployed and merged.
  - Done when: The suite is green on the deployed system and the load numbers are recorded.

- [ ] **L-31. Demo rehearsal and submission pack**
  - Epic: `epic-integration-and-demo-readiness`
  - Build: Rehearse the demo on the laptop and online, including the fallback, and check the submission pack (report evidence, repository link, demo script).
  - Covers: LX-3, LX-4
  - Waits on: L-30.
  - Done when: A rehearsal is recorded and problems found are listed.

## Others are waiting on you

Finish these early, or tell the other developer which mock to use meanwhile.

| Your task | Needed by |
|---|---|
| L-01 Repository skeleton and tooling run end to end (tracer bullet) | P-01 (Akshay, sprint 1), T-01 (Sahil, sprint 1), T-02 (Sahil, sprint 1) |
| L-02 Instance contract v0 (IF-6) | T-03 (Sahil, sprint 1) |
| L-03 Instance event schema (IF-4), app-event names and fake ingest | T-03 (Sahil, sprint 1), T-10 (Sahil, sprint 2) |
| L-05 Lab fragment of the platform API (IF-2) with a mock | P-04 (Akshay, sprint 1) |
| L-06 Stub shop, fake ingest and lab harness | T-04 (Sahil, sprint 1) |
| L-11 Vercel project, same-origin rewrite and live-stream check | P-22 (Akshay, sprint 3), P-32 (Akshay, sprint 4) |
| L-12 Image builds for amd64 and arm64 and deploy pipelines | T-32 (Sahil, sprint 4) |
| L-13 Orchestrator creates an instance from a template | T-09 (Sahil, sprint 2) |
| L-15 Instance isolation and hardening | T-32 (Sahil, sprint 4) |
| L-16 Concurrency, quotas, start failures and warm-pool decision | P-28 (Akshay, sprint 4) |
| L-17 Edge and gate for instance access | P-32 (Akshay, sprint 4), T-32 (Sahil, sprint 4) |
| L-21 Milestone engine and evidence capture | T-27 (Sahil, sprint 4) |
| L-23 Scoring engine | P-26 (Akshay, sprint 4) |
