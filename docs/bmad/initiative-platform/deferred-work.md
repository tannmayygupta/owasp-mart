- source_plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan.md`
  summary: Add an automated browser-level check that the dashboards page hydrates and shows the health result (Playwright, with the dashboards skeleton).
  evidence: Story 1.1 shipped with the page stuck on "Checking the API..." because Next 16 blocked dev resources from 127.0.0.1; every non-browser check (HTTP, e2e) passed. Found only by a real-browser check and fixed with allowedDevOrigins. A guard belongs in story 1.7 (dashboards skeleton).
- source_plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan.md`
  summary: Add a CI check that apps/web/pnpm-lock.yaml and the root pnpm-lock.yaml do not drift apart.
  evidence: The dev image installs from the app's own lockfile (as apps/shop does) while CI installs from the root lockfile; two sources of truth for the same dependencies.
- source_plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan.md`
  summary: Make `node scripts/dev.mjs up web` (without platform) fail with a clear message instead of Compose's "depends on undefined service" error.
  evidence: The web service depends on api (profile platform). README says to start both; a lone `up web` prints Compose's raw error. Low impact; dev.mjs is stream L's file, so raise it with Tanmay.
- source_plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan.md`
  summary: Check the web dev container on a Linux or macOS host, where the bind-mounted source is owned by a host user other than uid 65532.
  evidence: Verified on Windows only (the developer uses no Mac). Next may fail to write next-env.d.ts or tsconfig.json into a source folder it does not own. Unverified; would be medium for a Linux or Mac developer.

## Deferred from: code review of story-platform-stack-runs-end-to-end-locally-tracer-bullet-plan (2026-10-11)

- The real Postgres and Valkey checks, the `/api` rewrite and both Dockerfiles are verified only by `scripts/e2e/platform-stack.e2e.test.mjs`, which no CI workflow runs; CI also builds no image and does not typecheck the web app. Would be medium. Settle by a CI job that runs `pnpm run test:e2e` (stream L owns the CI shape).
- No automated browser-level test that the page hydrates (see the first entry above); to be added with story 1.7.
- Two lockfiles for the web app can drift (see above).
- `up web` without `platform` fails with Compose's raw error (see above).

## Deferred from: code review of story-error-registry-and-problem-details-format-if-8-plan (2026-10-11)

- The end-to-end test (which proves the API image and the web-origin pass-through of error bodies) is not run in CI; only the image build is (added in this review). Would be medium. Settle with a CI job that runs `pnpm run test:e2e`. Source plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-error-registry-and-problem-details-format-if-8-plan.md`.
- Nothing reads the instance contract's exit-code table or stream L's contracts to compare with the registry: the registry matches them today by construction (seeded 2026-10-11) and can drift. Settle with a check that parses `contracts/instance/instance-contract.md` section 5 and, once stream L's contracts are merged, their code lists.
- Registry gaps: no generic `REQ-RATE-LIMITED` (429), `REQ-UNAVAILABLE` (503), `REQ-TIMEOUT`, `AUTH-FORBIDDEN` (403 for a signed-in user) or sign-in failure code, and `retryable` is in the registry but not in the body (no `Retry-After` convention). Add them with the stories that need them (accounts, P-11 and P-12); each is an additive change.
- The generated TypeScript file is not type-checked in CI (it was checked once with `tsc --strict`, exit 0). Add when `apps/web` imports `@vulnmart/ts-client`.

## Deferred from: code review of story-domain-event-schema-if-3-with-fixtures-and-replay-script-plan (2026-10-11)

- No mapping from orchestrator infrastructure faults (IF-4 `fault_class` and `detail_code`) to an `INST-*` registry code: only `INST-HEALTH-TIMEOUT` and the injector codes exist. Needs stream L's list of fault classes; add the codes to the registry and a fixture when L defines them. Source plan: `docs/bmad/initiative-platform/epic-platform-baseline/story-domain-event-schema-if-3-with-fixtures-and-replay-script-plan.md`.
- The H-22 decision (64-bit `seq`, reserved range, `infrastructure_fault` written by the orchestrator) is recorded in HANDOFFS, the IF-3 README and the changelog, but IF-4 and IF-5 text and schemas (stream L's) do not say it yet; they change in their own story.
- The replay script has its own hub and consumer and cannot be pointed at another one; a `--url` mode to drive the real hub is a follow-up for P-22. No code resolves an audience from an attempt yet (the relay, P-05 and P-22); the fixtures supply the resolved audiences and the validator compares them with the table.
- Streams are not size-limited in the contract (trim age or length, connection caps, slow consumers): decided with the hub in P-22 and spike S-2.

## Deferred from: code review of story-platform-and-lab-api-fragments-bundle-mock-and-generated-cli-plan (2026-10-11)

- Mock lab half: lab operations are proxied to the fake lab and tested only for reachability; a bundle-level comparison with the bundle's lab examples is a later hardening (stream L's `test_lab_contract.py` covers the fake lab against IF-2).
- Mock parameter validation: path, query and header parameters are not validated (`limit=1000` gives 200, not 422); add when P-07 needs a failure path.
- IF-1 has no account-deletion or email-change route; later stories (FR-PRV, P-25).
- Client has no `/live` helper (reconnect, `Last-Event-ID`, `stream.resync` then snapshot); write with the dashboards (P-07).
- Client does not throw when an authenticated write has no CSRF token; a dashboards decision (P-07).

- Decision on paging (open point 15): no cursor for the sprint-2 slice; add additively with the dashboards story that needs it.

## Deferred from: story-multi-factor-login-plan (2026-10-18)

- OI-13 stays open: whether recruiter MFA becomes mandatory and whether passkeys replace or add to TOTP. Only TOTP exists.
- The field key is a setting until the key service (P-17, handoff H-135); changing it makes every sealed TOTP secret unreadable and every recovery code unmatched, so it needs a migration plan before the first real use.
- An admin who loses the phone and all recovery codes can be recovered only by an operator in the database; no runbook step exists for that yet (the runbook says it must be done by hand).
- No mail tells a person that a recovery code was used or that the second factor was turned on or off (not in the list of FR-NTF-01); the audit entries exist (in memory until P-17).
- The enrolment and sign-in pages (dashboards): the otpauth address and the recovery codes are shown once by the API and a page must not store them (handoff H-135).
- An account can start enrolment again and again before confirming (each replaces the pending secret); only the per-address login limit bounds it.
- Learners and candidates may also turn the factor on; no page offers it and no requirement asks for it.
- ASVS 5.0 and NIST SP 800-63B were not re-read; RFC 6238 was checked by its published test vectors and by an independent Node implementation, not by reading the RFC.

## Deferred from: story-password-reset-quality-and-account-self-service-plan (2026-10-17)

- The forgot-password, reset-password, account and signup pages (dashboards, handoff H-134); an email change (needs its own verification step).
- Which breach check is the default is the developer's call (ADR 0044): the bundled list of 10,000 passwords misses most breached passwords (`password1234` passes); `VULNMART_BREACH_CHECK=hibp` closes that and tells a third party a 5-character hash prefix. The range client was checked against the live service by hand once for the response format and never in an automated test.
- In `hibp` mode an outage of the service means passwords are accepted on the other rules with only a log warning; nothing alerts anyone.
- No "your password was changed" mail (it is not in the list of FR-NTF-01); a person whose account was taken over would not be told. Worth adding to the list.
- The refusal sentences are a first draft; the length rule is the contract's proposal (12) and the placeholder numbers (24-hour links, 3 reset mails an hour per address) are not tuned.
- The own-details rule compares only the email, its local part and the display name from 4 characters; it does not know other personal data.

## Deferred from: story-account-types-candidate-role-and-admin-creation-plan (2026-10-17)

- The routes for an admin to grant or revoke a role and to create another admin (P-28, a contract change) and the invite acceptance that calls `grant_candidate_role` with its clear refusal message and a new registry code (P-21): handoff H-133.
- Audit entries (`role.granted`, `role.revoked`, `admin.created`) go to the in-memory audit port until the durable log exists (P-17, handoff H-132); the seed command also logs them. Until P-17 a restart loses them.
- An admin cannot sign in until the second factor exists (P-15) and an admin created by an admin cannot choose a password until the reset story (P-14) consumes the `reset` token of the mail; so no admin screen can be tried yet.
- The seed operator knows the first admin's initial password; a change at first sign-in is P-14.
- The wording of `account.admin_created` is a first draft.
- A role-gated route answers 404 like an unknown route; there is no 403 in the error registry, which also means a user cannot be told "this needs a recruiter account" (a UX question for the dashboards).
- Account type changes after creation (a person who becomes a recruiter) are not supported: a new account is needed. The database refuses the change while the account holds a role.

## Deferred from: story-login-sessions-timeouts-and-csrf-plan (2026-10-17)

- The routes for a user's own session list, revoking one session and "log out everywhere" (FR-ACC-04): story 3.6; the service functions are built and tested.
- The login form and the "who am I" page (dashboards); `getMe` and `updateMe` are P-14.
- Expired and revoked rows stay in `sessions` until a purge job exists (the retention scheduler, P-24).
- The architecture's Valkey cache of active sessions is not built; every authenticated request is one Postgres read (plus a write at most once a minute). Measure before adding it.
- The login limits (60 attempts an hour per visitor address; 10 wrong passwords in 15 minutes per email address) are placeholders; the per-email wait also stops the right password for that window.
- A strict deployment accepts one dashboard origin only; `localhost` and `127.0.0.1` are different origins to the check.
- The Argon2id hash upgrade at login (`needs_rehash`) is tested with a weak hash but no production hash is older than the current profile yet.
- The session and CSRF behaviour was checked against the contract and a local browser-less client; not in a real browser, and not on the deployed Vercel path (handoff H-131).

## Deferred from: story-learner-signup-email-verification-and-signup-abuse-protection-plan (2026-10-17)

- The signup form and the verify-email page (the link in the mail points at `${public_origin}/verify-email?token=...`, a dashboards page that does not exist yet); until then a learner can only be created and verified through the API. No task before P-26 builds them: decide which dashboards story owns them.
- Argon2id is at the OWASP minimum (19 MiB, 2 passes, 1 lane); the epic's note says it is tuned in spike S-12 on the real VM.
- Rate limits: login, password reset and invite endpoints (FR-ACC-10) come with their stories; the numbers are placeholders; the fixed window allows up to twice the limit around a window edge.
- `trusted_proxy_hops` is 1; behind `caddy-p` it must be 2 (handoff H-129, Tanmay) and nobody has measured it on the deployed path.
- The breach-list check and password quality rules (FR-ACC-08) are P-14: signup checks the length only.
- Concurrent hashing is capped at 4 per API process by a semaphore; the cap was chosen for the 256 MiB container, not measured under load.
- The mail text of `account.already_registered` is a first draft like the other templates.

## Deferred from: story-email-templates-plan (2026-10-17)

- FR-NTF-04 and FR-SES-03 (in-app time warnings, recruiter alerts): story 2.3 of `epic-notifications-and-email`, after the live hub (P-22, P-23) and the dashboards (P-26, P-27). Open: where the 15 and 5 minute warnings come from (a scheduler timer that records the event, or the page computing them from `deadline_at`) and who owns the timer between this stream and stream L.
- A single-use link sits in `email_outbox.params` while the row is `pending` or `failed` (it is removed once sent). Encrypting link parameters with the KeyPort (P-17) would close that window.
- The nine templates were not sent to a real Mailpit in this story (Docker would not start on the developer's PC): rendering, sending through a fake provider and the SMTP message builder are tested; a real-stack check of one verification mail is still to do.
- Wording of the nine mails is a first draft by the builder, not reviewed by the developer or a language reviewer; P-25 may change the deletion mails' parameters.

## Deferred from: story-outbox-queue-worker-and-email-provider-plan (2026-10-17)

- Admin HTTP routes for the failed-mail list, the outbox counts and requeue (P-28, H-128); the functions exist and are tested.
- Provider facts not verified at build time: whether Brevo's 300 a day also counts API mail; Single Sender Verification steps; the production sender address (OI-9, OI-32). The Brevo adapter was tested against fake HTTP answers built from the documentation, never against Brevo itself (no account or key was used).
- Spike S-18 (Dramatiq on Valkey under a worker kill and under load) is still open; this story shows delivery and a worker restart on Valkey 9.0.6, not a kill during a send.
- Delivery is at-least-once (ADR 0040); a duplicate is possible only in the window between the provider accepting a mail and the row being marked sent.

## Deferred from: code review of story-dashboards-skeleton-with-the-same-origin-proxy-local-plan (2026-10-12)

- The health page's own client call is not run in a real browser under the CSP (no browser harness yet); the e2e test fetches the same URL and checks the CSP. Add a browser test with the first dashboards story that needs one.

## Deferred from: story-consent-screen-consent-record-minimum-data-and-18-and-over-plan (2026-10-18)

- The consent page (dashboards): the unticked agree box, the Start and Decline buttons, reading the notice from getConsentNotice and sending the version and hash back.
- No attempt in state `consent` exists until the invite flow (P-21); the running API uses an empty `ConsentTargets`, so every attempt id is 404. The real port, and the step out of `consent` in stream L's `AttemptPort` (handoff H-136).
- The contract, architecture 04 section 10.1 and `AttemptPort.cancel` disagree about where a decline ends the attempt (`cancelled` or `withdrawn`).
- Withdrawal (P-25): a new row with action `withdrawn`; the withdraw route, the 7-day undo and the recruiter mail.
- The notice wording is a draft; a lawyer has not reviewed it (OI-33). A new wording needs a new version line in `privacy/notice.py` (the old line stays).
- OI-37 is answered (assessment retention plus 12 months, `consent_record_extra_months`) but not yet written into `initial.md`; the purge that shrinks an expired record to hash and version (P-24) and the pseudonymisation on deletion (P-25) are UPDATEs the application role cannot do: a decision for P-24 (handoff H-136).
- `audit_seq` links to the in-memory audit stand-in until P-17, so it points at nothing durable yet.
- The inventory test lists the columns of the tables of streams P; the lab's tables (attempts, evidence, events) are inventoried by stream L's stories.
- The rate limit on decisions (30 an hour per account) is a placeholder.

## Deferred from: story-audit-log-and-key-service-plan (2026-10-18)

- The 12-month purge of audit rows (needs a privileged path that writes a checkpoint first) and the scheduled daily anchor job and chain check with an admin alert: story P-24.
- The audit entries of events that do not exist yet (approvals, invites, views and exports of candidate data, assessment steps, deletion steps, retention changes, admin access, log reads, failed access to resources): each is written by the story that creates the event.
- The keystore snapshot after every shred (new snapshot, then delete older ones), the 14-day backup of the data database off VM-P, shipping the anchor file off the machine, and mounting a writable volume for it: operator and deployment steps (runbook, P-32, L-17); nothing was run on a VM.
- A restore drill with real backup files (spike S-19); the test here uses a copy of the data taken before the shred.
- The signed one-line commit to a separate repository and the email to the admins (ADR 0008) are not built; the anchor is a table row and a signed line in a file.
- KeyPort.flag has no key version argument (handoff H-137); the three master keys have no rotation procedure.
- The seed-admin command still writes its `admin.created` entry to an in-memory port, not to the durable log.
- The audit write is committed before the caller's transaction (an action that rolls back still leaves its entry); joining the caller's transaction needs a request-scoped session.
- Raw user ids remain in other tables (consent records, the email outbox): the pseudonym protects the audit log only (P-25).
- Every failed login writes an audit row; the volume is bounded by the rate limits but not by retention until P-24.
- OI-28 is answered (self-hosted on VM-P) but not yet written into initial.md.

## Deferred from: story-recruiter-signup-and-company-approval-plan (2026-10-18)

- No HTTP route: IF-1 has no recruiter signup, standing, queue or decision route. A route is a contract change (bundle, generated clients, mock, COMPAT, the contract owner's look): story 5.3 of the companies epic (handoff H-138).
- Colleagues joining a company by request, the data-processing terms accepted at approval (architecture 04 section 10.5), the invite cap, the admin delete, and the organisation scope set from the session for recruiters: story P-19. Two recruiters of one domain each start their own company until then.
- The invite itself and its use of the gate `active_company_of`: P-20.
- The admin queue screen and the other admin operations: P-28.
- The disposable-domain list is a starter list of 75 domains written from memory; it is not maintained and not verified. Replace it with a maintained list and record its source and date.
- OI-10 and OI-11 are answered by the developer (free webmail allowed with no extra check; re-apply at any time) but not yet written into initial.md. With no check on free webmail and no waiting period, the single admin approval is the only gate against fake recruiters.
- A company is created for any domain: nothing checks that the email domain belongs to the company named.
- The mail to admins about a new pending company is not built (the queue is pulled).
- The two read-only policies (`admin_read`, `own_membership`) are exceptions to ADR 0014's one rule: a future table must opt in on purpose, and nothing with candidate data may.

## Deferred from: story-company-members-admin-controls-data-scoping-terms-and-invite-caps-plan (2026-10-18)

- Still no HTTP route for any recruiter, company or admin function (story 5.3, a contract change); the terms page, the member list and the join request screens are dashboards work.
- The cap is a decision function: counting the invites sent today, showing the message and keeping the pending list is story P-20. Assessments, invites and candidates do not exist yet, so a test that a recruiter of company A cannot read, change or guess company B's assessments, invites or candidates comes with P-20 and P-21 (two tests already fail when a new table with an organisation column is not scoped).
- Deleting a company changes its state, ends its members' access and frees its domain; removing its data (and its join requests and terms acceptances, which the application role cannot delete) follows the retention rules: P-24, P-25.
- A person is in one company only; changing company means being removed and asking again. An owner cannot hand the company to someone else or leave it.
- Nothing checks that a domain belongs to the company named; with OI-10 and OI-11 as answered, the one admin approval is the only gate, and the first signup of a small provider's domain that is missing from the free-webmail list claims it.
- The free-webmail list is a starter list from memory (about 45 domains); replace it with a maintained list. The data-processing terms are a draft no lawyer has reviewed (OI-33).
- A colleague's outcome mail reuses the company approval template ("your company has been approved"); a dedicated template changes the FR-NTF-01 list.
- The owner is not told about a new join request by mail (the list is pulled); a stream already open when a recruiter is removed or suspended is for the live-update stories to close (P-22, P-23).
- OI-11's second half (company-name verification beyond the email domain) was not asked and is not built.

## Deferred from: story-assessment-template-creating-and-sending-invites-invite-lifecycle-plan (2026-10-18)

- No HTTP route for templates or invites (story 5.3, a contract change); the dashboards screens (P-26, P-27).
- Accepting an invite (opening the link, sign-in or registration with a matching verified address, the consent screen, the candidate role, handing a consented attempt to the lab port), a re-invite after a fault that supersedes the old attempt, and bulk invites: story P-21. `Invite.superseded_by` exists and nothing writes it.
- The consent notice shows the setting `candidate_retention_days`; the template has its own `retention_days`, which the consent notice should show once `ConsentTargets` is real (P-21).
- `expire_all` exists; the scheduler that calls it daily, and the invite purge that empties `token_hash` (the column is nullable for it), are story P-24.
- A resend is not limited and does not count against the daily cap; only a created invite counts.
- `sent` is read from the queued mail when the invite is read and can lag until then; opening the link counts as delivery.
- An outbox row of a failed invite mail keeps its sealed address until an admin requeues it or it is removed.
- A deleted candidate's invite keeps `email_ci`; whether deletion clears it is for P-25.
- The template ranges are the research placeholders of OI-25 (time 30 to 480, resets 0 to 10, expiry 1 to 30, retention 30 to 365); OI-14 and OI-15 are answered but not yet in `initial.md`. A cost percentage of hints (default 20 when hints are on) is a placeholder.
- A template cannot be archived, only deleted when it has no invites.

## Deferred from: story-accepting-invites-re-invite-after-a-fault-and-bulk-invites-plan (2026-10-18)

- No HTTP route for opening a link, accepting, a re-invite or a bulk invite (story 5.3, a contract change); the candidate's pages and the recruiter's invite screens (P-26, P-27).
- Only the first way of FR-ASM-04 is built (a different verified address cannot use the link); the "bind only after the candidate confirms" way is not.
- `create_app` uses the lab runtime's own attempt port when `VULNMART_LAB_RUNTIME=1` runs the lab in the same process (merged from main on 2026-10-18); without the lab runtime the consent routes still answer 404 for every attempt id. Not run against a real lab runtime: only the engine in tests and in the stack test (H-141).
- Later generations of a re-invite use the template key `<template>~n` on the lab port because the engine allows one attempt per account and template; a real supersede on the port is stream L's. The rules of the invite are not yet passed to the attempt.
- A grant recorded for an invite that was revoked in the meantime leaves a consent record without an attempt; the candidate is refused with the invite's state.
- The invite keeps `user_id`, `attempt_id` and `email_ci` after it closes; the retention sweep (P-24) and deletion (P-25) decide when they go. `consent_records` stay append-only (H-136).
- Binding is by the verified address only; a candidate who registered with another address needs a new invite. A bulk list is capped at 500 addresses (a placeholder, OI-25).
- The scheduler that calls `expire_all` and `purge_closed_tokens` is P-24.


## Deferred from: story-live-updates-hub-sse-stream-replay-buffer-heartbeat-snapshot-and-the-fan-out-from-events-to-streams-plan (2026-10-18)

- Nothing in the lab or the platform publishes domain events yet (stream L, H-142); the hub and relay are proven with rows written by the test and by the API port.
- The browser client (EventSource, resync handling, the polling fallback) is the dashboards' (P-26, P-27); this story is the server side and the snapshot.
- Streams are authorised from the session only; the per-role cross-user tests and HTTP/2 are story 7.2 (P-23). `POST /api/v1/live/ticket` stays pending spike S-14.
- The snapshot of a recruiter is empty (no attempts of their own); the company's attempts are P-27. The snapshot reads the lab runtime in the same process and is empty without one.
- Placeholders (OI-25): relay interval 250 ms, heartbeat 15 s, session check 30 s, maximum stream age 15 min, 6 streams per user, 2000 per process, 600 connects an hour per user, 1000 entries and one hour per stream, 20 relay passes before an event is dropped. The latency target of NFR-PRF-03 waits for spike S-2.
- The caps are per API process. An idle stream is trimmed only when it is next appended to, so its entries (ids and states) outlive an hour until then; retention (P-24) and deletion (P-25) must clear them.
- SSE through the real Vercel and Caddy path, and HTTP/2, are not verified (S-2, S-14). The web proxy of the local stack needed `compress: false`; Caddy's `encode` in front of production has not been checked.
- A client that held exactly the newest id before a Valkey reset is told to resync (the evidence that it was up to date goes with the reset).
- Old rows of `domain_events` are not purged yet (P-24).


## Deferred from: story-stream-authorisation-and-http-2-plan (2026-10-19)

- HTTP/2 is proven locally with the real Caddy image only; Vercel's leg and the Hobby plan are spike S-14 and not verified. The API itself speaks HTTP/1.1 and HTTP/2 between the front and the API is not used.
- A logout, revoke, suspension or removal ends an open stream within the 30-second re-check, not at once; the events delivered in between are the person's own and were authorised when appended.
- The stream and its snapshot do not count as session activity (the dashboards must make a real call when the person does something, H-143); whether the dashboards want a keep-alive ping is theirs to decide with the developer.
- The standing check is a few queries per connection per re-check; at the connection cap that is about 70 checks a second per process (placeholders, OI-25), and the cap is per process.
- The authorisation tests that need a company use the real services on SQLite and the Postgres suite of P-22; a Postgres test of the company stream with row-level security was not added (the stream reads no company table).
- A new company state (for example an archived one) takes the live view away only if `active_company_of` stops returning the company.


## Deferred from: story-retention-scheduler-retention-rules-and-log-rules-plan (2026-10-19)

- No route shows the last run of each job to an admin (`Scheduler.status` has the data); the admin area (P-28, P-30) adds it. A failed job is recorded, audited (`job.failed`) and logged; no email goes to the admins (OI-12, OI-34 are open).
- A company deleting a candidate earlier and a candidate's or learner's own deletion request with the 7-day undo are P-25; the retention jobs are written so those steps can be reused (H-144).
- Raw container logs (7 days, FR-PRV-06) are the lab's and the orchestrator's and are not deleted by anything built here. The evidence rule uses the lab's destroy claim (or the end of the attempt) as the destroy time, because the lab keeps no later instant.
- The legal review of the retention periods, the 18+ rule and the one-year log rule against erasure (OI-33, FR-PRV-19) has not happened; the periods are the requirements' numbers and the settings hold them.
- A learner who also took part in an assessment keeps the account (and so the e-mail address and name) until the assessment data is deleted by its own date; only the practice data goes at 12 months.
- The application role can still insert a row into `audit_checkpoint` (it always could); the anchors kept outside the database are what proves the log was not cut short.
- Mail rows older than 12 months are purged with the logs, although FR-PRV-15 names security and system logs only; the sealed address of a mail that never left is cleared after 30 days.
- The seed check finds addresses on non-reserved domains, numbers that pass the card check and well-known secret formats; it cannot tell a real person's name from an invented one, and it covers the shop's seed folders and the migrations, not future seed files in other folders.
- Companies that accepted the data-processing terms before version 2026-10-19.1 must accept again before they invite.
- The scheduler's intervals are after the last success, not clock times (a restart runs what is due at once); a dead run holds its job for up to an hour; raw per-job metrics are not exported.

## Deferred from: story-deletion-workflow-7-day-undo-and-who-viewed-me-plan (2026-10-19)

- No email confirms a decision or a deletion to the parties, and the company gets no reminder before the 14-day deadline (FR-PRV-08, OI-12); the escalation is an audit entry only.
- The company's side (`for_company`, `decide`, `company_delete`) has no routes until the recruiter routes of story 5.3.
- Nothing records into the view history yet: the dashboard (P-27) and the exports (P-29) must call `ViewHistory.record` (H-145).
- The `withdrawn` value of the consent record is still written by nothing; a candidate's withdrawal is their deletion request.
- The registry has no deletion error codes (the existing `ATT-NOT-FOUND` and `ATT-INVALID-STATE` are used); a `PRV` family is the cleaner design.
- The learner's account stays usable during the 7 days (no lock, no banner).
- The periods (7 and 14 days) are not legally reviewed (OI-33); VulnMart's 30-day execution after approval is replaced by the 7-day hold plus the hourly job.
- A candidate who also took part as a learner keeps the account when the learner request runs; the account is removed when no assessment data is left (the retention job or a later request).

## Story 1.9 (refactor sweep): every item above, triaged (2026-10-20)

Scope set by the developer on 2026-10-20: "small fixes + record the rest", and the accepted limitations below accepted as recorded. Each item was checked against the code of `main` after story 2.3 (a read-only triage, then checked while fixing). Labels: **A** is the four entries at the top, then **B** to **W** follow the "Deferred from" headings in order (B tracer bullet, C error registry, D domain events, E bundle and mock, F multi-factor login, G password reset, H account types, I login and sessions, J learner signup, K email templates, L outbox, M dashboards skeleton, N consent, O audit log and keys, P recruiter signup, Q company members, R assessment template, S accepting invites, T live hub, U stream authorisation, V retention, W deletion). The number is the bullet's place under its heading. 156 items in all; 40 were already closed by later stories and 14 are accepted limitations.

### Fixed in story 1.9
| Item | What was done |
|---|---|
| A2, B3 (lockfiles drift apart) | `scripts/web-lockfile-sync.test.mjs`: the `apps/web` importer and every package of the web lockfile must match the root lockfile (runs in CI's script tests). |
| B1, CI half (the web app is not typechecked in CI) | `pnpm run web:check` (typecheck plus `apps/web/test`), chained into `api:check`, which CI runs. The stack e2e half stays with stream L (below). |
| C2 (nothing reads the instance contract's exit-code table) | `exitCodeProblems` in `scripts/validate-errors.mjs`: the table and the registry's `exit_code` must agree both ways; tested. |
| F3 (no runbook step for a lost second factor) | "Lost second factor" in `docs/runbooks/seed-admin.md`. |
| F6 (enrolment again and again) | `rate_mfa_enrol_per_user_per_hour` (10, placeholder) on `startMfaEnrolment`; tested. |
| N1 (unticked agree box, Start and Decline) | The consent screen has an agree box that starts unticked; Start stays disabled until it is ticked; Decline. |
| N3 (where a decline ends) | `docs/architecture/04-data-and-state.md`: `consent --> cancelled: declined`, as the code does (the invite becomes declined; no attempt record). |
| N6, O11, P6, R9 (answered OIs not in `initial.md`) | D-98 (OI-10, OI-11), D-99 (OI-14, OI-15), D-100 (OI-28), D-101 (OI-37). The purge half of N6 was already closed (migration 0014, `ConsentPurge`). |
| O7 (seed-admin writes to an in-memory port) | The command writes `admin.created` to the durable, pseudonymised audit log; tested on Postgres. |
| R5 (a resend is not limited) | `rate_invite_resend_per_user_per_hour` (30, placeholder) on `actOnInvite` resend; tested. Whether resends count against the daily cap stays open (below). |
| U5 (no Postgres test of the company stream) | `test_companies_postgres.py`: `StreamAuthoriser` with the real `active_company_of` under row-level security. |
| (not a bullet) dead `check_password` in `accounts/service.py` | Removed; signup uses `check_new_password`. |

### Closed by later stories (evidence)
C4 (ts-client typecheck in `api:check`), D2 (D-42 seq lanes, IF-4), E4 (`apps/web/lib/live.ts`), E5 (`apps/web/lib/api.ts` CSRF), F5 and F7 (account page, P-26), H2 (`DbAuditPort`, `kernel/services.py`), H3 (P-15), I1 (story 3.6), I2 (P-26 `/login`, `/account`), I3 (`account_housekeeping`), J1 (P-26 signup, verify-email), J5 (`check_new_password`), K1 (story 2.3), K3 (Mailpit check in the stack e2e), N2 (P-21 `accept.py`), N7 (P-17), O1 (audit purge, checkpoint, anchor), O10 (`LogPurge`, P-24), P1 (P-27 routes, story 5.3 test), P2 (P-19), P3 (P-20 `invite_company_of`), P4 (P-28, P-30), Q2 (`test_privacy_wall.py`, P-30), R1 (P-27), R2 (P-21), R3 (`privacy/consent.py`), R4 and S8 (invite expiry and token purge jobs), R7 (sealed address cleared after 30 days), R8 and S6 (invite rows deleted on deletion and retention), S1 (P-26, P-27), T1 (`lab/live.py`), T2 (`lib/live.ts`), T4 (P-27 `/company/candidates`), T6 and T9 (`LiveCleanup`), V2 (P-25), W3 (view history, P-25 and L-25).

### Accepted limitations (developer, 2026-10-20)
G6 (the own-details rule is limited), I6 (one origin per deployment), I7 (rehash tested with a weak hash only), L4 (an at-least-once mail can arrive twice, ADR 0040), P9 (two read-only policies are exceptions to ADR 0014), R6 (`sent` lags the mail), S5 (a grant on a revoked invite), T8 (resync after a Valkey reset), U2 (the 30-second re-check), U6 (new company states), V5 (a learner keeps the account), V8 (seed-check limits), V9 (re-accepting the terms), W8 (a candidate who is also a learner keeps the account until no assessment data is left).

### Another stream or deployment
A3, B4 (`up web` without platform: `dev.mjs`, stream L); A4 (the web container on a Linux or Mac host: stream L or CI); B1, C1 (the stack e2e in CI: stream L, CI shape); D1 (IF-4 `fault_class` to `INST-*`: stream L); I8 (session and CSRF in a browser and on the deployed site: H-131, H-358); J2, J6 (Argon2 tuning, the hashing cap: measured on the VM); J4 (`trusted_proxy_hops` 2 behind caddy-p: stream L, H-129); N8 (lab tables in the data inventory: stream L); O3 (keystore snapshot, off-VM backup, anchor shipping: deployment, L-17); O4 (restore drill S-19: deployment); S3 (consent and lab runtime run for real: H-358); S4 (supersede on the port: stream L, H-351); T7, U1 (SSE and HTTP/2 through Vercel and Caddy: stream L, S-2, S-14); V3 (raw container logs: stream L).

### Still open: a decision, an open question or a contract change
- **Moved out of the sweep after a closer look:** K2 (seal the single-use link in `email_outbox.params`): 16 test files read the link from the row, so it is a story of its own, not a sweep fix. P5, Q6 (replace the starter disposable and free-webmail lists with maintained ones): choosing and vendoring a third-party list (for example the CC0 `disposable-email-domains` project) is the developer's call. D4 (stream size limits and the stale OI-15 line in the IF-3 README): a contract file, so it needs an IF-3 release and a re-approval. E2 (validate parameters in the platform mock): optional, and a change to IF-1's mock.
- **Contract changes:** C3 (REQ-UNAVAILABLE, REQ-TIMEOUT, AUTH-FORBIDDEN), E3 and G1 (email change), H1 (role grant and revoke, create-admin routes, AUTH-ROLE-NOT-ALLOWED; H-133), L1 (failed-mail list and requeue), Q1 (member and join-request routes), W2 (the company side of deletion has no routes, so a candidate's request to a company cannot be decided over HTTP), W5 (a PRV error family).
- **Product or security decisions:** A1, B2, M1 (a browser test: no browser tooling, OI-30); D3 (drop the replay `--url` mode as superseded?); E1 (bundle-level check of the mock's lab half: keep or drop); E6 (a paging cursor, open point 15); F1 (OI-13); F2 (the field key is still a setting: H-135); F4, G4, P8, Q7, Q8, V1, W1 (which mails exist: FR-NTF-01); F8 (re-read ASVS and NIST: part of the per-requirement ASVS review P-32 left open); G2, G3 (the default breach check; an hibp outage alerts nobody; ADR 0044); G5, H5, J7, K4 (wording and placeholder numbers, OI-25); H4 (force a password change at the first admin sign-in?); H6 (404 rather than 403 for role-gated routes); H7 (account type cannot change); I4 (a Valkey session cache: measure first); I5, J3, N9, T5, U4 (rate limits, caps and intervals are placeholders, OI-25); L2 (Brevo, sender address: OI-9, OI-32); L3 (spike S-18: schedule or accept); N4, W4 (the consent `withdrawn` row; no recruiter withdrawal mail: H-353); N5, V4, W7 (legal review: OI-33); O2 (remainder: failed access to resources is not audited); O5 (signed commit to a separate repository, ADR 0008); O6 (`KeyPort.flag` has no key version: H-137); O8 (an audit write commits before the caller's transaction); O9 (raw user ids in other tables); P7, Q5 (no check that the domain belongs to the company); Q3 (a deleted company's join requests and terms acceptances); Q4, Q9 (one company per person; OI-11's second half); R5's other half (do resends count against the daily cap?); R10 (no template archive); S2, S7 (only the first way of FR-ASM-04; bind by address; the cap of 500); T3 (`createLiveTicket` pending S-14: H-353); U3 (a keep-alive ping); V6 (the application role can insert into `audit_checkpoint`); V7 (mail rows purged with the logs); V10 (scheduler intervals and metrics); W6 (no lock or banner during the 7-day hold).
