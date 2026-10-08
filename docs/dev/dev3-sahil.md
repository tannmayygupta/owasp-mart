# Developer 3: Sahil, Target stream

Sahil owns the vulnerable marketplace and its 11 challenges: the shop, its services, the challenge catalogue, hints and write-ups, and the exploit tests.

| | |
|---|---|
| Ticket tree | `docs/bmad/initiative-target/` |
| Excel tracker | `docs/bmad/VulnMart-Tracker.xlsx`, sheet "3 Sahil (Target)" (updated by hand) |
| Tasks | 32 tasks in 4 weekly sprints |
| Status | Draft plan written 2026-10-08 by Claude Code; not yet approved by the team |

## How to work from this file

1. Take the next unticked task whose "Waits on" items are done. If a wait is on another developer, use the mock or fake named in the task and carry on; do not stop.
2. Create the story with `bmad-ticket`, build it with `bmad-build`, review it, test it. A task that is too big may become more than one story.
3. When the tests have really passed: tick the box below, update the story state in `docs/bmad/initiative-target/`, write the dev-log entry, changelog line and traceability rows, then commit.
4. Update the Excel sheet by hand (Done = Yes).

Sprint dates are a proposal: the final submission is in the first week of November (exact date not yet given). The exact acceptance criteria of each task are written when the task starts. Open questions named in a task (OI-xx) must be answered by the team before that part is built.

## Sprint overview

| Sprint | Dates | Goal | Tasks |
|---|---|---|---|
| 1 | 8 Oct to 14 Oct 2026 | The shop skeleton runs in the lab harness, the catalogue schema exists and the shop data model is in place. | T-01 to T-08 (8) |
| 2 | 15 Oct to 21 Oct 2026 | The shop runs inside an instance (health, events, mock services, import service, bot) and the customer, support, finance and admin flows work. | T-09 to T-16 (8) |
| 3 | 22 Oct to 28 Oct 2026 | Seller and money flows, and challenges C01 to C06. | T-17 to T-24 (8) |
| 4 | 29 Oct to 4 Nov 2026 | Challenges C07 to C11, the catalogue content, cross-challenge tests, the release gate and deployed verification. | T-25 to T-32 (8) |

## Sprint 1 (8 Oct to 14 Oct 2026)

Goal: The shop skeleton runs in the lab harness, the catalogue schema exists and the shop data model is in place.

- [ ] **T-01. Shop skeleton runs in a container (tracer bullet)**
  - Epic: `epic-target-baseline`
  - Build: Set up your Windows environment and run an Express app on Node 24 in a hardened container that answers /healthz, /readyz and /version.
  - Covers: TB-3, TB-5
  - Waits on: L-01 (repository skeleton).
  - Done when: `docker run` of the shop image answers its health endpoints and Docker, Node 24, uv and `node scripts/verify-skills.mjs` succeed on your PC.

- [ ] **T-02. Challenge catalogue schema and 11 stub entries (IF-7)**
  - Epic: `epic-target-baseline`
  - Build: Define the catalogue schema and commit 11 stub entries with tags, tier, placeholder milestones and hint slots.
  - Covers: TB-1
  - Waits on: L-01.
  - Done when: All 11 stubs validate against the schema in CI.

- [ ] **T-03. Review the instance contract and event schema as consumer**
  - Epic: `epic-target-baseline`
  - Build: Review IF-6 and IF-4 against what the shop needs and file change requests through the contract rules.
  - Covers: TB-2
  - Waits on: Tanmay's drafts L-02 and L-03 (open pull requests).
  - Done when: Review comments are merged or answered and you have signed the versions you build against.

- [ ] **T-04. Shop skeleton meets the instance contract in the lab harness**
  - Epic: `epic-target-baseline`
  - Build: Make the skeleton ready only after the injector marker, serve a planted flag and emit one app event inside the lab harness.
  - Covers: TB-3
  - Waits on: T-01, T-03 and Tanmay's harness (L-06).
  - Done when: In the harness the instance becomes ready after the marker, the planted flag is served and the fake ingest accepts the event.

- [ ] **T-05. Exploit test runner skeleton**
  - Epic: `epic-target-baseline`
  - Build: A runner that executes a test against any instance URL, with its own tiny vulnerable and fixed stubs.
  - Covers: TB-4
  - Waits on: T-01.
  - Done when: A trivial test passes on the vulnerable stub and fails on the fixed stub in CI.

- [ ] **T-06. Shop data model and seven state machines**
  - Epic: `epic-shop-core-and-roles`
  - Build: About 20 tables with migrations and the seven state machines.
  - Covers: FR-SHP-02, 04
  - Waits on: T-01.
  - Done when: Migrations run on SQLite and state transitions are tested.

- [ ] **T-07. Shop identity, six roles, permissions and strong hashing**
  - Epic: `epic-shop-core-and-roles`
  - Build: Neutral marketplace look, accounts, six roles with the permission matrix, strong password hashing.
  - Covers: FR-SHP-01, 03, 09
  - Waits on: T-06.
  - Done when: Role permissions are tested and no MD5 or unsalted hash exists in the shop.

- [ ] **T-08. Snapshot seeding mechanism**
  - Epic: `epic-shop-instance-integration`
  - Build: Build a seeded snapshot in CI and a per-epic seed-data mechanism so later work adds seed data without editing shared files.
  - Covers: FR-SHP-12
  - Waits on: T-06.
  - Done when: A fresh instance starts from the snapshot with seed data and the start time is measured.

## Sprint 2 (15 Oct to 21 Oct 2026)

Goal: The shop runs inside an instance (health, events, mock services, import service, bot) and the customer, support, finance and admin flows work.

- [ ] **T-09. Health, readiness after the injector marker and runtime profile**
  - Epic: `epic-shop-instance-integration`
  - Build: Health endpoints, ready only after the injector writes the marker, running non-root with a read-only filesystem and no egress.
  - Covers: FR-SHP-15
  - Waits on: T-04, T-08 and Tanmay's L-13.
  - Done when: The shop is never ready before the marker and runs under the runtime profile in the harness.

- [ ] **T-10. Shop boundaries and signed app events**
  - Epic: `epic-shop-instance-integration`
  - Build: The shop has no route to the platform database, Valkey, the orchestrator or other instances, and sends signed app events through the sidecar.
  - Covers: FR-SHP-14
  - Waits on: T-09, Tanmay's event schema (L-03).
  - Done when: Boundary tests pass and the fake ingest accepts the shop's events.

- [ ] **T-11. Mock services container**
  - Epic: `epic-shop-instance-integration`
  - Build: Combined mock services: payment, KYC, metadata and the XSS collector, reachable only inside the instance network.
  - Covers: FR-SHP-13
  - Waits on: T-09.
  - Done when: Each mock answers inside the instance and is unreachable from outside.

- [ ] **T-12. Isolated import service**
  - Epic: `epic-shop-instance-integration`
  - Build: An import service that runs a fresh process per job with no network and no database access.
  - Covers: FR-SHP-13
  - Waits on: T-09.
  - Done when: A job runs in a fresh process and cannot reach the network or the database.

- [ ] **T-13. Support-agent bot**
  - Epic: `epic-shop-instance-integration`
  - Build: The bot controller that opens only pages of its own instance for a fixed time.
  - Covers: FR-SHP-11; spike S-5
  - Waits on: T-11.
  - Done when: The bot visits an allowed page, refuses others and its memory per instance is measured (S-5).

- [ ] **T-14. Customer flows**
  - Epic: `epic-shop-core-and-roles`
  - Build: Browse, search, cart, checkout with the simulated payment, orders, reviews and support tickets.
  - Covers: FR-SHP-05
  - Waits on: T-07, T-08.
  - Done when: A customer can complete the whole flow in a fresh instance.

- [ ] **T-15. Support, finance and admin flows**
  - Epic: `epic-shop-core-and-roles`
  - Build: Support, finance and admin screens following the permission matrix.
  - Covers: FR-SHP-07
  - Waits on: T-07.
  - Done when: Each role works as the matrix says in tests.

- [ ] **T-16. Seeded accounts for the challenges**
  - Epic: `epic-shop-core-and-roles`
  - Build: Seeded accounts for every challenge.
  - Covers: FR-SHP-08
  - Waits on: T-07, T-08.
  - Done when: The seeded accounts work in a fresh instance and no seeded password repeats across challenges.

## Sprint 3 (22 Oct to 28 Oct 2026)

Goal: Seller and money flows, and challenges C01 to C06.

- [ ] **T-17. Seller flows**
  - Epic: `epic-shop-seller-and-money`
  - Build: Seller store registration and approval, products, fulfilment and staff.
  - Covers: FR-SHP-06
  - Waits on: T-14. Open in part: OI-20.
  - Done when: A seller registers, waits for approval, lists products and fulfils orders; a pending seller cannot publish.

- [ ] **T-18. Refunds, disputes, commissions and payouts**
  - Epic: `epic-shop-seller-and-money`
  - Build: The correct marketplace money model with refunds, disputes, proportional commission reversal, append-only ledger.
  - Covers: FR-SHP-10
  - Waits on: T-17. Open in part: OI-19.
  - Done when: A partial refund reverses commission in proportion and refunded total never exceeds the amount paid on any path.

- [ ] **T-19. C01 Broken Access Control (cross-store order read)**
  - Epic: `epic-challenges-c01-c04`
  - Build: Build C01 as designed with its flag, milestones, hints, write-up and exploit test.
  - Covers: FR-CHL-02
  - Waits on: T-14, T-17.
  - Done when: The exploit test passes on the vulnerable build and fails on the fixed one, and the flag appears only on the intended path.

- [ ] **T-20. C02 Cryptographic Failures (gift-card codes from a weak hash)**
  - Epic: `epic-challenges-c01-c04`
  - Build: Build C02 as designed with its flag, milestones, hints, write-up and exploit test.
  - Covers: FR-CHL-03
  - Waits on: T-14.
  - Done when: The exploit test passes on the vulnerable build and fails on the fixed one.

- [ ] **T-21. C03 Injection (SQL injection and stored XSS)**
  - Epic: `epic-challenges-c01-c04`
  - Build: Build C03 parts A and B: SQL injection against a read-only catalogue file and stored XSS visited by the bot.
  - Covers: FR-CHL-04
  - Waits on: T-11, T-13, T-14; check SQLite ATTACH and load_extension.
  - Done when: The exploit tests pass and fail as required, and SQL injection cannot reach other data.

- [ ] **T-22. C04 Insecure Design (refund total beyond the amount paid)**
  - Epic: `epic-challenges-c01-c04`
  - Build: Build C04 as a separate quick-refund path on top of the correct model.
  - Covers: FR-CHL-05
  - Waits on: T-18.
  - Done when: The exploit test passes on the vulnerable build and fails on the fixed one.

- [ ] **T-23. C05 Security Misconfiguration (unauthenticated diagnostics page)**
  - Epic: `epic-challenges-c05-c08`
  - Build: Build C05 with a diagnostics page that shows only a synthetic object.
  - Covers: FR-CHL-06
  - Waits on: T-15.
  - Done when: The exploit test passes and fails as required and no real data is exposed.

- [ ] **T-24. C06 Vulnerable Components (prototype pollution in the import service)**
  - Epic: `epic-challenges-c05-c08`
  - Build: Build C06 with the old lodash in the isolated import service; confirm the pollution input works on Node 24.
  - Covers: FR-CHL-07; spike S-9
  - Waits on: T-12.
  - Done when: The exploit test passes and fails as required, the import service has no network or database, and no code execution is possible.

## Sprint 4 (29 Oct to 4 Nov 2026)

Goal: Challenges C07 to C11, the catalogue content, cross-challenge tests, the release gate and deployed verification.

- [ ] **T-25. C07 Authentication Failures (weak password-reset code)**
  - Epic: `epic-challenges-c05-c08`
  - Build: Build C07 on the finance account; the reset mailbox is unreadable by the player.
  - Covers: FR-CHL-08
  - Waits on: T-15.
  - Done when: The exploit test passes and fails as required.

- [ ] **T-26. C08 Software or Data Integrity Failures (unsigned payment webhook)**
  - Epic: `epic-challenges-c05-c08`
  - Build: Build C08 with an unsigned payment webhook that releases a sentinel flag only on an unsigned sandbox event.
  - Covers: FR-CHL-09
  - Waits on: T-11.
  - Done when: The exploit test passes and fails as required.

- [ ] **T-27. C09 Logging and Alerting Failures (legacy login route not logged)**
  - Epic: `epic-challenges-c09-c11`
  - Build: Build C09 so that the attack leaves zero events in the shop's own events.
  - Covers: FR-CHL-10
  - Waits on: T-10, Tanmay's negative-observation rule (L-21).
  - Done when: The proof of "attack happened, zero events recorded" comes from the shop's own events and the exploit test passes and fails as required.

- [ ] **T-28. C10 Server-Side Request Forgery (seller image import)**
  - Epic: `epic-challenges-c09-c11`
  - Build: Build C10 with a seller image import that can reach only the fake metadata service.
  - Covers: FR-CHL-11
  - Waits on: T-11, T-17.
  - Done when: The fetcher cannot reach the host gateway or `host.docker.internal` and the exploit test passes and fails as required.

- [ ] **T-29. C11 Mishandling of Exceptional Conditions (KYC check fails open)**
  - Epic: `epic-challenges-c09-c11`
  - Build: Build C11 with a seller KYC check that fails open and a sentinel flag.
  - Covers: FR-CHL-12
  - Waits on: T-11, T-17.
  - Done when: The flag shows only when the store was approved by the fail-open path and the exploit test passes and fails as required.

- [ ] **T-30. Catalogue content: tags, tiers, briefs, hints, write-ups and decoy locations**
  - Epic: `epic-catalogue-hints-and-verification`
  - Build: Fill the catalogue for all 11 challenges: both OWASP tags, CWE and ATT&CK ids re-checked on the official sites, tier, player brief, three hint levels, write-up hidden until solved, and the decoy flag locations.
  - Covers: FR-CHL-01, 14, 15, 17
  - Waits on: T-19 to T-29. Open in part: OI-14.
  - Done when: Every challenge page shows its tags and tier and a brief that never contains a flag.

- [ ] **T-31. Cross-challenge tests and exploit tests as a CI release gate**
  - Epic: `epic-catalogue-hints-and-verification`
  - Build: Prove that solving one challenge captures no other flag, and run the 11 exploit tests in CI as a release gate.
  - Covers: FR-CHL-13, 16
  - Waits on: T-30.
  - Done when: A failing exploit test blocks a release and the independence tests pass.

- [ ] **T-32. Deployed verification on the instance VM**
  - Epic: `All target epics`
  - Build: Run all exploit tests and the shop checks against an instance on VM-I.
  - Covers: Done-when of every target epic
  - Waits on: Tanmay's deployment (L-12, L-15, L-17) and all earlier target tasks.
  - Done when: All 11 exploit tests pass on the vulnerable build and fail on the fixed build on the deployed instance VM.

## Others are waiting on you

Finish these early, or tell the other developer which mock to use meanwhile.

| Your task | Needed by |
|---|---|
| T-02 Challenge catalogue schema and 11 stub entries (IF-7) | L-21 (Tanmay, sprint 3), P-04 (Akshay, sprint 1) |
| T-03 Review the instance contract and event schema as consumer | L-09 (Tanmay, sprint 2) |
| T-30 Catalogue content: tags, tiers, briefs, hints, write-ups and decoy locations | P-26 (Akshay, sprint 4) |
| T-32 Deployed verification on the instance VM | L-30 (Tanmay, sprint 4) |
