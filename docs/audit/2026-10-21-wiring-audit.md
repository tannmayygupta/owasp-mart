# Wiring audit, 2026-10-21

Method: read-only. Base commit 52c88b0 (HEAD moved to ef7d5c7 during the audit; see F-01). Every item was checked in code, not in docs or trackers. Two sub-reviewers covered (a) cross-service flows outside apps/api and (b) contract drift and test reality; I re-verified their top items. No flag values or secrets appear here. Severity: P0 breaks a core promise or privacy duty in the deployed system, P1 a feature that looks done and does not work, P2 a gap that bites under load or misuse, P3 hygiene.

Headline: the deployed system is a learner practice lab (apps/lab-console, served by Caddy) on top of a much larger platform whose recruiter, candidate and admin parts are implemented in the API but have no deployed UI, no real mail, and no running scheduler.

## 1. Wired OK (short)

- Learner path end to end on the deployed stack: sign-up, login, CSRF/Origin checks, instance request, orchestrator create/ready, one-time gate ticket (formats and keys agree: lab/tickets.py:22-66 vs apps/edge/src/tickets.mjs), sidecar signing and API ingest verify (ingest/verify.py:27-33), milestones, flag paste, hints, submit, report.
- Spec vs routes: 91 of 92 platform/lab operations match method, path, operationId and status code (one exception, F-24). Error codes in code are all registered.
- Orchestrator client vs orchestrator service routes and fields match (http_instance_host.py vs service.py:73-78). Activity reporting is wired (lab/runtime.py:411).
- All lab stores have Postgres twins (lab/pg.py:593-602). Keys come from the keystore in the deployed compose.
- Bot, import-service and mock-services are in the instance template, images.json and live-deploy.
- Role checks on reviewer routes (lab/api.py is_reviewer/reviewable) and admin routes (`requires(Role.ADMIN)`, admin session needs proved TOTP, accounts/sessions.py:236) are consistent; no silent `except: pass` swallow was found in apps/api/src (failures are logged).

## 2. Implemented but not wired

| # | Item | Where | What is missing | Sev |
|---|------|-------|-----------------|-----|
| F-01 | Template rules to attempt | assessments/accept.py:132 (HEAD 52c88b0) | `create_from_consent` was called without `rules`, so every candidate got default Rules (120 min, 3 resets, after_submit); `after_release` and the release button were dead. Fixed in ef7d5c7 (`rules=view.rules`) while this audit ran. No test asserts the stored attempt's rules through the real accept path (test_invite_acceptance.py:432-434 checks the invite only). | P0 (fixed, untested) |
| F-02 | Retention scheduler | infra/deploy/platform.compose.yaml (no `VULNMART_SCHEDULER_ENABLED`); settings.py:58 default False; main.py:204 | Only the dev compose enables it (infra/compose/compose.yaml:199). Deployed: no invite expiry job, no candidate/learner retention, no `deletion_requests` job (erasure requests are never executed after the undo window), no audit anchor, no log purge, no account housekeeping. Consent notices promise deletion after N days. Admin jobs screen shows "never ran". | P0 |
| F-03 | Email delivery | platform.compose.yaml:22-25 (provider smtp, host mailpit) | Mail goes to a Mailpit catcher visible only on 127.0.0.1:8025. Verification, password reset, invites, approval, break-glass alerts never reach anyone. Brevo adapter (notifications/provider.py:97) exists but is not configured. | P0 for any real user |
| F-04 | Dashboards (apps/web) | infra/deploy, infra/vercel/.deploy (probe page only), apps/web/Dockerfile (dev server image) | Next.js recruiter, candidate, admin, invite, consent, account pages are not deployed anywhere. Caddy serves only the lab console (Caddyfile.platform:50-53). Invite links point to `/invite?token=` on a host that has no such page (assessments/service.py:505). | P0 |
| F-05 | Invite never becomes `started` | assessments/service.py:61-66 allows consented->started, but no code calls `advance(..., "started")` (grep: only accept.py moves opened/consented/declined) | `_refresh` (service.py:548) expires `consented` invites at expires_at even while the attempt runs or has ended; then web assessment page shows "invitation is expired" and hides the attempt (assessment/[attemptId]/page.tsx:100), recruiter list drops the attempt row (candidates/page.tsx:26), retention clock switches to invite date (retention/candidates.py:57-62), `AlreadyStarted` guard (service.py:420) never fires. | P1 **FIXED 2026-10-21 (WP-A, ADR 0071, test_invite_lifecycle.py)** |
| F-06 | Start ignores invite state | lab/api.py:498-508, engine DUE_STATES excludes READY | A revoked (service.py:600, does not cancel the attempt) or expired invite leaves a `ready` attempt that the candidate can still start weeks later. Ready attempts never expire. Recruiter cannot cancel a ready or running attempt except through re-invite. | P1 **FIXED 2026-10-21 (WP-A, test_invite_lifecycle.py)** |
| F-07 | Template settings never reach the lab | lab/api.py:192-193 (`hints_enabled = org_id is None`, "placeholder"), :336 (cost `level*10`), :598 (all `rt.challenge_keys`) | `hints_mode`, `hint_cost_pct`, `writeup_required`, `flag_submissions_per_minute`, and the template's challenge subset are stored, shown in UI and invite summaries, and ignored: candidates never get hints, always see all 11 challenges. | P1 **FIXED 2026-10-21 (WP-A, test_template_settings_reach_the_lab.py)** |
| F-08 | Admin quotas | kernel/quota.py `limits()` used only by ports/lab_fakes.py:211 | The real LabRuntime never reads QuotaPort. Per-user, per-company and total caps set in the admin UI are write-only. Only one-running-learner-attempt check (lab/api.py:425) and orchestrator capacity apply. Handoff H-126 still Open. | P1 **FIXED 2026-10-21 (WP-A, test_lab_quota.py)** |
| F-09 | Candidate deletion requests | privacy/deletion.py:182-236 `for_company`, `decide`, `company_delete` have no callers; no company route | Candidate asks (assessment page button) -> row stays pending; company has no route or notice (template `privacy.deletion_request_for_company` never enqueued). Only "escalated" by a job that is not running (F-02). | P1 |
| F-10 | Unsent mail types | notifications/templates.py specs `recruiter.consent_withdrawn`, `privacy.deletion_requested`, `privacy.deletion_request_for_company`, `privacy.deletion_confirmed` | Never enqueued (grep). PRD FR-NTF-01 (Locked, Must) lists them. No mail for time warnings, submission or released results either (not in registry). | P1 |
| F-11 | Invite actions UI | POST /company/invites/{id}/actions (company_api.py:247) | No caller in apps/web: recruiter cannot revoke, resend or re-invite from the UI. Template edit (PUT) also has no UI. | P2 |
| F-12 | Resend verification | POST /accounts/verify-email/resend | No caller in web or console. | P3 |
| F-13 | `technique_label` | lab/api.py:777 hard-coded None; report page column always "-" | Not implemented. | P3 |
| F-14 | Sequenced learner mode vs apps/web | apps/web/app/attempt-board.tsx (no `beginChallenge`, no `current_key` handling) | Deployed lab runs `VULNMART_LAB_SEQUENCE=1`; the web board cannot begin challenges, so flags and hints 409. Only lab-console implements it. | P1 |
| F-15 | Break-glass review | admin/breakglass.py:137,213 | Alerts go to "other admins" and review needs another admin; with one admin neither works (and mail is F-03). Audit entry written after the session row commits (:144). | P2 |
| F-16 | Live stream in the deployed stack | worker relay is wired, hub reads Valkey | Only consumer is apps/web `useLive` (not deployed); console polls. `createLiveTicket` in spec has no route (live/api.py:1, F-24). | P3 |
| F-17 | Empty packages | vulnmart/attempts, instances, scoring `__init__.py` only; scheduler/live entrypoints are skeletons (kernel/entrypoints) | Dead directories. | P3 |

## 3. Stubs reachable in production

- `ports` audit/outbox/keys/quota are in-memory stubs when their DSN is missing (kernel/services.py:43-99); the compose sets the DSNs so audit, keys, quota are real. The API's `ports.outbox` is `LiveOutbox(..., FakeOutboxPort())` because the API passes no `session_source` (main.py:209); email still works because modules call `DbOutboxPort` per transaction. Only domain events go via `ports.outbox.publish`.
- Silent fakes on misconfiguration, no fail-closed guard in production: `_host_from_environ` returns `FakeInstanceHost()` if ORCH_URL or key is missing (lab/runtime.py:817-819); `LABS` without `VULNMART_LAB_STORE=postgres` keeps all attempts in memory with random per-process keys (runtime.py:126, 838). P1.
- `LabRuntime` memory-only state: state reports (lab/state_reports.py:79, unbounded history), `_starting`/`_resetting` sets, ingest `_pending` windows (rebuilt on start). A restart during a start leaves a `ready` attempt with an orphan instance until the next press.
- Orchestrator: `FakeSettingsPort` is the default (engine.py:144) so admin idle/max settings do not apply; state reports OFF unless the lab.reports override is staged (compose.yaml:445,483); records, nonce cache, report queue (10,000, drops oldest) in memory; `host_status` health hard-coded "ok" (engine.py:882).
- Edge gate access map and used-ticket set in memory (state.mjs:57, gate.mjs:77): after an edge restart every live lab answers "ended" until the orchestrator re-syncs (P1).
- Sidecar outbox in memory, 1000 events, evicts the oldest even if it is a flag event (outbox.mjs:117); 401/409/413/422 dropped with stderr only. Containers do not restart (backend.py:335).
- Valkey in compose: no persistence, no auth, `allkeys-lru` at 64 MB: rate-limit counters and queued mail ids can be evicted.
- Backups on the same host only; alerts are a marker file read by a manual script; no monitoring.

## 4. Half-implemented logic and cases

- C09 M2 cannot distinguish vulnerable from fixed: `shop.security_event_written` is never emitted (apps/shop/src/challenges/c09-logging-failures.mjs:38-39); its comment is stale, the event is in the schema. C05 M2, C08 M1, C10 status are loose (fire on any hit). (P1 for C09.)
- Learner practice uses `activity_check_mode="hold"` (Rules default; ingest/gate.py:50-57). A correct pasted flag with fewer than 5 recorded requests is "held for review", but `default_may_review` needs an org and `decideIntegrityFlag` needs the recruiter role (lab/api.py:739): a learner's held capture can never be released. P2.
- One attempt per (user, template): `engine.create` returns the existing attempt for non-learner records (store.py:73). A new generation-1 invite for the same template after a withdrawn/expired-with-attempt invite gets a dangling `attempt_id` (create returns the other record; accept.py ignores the returned id). Only the REINVITABLE path uses `~N` keys (accept.py:46). P1/P2.
- Candidate start always boots the one `shop-v0` template (runtime.py:565); a failed start is only logged, attempt stays `ready`.
- Withdrawal writes no consent record and does not move the invite out of `consented`.
- 500-address bulk invite vs 16 KiB body cap (accounts/http.py:41): long addresses return 413 (P3).
- Break-glass reason: route allows 1+ chars, service 20+ (generic 422).
- Contract: platform spec `info.version` 1.0.0 vs 1.7.0 in CHANGELOG/COMPAT/registry; bundle label stale; `contracts-v1.0.0` tag missing; COMPAT pending rows (all 2026-10-20): IF-2 2.1.0 consumer (Akshay), DB 2.2.0 owner (Akshay), DB 2.2.0 consumer (Sahil). IF-2 2.0.0 is BREAKING and its only consumer approval is pending. IF-1, IF-3, IF-8, GATE have single-owner rows. Sign-offs recorded inside the change commits (CHANGELOG 1.7.0).
- Generated TS client and py-models are used by nothing; apps/web/lib/api.ts is hand-typed `unknown` casts; non-lab responses are not validated against the spec in any test (field names matched by hand today).
- 88 rows in docs/dev/HANDOFFS.md still carry an Open status.

## 5. Security gaps

- No rate limits on authenticated lab and company routes: requestInstance, instances/open (ticket mint), reset, stop, company templates/exports, release, flag-decision (rate limits exist on auth, signup, reset, consent, deletion, export, invite open/accept/resend, flag paste). A learner can loop start/stop to churn instances (F-08 removes the quota backstop).
- Origin secret is injected by Caddy for every visitor (Caddyfile.platform:41), so it only blocks direct access to api:8000, not the public.
- Private listener :9444 is server TLS only; callers authenticate by HMAC; mutual TLS is a follow-up (Caddyfile.platform:57-59).
- Sidecar :9000 events are unauthenticated on the instance network (any compromised shop forges milestones); bot `/visit` unauthenticated on that network.
- Orchestrator and edge replay windows reset on restart (60 s).
- Edge `decide` catches every exception and answers denied (gate.mjs:153-156) which hides bugs as auth failures.
- A recruiter-visible `Role.CANDIDATE`/`LEARNER` are never used for authorization (grep); authorization is by attempt ownership and `org_id`. Fine, but the roles are decorative.
- Login on any device bumps access epoch for the user's live instances including an assessment in progress (runtime.py:773-795, FR-SES-11).

## 6. Learner <-> candidate model gaps

How it works in code: one participant account holds role `learner` from sign-up (accounts/service.py:140). Accepting an invite requires account_type participant, verified email equal to the invite address (accept.py:79-82), binds invite to user and pre-assigns the attempt id (service.py:686), consent creates a `ready` attempt with `org_id` set (accept.py:132) and grants role `candidate` (accept.py:135; roles.py:71). Mode is derived only from `attempt.org_id` (lab/api.py:188). Practice runs and candidate attempts share one `/me/attempts` list.

Gaps:
1. Email must match: a learner with another address must open a second account; there is no email change route, so "same account becomes candidate" works only if the invite went to the signup address.
2. lab-console (the only deployed UI) does not filter by mode: `current = running/ready attempt || mine[0]` (app.js:130) can pick a candidate attempt and render it as practice (submit, flags, reset on an assessment); the candidate has no deployed UI at all (F-04).
3. Template rules did not reach candidate attempts at 52c88b0 (F-01) and hints/subset still do not (F-07).
4. Expiry/started defects (F-05, F-06), dangling attempt id on repeat invite (section 4).
5. Quotas do not separate modes; a learner can run a practice instance and an assessment instance together (F-08).
6. Retention: learner job keeps the account if candidate data exists (learners.py:90) - correct; but candidate retention clock goes wrong after F-05.
7. Practice history leaking to a recruiter: none found. Recruiter report is per attempt, `account_progress` and exports skip org attempts, live audiences keep learner events on the user stream. Candidate results hidden by `results_hidden` only works since F-01 fix.
8. Held captures in practice cannot be released (section 4).
9. Candidate role is never removed and does nothing; admin can grant/revoke it, no effect.

## 7. Test-reality gaps

- CI `api` job has Postgres 18; the `scripts` job skips the 15 `*_postgres` modules silently (skipif, no skip-count assertion). No Valkey anywhere in CI: live hub, rate limiter and mail relay Valkey tests always skip.
- Not in CI: scripts/e2e platform-stack, edge, ingest-relay, loop, contracts e2e; all `e2e-live*.mjs`, live-smoke, audit-platform-wiring. No Playwright, no browser test, no `next build`; web has two lib test files plus typecheck; lab-console covered by one script test.
- No test asserts the stored attempt rules after invite -> consent -> create_from_consent (F-01 passed all tests); fix ef7d5c7 should come with a regression test.
- Quota enforcement is tested only against FakeInstanceHost/lab_fakes (F-08). Hints from template, writeup, challenge subset: stored-and-echoed tests only (F-07).
- Deployed-compose facts (scheduler on, real mail provider, ORCH URL set, no fake host) have no test or check.
- In-process `create_app` tests use FakeInstanceHost, in-memory limiter, FakeKeyPort; the real orchestrator + Docker loop is manual.
- Email providers tested only with injected openers; no real SMTP/Brevo.
- Fake behaviours the real parts lack: quota enforcement, instant ready, orchestrator Busy/mTLS.
- Spec-vs-route diff is not a CI check (createLiveTicket exemption lives in a live-only script, verify-deployed.mjs:13-14).

## Order I would fix in
F-02 and F-03 (one env change each, plus a Brevo key), F-04 (decide where the dashboards run), F-05/F-06 (advance to `started`, check invite on start, cancel on revoke, expire READY), F-07, F-08, F-09/F-10, fail-closed host/store guards, regression test for F-01.
