# Developer 1: Tanmay, Lab stream

Tanmay owns the instance plane and the assessment engine: contracts and the lab harness, the two cloud VMs (AWS Sydney, D-41), the orchestrator, isolation, the edge and gate, flags, detection, attempts, scoring and anti-cheat, and the final end-to-end checks.

| | |
|---|---|
| Ticket tree | `docs/bmad/initiative-lab/` |
| Excel tracker | `docs/bmad/VulnMart-Tracker.xlsx`, sheet "1 Tanmay (Lab)" (updated by hand) |
| Tasks | 31 tasks in 4 weekly sprints |
| Read first | [START-HERE.md](START-HERE.md): how to run every task with BMAD and Claude Code |
| Branches | one branch per sprint: `sprint-<n>-tanmay`, one pull request per sprint; tasks marked EARLY PR get their own small pull request `shared-<task-id>` |
| Status | Draft plan written 2026-10-08 by Claude Code; not yet approved by the team |

## How to work from this file

1. Take the next unticked task whose "Waits on" items are done. If a wait is on another developer, use the mock or fake named in the task and carry on; do not stop. One task at a time.
2. Create the story with `bmad-ticket`, build it with `bmad-build`, review it, test it. The line "BMAD story" under each task says whether the story already exists. A task that is too big may become more than one story.
3. When the tests have really passed: tick the box below, update the story state in `docs/bmad/initiative-lab/`, write the dev-log entry, changelog line and traceability rows, then commit.
4. Update the Excel sheet by hand (Done = Yes).

Sprint dates are a proposal: the final submission is in the first week of November (exact date not yet given). The exact acceptance criteria of each task are written when the task starts. Open questions named in a task (OI-xx) must be answered by the team before that part is built.

## Sprint overview

| Sprint | Dates | Goal | Tasks |
|---|---|---|---|
| 1 | 8 Oct to 14 Oct 2026 | Contracts v1, the lab harness and the two AWS hosts in Sydney exist (hosting moved from Oracle, see D-41), so the other two streams can build against stable contracts and fakes. | L-01 to L-08 (8) |
| 2 | 15 Oct to 21 Oct 2026 | Instances start, reset, tear down and are isolated; the deployment pipeline works (Vercel, certificates, image builds). | L-09 to L-16 (8) |
| 3 | 22 Oct to 28 Oct 2026 | The edge and gate, event relay, flags, the detection sidecar, the attempt engine and scoring work end to end. | L-17 to L-24 (8) |
| 4 | 29 Oct to 4 Nov 2026 | Time metrics, anti-cheat, isolation proof, the end-to-end suite, the load check and the demo rehearsal. | L-25 to L-31 (7) |

## Sprint 1 (8 Oct to 14 Oct 2026)

Goal: Contracts v1, the lab harness and the two AWS hosts in Sydney exist (hosting moved from Oracle, see D-41), so the other two streams can build against stable contracts and fakes.

- [x] **L-01. Repository skeleton and tooling run end to end (tracer bullet)**
  - Epic: `epic-lab-baseline`
  - BMAD story: already planned, ref `1.1` in `epic-lab-baseline` (find it with `bmad-ticket`)
  - EARLY PR: yes. P-01, T-01, T-02 (another developer, same sprint) wait on it, so merge it through its own pull request as soon as it is done.
  - Build: Monorepo with uv and pnpm workspaces and pinned tools, CI skeleton, CODEOWNERS, Compose profiles and `scripts/dev.mjs`; check Docker on your PC (WSL and Docker data on D:, memory cap).
  - Covers: LB-1, LB-2
  - Waits on: Nothing. This is the first task of the whole project.
  - Done when: `node scripts/dev.mjs hello` starts a hello container on your PC and the CI skeleton runs green on a pull request.
  - Audit 2026-10-18: VERIFIED. Pins, hello stack and CI green on pull requests. No branch protection on main. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-02. Instance contract v0 (IF-6)**
  - Epic: `epic-lab-baseline`
  - BMAD story: already planned, ref `1.2` in `epic-lab-baseline` (find it with `bmad-ticket`)
  - EARLY PR: yes. T-03 (another developer, same sprint) wait on it, so merge it through its own pull request as soon as it is done.
  - Build: Write the contract every in-instance service obeys: containers, env, health, labels, injection protocol and runtime profile.
  - Covers: LB-3
  - Waits on: L-01.
  - Done when: The contract validates and Sahil has approved it as consumer.
  - Closed with (2026-10-11): the contract validates; "Sahil has approved it" was waived by D-37 (review optional during initial development) and is not met; handoffs H-24 to H-35 are open.
  - Audit 2026-10-18: VERIFIED. IF-6 validates (7 valid, 192 invalid examples); Sahil approved at 1.0.0 (COMPAT). Owner rows are part of L-09. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-03. Instance event schema (IF-4), app-event names and fake ingest**
  - Epic: `epic-lab-baseline`
  - BMAD story: already planned, ref `1.3` in `epic-lab-baseline` (find it with `bmad-ticket`)
  - EARLY PR: yes. T-03 (another developer, same sprint) wait on it, so merge it through its own pull request as soon as it is done.
  - Build: Define the signed events that sidecars and the shop send to ingest, the list of app-event names, and a fake ingest that validates them.
  - Covers: LB-4
  - Waits on: L-02.
  - Done when: Every example event validates and the fake ingest rejects a malformed or oversize one.
  - Handoffs: H-82 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Audit 2026-10-18: VERIFIED. 29 valid events, 69 invalid refused, fake ingest 44 of 44. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-04. Orchestrator API (IF-5), InstanceHost protocol and fake orchestrator**
  - Epic: `epic-lab-baseline`
  - BMAD story: already planned, ref `1.4` in `epic-lab-baseline` (find it with `bmad-ticket`)
  - Build: Write the orchestrator HTTP contract, the InstanceHost protocol the orchestrator drives, and a fake orchestrator with a FakeInstanceHost.
  - Covers: LB-5
  - Waits on: L-01.
  - Done when: A client built from the contract creates, resets and destroys instances against the fake, and the fake host passes the protocol tests the real one must pass later.
  - Closed with (2026-10-11): met locally with a hand-written client (not generated); the GitHub CI run of the new jobs has never happened; tracked in `docs/dev/sprint-1-pr-checklist.md`.
  - Handoffs: H-82 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Audit 2026-10-18: VERIFIED with a caveat: the fake host passes the protocol tests; the client is hand-written, not generated from the contract. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-05. Lab fragment of the platform API (IF-2) with a mock**
  - Audit 2026-10-19: TICKED. The fragment validates (`check_lab_contract.py`: 20 operations, 41 valid and 101 invalid examples), the mock answers every operation (`apps/api/tests/test_lab_contract.py` 186 passed, `scripts/fake-lab.test.mjs` 8 passed), the real API serves the same routes and passes the same schemas (`test_lab_api.py`, deployed journey 34 of 34), and stream P read it as consumer (`docs/reviews/2026-10-12-p08-contract-sign-off.md`, condition F-2 met). Still open and not part of this task: the formal COMPAT.md sign-off rows (L-09), handoffs H-84 to H-89 confirmations, ADR 0019 is still Proposed (the developer accepts it).
  - Epic: `epic-lab-baseline`
  - BMAD story: already planned, ref `1.9` in `epic-lab-baseline` (find it with `bmad-ticket`)
  - EARLY PR: yes. P-04 (another developer, same sprint) wait on it, so merge it through its own pull request as soon as it is done.
  - Build: Write the endpoints the lab provides to the platform (attempts, instances, reports) as an API fragment and a mock.
  - Covers: LB-9
  - Waits on: L-01.
  - Done when: The fragment validates, the mock answers every endpoint and Akshay has reviewed it as consumer.
  - Closed with (2026-10-11): the fragment validates and the mock answers every endpoint; "Akshay has reviewed it as consumer" was waived by D-37 and is not met; handoffs H-84 to H-89 are open; ADR 0019 is still Proposed.
  - Handoffs: H-78 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Audit 2026-10-18: WAITING ON Akshay: his consumer review of IF-2 is pending; ADR 0019 is still Proposed. Our side (fragment, mock, checks) is done. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-06. Stub shop, fake ingest and lab harness**
  - Epic: `epic-lab-baseline`
  - BMAD story: already planned, ref `1.5` in `epic-lab-baseline` (find it with `bmad-ticket`)
  - EARLY PR: yes. T-04 (another developer, same sprint) wait on it, so merge it through its own pull request as soon as it is done.
  - Build: A tiny stub shop that meets the instance contract, and a Compose harness that starts one full instance with pass-through sidecar, edge and gate stubs and an injection step.
  - Covers: LB-6
  - Waits on: L-02, L-03, L-04.
  - Done when: One command starts a full stub instance on a laptop: it answers health, becomes ready only after the injection marker, serves a planted flag, emits one app event the fake ingest validates, and passes the contract conformance check.
  - Closed with (2026-10-11): met locally on one PC; the GitHub CI run of the `compose` job has never happened; tracked in `docs/dev/sprint-1-pr-checklist.md`.
  - Handoffs: H-74 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Audit 2026-10-18: VERIFIED. Harness and conformance run in CI (jobs compose and e2e), green. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-07. Contract checks live in CI**
  - Epic: `epic-lab-baseline`
  - BMAD story: already planned, ref `1.6` in `epic-lab-baseline` (find it with `bmad-ticket`)
  - Build: Add the contract checks to CI (schema validity, breaking change, bundle current, mock validity, provider conformance, migrations, table ownership, compatibility file), including the ownership and single-Alembic-head checks the other streams rely on.
  - Covers: LB-7
  - Waits on: L-02, L-03, L-04.
  - Done when: A deliberately breaking contract change fails CI and a valid one passes.
  - Closed with (2026-10-11): proven by the local tests and a Linux container run; job `contract-rules` has never run as a pull request on GitHub; tracked in `docs/dev/sprint-1-pr-checklist.md`.
  - Handoffs: H-73 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Audit 2026-10-18: VERIFIED. Checker with 84 tests; trusted (base) and head runs green on GitHub. A breaking pull request going red on GitHub is not recorded. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-08. AWS account (Sydney), two VMs, private link and firewall** (was Oracle; see D-41)
  - Epic: `epic-environments-and-deployment`
  - BMAD story: not planned yet; created when you incept `epic-environments-and-deployment` (see START-HERE.md, section "First task of an epic")
  - Build: Create VM-P and VM-I, a private link between them, key-only SSH and only ports 80 and 443 public; keep-alive and budget alert; send the Oracle terms-of-service email.
  - Covers: LE-1, LE-6; spikes S-11, S-17
  - Waits on: Decision on who owns the Oracle account (Q-32).
  - Done when: Both VMs are reachable by key-only SSH, only 80, 443 and SSH are open, the private link works, and the account owner, budget alert and keep-alive routine are written down.
  - Closed with (2026-10-11): the hosts were built and checked live (verify-hosts 94 checks, private-link-check 22); open: budget alert e-mail unconfirmed, only one developer key installed, stop and start rehearsal and idle observation not done; tracked in `docs/dev/sprint-1-pr-checklist.md`.
  - Handoffs: H-68 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Audit 2026-10-18: OPEN (human). Hosts, firewall and private link are real. Budget e-mail unconfirmed; only one developer key installed; stop/start rehearsal not done; keep-alive off; Terraform state is one local file; ports 80/443 are open only to the developer's own IP (audit B3). Details: docs/audit/2026-10-18-lab-stream-audit.md

## Sprint 2 (15 Oct to 21 Oct 2026)

Goal: Instances start, reset, tear down and are isolated; the deployment pipeline works (Vercel, certificates, image builds).

Truth summary (2026-10-13): built and verified locally: L-09 preparation and release commit, L-10 to L-13 code. NOT built: L-14, L-15, L-16.

- [ ] **L-09. Tag contracts v1.0.0 and start the change rules**
  - Audit 2026-10-19: versions and release labels are PASS in the dry-run (COMPAT.md real versions incl. IF-1 1.1.0 and DB 2.1.0 after Akshay's P-25, rule amended); still open: 18 pending sign-offs and 19 of 62 checklist lines (H-352 asks Akshay and Sahil), then the tag.
  - Unticked 2026-10-18 on the developer's instruction after a code-based status check: the tag contracts-v1.0.0 does not exist and the COMPAT.md approvals are pending, so the Done-when is not met.
  - Closed 2026-10-12 on the developer's instruction. Release commit done 2026-10-13 (0a2a43b). NOT met: tag contracts-v1.0.0 does not exist; all 19 COMPAT.md Approvals rows pending (Akshay, Sahil, and Tanmay's own); the approvals rule is NOT-APPLICABLE until the tag; handoff checklist has 27 unticked lines (node scripts/tag-contracts.mjs --dry-run).
  - Epic: `epic-lab-baseline`
  - BMAD story: already planned, ref `1.7` in `epic-lab-baseline` (find it with `bmad-ticket`)
  - Build: Collect every contract owner approval, write COMPAT.md, tag `contracts-v1.0.0` and turn the change rules on. Settle branch protection on the private repository (EF-30) or use the CI approvals check.
  - Covers: LB-8
  - Waits on: L-05, L-06, L-07 and the sign-offs of Akshay (P-08) and Sahil (T-03).
  - Done when: The tag exists, COMPAT.md lists the versions every stream targets and the approvals check is active.
  - Handoffs: H-58, H-80, H-81, H-82, H-114 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Status 2026-10-11 (story 1.7): everything that needs no other stream is built and tested (COMPAT.md, the CI approvals rule, the tag script, Tanmay's handoffs, ADR 0029, runbook); NOT met (ticked on the developer's instruction): the tag `contracts-v1.0.0` waits for the sign-offs of Akshay (P-08) and Sahil (T-03), the open checklist boxes and the release commit (relabel 1.0.0). Run `node scripts/tag-contracts.mjs --dry-run`.
  - Audit 2026-10-18: WAITING ON Akshay (P-08), Sahil (T-03) and Tanmay (own rows): no tag contracts-v1.0.0; 16 approval rows pending; COMPAT.md is stale (IF-2 1.0.1, DB 2.0.0); no branch protection. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-10. DuckDNS names and certificates**
  - Live 2026-10-17 (L-10 Done-when MET): S-16 recorded (a random label under the labs name resolves to the vm-i address), real Let's Encrypt certificates issued on both hosts (`tanmay-platform-prod.duckdns.org` on vm-p, `*.tanmay-labs-prod.duckdns.org` on vm-i; 89 days left), the renewal timer is enabled on both and one real renewal worked (docs/assets/l-10-certificates/live-run.txt). Fixed live: the script used the wrong lego v5 syntax, and the hosts need `LEGO_EXTRA_ARGS=--dns.propagation.disable-ans` (they reach only the VPC resolver). Still open for L-11 and L-17: Caddy does not mount the files yet (the reload hook finds no container), H-115 file ownership.
  - Domain decision 2026-10-17 (developer): there is no custom domain, only AWS credit and Vercel. The plan stands unchanged: two free DuckDNS names (labs wildcard by DNS-01, platform) on the AWS hosts, and the free `*.vercel.app` name for the site with the same-origin rewrite to the platform DuckDNS name. First live check is S-16 (does `*.<labs-name>.duckdns.org` resolve); if it fails, research a fallback before any certificate work.
  - Closed 2026-10-12 on the developer's instruction (ticked on the developer's instruction, live steps open). Still open (developer, live): DuckDNS names, lego staging then production, renewal, S-16 result. NOT met: Done-when (real certificates issued and renewing, S-16 recorded).
  - Epic: `epic-environments-and-deployment`
  - BMAD story: not planned yet; created when you incept `epic-environments-and-deployment` (see START-HERE.md, section "First task of an epic")
  - Build: Register the platform and labs DuckDNS names, issue a certificate for the platform host and a wildcard certificate for the labs name (DNS-01), automatic renewal.
  - Covers: LE-2; spike S-16
  - Waits on: L-08.
  - Done when: Real certificates are issued and renew automatically; the S-16 result (wildcard resolution) is recorded.
  - Status 2026-10-11 (story 2.2): the host scripts, the timer, the pinned lego installer, the cloud-init wiring, the S-16 check script, ADR 0030, decision D-49 (Proposed) and the runbook `docs/runbooks/certificates.md` are built and tested against stubs (and on Linux in Docker). NOT met (ticked on the developer's instruction): the live steps are the developer's (DuckDNS accounts and names, token files on the hosts, staging then production issuance, one real renewal, the S-16 result). Tick L-10 only after the real redacted results are pasted.
  - Audit 2026-10-18: OPEN. Real certificates, one real renewal on vm-p. The reload hook was broken (it restarted a container that does not exist): fixed and deployed on 2026-10-18 (audit B2); a forced renewal on vm-i is still to be proved; no alert on a failed renewal. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-11. Vercel project, same-origin rewrite and live-stream check**
  - Audit 2026-10-19: NOT TICKED, and one claim of the 2026-10-18 line below no longer holds. The probe alias answers through the rewrite (health 200), but the public demo site is now served straight from vm-p with no origin-secret check on the pages and the API, so "direct access to the VM without the secret is refused" is false for the demo configuration. S-14 itself says plan A holds (the stream is not buffered), so `createLiveTicket` in IF-1 should be removed (H-353 asks Akshay; it is his contract). The production dashboards (P-26 to P-30) are not built; `apps/web` is a skeleton.
  - Live 2026-10-18 (L-11 Done-when MET): the throwaway Vercel project reaches the API through `/api/*` (production alias, real Let's Encrypt certificate on vm-p, Caddy gate), a request straight to vm-p without the secret is 403, and S-14 is recorded: all ten checks pass (stream not buffered, held 129 s, cookies pass, secret cannot be spoofed, no shared cache) on the shape in `infra/vercel/s14-probe/vercel.json`, which now also needs the route-level header `x-vercel-enable-rewrite-caching: 0` (found live: the shared cache leaked one visitor's answer to another until then; validator and template updated, tests 27 passed). Details and the byte-order-mark trap: `docs/research/s-14-vercel-sse.md`. Port 443 was opened to the internet for the run only and closed again. NOT met: the real project from Akshay's dashboards (P-07), the API's timing-safe re-check and heartbeat (H-116).
  - Closed 2026-10-12 on the developer's instruction (ticked on the developer's instruction, live steps open). Still open: live Vercel S-14 run; wiring with Akshay P-07; port 443 via public_web_cidrs. NOT met: Done-when (site reaches the API through /api/*, S-14 recorded).
  - Epic: `epic-environments-and-deployment`
  - BMAD story: not planned yet; created when you incept `epic-environments-and-deployment` (see START-HERE.md, section "First task of an epic")
  - Build: Create the Vercel project with the rewrite config from Akshay, the origin secret and the origin-secret check in the platform Caddy; run the SSE-through-rewrite test on the real VM.
  - Covers: LE-3; spike S-14
  - Waits on: L-10 and Akshay's dashboards skeleton (P-07).
  - Handoffs: H-116, H-117 (see docs/dev/HANDOFFS.md; added by the preparation story, 2026-10-11)
  - Done when: The Vercel site reaches the API through `/api/*`, direct access to the VM without the secret is refused, and the S-14 result is recorded.
  - Handoffs: H-113, H-129, H-131 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Status 2026-10-12 (story 2.3): the Caddy origin-secret gate, the stock Caddy edge for vm-p, the Vercel probe project with the `routes` header transform, the S-14 check script, ADR 0031, decision D-50 (Proposed) and the runbook `docs/runbooks/vercel-and-origin.md` are built and tested with real Caddy in Docker (including TLS) and stand-in proxies. NOT met (ticked on the developer's instruction): the live steps are the developer's (Vercel login and project, sensitive environment variable, secret files on vm-p, port 443, the S-14 run) and the real wiring waits for Akshay's P-07 and the live certificates of L-10.
  - Audit 2026-10-18: WAITING ON Akshay (P-07): only a throwaway Vercel probe exists; the real site is not deployed. S-14 recorded. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-12. Image builds for amd64 and arm64 and deploy pipelines**
  - Unticked 2026-10-18 on the developer's instruction after a code-based status check: no recorded run shows a hello stack from CI on both VMs and the laptop, so the Done-when is not met.
  - Closed 2026-10-12 on the developer's instruction (ticked on the developer's instruction, live steps open). arm64 not built (D-51 amends LE-4); only amd64 is in scope. Still open (developer, live): run images workflow on GitHub, make the hello package public, deploy to both VMs and laptop. NOT met: Done-when (hello stack from CI on both VMs and the laptop).
  - Epic: `epic-environments-and-deployment`
  - BMAD story: not planned yet; created when you incept `epic-environments-and-deployment` (see START-HERE.md, section "First task of an epic")
  - Build: CI builds images for amd64 and natively for arm64 on the VM, and a deploy step puts them on both VMs.
  - Covers: LE-4
  - Waits on: L-08, L-07.
  - Handoffs: H-118 (how to add an image; added by the story, 2026-10-12). Preparation done and tested locally (story plan, ADR 0032, D-51, runbook `docs/runbooks/deploy.md`); NOT met (ticked on the developer's instruction): the workflow run, the public package and the deploy to both VMs and the laptop are yours.
  - Done when: A hello stack from CI runs on both VMs and on the laptop.
  - Audit 2026-10-18: OPEN. images.yml builds and pushes amd64 only; there is no deploy pipeline (deploy is scripts/live-deploy.mjs from the developer's PC); arm64 dropped by D-51. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-13. Orchestrator creates an instance from a template**
  - Live 2026-10-17 (S-4): cold start measured on vm-i with the STUB image (median 2.12 s, p95 2.81 s, 10 rounds; about 30 MiB per instance; evidence `docs/assets/orchestrator-measure/vm-i-s4-measure-result.json`, `docs/research/s4-cold-start-and-memory.md`). The Done-when "cold-start time measured and recorded" is met for the stub; the real shop images (T-04, L-12) will be heavier and must be measured again.
  - Closed 2026-10-12 on the developer's instruction. Done-when NOT met: S-4 not measured on vm-i (developer run, runbook `docs/runbooks/measure-instances.md`); reset (3.4) and reconciler (3.5) belong to L-14. ONE sprint PR carries L-13 too (branch shared-L-13 is not pushed); Sahil's T-09 waits for this PR being merged, tell him then.
  - Epic: `epic-orchestrator-and-instance-lifecycle`
  - BMAD story: not planned yet; created when you incept `epic-orchestrator-and-instance-lifecycle` (see START-HERE.md, section "First task of an epic")
  - EARLY PR: yes, but decided 2026-10-13: ONE sprint PR carries L-13 too (the branch shared-L-13 is not pushed). T-09 (Sahil, same sprint) waits for that PR to be merged.
  - Build: Create a private instance on request from a template, wait for health and flag injection, track its state in a state machine.
  - Covers: FR-INS-01, 02, 07, 11; spike S-4
  - Waits on: L-04, L-08.
  - Done when: An instance is never shown ready before flag injection finished and the cold-start time is measured and recorded (S-4).
  - Handoffs: H-57, H-58, H-59, H-60, H-61, H-64, H-66, H-67, H-68, H-69, H-70, H-71, H-72, H-79 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Status (2026-10-12): engine done (state machine, builder, Docker backend, create and destroy; tests on a fake and on real Docker). Story 3.2 built the same day (the IF-5 service: signing, mTLS options, strict JSON, rate limit, capacity, accept and run, state reports, test backend, Dockerfile; the contract suites of apps/api pass against it; ADR 0034, D-53). NOT met (ticked on the developer's instruction): reset and idle detection (story 3.4), the reconciler (3.5) and the cold-start measurement S-4 are open, and the stories wait for review and the developer's confirmation.
  - Audit 2026-10-19: VERIFIED on the real shop. Readiness only after the injector marker; the orchestrator now creates instances of the REAL shop (real injector built, handoff H-350), ready in 6.1 s from the request on vm-i, 30 of 30 in the deployed journey. S-4 on the old stub numbers (median 2.1 s) is superseded by this live figure. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-14. Reset, teardown, timing defaults and reconciler**
  - Audit 2026-10-19 (limits): the lab was putting 1440 idle and 1440 total minutes into every instance, so abandoned instances held slots for a day (the load check left five of seven slots busy after 68 minutes). Fixed in code: 60 and 240 for a learner, longer for a candidate (`LabRuntime._limits_for`, tests). NOT proved live: an instance destroyed after 60 idle minutes (needs the deploy of this change and an hour of waiting); the kill test of the Done-when is still not run.
  - Epic: `epic-orchestrator-and-instance-lifecycle`
  - BMAD story: not planned yet; created when you incept `epic-orchestrator-and-instance-lifecycle` (see START-HERE.md, section "First task of an epic")
  - Build: Reset with new flags, tear down at expiry or inactivity, and a reconciler that repairs any difference between recorded and real state.
  - Covers: FR-INS-03, 04, 05; spike S-13
  - Waits on: L-13.
  - Done when: Learner instances stop after 60 minutes idle or 4 hours total; killing the orchestrator mid-provision leaves no orphans after the reconciler runs.
  - Handoffs: H-59, H-61, H-65, H-67 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Status (2026-10-16): ticked on the developer's instruction to complete sprint 2 from our side. Stories 3.4 (reset, reaper, settings; ADR 0035, D-54) and 3.5 (reconciler, tombstones, startup gate; ADR 0036, D-55) are built, reviewed with four lenses and tested locally (orchestrator 406 tests, shared protocol suites 392 passed, real-Docker kill test: no orphan after the first pass). NOT met live: nothing ran on vm-i; the platform activity signal and the desired-state list are open (H-122, H-123, Akshay); the stories stay `built` until the developer confirms them. Open leftovers are in `docs/bmad/initiative-lab/deferred-work.md`.
  - Audit 2026-10-19: OPEN. Blocker B1 fixed and live: the platform now reports player activity to the orchestrator (IF-5 1.1.0, signed route; the deployed journey shows the instance `active` after play). Not yet run live: an instance actually destroyed after its idle limit without play and kept alive with play; the reconciler's all-wanted desired state (H-123, Akshay); no live kill test. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-15. Instance isolation and hardening**
  - Live 2026-10-17 (partial, not ticked): on vm-i the baseline isolation probe PASSES with the host rule on (16 forbidden targets blocked, control reached, gateway rows timeout; `docs/assets/story-4-1-isolation-probe/vm-i-rule-on.json`). NOT done: S-3 host rule off (the auto-mode safety check refused the script; the developer runs steps 5 to 7 of `docs/runbooks/isolation-vm-i.md`), the subnet check 3b, Docker restart and reboot (steps 8 and 9), the port scan, S-15 with 20 instances, the socket proxy in front of the orchestrator on vm-i.
  - Epic: `epic-isolation-and-hardening`
  - BMAD story: not planned yet; created when you incept `epic-isolation-and-hardening` (see START-HERE.md, section "First task of an epic")
  - Build: Internal networks with no route out, a host rule that drops instance-to-host traffic, hardened containers, the Docker socket behind a proxy, template-ID-only orchestrator requests.
  - Covers: NFR-ISO-01 to 04, NFR-SEC-02, 04; spikes S-3, S-15
  - Waits on: L-13.
  - Done when: From inside an instance the internet, LAN, cloud metadata, other instances, the platform, the gateway IP and host services are unreachable, tested on VM-I.
  - Handoffs: H-62, H-71 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Ticked 2026-10-18: the Done-when (unreachable from inside an instance, tested on VM-I) is met by the live probe PASS, S-3 answer, restart and reboot persistence, port scan and audit 8 PASS (L-29 part 1). Not measured: 20 real instances through the orchestrator (S-15 was emulated).
  - Status (2026-10-16, superseded): NOT ticked. Stories 4.1 (isolation probe from inside a real instance network, conformance rules, VM-I runbook `docs/runbooks/isolation-vm-i.md`; ADR 0037, D-57) and 4.2 (Docker socket behind a filtering proxy, compose rule on a real YAML parse; ADRs 0010 and 0038, D-58) are built, reviewed and tested on Docker Desktop (the probe reports 16 forbidden targets blocked and the control reached). Done-when needs the developer's run on VM-I (S-3 host rule on and off, S-15, the proxy in front of the orchestrator): runbook steps, handoff H-125. Tick when the evidence is saved.
  - Audit 2026-10-19: VERIFIED live. Blocker B4 fixed: the labs chain accepts no tcp/443 for containers and drops traffic between container networks; the probe on vm-i passes 18 of 18 forbidden targets (peer network on 80/443, the platform event port, gateway, metadata, LAN, public) with the control reached and nothing left over; host audit 9 PASS. The probe uses the network profile the orchestrator builds, not an orchestrator-made instance. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-16. Concurrency, quotas, start failures and warm-pool decision**
  - Closed 2026-10-17 after a live run on vm-i (Claude over SSH, developer's authorisation): 10 and 20 stub instances started at once, 10 of 10 and 20 of 20 ready, 0 failed, 0 refused, wall 8.0 s and 16.1 s, p95 ready 8.0 s and 16.1 s, build cap held at 4, about 30 MiB per instance, nothing left behind (`docs/assets/story-3-6-concurrency-quotas/vm-i-concurrent-10.json`, `-20.json`); quotas and failed starts were proven locally (story 3.6). ADR 0039 stays accepted: no warm pool unless the real shop's p95 exceeds 30 s or a start is refused. NOT met: numbers with the real images (T-04, L-12), the real InstancePort and quota numbers (Akshay, H-79, H-126).
  - Epic: `epic-orchestrator-and-instance-lifecycle`
  - BMAD story: not planned yet; created when you incept `epic-orchestrator-and-instance-lifecycle` (see START-HERE.md, section "First task of an epic")
  - Build: Start many instances at once without manual work, enforce per-user, per-company and global quotas through QuotaPort (a fake until Akshay's P-28), handle start failures, decide whether a warm pool is needed.
  - Covers: FR-INS-06, 08, 09
  - Waits on: L-13, L-14.
  - Done when: The measured number of concurrent instances and memory per instance are recorded, quotas are enforced against the fake port and failed starts are handled.
  - Handoffs: H-66, H-79 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Status (2026-10-16): NOT ticked. Story 3.6 (build cap, one start retry, quotas through the fake QuotaPort with INST-QUOTA-REACHED, `measure.py --concurrent`; ADR 0039 warm pool Proposed, D-59) is built, reviewed and tested locally (a local run: 3 of 3 ready in about 7.6 s, local only). Done-when needs the measured concurrency and memory per instance on vm-i (runbook `docs/runbooks/measure-instances.md` step 7) and the developer's confirmation of the warm-pool ADR; the real InstancePort and the quota numbers are with Akshay (H-79, H-126).
  - Audit 2026-10-18: VERIFIED on the stub image (20 of 20 ready in 16.1 s live; build cap and retry; quotas enforced at the platform against the fake port). Capacity numbers are stub numbers. Details: docs/audit/2026-10-18-lab-stream-audit.md

## Sprint 3 (22 Oct to 28 Oct 2026)

Goal: The edge and gate, event relay, flags, the detection sidecar, the attempt engine and scoring work end to end.

- [x] **L-17. Edge and gate for instance access**
  - Closed 2026-10-17 on the developer's instruction after local proof (edge e2e 11 passed on Docker Desktop, orchestrator attaches the edge and pushes access state: 458 orchestrator tests, real-Docker test_edge_attach.py). NOT met live: vm-i run, real certificate, real browser, gate admin reachability: decided 2026-10-17, orchestrator runs as a container on labs-core and is proven locally (H-343 answered, open points in H-347); D-60 to D-68 and ADR 0004 still Proposed.
  - Epic: `epic-edge-gate-and-event-path`
  - BMAD story: not planned yet; created when you incept `epic-edge-gate-and-event-path` (see START-HERE.md, section "First task of an epic")
  - Build: The labs edge terminates TLS for instance hostnames; a gate admits only the owner with a ticket and a host-only cookie, routes to the right sidecar and blocks frozen or closed instances.
  - Covers: FR-INS-10
  - Waits on: L-10, L-13, L-15.
  - Done when: A second account or an edited hostname cannot reach another user's instance, a frozen instance refuses requests, and no instance publishes a host port.
  - Status 2026-10-17 (earlier status, superseded by the Closed line): gate core (contract `GATE` 0.1.0, `apps/edge` library, admin handlers, 77 tests) and edge service (Caddy, gate service, relay, compose, 11 end-to-end tests with 20 internal networks on Docker Desktop) are built, local proof only. Not done: the orchestrator attaching the edge and pushing access state, the vm-i run, a real certificate, a real browser, the developer's confirmation of D-60 to D-68 and ADR 0004. Handoffs H-336 to H-339.
  - Audit 2026-10-18: VERIFIED. Gate tests 96 of 96; live: wildcard certificate, ticket once only, forged ticket refused, no instance port published. Not run live: a second account against another's instance. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-18. Event relay, ingest and one active browser session**
  - Audit 2026-10-19: TICKED. The platform half of FR-SES-11 is built (H-341): a new login raises the access epoch of the account's live instances (`LabRuntime.bump_access_for_user`, hook in `SessionService.open_session`, retried by the tick when the orchestrator is away; tests `apps/api/tests/test_login_bump.py` 3 passed). Proved on the deployed system (vm-i gate, `docs/assets/production-readiness/e2e-run14-login-bump.json`, 34 of 34): after a second login the older tab gets 403 at the gate and the new login gets a working ticket. Signed relay, forged and replayed refusal were already proved (ingest-relay e2e). Not done on purpose: the platform's older sessions are not ended (the user's session list is P-12; H-353 asks Akshay).
  - Closed 2026-10-17 after local proof: signed event relayed to the real ingest verifier, forged and replayed refused (ingest-relay e2e), second session handled by the access epoch (apps/edge session-epoch test, 7 passed). NOT met: the platform half of FR-SES-11 (login bump, H-341) and the vm-i run.
  - Epic: `epic-edge-gate-and-event-path`
  - BMAD story: not planned yet; created when you incept `epic-edge-gate-and-event-path` (see START-HERE.md, section "First task of an epic")
  - Build: The edge relays signed sidecar events to ingest (with replay and signature checks) without giving instances a route to the platform; enforce one active browser session per candidate.
  - Covers: FR-SES-11
  - Waits on: L-03, L-17.
  - Done when: A signed event reaches ingest, a forged or replayed one is rejected, and a second browser session for the same candidate is handled as FR-SES-11 requires.
  - Handoffs: H-64, H-75 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Status 2026-10-17 (earlier status, superseded by the Closed line): the event relay is built and tested locally (edge story 2, D-64). Not built: the real ingest verifier, one active browser session end to end, the vm-i runbook. H-75 partly answered; H-338.
  - Audit 2026-10-18: WAITING ON Akshay: the platform half of FR-SES-11 (login bumps the access epoch, H-341). Relay, signatures and replay checks are verified. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-19. Flag derivation, injection and secrecy**
  - Audit 2026-10-19 (CI): the scan is now a CI step (`images.yml`: `--load`, then `node scripts/scan-flags.mjs --image` for every image of a pull request; workflow shape test). Local scan of the shop, mock-services, import-service and bot images: CLEAN. Still open: a scan of a running instance on vm-i (the script needs docker on that host) and the decoy placement list (H-331).
  - Closed 2026-10-17 after local proof: two instances get different flags, a reset invalidates the old ones (test_lab_loop.py), flag leak scan built (scripts/scan-flags.mjs). NOT met: the real KeyPort and real InstancePort (Akshay), a scan of vm-i, decoy placement in the catalogue (H-331).
  - Epic: `epic-flags-detection-and-sidecar`
  - BMAD story: not planned yet; created when you incept `epic-flags-detection-and-sidecar` (see START-HERE.md, section "First task of an epic")
  - Build: Derive a unique flag per instance with a key that never enters an instance, inject at start, verify by recomputing, place decoys, keep flags out of images and logs.
  - Covers: FR-FLG-01, 02, 03, 07, 08
  - Waits on: L-13. Use a fake KeyPort until Akshay delivers the real one.
  - Done when: Two instances of the same challenge hold different flags, a reset invalidates old ones, and a CI scan finds no flag pattern in any image layer or log.
  - Handoffs: H-63 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Status 2026-10-17 (earlier status, superseded by the Closed line): flag material builder, checker and leak scan are built and tested locally with the fake KeyPort (story 6.1). Not done: the real `InstancePort` calling them, the real KeyPort, a scan of a full orchestrator-made instance and of vm-i, decoy placement in the catalogue. H-63 answered in part; H-330, H-331.
  - Audit 2026-10-19: OPEN (one item). Flags derived and planted by the real injector, two rounds hold different flags and a reset invalidates the old one (live, real shop), key service real. Still open: the CI flag-pattern scan is a script, not a CI job (L-19 Done-when). Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-20. Coraza sidecar, automatic capture and paste**
  - Closed 2026-10-17 after local proof: the Coraza and Core Rule Set helper (story 6.5) is built into the sidecar image and S-6 is measured (15 of 32 exploits seen, 0 of 60 benign flagged, sidecar suite 69 passed, Go tests passed, re-run by the coordinator). The sidecar never blocks (tests). NOT met: nothing on vm-i, no full compose harness run with the product image; the accuracy is mixed so `classifier_accuracy_verified` stays false (your decision); CRS is 4.25.0 (newest Go module; upstream 4.30.0 exists, loading it needs the release tarball in the image build), the PRD names 4.30.0.
  - Epic: `epic-flags-detection-and-sidecar`
  - BMAD story: not planned yet; created when you incept `epic-flags-detection-and-sidecar` (see START-HERE.md, section "First task of an epic")
  - Build: Coraza sidecar in detect-only mode with the OWASP Core Rule Set, flag-in-response matching, automatic capture and paste submission, fixed tags and technique detection.
  - Covers: FR-FLG-04, 05, 06, FR-DET-01, 02, 04; spikes S-6, S-7, S-9
  - Waits on: L-18, L-19.
  - Done when: A valid flag in a response to the owning player is credited automatically, a decoy is not, the sidecar never blocks, and classifier accuracy is measured (S-6).
  - Handoffs: H-76 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Status 2026-10-17 (not ticked): the product sidecar and its image are built, 49 of 49 tests passed on Docker Desktop, S-9 table written (story 6.2); the paste service exists as a library (story 6.3). Not built: the Coraza and Core Rule Set helper, classifier accuracy (S-6), the full harness run with the product image, any run on vm-i. H-76 and H-94 answered as built; H-332.
  - Audit 2026-10-18: VERIFIED with limits: automatic capture credited live, S-6 measured. Detection is hint-level (15 of 16 request-visible exploits; the logic-bug challenges depend on shop events from Sahil). Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-21. Milestone engine, evidence capture and sharing signal**
  - Closed 2026-10-17 after local proof: milestone engine with 33 rules for all 11 challenges, C09 negative-observation rule, evidence sealed through KeyPort (fake), activity metadata and bot visits wired into the runtime. NOT met: the real tables and worker (H-330), the real catalogue (Sahil T-02/T-30).
  - Epic: `epic-flags-detection-and-sidecar`
  - BMAD story: not planned yet; created when you incept `epic-flags-detection-and-sidecar` (see START-HERE.md, section "First task of an epic")
  - Build: Turn events into milestones M1 to M3 for all 11 challenges, negative-observation rules, evidence capture, activity metadata, bot visit evidence and the flag-sharing signal.
  - Covers: FR-DET-03, 05, 06, 07, 08, 09, FR-FLG-09
  - Waits on: L-20 and the catalogue (Sahil, T-02).
  - Done when: Milestones fire from the events in the challenge specs for every challenge, including the C09 negative-observation rule, and evidence is stored through KeyPort.
  - Handoffs: H-77 (see docs/dev/HANDOFFS.md; read them when you plan this task)
  - Status 2026-10-17 (earlier status, superseded by the Closed line): milestone engine with 33 rules, paste service and sharing signal are built against in-memory stores, 90 tests passed (story 6.3). Not built: evidence sealed through KeyPort, activity metadata, bot visit evidence, the tables, the ingest route and the worker. H-77 answered as built; H-333, H-334.
  - Audit 2026-10-19: OPEN. Blocker B5 fixed (events after the end credit nothing; the C09 window survives a restart). Still open: spec deviations (C01 M2 alternative, C03 single key, C07 M1, C08 M2 pairing) to be settled against the real catalogue of Sahil (T-30), and FR-TIM-04 events never emitted. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-22. Attempt state machine and server clock**
  - Closed 2026-10-17 after local proof: attempt engine and rules in packages/py-attempts (clock from instance ready, D-80 confirmed by the developer 2026-10-17), reachable over the demo routes. NOT met: the SQL store, the scheduler job and the real API adapter (H-346).
  - Epic: `epic-attempts-scoring-and-integrity`
  - BMAD story: not planned yet; created when you incept `epic-attempts-scoring-and-integrity` (see START-HERE.md, section "First task of an epic")
  - Build: Attempt start, server-side clock, time warnings, expiry with auto-submit, 15-minute freeze and destroy, manual submit, no pause, one attempt, cancel.
  - Covers: FR-SES-01 to 08, FR-TIM-05
  - Waits on: L-18. Clock start (OI-22) needs your decision first.
  - Done when: An attempt moves through its states without skipping, expiry auto-submits and freezes, and a lost connection never stops the clock.
  - Status 2026-10-17 (earlier status, superseded by the Closed line): attempt rules library and attempt engine are built in `packages/py-attempts` and tested with a fake clock, store and instance control, 254 tests passed (stories 7.1, 7.2). Not done: the OI-22 confirmation (D-80 is a proposal), the API adapter, the SQL store, the scheduler job, the live check. H-327, H-328.
  - Audit 2026-10-19: OPEN. Engine verified; blocker B5 fixed (a paste or event after the deadline scores nothing even before the tick). Still open: template rules (time limit, resets, hint mode) never reach the attempt (with Akshay); the scheduler scans every row. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-23. Scoring engine**
  - Closed 2026-10-17 after local proof: scoring reproduces all six PRD Appendix A examples; held captures stay out of the score (test_lab_loop.py, score 147 by hand). NOT met: the real ReportPort over tables (H-346), the recruiter screen.
  - Epic: `epic-attempts-scoring-and-integrity`
  - BMAD story: not planned yet; created when you incept `epic-attempts-scoring-and-integrity` (see START-HERE.md, section "First task of an epic")
  - Build: Server-side scoring from signed events: hiring formula, milestone credit, hint cost, time shown not scored, no penalty for wrong submissions, learner progress, held captures excluded.
  - Covers: FR-SCR-01 to 06, 09, 10
  - Waits on: L-21, L-22.
  - Done when: The tests reproduce every PRD Appendix A example and held captures stay out of the score until a human decides.
  - Status 2026-10-17 (earlier status, superseded by the Closed line): the scoring function is built and reproduces all six PRD Appendix A examples (story 7.3, 221 package tests passed at that time). Not built: the `ReportPort` adapter, the fact source, held-capture review (OI-38), the recruiter screen. H-329.
  - Audit 2026-10-19: OPEN (one item). Reproduces all six Appendix A examples; the learner hint-cost defect is fixed (hints cost points only in an assessment, learners' are free; tested). Still open: template hint settings (hint cost percent, hints on or off) do not reach the attempt yet (handoff H-351 with Akshay). Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-24. Backups, laptop fallback and remaining spikes**
  - Closed 2026-10-17 on local proof only: encrypted dump, checksum, restore into a scratch database with equal row counts, wrong passphrase and a flipped byte fail, laptop fallback up/check/down on this PC (docs/assets/story-8-4-backup-fallback/). NOT met: the backup to S3 and a restore on a VM (runbook steps), no real platform data was backed up.
  - Epic: `epic-environments-and-deployment`
  - BMAD story: not planned yet; created when you incept `epic-environments-and-deployment` (see START-HERE.md, section "First task of an epic")
  - Build: Encrypted backups to Oracle Object Storage with a restore test, the laptop fallback start procedure, and the remaining spike write-ups (S-1).
  - Covers: LE-5, LE-7, LE-8
  - Waits on: L-12 and the database from Akshay (P-06).
  - Done when: A restore test succeeds and the laptop fallback is tested on your PC.
  - Audit 2026-10-18: OPEN. Restore proved locally and (by hand) on the deployed database; no schedule, no off-host copy, keystore keys not covered. Details: docs/audit/2026-10-18-lab-stream-audit.md

## Sprint 4 (29 Oct to 4 Nov 2026)

Goal: Time metrics, anti-cheat, isolation proof, the end-to-end suite, the load check and the demo rehearsal.

- [ ] **L-25. Time metrics and event log**
  - Audit 2026-10-19: the 500 is fixed (a capture dated before the start counts zero seconds, `clamp_to_start`, test). Still open: the allow-listed FR-TIM-04 events are never emitted, and the dashboard shows nothing yet (stream P).
  - Closed 2026-10-17 after local proof: headline time, estimated active time, resets and retries, ids-only allow-listed event log (96 new library tests across L-25 to L-28; runtime time_metrics tested). NOT met: a time method on the report port and the dashboard (H-346).
  - Epic: `epic-attempts-scoring-and-integrity`
  - BMAD story: not planned yet; created when you incept `epic-attempts-scoring-and-integrity` (see START-HERE.md, section "First task of an epic")
  - Build: Headline time to capture, estimated active time, resets and retries, and the attempt event log (ids and metadata only).
  - Covers: FR-TIM-01 to 04
  - Waits on: L-21, L-22.
  - Done when: Time is shown beside the score, resets are counted and the event log holds only ids and metadata.
  - Audit 2026-10-18: OPEN. Metrics and ids-only log verified; allow-listed events never emitted; time_metrics can raise (500). Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-26. Reset and withdrawal during an assessment**
  - Audit 2026-10-19: TICKED (the earlier audit line below is superseded). `POST /api/v1/attempts/{id}/withdraw` and `/withdraw/undo` are in IF-2 1.1.0 and served by the lab (`apps/api/tests/test_lab_api.py`, `test_lab_contract.py`; mock and examples updated). Proved on the deployed system (real Postgres and orchestrator, `docs/assets/production-readiness/e2e-run15-withdraw.json`, 11 of 11): the owner withdraws, the instance is destroyed, nothing is accepted afterwards, a second withdrawal keeps the date, the undo cancels the deletion, a foreign account gets 404. The candidate attempt was created through the lab runtime of the API container because the invite routes (stream P) do not exist yet; the route itself is the real one. Cancel and purge routes stay with stream P (H-353).
  - Closed 2026-10-17 after local proof: reset counted with limit 3 (fourth refused before the instance is touched), withdrawal destroys, schedules deletion after 7 days, undo inside the window (engine and runtime tests). NOT met: the platform routes (H-346).
  - Epic: `epic-attempts-scoring-and-integrity`
  - BMAD story: not planned yet; created when you incept `epic-attempts-scoring-and-integrity` (see START-HERE.md, section "First task of an epic")
  - Build: Handle a reset and a withdrawal in the middle of an assessment attempt.
  - Covers: FR-SES-09, 10
  - Waits on: L-14, L-22.
  - Done when: Both are recorded in the event log and handled as FR-SES-09 and FR-SES-10 require.
  - Audit 2026-10-19: WAITING ON Akshay (H-346): no HTTP withdraw, cancel or undo route. Reset limit, withdrawal, undo and erase (key shred, purge, retry) are verified; the lab now announces attempt state changes to the live hub. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [x] **L-27. Anti-cheat signals and held-capture review**
  - Closed 2026-10-17 after local proof: held captures stay out of the score until a named recruiter or admin of the owning organisation decides, the decision is audited and final, nobody is zeroed (library and runtime tests). The idle and too-fast numbers are placeholders (OI-25). NOT met: FR-ACH-01 and 02 (submission limit coverage, the real activity gate), the review screen, D-92 (OI-38) confirmed 2026-10-17.
  - Epic: `epic-attempts-scoring-and-integrity`
  - BMAD story: not planned yet; created when you incept `epic-attempts-scoring-and-integrity` (see START-HERE.md, section "First task of an epic")
  - Build: Submission limits, activity-versus-capture check, timing anomalies, write-up similarity review, integrity signals as evidence for a human, review of held captures.
  - Covers: FR-ACH-01 to 07
  - Waits on: L-21, L-23. Reviewer for held captures (OI-38) needs a decision.
  - Done when: Held captures stay out of the score until a named reviewer decides, the decision is audited and nobody is auto-zeroed.
  - Audit 2026-10-19: VERIFIED in code and tests. Blocker B6 fixed: pasted flags are checked against recorded activity (held for a named reviewer, mode flag counts with a flag, a too-fast capture raises a timing flag); review is audited and final; nobody is zeroed. Not wired: write-up similarity (needs write-ups) and the idle-gap signal. Not run live (a live paste needs a held capture and a recruiter session). Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-28. Cohort board and ranking aid**
  - Audit 2026-10-19: NOT TICKED. The platform adapter now exists (`apps/api/src/vulnmart/ports/engine_cohort.py`, `LabRuntime.cohort`; tests `test_engine_cohort.py` 3 passed: only ended attempts of one company and one assessment, aid order, refusal before any row is read, no cross-company call). Still missing, and Akshay's: the IF-1 route that reads `cohort_board` of the assessment and the recruiter screen (H-353). Without them a recruiter cannot see the board, so the Done-when is not demonstrable.
  - Closed 2026-10-17 after local proof: ranking aid and private, scoped cohort rules, board off by default (D-93 confirmed by the developer 2026-10-17, OI-26 answered). NOT met: the platform port and recruiter screen.
  - Epic: `epic-attempts-scoring-and-integrity`
  - BMAD story: not planned yet; created when you incept `epic-attempts-scoring-and-integrity` (see START-HERE.md, section "First task of an epic")
  - Build: The cohort view for recruiters and the ranking aid, with no global leaderboard.
  - Covers: FR-SCR-07, 08
  - Waits on: L-23. Open question OI-26: ask before building.
  - Done when: The board and aid work as the decision on OI-26 says.
  - Audit 2026-10-18: WAITING ON Akshay (P-27 recruiter dashboard) plus a small EngineCohortPort on our side: library only, no route. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-29. Isolation proof and extra hardening on VM-I**
  - Unticked 2026-10-18 on the developer's instruction after a code-based status check: S-8 was not tested live and the audit does not yet read the VULNMART-LABS chain (review finding D1), so the Done-when is not fully met.
  - Ticked 2026-10-18 with a caveat: S-8 (user namespaces, rootless Docker, gVisor) was NOT tested live; the developer skipped it for the demo and the result is reasoning only (docs/research/s-8-instance-sandboxing.md, story dropped). The isolation tests do pass on VM-I.
  - Sprint 4 run 2026-10-18 (L-29 part 1): S-3 answered live (the per-subnet INPUT rule blocks the gateway; an uncovered subnet leaks gateway:22), probe PASS after a Docker restart and a reboot, vm-i exposes only 22, read-only audit 8 PASS 0 FAIL, S-15 emulated with the real edge-gate (restart healthy in 3.3 s with 20 networks); research note docs/research/s-3-s-15-vm-i-isolation.md. Open for the Done-when: part 2 (S-8: user namespaces, rootless Docker, gVisor, wider pools) and 20 real instances through the orchestrator.
  - Status 2026-10-17 (not ticked): `scripts/vmi-audit.mjs` (22 tests, fixtures) and runbook `docs/runbooks/vmi-hardening.md` are built; the isolation tests on VM-I are the developer's runs (Part A), no live result exists; S-8 stays open.
  - Epic: `epic-isolation-and-hardening`
  - BMAD story: not planned yet; created when you incept `epic-isolation-and-hardening` (see START-HERE.md, section "First task of an epic")
  - Build: Add user namespaces, rootless Docker or gVisor only where tests pass; raise Docker address pools; write up spikes S-3, S-8 and S-15.
  - Covers: NFR-ISO-05 to 07; spikes S-3, S-8, S-15
  - Waits on: L-15, L-17.
  - Done when: The isolation tests pass on VM-I and the spike results record what worked and what did not.
  - Audit 2026-10-18: OPEN. B4; S-8 live tests skipped; S-15 emulated; address pools not raised. Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-30. End-to-end suite and load check**
  - Audit 2026-10-19 (load numbers): the deployed learner journey now has 34 checks including FR-SES-11 and passes 34 of 34 (`e2e-run14-login-bump.json`); load check of 8 learners (`e2e-run16-load8.json`): 5 of 8 instances ready (first 8 s, median 13.7 s, p90 17.4 s, slowest 17.4 s, wall 19 s), 3 answered a clean 429 `REQ-RATE-LIMITED` because vm-i admits 7 instances (5600 MB at 768 MB) and earlier test instances still held slots. Re-run on the merged main (2026-10-19, after the capacity was freed): journey 34 of 34 (`e2e-run19-main.json`), withdraw and undo 11 of 11 (`e2e-run20-withdraw-main.json`), load check of 6 learners (`e2e-run21-load6.json`): 4 of 6 ready (first 8.3 s, median 13.8 s, p90 13.9 s, wall 17 s), 2 clean 429 because earlier test instances still held 3 of the 7 slots; the load check now stops its own instances (4 of 4). Still missing: the assessment attempt, invite and recruiter report in the suite (stream P routes, P-32) and Sahil's T-32.
  - Status 2026-10-17 (not ticked): local loops exist (in-process `apps/api/tests/test_lab_loop.py`; the Docker Desktop loop passes 10 of 10 steps with the stub image and the load check passes 6 of 6, laptop numbers, story 8.3), `scripts/live-smoke.mjs` is built; nothing ran on the deployed system, which the Done-when requires.
  - Epic: `epic-integration-and-demo-readiness`
  - BMAD story: not planned yet; created when you incept `epic-integration-and-demo-readiness` (see START-HERE.md, section "First task of an epic")
  - Build: An end-to-end suite for signup, instance start, a captured flag, an assessment attempt, scoring and a recruiter report on the deployed system, plus a load check.
  - Covers: LX-1, LX-2
  - Waits on: Akshay (P-32) and Sahil (T-32) deployed and merged.
  - Done when: The suite is green on the deployed system and the load numbers are recorded.
  - Audit 2026-10-19: WAITING ON Akshay (P-32) and Sahil (T-32), partly unblocked: the learner journey passes 30 of 30 on the REAL shop (docs/assets/production-readiness/e2e-run11-real-shop.json) and Sahil can now run T-32. Still no assessment attempt, invite or recruiter report in the journey (routes and screens of stream P are missing). Details: docs/audit/2026-10-18-lab-stream-audit.md

- [ ] **L-31. Demo rehearsal and submission pack**
  - Status 2026-10-17 (not ticked): the demo runbook (docs/runbooks/demo-19-oct.md) and the submission pack checker (21 items pass) are built; no rehearsal has been run or recorded.
  - Epic: `epic-integration-and-demo-readiness`
  - BMAD story: not planned yet; created when you incept `epic-integration-and-demo-readiness` (see START-HERE.md, section "First task of an epic")
  - Build: Rehearse the demo on the laptop and online, including the fallback, and check the submission pack (report evidence, repository link, demo script).
  - Covers: LX-3, LX-4
  - Waits on: L-30.
  - Done when: A rehearsal is recorded and problems found are listed.
  - Audit 2026-10-18: OPEN (human): the rehearsal was never run; the pack checker only counts files. Details: docs/audit/2026-10-18-lab-stream-audit.md

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
| L-21 Milestone engine, evidence capture and sharing signal | T-27 (Sahil, sprint 4) |
| L-23 Scoring engine | P-26 (Akshay, sprint 4) |
