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
