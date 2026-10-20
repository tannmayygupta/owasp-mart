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

- [x] **P-01. Platform stack runs end to end locally (tracer bullet)**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.1` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Postgres, API, worker, Valkey and the dashboards start with `node scripts/dev.mjs`, and a request passes dashboards, API and database.
  - Covers: PB-7, PB-8
  - Waits on: L-01 (repository skeleton and Compose profiles).
  - Done when: A hello request works through the whole local stack and the developer environment on your Mac is verified.

- [x] **P-02. Error registry and problem-details format (IF-8)**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.2` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Define the shared error codes and the problem-details response format.
  - Covers: PB-1
  - Waits on: P-01.
  - Done when: The registry validates and a test shows an API error in the agreed format.
  - Handoffs: H-01, H-02, H-03, H-04, H-91 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-03. Domain event schema (IF-3) with fixtures and replay script**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.3` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Define the platform domain events, fixtures and a replay script.
  - Covers: PB-2
  - Waits on: P-02.
  - Done when: Every fixture validates, the replay script emits them in order to a local consumer and the validation runs in CI.
  - Handoffs: H-22 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-04. Platform and lab API fragments, bundle, mock and generated clients (IF-1, IF-2)**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.4` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Write the platform API fragment, bundle it with the lab fragment, a mock server and generated clients.
  - Covers: PB-3
  - Waits on: P-02, P-03, Tanmay's L-05 (lab fragment) and Sahil's T-02 (catalogue stubs).
  - Done when: The bundle validates, the mock answers every endpoint and clients are generated in CI.
  - Handoffs: H-12, H-13, H-14, H-16, H-17, H-19, H-20, H-23, H-84, H-85, H-86, H-87, H-88, H-89, H-90, H-91 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-05. Ports, in-memory fakes and table ownership (IF-9, IF-10)**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.5` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Define the ports the platform provides (AuditPort, OutboxPort, KeyPort, ScopePort, SettingsPort, QuotaPort) as Python protocols with in-memory fakes, fakes of the lab ports and the table-owners file.
  - Covers: PB-4
  - Waits on: P-02, P-03.
  - Done when: Tests run against the fakes and the table-owners file validates (the CI ownership check is Tanmay's L-07).
  - Handoffs: H-05, H-06, H-07, H-08, H-09, H-10, H-11, H-12, H-13, H-14, H-15, H-18, H-20, H-21, H-83, H-90, H-91 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-06. API skeleton: kernel and single-head migrations**
  - Epic: `epic-platform-baseline`
  - BMAD story: already planned, ref `1.6` in `epic-platform-baseline` (find it with `bmad-ticket`)
  - Build: Settings, session and organisation scope, audit, outbox and key-service stubs, request IDs and structured logs, health, readiness and version endpoints, one Alembic history.
  - Covers: PB-5
  - Waits on: P-01, P-03, P-05.
  - Done when: The API starts against Postgres, `alembic heads` shows one head and a scope test refuses a query without an organisation filter.
  - Handoffs: H-05, H-07, H-16, H-19, H-22, H-23 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-07. Dashboards skeleton with the same-origin proxy (local)**
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

- [x] **P-09. Outbox, queue worker and email provider**
  - Epic: `epic-notifications-and-email`
  - BMAD story: planned, ref `2.1` in `epic-notifications-and-email` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Transactional outbox, Dramatiq worker with retries, and the email provider adapter.
  - Covers: FR-NTF-02, 03
  - Waits on: P-06. Open: which provider, Resend or Brevo (OI-32).
  - Done when: An email goes through the outbox, a failed send is retried and nothing is lost on a restart.

- [x] **P-10. Email templates and in-app warnings**  (email templates built; the in-app warnings part, FR-NTF-04, was moved to story 2.3 because it needs the live hub and the dashboards: NOT built here)
  - Epic: `epic-notifications-and-email`
  - BMAD story: planned, refs `2.2` (email templates, state `built`, awaiting the developer's confirmation) and `2.3` (in-app warnings, planned, blocked until P-22 to P-26) in `epic-notifications-and-email`
  - Build: Templates for every email type and in-app warnings.
  - Covers: FR-NTF-01, 04
  - Waits on: P-09.
  - Done when: Each email type renders and sends in a test and the warnings show in the app.
  - Handoffs: H-128 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-11. Learner signup, email verification and signup abuse protection**
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: planned, ref `3.1` in `epic-accounts-and-sessions` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Learner signup with Argon2id passwords, email verification and rate limits against abuse.
  - Covers: FR-ACC-01, 02, 10
  - Waits on: P-10. Open: CAPTCHA choice.
  - Done when: A learner can sign up and verify by email on the local stack, and the abuse limits trigger in a test.
  - Handoffs: H-127 (answered in P-11), H-129 (to Tanmay, L-11) (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-12. Login, sessions, timeouts and CSRF**  (the user's own session list and "log out everywhere" exist as tested service functions; their routes need a contract change and moved to story 3.6)
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: planned, ref `3.2` in `epic-accounts-and-sessions` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done; the routes of FR-ACC-04's session list are story `3.6`
  - Build: Session cookies, idle and absolute timeouts, logout, CSRF protection and the cookie rules of NFR-SEC-03.
  - Covers: FR-ACC-03, 04
  - Waits on: P-11.
  - Done when: Login, logout and both timeouts work and a request without a CSRF token is refused.
  - Handoffs: H-131 (to Tanmay, L-11) (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-13. Account types, candidate role and admin creation**  (service level: no HTTP route for role changes or admin creation yet, they come with the admin area P-28 and the invite routes P-21)
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: planned, ref `3.3` in `epic-accounts-and-sessions` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Separate account types, the candidate role on the same login, and admin account creation.
  - Covers: FR-ACC-05, 06, 11
  - Waits on: P-12.
  - Done when: Roles are enforced in tests and an admin can only be created as FR-ACC-11 says.
  - Handoffs: H-130 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-14. Password reset, password quality and account self-service**  (API level: the forgot-password, reset and account pages are dashboards work)
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: planned, ref `3.4` in `epic-accounts-and-sessions` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Password reset by email, password quality rules, and self-service account management.
  - Covers: FR-ACC-08, 09
  - Waits on: P-10, P-12.
  - Done when: A reset link works once and expires, weak passwords are refused and a user can change their details.
  - Handoffs: H-127, H-130, H-132 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-15. Multi-factor login**  (API level: no enrolment or sign-in page, those are dashboards work; OI-13 stays open)
  - Epic: `epic-accounts-and-sessions`
  - BMAD story: planned, ref `3.5` in `epic-accounts-and-sessions` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Multi-factor login as the requirement specifies.
  - Covers: FR-ACC-07
  - Waits on: P-12.
  - Done when: MFA enrolment and login work in tests, and recovery is covered.
  - Handoffs: H-130, H-134 (answered here), H-135 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-16. Consent screen, consent record, minimum data and 18-and-over**  (API level: the notice text and the three routes; no consent page, and no attempt in state consent exists until P-21; OI-37 answered, wording is a draft until legal review OI-33)
  - Epic: `epic-privacy-audit-and-keys`
  - BMAD story: planned, ref `4.1` in `epic-privacy-audit-and-keys` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Consent screen, stored consent record, collect only the minimum data, 18-and-over check.
  - Covers: FR-PRV-01, 02, 03, 13
  - Waits on: P-12. Open in part: OI-37.
  - Done when: A new user cannot proceed without consent and the consent record is stored.
  - Handoffs: H-136 (see docs/dev/HANDOFFS.md; read them when you plan P-21, P-24 and P-25)

## Sprint 3 (22 Oct to 28 Oct 2026)

Goal: Audit and keys, companies, assessments and invites, live updates, retention.

- [x] **P-17. Audit log and key service**  (the mechanism and the entries that exist today: logins, failed logins, logouts, roles, admins, second factor, consent; every other sensitive action writes its entry in the story that creates it; OI-28 answered, anchor schedule and purge are P-24, snapshot and anchor shipping are operator steps)
  - Epic: `epic-privacy-audit-and-keys`
  - BMAD story: planned, ref `4.2` in `epic-privacy-audit-and-keys` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Append-only audit log, encryption at rest and the key service with a KeyPort.
  - Covers: FR-PRV-10, 12
  - Waits on: P-12. Open in part: OI-28. Tanmay's flag and evidence tasks use your KeyPort.
  - Done when: Every sensitive action writes an audit entry and the key service encrypts and decrypts in a test.
  - Handoffs: H-08, H-09, H-10, H-21, H-132, H-135 (answered here), H-137 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-18. Recruiter signup and company approval**  (service level: IF-1 has no recruiter or admin route, they are story 5.3 and a contract change; OI-10 and OI-11 answered: free webmail allowed, re-apply any time)
  - Epic: `epic-companies-and-approval`
  - BMAD story: planned, ref `5.1` in `epic-companies-and-approval` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Recruiter signup, the company state machine from signup to active, rejected and suspended, and the approve and reject API.
  - Covers: FR-ORG-01, 02, 04
  - Waits on: P-13, P-17. Open: free-email recruiters (OI-10).
  - Done when: A company moves from signup to approved or rejected with reasons and audit entries.
  - Handoffs: H-138 (see docs/dev/HANDOFFS.md; read them when you plan P-19, P-20 and P-28)

- [x] **P-19. Company members, admin controls, data scoping, terms and invite caps**  (service level, no routes (story 5.3); the cap is a decision function that P-20 applies when it counts the invites; assessments, invites and candidates do not exist yet, so the cross-company test over them comes with P-20 and P-21)
  - Epic: `epic-companies-and-approval`
  - BMAD story: planned, ref `5.2` in `epic-companies-and-approval` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Colleagues join through the owner, admin controls over companies, company scoping of data, data-processing terms, invite caps.
  - Covers: FR-ORG-03, 05, 06, 07, 08
  - Waits on: P-18.
  - Done when: A recruiter never sees another company's data in tests and invite caps are enforced.
  - Handoffs: H-138 (partly answered here), H-139 (see docs/dev/HANDOFFS.md; read them when you plan P-20 and P-21)

- [x] **P-20. Assessment template, creating and sending invites, invite lifecycle**  (service level, no routes (story 5.3); the invite mail arrives on the local stack at an address with no account; OI-14 and OI-15 answered: template settings)
  - Epic: `epic-assessments-and-invites`
  - BMAD story: planned, ref `6.1` in `epic-assessments-and-invites` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Assessment template, create and send invites by email, invite lifecycle states.
  - Covers: FR-ASM-01, 02, 03
  - Waits on: P-10, P-19.
  - Done when: A recruiter creates an assessment and sends an invite and the invite email arrives.
  - Handoffs: H-139, H-140 (see docs/dev/HANDOFFS.md; read them when you plan P-21)

- [x] **P-21. Accepting invites, re-invite after a fault and bulk invites**  (service level, no routes (story 5.3); `create_app` takes the lab runtime's attempt port when the lab runs in the same process (tests give an engine port); the first way of FR-ASM-04: a different verified address cannot use the link)
  - Epic: `epic-assessments-and-invites`
  - BMAD story: planned, ref `6.2` in `epic-assessments-and-invites` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: A candidate accepts an invite with consent, a re-invite after a fault, and bulk invite handling.
  - Covers: FR-ASM-04, 05, 06
  - Waits on: P-16, P-20.
  - Done when: Accept, re-invite and bulk work in tests and the invite purge job can see expired invites.
  - Handoffs: H-133, H-136, H-141 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [x] **P-22. Live updates hub: SSE, heartbeat, snapshot with polling fallback, fan-out**  (server side: nothing in the lab publishes events yet (H-142), the browser client and polling are the dashboards', HTTP/2 and the per-role tests are P-23; proven on the local stack through the web origin, not through Vercel (S-14))
  - Epic: `epic-live-updates`
  - BMAD story: planned, ref `7.1` in `epic-live-updates` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Server-sent events with heartbeat and no buffering, a snapshot plus polling fallback, and the fan-out path from events to streams.
  - Covers: FR-LIV-01, 02, 04, 06
  - Waits on: P-06, P-12. Tanmay's L-11 proves SSE through Vercel (S-14).
  - Done when: A change shows live in a browser within the target time and the polling fallback works when SSE is blocked.

- [x] **P-23. Stream authorisation and HTTP/2**  (the stream is authorised from the session and the company's standing and re-checked while open; HTTP/2 proven locally through the real Caddy image, not through Vercel (S-14); the stream and snapshot no longer extend an idle session)
  - Epic: `epic-live-updates`
  - BMAD story: planned, ref `7.2` in `epic-live-updates` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Authorise every stream per user and company; HTTP/2 as far as the spike allows.
  - Covers: FR-LIV-03, 05
  - Waits on: P-19, P-22.
  - Done when: A user cannot subscribe to another user's or company's stream.

- [x] **P-24. Retention scheduler, retention rules and log rules**  (service level: no admin route, the status data exists (`Scheduler.status`); the lab erases attempts through `LabRuntime.erase`; raw container logs are the lab's; the periods are the requirements' numbers, not legally reviewed (OI-33))
  - Epic: `epic-privacy-audit-and-keys`
  - BMAD story: planned, ref `4.3` in `epic-privacy-audit-and-keys` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Retention and auto-delete jobs for candidates and learners, evidence data rules, controller and processor roles, IP and browser details, system logs, synthetic data only.
  - Covers: FR-PRV-04, 05, 06, 07, 14, 15, 16, 17, 18
  - Waits on: P-17, P-21.
  - Done when: The jobs run on schedule, the invite purge runs and an admin can see the last run.

## Sprint 4 (29 Oct to 4 Nov 2026)

Goal: Deletion, the four dashboards, exports, the admin area and deployed verification.

- [x] **P-25. Deletion workflow, 7-day undo and "who viewed me"**  (service level plus person routes: the company's decision and direct deletion have no routes until story 5.3; no email to the parties (OI-12); the view history stays empty until the dashboard and the exports call `ViewHistory.record`; the periods are not legally reviewed (OI-33))
  - Epic: `epic-privacy-audit-and-keys`
  - BMAD story: planned, ref `4.4` in `epic-privacy-audit-and-keys` (find it with `bmad-ticket`); state `built`, awaiting the developer's confirmation to mark it done
  - Build: Account deletion request and workflow with a seven-day undo window, and the candidate view of who viewed their data.
  - Covers: FR-PRV-08, 09, 11
  - Waits on: P-17, P-24 and Tanmay's purge call (AttemptPort).
  - Done when: A deletion request completes after seven days, can be undone before, and a candidate sees who viewed.

- [x] **P-26. Learner and candidate dashboards with hints**  (export is P-29; `after_release` results hidden in the page only until stream L adds the server rule (H-355); the write-up is Tanmay's IF-2 1.2.0 field, practice attempts only; not browser-tested (OI-30))
  - Epic: `epic-dashboards-and-exports`
  - BMAD story: planned, ref `8.1` in `epic-dashboards-and-exports` (find it with `bmad-ticket`); state `done` (confirmed by the developer 2026-10-20, merged in pull request 58)
  - Build: The learner and candidate dashboards, learner hints, candidate hints off by default.
  - Covers: FR-DSH-01, 04, FR-HNT-01, 02
  - Waits on: P-22, Tanmay's scoring (L-23) and the catalogue (T-30). Open in part: OI-15.
  - Done when: Both dashboards show live data on the deployed site and candidate hints are off by default.
  - Handoffs: H-134, H-135 (see docs/dev/HANDOFFS.md; read them when you plan this task)

- [ ] **P-27. Recruiter dashboard, live monitor and hints used**
  - Epic: `epic-dashboards-and-exports`
  - BMAD story: not planned yet; created when you incept `epic-dashboards-and-exports` (see START-HERE.md, section "First task of an epic")
  - Build: The recruiter dashboard, the live monitor of running attempts and the hints-used view.
  - Covers: FR-DSH-02, 03, FR-HNT-03
  - Waits on: P-19, P-22.
  - Done when: A recruiter sees only their company's candidates live.

- [x] **P-28. Admin operations: queue, users, force-stop, settings, quotas, capacity**  (force-stop needs a lab in the API process, so it is tested with a stand-in, not on the Compose stack; quota and cap numbers are placeholders (OI-21); no admin dashboard pages (P-30))
  - Epic: `epic-admin-and-operations`
  - BMAD story: planned, ref `1` in `epic-admin-and-operations` (find it with `bmad-ticket`); state `done` (confirmed by the developer 2026-10-20)
  - Build: Approval queue screen, user management, force-stop, settings and quotas (provides SettingsPort and QuotaPort to Tanmay), capacity view.
  - Covers: FR-ADM-01, 02, 04, 05, 06
  - Waits on: P-18 and Tanmay's L-16 (InstancePort, capacity).
  - Done when: An admin approves a company, force-stops an instance and changes a quota that the lab then enforces.
  - Handoffs: H-15, H-122, H-128, H-133 (see docs/dev/HANDOFFS.md; read them when you plan this task)

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
