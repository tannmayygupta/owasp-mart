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