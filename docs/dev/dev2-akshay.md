# Developer 2: Akshay, Platform stream

Akshay owns the platform and dashboards: accounts and sessions, email, privacy and audit, companies, assessments and invites, live updates, the four role dashboards, exports and the admin area.

| | |
|---|---|
| Ticket tree | `docs/bmad/initiative-platform/` |
| Excel tracker | `docs/bmad/VulnMart-Tracker.xlsx`, sheet "2 Akshay (Platform)" (updated by hand) |
| Tasks | 32 tasks in 4 weekly sprints |
| Read first | [START-HERE.md](START-HERE.md): how to run every task with BMAD and Claude Code |
| Branches | one branch per sprint: `sprint-<n>-akshay`, one pull request per sprint; tasks marked EARLY PR get their own small pull request `shared-<task-id>` |
| Status | Draft plan written 2026-10-08 by Claude Code; not yet approved by the team |

## How to work from this file

1. Take the next unticked task whose "Waits on" items are done. If a wait is on another developer, use the mock or fake named in the task and carry on; do not stop. One task at a time.
2. Create the story with `bmad-ticket`, build it with `bmad-build`, review it, test it. The line "BMAD story" under each task says whether the story already exists. A task that is too big may become more than one story.
3. When the tests have really passed: tick the box below, update the story state in `docs/bmad/initiative-platform/`, write the dev-log entry, changelog line and traceability rows, then commit.
4. Update the Excel sheet by hand (Done = Yes).

Sprint dates are a proposal: the final submission is in the first week of November (exact date not yet given). The exact acceptance criteria of each task are written when the task starts. Open questions named in a task (OI-xx) must be answered by the team before that part is built.

## Sprint overview

| Sprint | Dates | Goal | Tasks |
|---|---|---|---|
| 1 | 8 Oct to 14 Oct 2026 | Platform contracts, ports, the API skeleton and the dashboards skeleton exist and are signed off. | P-01 to P-08 (8) |
| 2 | 15 Oct to 21 Oct 2026 | Email, accounts, sessions, MFA and the consent screen work. | P-09 to P-16 (8) |
| 3 | 22 Oct to 28 Oct 2026 | Audit and keys, companies, assessments and invites, live updates, retention. | P-17 to P-24 (8) |
| 4 | 29 Oct to 4 Nov 2026 | Deletion, the four dashboards, exports, the admin area and deployed verification. | P-25 to P-32 (8) |

## Sprint 1 (8 Oct to 14 Oct 2026)

Goal: Platform contracts, ports, the API skeleton and the dashboards skeleton exist and are signed off.

- [ ] **P-01. Platform stack runs end to end locally (tracer bullet)**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.1` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Postgres, API, worker, Valkey and the dashboards start with `node scripts/dev.mjs`, and a request passes dashboards, API and database.
  - Covers: PB-7, PB-8
  - Waits on: L-01 (repository skeleton and Compose profiles).
  - Done when: A hello request works through the whole local stack and the developer environment on your Mac is verified.

- [ ] **P-02. Error registry and problem-details format (IF-8)**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.2` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Define the shared error codes and the problem-details response format.
  - Covers: PB-1
  - Waits on: P-01.
  - Done when: The registry validates and a test shows an API error in the agreed format.
  - Handoffs: H-01, H-02, H-03, H-04 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [ ] **P-03. Domain event schema (IF-3) with fixtures and replay script**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.3` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Define the platform domain events, fixtures and a replay script.
  - Covers: PB-2
  - Waits on: P-02.
  - Done when: Every fixture validates, the replay script emits them in order to a local consumer and the validation runs in CI.
  - Handoffs: H-22 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [ ] **P-04. Platform and lab API fragments, bundle, mock and generated clients (IF-1, IF-2)**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.4` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Write the platform API fragment, bundle it with the lab fragment, a mock server and generated clients.
  - Covers: PB-3
  - Waits on: P-02, P-03, Tanmay's L-05 (lab fragment) and Sahil's T-02 (catalogue stubs).
  - Done when: The bundle validates, the mock answers every endpoint and clients are generated in CI.
  - Handoffs: H-12, H-13, H-14, H-16, H-17, H-19, H-20, H-23 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [ ] **P-05. Ports, in-memory fakes and table ownership (IF-9, IF-10)**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.5` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Define the ports the platform provides (AuditPort, OutboxPort, KeyPort, ScopePort, SettingsPort, QuotaPort) as Python protocols with in-memory fakes, fakes of the lab ports and the table-owners file.
  - Covers: PB-4
  - Waits on: P-02, P-03.
  - Done when: Tests run against the fakes and the table-owners file validates (the CI ownership check is Tanmay's L-07).
  - Handoffs: H-05, H-06, H-07, H-08, H-09, H-10, H-11, H-12, H-13, H-14, H-15, H-18, H-20, H-21, H-83 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [ ] **P-06. API skeleton: kernel and single-head migrations**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.6` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Settings, session and organisation scope, audit, outbox and key-service stubs, request IDs and structured logs, health, readiness and version endpoints, one Alembic history.
  - Covers: PB-5
  - Waits on: P-01, P-03, P-05.
  - Done when: The API starts against Postgres, `alembic heads` shows one head and a scope test refuses a query without an organisation filter.
  - Handoffs: H-05, H-07, H-16, H-19, H-22, H-23 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [ ] **P-07. Dashboards skeleton with the same-origin proxy (local)**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.7` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Next.js skeleton with the `/api/*` proxy, origin secret header, no-store and security headers, run locally.
  - Covers: PB-6
  - Waits on: P-01, P-04.
  - Done when: A page reaches the API health through `/api/*` and two different users never receive each other's response in a caching test.

- [ ] **P-08. Sign off contracts v1.0.0 as provider and consumer**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.8` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Review and sign the contracts you provide and consume and record the versions you build against.
  - Covers: PB-9
  - Waits on: P-03, P-04, P-05.
  - Done when: Your approvals are on the contracts pull request and COMPAT.md lists the versions you target (the tag itself is Tanmay's L-09).
  - Handoffs: H-10, H-11, H-83 (see docs/dev/HANDOFFS.md; read them when you plan this task)

## Sprint 2 (15 Oct to 21 Oct 2026)

Goal: Email, accounts, sessions, MFA and the consent screen work.

- [ ] **P-09. Outbox, queue worker and email provider**
  - Epic: `epic-notifications-and-email`
  - BMAD story: not planned yet; created when you incept `epic-notifications-and-email` (see START-HERE.md, section "First task of an epic")
  - Build: Transactional outbox, Dramatiq worker with retries, and the email provider adapter.
  - Covers: FR-NTF-02, 03
  - Waits on: P-06. Open: which provider, Resend or Brevo (OI-32).
  - Done when: An email goes through the outbox, a failed send is retried and nothing is lost on a restart.

- [ ] **P-10. Email templates and in-app warnings**
  - Epic: `epic-notifications-and-email`
  - BMAD story: not planned yet; created when you incept `epic-notifications-and-email` (see START-HERE.md, section "First task of an epic")
  - Build: Templates for every email type and in-app warnings.
  - Covers: FR-NTF-01, 04
  - Waits on: P-09.
  - Done when: Each email type renders and sends in a test and the warnings show in the app.

- [ ] **P-11. Learner signup, email verification and signup abuse protection**
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: not planned yet; created when you incept `epic-accounts-and-sessions` (see START-HERE.md, section "First task of an epic")
  - Build: Learner signup with Argon2id passwords, email verification and rate limits against abuse.
  - Covers: FR-ACC-01, 02, 10
  - Waits on: P-10. Open: CAPTCHA choice.
  - Done when: A learner can sign up and verify by email on the local stack, and the abuse limits trigger in a test.

- [ ] **P-12. Login, sessions, timeouts and CSRF**
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: not planned yet; created when you incept `epic-accounts-and-sessions` (see START-HERE.md, section "First task of an epic")
  - Build: Session cookies, idle and absolute timeouts, logout, CSRF protection and the cookie rules of NFR-SEC-03.
  - Covers: FR-ACC-03, 04
  - Waits on: P-11.
  - Done when: Login, logout and both timeouts work and a request without a CSRF token is refused.

- [ ] **P-13. Account types, candidate role and admin creation**
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: not planned yet; created when you incept `epic-accounts-and-sessions` (see START-HERE.md, section "First task of an epic")
  - Build: Separate account types, the candidate role on the same login, and admin account creation.
  - Covers: FR-ACC-05, 06, 11
  - Waits on: P-12.
  - Done when: Roles are enforced in tests and an admin can only be created as FR-ACC-11 says.

- [ ] **P-14. Password reset, password quality and account self-service**
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: not planned yet; created when you incept `epic-accounts-and-sessions` (see START-HERE.md, section "First task of an epic")
  - Build: Password reset by email, password quality rules, and self-service account management.
  - Covers: FR-ACC-08, 09
  - Waits on: P-10, P-12.
  - Done when: A reset link works once and expires, weak passwords are refused and a user can change their details.

- [ ] **P-15. Multi-factor login**
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: not planned yet; created when you incept `epic-accounts-and-sessions` (see START-HERE.md, section "First task of an epic")
  - Build: Multi-factor login as the requirement specifies.
  - Covers: FR-ACC-07
  - Waits on: P-12.
  - Done when: MFA enrolment and login work in tests, and recovery is covered.

- [ ] **P-16. Consent screen, consent record, minimum data and 18-and-over**
  - Epic: `epic-privacy-audit-and-keys`
  - BMAD story: not planned yet; created when you incept `epic-privacy-audit-and-keys` (see START-HERE.md, section "First task of an epic")
  - Build: Consent screen, stored consent record, collect only the minimum data, 18-and-over check.
  - Covers: FR-PRV-01, 02, 03, 13
  - Waits on: P-12. Open in part: OI-37.
  - Done when: A new user cannot proceed without consent and the consent record is stored.

## Sprint 3 (22 Oct to 28 Oct 2026)

Goal: Audit and keys, companies, assessments and invites, live updates, retention.

- [ ] **P-17. Audit log and key service**
  - Epic: `epic-privacy-audit-and-keys`
  - BMAD story: not planned yet; created when you incept `epic-privacy-audit-and-keys` (see START-HERE.md, section "First task of an epic")
  - Build: Append-only audit log, encryption at rest and the key service with a KeyPort.
  - Covers: FR-PRV-10, 12
  - Waits on: P-12. Open in part: OI-28. Tanmay's flag and evidence tasks use your KeyPort.
  - Done when: Every sensitive action writes an audit entry and the key service encrypts and decrypts in a test.
  - Handoffs: H-08, H-09, H-10, H-21 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [ ] **P-18. Recruiter signup and company approval**
  - Epic: `epic-companies-and-approval`
  - BMAD story: not planned yet; created when you incept `epic-companies-and-approval` (see START-HERE.md, section "First task of an epic")
  - Build: Recruiter signup, the company state machine from signup to active, rejected and suspended, and the approve and reject API.
  - Covers: FR-ORG-01, 02, 04
  - Waits on: P-13, P-17. Open: free-email recruiters (OI-10).
  - Done when: A company moves from signup to approved or rejected with reasons and audit entries.

- [ ] **P-19. Company members, admin controls, data scoping, terms and invite caps**
  - Epic: `epic-companies-and-approval`
  - BMAD story: not planned yet; created when you incept `epic-companies-and-approval` (see START-HERE.md, section "First task of an epic")
  - Build: Colleagues join through the owner, admin controls over companies, company scoping of data, data-processing terms, invite caps.
  - Covers: FR-ORG-03, 05, 06, 07, 08
  - Waits on: P-18.
  - Done when: A recruiter never sees another company's data in tests and invite caps are enforced.

- [ ] **P-20. Assessment template, creating and sending invites, invite lifecycle**
  - Epic: `epic-assessments-and-invites`
  - BMAD story: not planned yet; created when you incept `epic-assessments-and-invites` (see START-HERE.md, section "First task of an epic")
  - Build: Assessment template, create and send invites by email, invite lifecycle states.
  - Covers: FR-ASM-01, 02, 03
  - Waits on: P-10, P-19.
  - Done when: A recruiter creates an assessment and sends an invite and the invite email arrives.

- [ ] **P-21. Accepting invites, re-invite after a fault and bulk invites**
  - Epic: `epic-assessments-and-invites`
  - BMAD story: not planned yet; created when you incept `epic-assessments-and-invites` (see START-HERE.md, section "First task of an epic")
  - Build: A candidate accepts an invite with consent, a re-invite after a fault, and bulk invite handling.
  - Covers: FR-ASM-04, 05, 06
  - Waits on: P-16, P-20.
  - Done when: Accept, re-invite and bulk work in tests and the invite purge job can see expired invites.

- [ ] **P-22. Live updates hub: SSE, heartbeat, snapshot with polling fallback, fan-out**
  - Epic: `epic-live-updates`
  - BMAD story: not planned yet; created when you incept `epic-live-updates` (see START-HERE.md, section "First task of an epic")
  - Build: Server-sent events with heartbeat and no buffering, a snapshot plus polling fallback, and the fan-out path from events to streams.
  - Covers: FR-LIV-01, 02, 04, 06
  - Waits on: P-06, P-12. Tanmay's L-11 proves SSE through Vercel (S-14).
  - Done when: A change shows live in a browser within the target time and the polling fallback works when SSE is blocked.

- [ ] **P-23. Stream authorisation and HTTP/2**
  - Epic: `epic-live-updates`
  - BMAD story: not planned yet; created when you incept `epic-live-updates` (see START-HERE.md, section "First task of an epic")
  - Build: Authorise every stream per user and company; HTTP/2 as far as the spike allows.
  - Covers: FR-LIV-03, 05
  - Waits on: P-19, P-22.
  - Done when: A user cannot subscribe to another user's or company's stream.

- [ ] **P-24. Retention scheduler, retention rules and log rules**
  - Epic: `epic-privacy-audit-and-keys`
  - BMAD story: not planned yet; created when you incept `epic-privacy-audit-and-keys` (see START-HERE.md, section "First task of an epic")
  - Build: Retention and auto-delete jobs for candidates and learners, evidence data rules, controller and processor roles, IP and browser details, system logs, synthetic data only.
  - Covers: FR-PRV-04, 05, 06, 07, 14, 15, 16, 17, 18
  - Waits on: P-17, P-21.
  - Done when: The jobs run on schedule, the invite purge runs and an admin can see the last run.

## Sprint 4 (29 Oct to 4 Nov 2026)

Goal: Deletion, the four dashboards, exports, the admin area and deployed verification.

- [ ] **P-25. Deletion workflow, 7-day undo and "who viewed me"**
  - Epic: `epic-privacy-audit-and-keys`
  - BMAD story: not planned yet; created when you incept `epic-privacy-audit-and-keys` (see START-HERE.md, section "First task of an epic")
  - Build: Account deletion request and workflow with a seven-day undo window, and the candidate view of who viewed their data.
  - Covers: FR-PRV-08, 09, 11
  - Waits on: P-17, P-24 and Tanmay's purge call (AttemptPort).
  - Done when: A deletion request completes after seven days, can be undone before, and a candidate sees who viewed.

- [ ] **P-26. Learner and candidate dashboards with hints**
  - Epic: `epic-dashboards-and-exports`
  - BMAD story: not planned yet; created when you incept `epic-dashboards-and-exports` (see START-HERE.md, section "First task of an epic")
  - Build: The learner and candidate dashboards, learner hints, candidate hints off by default.
  - Covers: FR-DSH-01, 04, FR-HNT-01, 02
  - Waits on: P-22, Tanmay's scoring (L-23) and the catalogue (T-30). Open in part: OI-15.
  - Done when: Both dashboards show live data on the deployed site and candidate hints are off by default.

- [ ] **P-27. Recruiter dashboard, live monitor and hints used**
  - Epic: `epic-dashboards-and-exports`
  - BMAD story: not planned yet; created when you incept `epic-dashboards-and-exports` (see START-HERE.md, section "First task of an epic")
  - Build: The recruiter dashboard, the live monitor of running attempts and the hints-used view.
  - Covers: FR-DSH-02, 03, FR-HNT-03
  - Waits on: P-19, P-22.
  - Done when: A recruiter sees only their company's candidates live.

- [ ] **P-28. Admin operations: queue, users, force-stop, settings, quotas, capacity**
  - Epic: `epic-admin-and-operations`
  - BMAD story: not planned yet; created when you incept `epic-admin-and-operations` (see START-HERE.md, section "First task of an epic")
  - Build: Approval queue screen, user management, force-stop, settings and quotas (provides SettingsPort and QuotaPort to Tanmay), capacity view.
  - Covers: FR-ADM-01, 02, 04, 05, 06
  - Waits on: P-18 and Tanmay's L-16 (InstancePort, capacity).
  - Done when: An admin approves a company, force-stops an instance and changes a quota that the lab then enforces.
  - Handoffs: H-15 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [ ] **P-29. Data exports**
  - Epic: `epic-dashboards-and-exports`
  - BMAD story: not planned yet; created when you incept `epic-dashboards-and-exports` (see START-HERE.md, section "First task of an epic")
  - Build: Candidate, learner and recruiter exports, each audited.
  - Covers: FR-EXP-01 to 04
  - Waits on: P-17. Open: OI-27.
  - Done when: Each export produces the right data and writes an audit entry.

- [ ] **P-30. Admin dashboard and privacy wall in every view**
  - Epic: `epic-dashboards-and-exports`
  - BMAD story: not planned yet; created when you incept `epic-dashboards-and-exports` (see START-HERE.md, section "First task of an epic")
  - Build: The admin dashboard and the privacy wall checks across every view.
  - Covers: FR-DSH-05, 06
  - Waits on: P-28.
  - Done when: No view shows data the privacy wall forbids, checked by a test per view.

- [ ] **P-31. Break-glass, audit access, admin limits, legal review and incident handling**
  - Epic: `epic-admin-and-operations`
  - BMAD story: not planned yet; created when you incept `epic-admin-and-operations` (see START-HERE.md, section "First task of an epic")
  - Build: Break-glass access, audit access, admins cannot read candidate answers by default, the legal review action, breach and incident handling.
  - Covers: FR-ADM-03, 07, 08, FR-PRV-19, 20
  - Waits on: P-17, P-28. Open: OI-12, OI-33, OI-34.
  - Done when: Break-glass is audited, admins cannot read candidate answers by default and the open items are decided or recorded.

- [ ] **P-32. Deployed verification and ASVS checklist**
  - Epic: `All platform epics`
  - BMAD story: not planned yet; created when you incept `All platform epics` (see START-HERE.md, section "First task of an epic")
  - EARLY PR: yes. L-30 (another developer, same sprint) wait on it, so merge it through its own pull request as soon as it is done.
  - Build: Verify every platform epic on the deployed site and compile the ASVS 5.0 checklist rows in docs/traceability.md.
  - Covers: Done-when of every platform epic; NFR-SEC
  - Waits on: L-11 (Vercel), L-17 and all earlier platform tasks.
  - Done when: Each epic is verified on the deployed site and the ASVS rows are filled.

## Others are waiting on you

Finish these early, or tell the other developer which mock to use meanwhile.

| Your task | Needed by |
|---|---|
| P-06 API skeleton: kernel and single-head migrations | L-24 (Tanmay, sprint 3) |
| P-07 Dashboards skeleton with the same-origin proxy (local) | L-11 (Tanmay, sprint 2) |
| P-08 Sign off contracts v1.0.0 as provider and consumer | L-09 (Tanmay, sprint 2) |
| P-32 Deployed verification and ASVS checklist | L-30 (Tanmay, sprint 4) |
