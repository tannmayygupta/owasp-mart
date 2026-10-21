# Role scenarios and code status audit, 2026-10-21

Read-only audit of `origin/main` plus PR #75. Method: read CLAUDE.md, initial.md, PRD (sections 2, 4, 5), then followed each scenario through `apps/api/src/vulnmart`, `packages/py-attempts`, `apps/web`, `apps/lab-console`, `infra/deploy`. Status words: IMPL+WIRED (route or job reachable in the deployed config), IMPL-NOT-WIRED (service code exists, no route, UI or schedule reaches it), PARTIAL, MISSING. "Live" notes refer to `infra/deploy/platform.compose.yaml` (the deployed demo). No flag values or secrets appear here.

## 0. Findings that colour every row (live deployment)

- **LB-1 No real mail.** Deployed API uses `VULNMART_EMAIL_PROVIDER: smtp` to the Mailpit container (platform.compose.yaml:22-24, runbook live-deploy.md:27). Invites, verification and reset mails never reach a real person.
- **LB-2 Only the learner console is deployed.** Caddy serves `apps/lab-console` plus `/api/*` (live-deploy.md:8). The Next.js app (`apps/web`: candidate, recruiter, admin, account pages) is not deployed (Vercel L-11 / P-07 unticked). Recruiters, candidates and admins have an API but no live screen.
- **LB-3 Scheduler is off live.** `VULNMART_SCHEDULER_ENABLED` appears only in `infra/compose/compose.yaml:199`, not in the deployed platform compose. Retention, invite purge, learner warning and deletion-request jobs do not run live (lazy invite expiry still works).
- **LB-4 Template rules do not reach the attempt (code, not config).** `InviteConsentTargets.proceed` calls `create_from_consent(...)` with no `rules=` (assessments/accept.py:132-134), so time limit, reset limit and `results_visibility` of the template are replaced by engine defaults (120 min, 3 resets, `after_submit`) (py-attempts rules.py:8-20; ports/engine_attempts.py:19-32). `hints_enabled()` is `org_id is None` (lab/api.py:192), so hints are never on for candidates; the lab runtime has one global `challenge_keys` (runtime.py:128), so the recruiter's challenge subset is ignored. **WP-A 2026-10-21: fixed.** The rules, the hints, the subset and the flag limit reach the attempt and the lab (ADR 0071, `test_template_settings_reach_the_lab.py`).
- **LB-5 Admin quotas and instance settings are cosmetic.** `QuotaPort` is never called by `LabRuntime` or `HttpInstanceHost` (no "quota" token in `lab/*.py`); settings `instance_idle_minutes`, `instance_max_minutes`, `instance_*_cap`, `hints_enabled_default`, `flag_submit_per_minute` are read nowhere outside admin/ops.py and quota.py. **WP-A 2026-10-21: fixed for the quotas and rate limits** (ADR 0071, `test_lab_quota.py`); the idle and maximum minutes settings are still read by the orchestrator side only.
- **LB-6 Invite never reaches `started`.** Nothing calls `advance(..., "started")`; `_refresh` expires any `consented` invite at its expiry date (assessments/service.py:548), even if the attempt is running or finished. Candidate page then says "This invitation is expired" (assessment/[attemptId]/page.tsx:106) and the recruiter monitor stops linking the report (candidates/page.tsx:26). `AlreadyStarted` is therefore dead code. **WP-A 2026-10-21: fixed.** Start moves the invite to started; a started invite does not expire (`test_invite_lifecycle.py`).

## 1. Learner vs candidate model (proposal, consistent with D-05, D-19, D-25, FR-ACC-05/06)

**Account and roles.** One `users` row per person with `account_type = participant`. Roles are additive flags on `user_roles`: `learner` (granted at signup, already done: accounts/service.py:139) and `candidate` (granted on first accepted invite, roles.py:71). Recruiter and admin are separate account types and never hold either (accept.py:79 refuses them). The email is the identity key: an invite is bound to one canonical address and only a verified account with that address may accept (accept.py:81). Proposed addition: an explicit, audited "add this address to my account" flow (verify mailbox) for people whose invite went to a different address, instead of today's dead end (see C-06).

**Attempt separation.** Every run is an `attempt` row with `org_id` NULL (practice) or set (assessment). Rules: (1) an assessment attempt is created only from a consent for one invite, never from `POST /instances`; (2) uniqueness key `(user, template_key)` where the assessment key includes the invite template and generation (`tpl~n`, accept.py:46) and the practice key is the lab template; (3) separate instance, separate attempt key (HMAC flags per instance, per-attempt key shredding); (4) practice has no consent record, hints free, sequenced countdowns; assessment has consent, one attempt per invite, no pause, hints per template, no sequencing. Add: a per-user cap that counts the user's live instances across both modes with the assessment taking priority (an assessment Start may stop an idle practice instance), and a reserved capacity slice for assessments.

**Visibility rules (privacy wall).**
| Data | Learner (self) | Candidate (self) | Recruiter of inviting company | Other company | Admin |
|---|---|---|---|---|---|
| Practice attempts, hints, account points, write-ups | yes | yes (same login) | never | never | no (break-glass reaches candidate attempts only, breakglass.py:5) |
| Assessment attempt: score, per-challenge, evidence, timeline | n/a | after submit or after release (server-enforced, see LB-4) | yes, own company, each view logged and shown to the candidate by company name | no | only via 15-minute break-glass |
| Invite email address, state | n/a | own invites (no address) | yes | no | user list shows email |
| Existence of an account for the invited address | n/a | n/a | no (invite shows only state; signup answers 202 for known addresses) | no | yes |
| Consent records | own | own | notice version and retention shown only | no | no |

**Lifecycle rules for the transition.** Existing account: sign in, accept, consent, start (no new account). New person: sign up with the invited address, verify, reopen the link. Different address: refused with a clear message and a self-service "link another verified address" path (missing). Unverified: refused with "verify your email first" and a resend button (today a generic 409). Expired, revoked, declined, cancelled invite: closed forever, recruiter issues a new invite; a superseded invite is revoked at re-invite. Practice run in progress: untouched, its instance may be stopped to free capacity; the assessment clock never stops. Withdrawal: assessment attempt locks, instance destroyed, 7-day undo, practice data untouched. Repeat assessment: only through a recruiter re-invite (new generation, old attempt `superseded`, kept for the recruiter). Deleting the learner account while assessment data exists locks the account instead (ops.py:236) until retention clears.

## 2. Learner scenarios (L)

| ID | Scenario (steps, expected, edge) | Status | Evidence |
|---|---|---|---|
| L-01 | Sign up with email, password, 18+ declaration; verification mail; edge: breached/weak password, rate limits, disposable mail allowed for learners | IMPL+WIRED (live mail goes to Mailpit, LB-1) | accounts/api.py:36-55, service.py:115; lab-console app.js:88 |
| L-02 | Verify email by single-use 24 h link; expired or reused link fails; resend | IMPL+WIRED | accounts/service.py:153-186 |
| L-03 | Sign in, optional TOTP, password reset, list/revoke sessions, log out everywhere | IMPL+WIRED (console has sign-in only; reset/MFA in web app, not live) | session_api.py, mfa_api.py, password_api.py |
| L-04 | Sign up with an already registered address: no enumeration, "already registered" mail | IMPL+WIRED | accounts/service.py:104-108,131-133 |
| L-05 | See catalogue: 11 challenges, both OWASP tags, difficulty, tier | IMPL+WIRED | lab/api.py:389; lab-console renderRail |
| L-06 | Start a practice instance; status requested to ready, shop opens through one-time ticket and gate; edge: second press while running | IMPL+WIRED | lab/api.py:420-454 |
| L-07 | Sequenced run: only current challenge visible, press Begin, countdown Easy 20 / Medium 40 / Hard 60 min | IMPL+WIRED (console only) | lab/sequence.py:22; api.py:632; compose VULNMART_LAB_SEQUENCE |
| L-08 | Same run through the Next.js dashboard | MISSING | apps/web has no `begin`, `me/progress`, `seconds_left` (Grep no hits); flags on a not-begun challenge 409 |
| L-09 | Countdown ends unsolved: challenge becomes expired, credit and hints stop, next challenge becomes current; earned points stay | IMPL+WIRED | sequence.py:94-113; runtime.py:249 |
| L-10 | Capture flag: auto detection by sidecar or paste; correct credited, suspicious held for review; edge: held capture is "solved" for sequencing | IMPL+WIRED | api.py:562; runtime.py:593; sequence.py:103 |
| L-11 | Wrong or decoy flags: rate limit 5 per 10 min per challenge, no score penalty | PARTIAL (hard cap 30 per attempt, FR-ACH-01, not found) | flags/submit.py:4-5,84 |
| L-12 | Three free hints, in order, only for the active challenge, never reveal flag; cost 0 for learner | IMPL+WIRED | api.py:685; runtime.py:611; RuntimeFacts charged only org |
| L-13 | Account points: best result per challenge across runs, never counted twice, out of 1000 | IMPL+WIRED (console only) | runtime.py:279; api.py:656 |
| L-14 | Run complete (all solved or timed out): auto-submit, instance freed, report, write-up after solve or expiry | IMPL+WIRED | runtime.py:755; api.py:619 |
| L-15 | Retry an expired or unsolved hard challenge: new run | PARTIAL: every run starts at C01 and each earlier challenge must be solved or time out (20-60 min each); no jump to a challenge | sequence.py:94 (no skip); runtime.py:439 |
| L-16 | Reset: fresh shop, new flags, milestones kept; confirm; edge: second reset while one runs refused | IMPL+WIRED | api.py:457; runtime.py:633 |
| L-17 | Stop, then start again inside the same run (new instance, same attempt, countdown continues) | IMPL+WIRED | runtime.py:689, 452-470 |
| L-18 | Close browser or lose connection mid-countdown; return later; server clock, SSE replay/poll | IMPL+WIRED | stored `opened_at` (sequence.py); live hub; console `skew` |
| L-19 | Idle 60 min / 4 h cap: instance destroyed, attempt keeps clock, restart possible | PARTIAL: timed idle destroy never proven live (audit 2026-10-18 B1) and idle can outlast a 60 min Hard countdown | runtime.py:65; lab-stream-audit B1 |
| L-20 | Instance fails to start or crashes: learner sees failure, can start again | PARTIAL: console message map has no crash text, generic error | app.js:28-35; api.py:153-155 |
| L-21 | Platform at capacity: clear message, retry, queue | PARTIAL: orchestrator `Busy` becomes HTTP 429 "Too many tries" (misleading text), no queue | api.py:150-152; app.js:30 **FIXED 2026-10-21 (WP-A): the orchestrator's Busy is 503 INST-NO-CAPACITY with Retry-After; no queue; `test_lab_quota.py`** |
| L-22 | One running instance per learner; admin per-user quota | PARTIAL: blocks a second running attempt only; quotas not consulted (LB-5) | api.py:426; no "quota" in lab/ **FIXED 2026-10-21 (WP-A): quotas are consulted; `test_lab_quota.py`** |
| L-23 | Export own data (zip JSON+CSV), request deletion with 7-day undo | IMPL+WIRED (web account page; not in console, not live) | export_api.py:46; deletion_api.py:63 |
| L-24 | 30-day warning email, deletion 12 months after last login | PARTIAL: jobs built, scheduler not enabled live (LB-3) | retention/build.py:38-49; compose |
| L-25 | Accessibility: keyboard, aria-live, reduced motion, WCAG 2.2 AA (OI-30) | PARTIAL: aria-live and reduced-motion present, no audit or test | lab-console index.html:68, style.css:176 |
| L-26 | Under-18 person tries to register | IMPL+WIRED as self-declaration only (OI-33 open; no DOB, no guardian path) | accounts/api.py:36-41 |

## 3. Candidate scenarios (C)

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| C-01 | Invite mail: 256-bit single-use token, hashed, bound to address, 7-day expiry, sealed address in outbox | PARTIAL: code fine; live mail is Mailpit (LB-1) | assessments/service.py:370-433, 499 |
| C-02 | Open link with no session: sees company, title, rules; closed states shown; rate limited | IMPL+WIRED (web, not live) | invite_api.py:55; web invite/page.tsx |
| C-03 | No account: sign up with invited address, verify, return to link | PARTIAL: token kept in per-tab sessionStorage; after mail verification the person must click the invite mail again, no automatic return | invite/page.tsx:11-26,104-107 |
| C-04 | Existing learner account, same verified address: accept, consent, candidate role added, practice data intact | IMPL+WIRED | accept.py:70-85,135; roles.py:71 |
| C-05 | Unverified email: refused | PARTIAL: generic 409 whose text blames "closed or other address"; no verify prompt | accept.py:79; invite/page.tsx:71-73 |
| C-06 | Invite sent to a different address than the account's: refused; no claim or change-email path | PARTIAL: refused, no explanation, no path (Grep "change email" none) | accept.py:81; invite_api.py:89 |
| C-07 | Expired, revoked, cancelled, declined, superseded invite: closed, recruiter must re-issue | IMPL+WIRED | service.py:61-65, 548; invite/page.tsx:36-41 |
| C-08 | Invite already bound to another account | IMPL+WIRED | service.py:686-711 |
| C-09 | Recruiter or admin account opens an invite | IMPL+WIRED (generic 409) | accept.py:79 |
| C-10 | Consent screen: plain notice, not pre-ticked, version and hash, stale notice refused | IMPL+WIRED | privacy/api.py:49-80; assessment page |
| C-11 | Decline: invite declined, no attempt, company told | IMPL+WIRED (company told only by monitor, no mail) | accept.py:124-127 |
| C-12 | Start: instance prepared, clock starts at ready (D-80), no pause | IMPL+WIRED | api.py:498; runtime.py:554 **FIXED 2026-10-21 (WP-A): Start checks the invite and moves it to started; `test_invite_lifecycle.py`** |
| C-13 | Template rules apply: time limit, reset limit, challenge set, results timing | MISSING (LB-4) | accept.py:132; runtime.py:128 **FIXED 2026-10-21 (WP-A): the template's subset, resets, time and results timing apply; `test_template_settings_reach_the_lab.py`** |
| C-14 | Timed run: server deadline, 15 and 5 min warnings, refused after deadline with 60 s grace | IMPL+WIRED (default 120 min only, LB-4) | runtime.py:596; py-attempts rules.py **FIXED 2026-10-21 (WP-A): the template's time limit is the attempt's; `test_template_settings_reach_the_lab.py`** |
| C-15 | Attack, milestones credited, evidence captured, held captures shown as "held for review" | IMPL+WIRED | api.py:584-630 |
| C-16 | Recruiter turned hints on: cost confirmation, deducted | MISSING | api.py:192-193 `hints_enabled` false for any org attempt **FIXED 2026-10-21 (WP-A): hints on per template, cost = percentage x level, taken from the score; `test_template_settings_reach_the_lab.py`** |
| C-17 | Reset within limit, new flags, milestones kept, clock continues | IMPL+WIRED (limit fixed at 3) | runtime.py:633-667 |
| C-18 | Submit early with confirmation; freeze 15 min; destroy; cannot reopen | IMPL+WIRED | api.py:511; D-83 |
| C-19 | Time runs out: expired, auto-submit with what was captured | IMPL+WIRED | engine tick, D-83 |
| C-20 | Browser closed mid-timer, return to same instance; second login ends the older tab | IMPL+WIRED | runtime.py:773 `bump_access_for_user` |
| C-21 | Lost connection or wrong laptop clock: countdown correctness | PARTIAL: web countdown uses `Date.now()` against `deadline_at`, ignores `server_time` (console corrects skew, web does not) | attempt-board.tsx:82 |
| C-22 | Instance crashes or fails to start mid-assessment | PARTIAL: server restarts instance on Start (runtime.py:452-470) but UI offers Start only in state `ready` | attempt-board.tsx:143 |
| C-23 | Results timing: `after_submit` vs `after_release` | PARTIAL: UI honours invite setting; server only honours attempt rule, which is always default (LB-4), so score API answers after submit regardless | api.py:252-256; attempt-board **FIXED 2026-10-21 (WP-A): the rule reaches the attempt through the real consent path; `test_template_settings_reach_the_lab.py` (last test)** |
| C-24 | Withdraw mid-attempt: lock, instance destroyed, 7-day undo, recruiter notified, consent "withdrawn" record | PARTIAL: lock and undo work; no `withdrawn` consent record written; no recruiter mail; undo does not resume attempt | api.py:538-559; privacy grep: only model lists "withdrawn" **PARTIAL, improved 2026-10-21 (WP-A): the withdrawn consent record is written once; undo keeps the attempt withdrawn (D-91), re-invite gives a fresh attempt; recruiter mail left to the notification work; `test_invite_lifecycle.py`** |
| C-25 | Request deletion of record: company decides in 14 days, then escalation, execution 7 days after approval | PARTIAL: candidate side and job exist; company has no route to decide | deletion_api.py docstring; deletion.py:190 |
| C-26 | Export own data and see which companies viewed it | IMPL+WIRED | export_api.py:46; deletion_api.py:104; api.py:259 |
| C-27 | Re-invite after a fault: new attempt, old kept `superseded` | PARTIAL: service and route exist, no recruiter button; new attempt key `tpl~n` | service.py:471; accept.py:46 **FIXED in the lab and service 2026-10-21 (WP-A): a re-invite gives a new attempt and the old stays; no recruiter button yet (web); `test_invite_lifecycle.py`** |
| C-28 | Invite expires (7 days from creation) while attempt running or finished | PARTIAL (bug, LB-6): candidate loses the attempt page, recruiter loses the report link | service.py:548; page.tsx:106 **FIXED 2026-10-21 (WP-A): a started invite never expires; `test_invite_lifecycle.py`** |
| C-29 | Candidate already mid-practice-run when invited | PARTIAL: separate attempt and instance (different template key), but no cross-mode instance cap and no capacity priority | engine.py:89-108; runtime.py:445 **FIXED 2026-10-21 (WP-A): two separate runs, separate counting, reserve for assessments, the recruiter sees no practice; `test_invite_lifecycle.py`, `test_lab_quota.py`** |
| C-30 | Extra time or accommodation for a candidate (reopen, change limit) | MISSING | no route; compare Codility "Reopen" below |
| C-31 | Duplicate flag paste on solved challenge | IMPL+WIRED (idempotent) | flags/submit.py:93 |
| C-32 | Flag copied from another candidate or decoy | IMPL+WIRED (per-instance HMAC; sharing and decoy integrity flags) | flags/checker.py; api.py:347 |
| C-33 | Cheating signals: held captures, timing flags; never auto-fail | IMPL+WIRED | RecordedActivityGate runtime.py:166 |
| C-34 | Time zone: times shown in local zone, deadline server UTC; invite expiry told as days | IMPL+WIRED | lib/api.ts:323 |
| C-35 | Candidate under 18 | PARTIAL (self-declaration only) | accounts/api.py:36 |
| C-36 | Candidate accessibility (screen reader, contrast, time) | PARTIAL | see L-25 |
| C-37 | Write-up (optional or required) | MISSING | no write-up route; `writeup_required` stored only |

## 4. Recruiter scenarios (R)

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| R-01 | Sign up with work email; disposable blocked; free webmail handled per D-98; same domain claims | IMPL+WIRED (web signup not live) | company_api.py:134; orgs/disposable.py |
| R-02 | Verify email; state `pending approval` | IMPL+WIRED | orgs/service.py:163 |
| R-03 | Admin approves or rejects with reason; mail outcome; owner re-applies | IMPL+WIRED (mail to Mailpit) | admin/api.py:100; company_api.py:162 |
| R-04 | Owner accepts versioned DPA terms; invites blocked before; changed text refused | IMPL+WIRED | company_api.py:169-181; service.py:567-603 |
| R-05 | Colleague signs up with same domain, owner approves join | IMPL-NOT-WIRED | request creates join row (service.py:285); no route lists or decides (company_api.py has none) |
| R-06 | Owner removes a member | IMPL-NOT-WIRED | service.py:548 |
| R-07 | Optional TOTP for recruiters | IMPL+WIRED | mfa_api.py |
| R-08 | Create template (title, challenges, time, hints, resets, expiry, retention, write-up, results timing) | PARTIAL: API full, web form omits retention, resets, expiry; set values not applied to attempts (LB-4) | company_api.py:193; company/page.tsx:118-157 **PARTIAL, improved 2026-10-21 (WP-A): the values now reach the attempt and the lab; the web form gaps stay; `test_template_settings_reach_the_lab.py`** |
| R-09 | Edit template; invites keep their copy; version bump | PARTIAL: API only, no UI | service.py:316 |
| R-10 | Delete unused template | IMPL+WIRED | service.py:356 |
| R-11 | Challenge subset honoured in the candidate's attempt and score | MISSING | runtime.py:128, 598 **FIXED 2026-10-21 (WP-A): subset honoured in list, flags, hints, score and report; `test_template_settings_reach_the_lab.py`** |
| R-12 | Single and bulk invite (500), skipped reasons, remaining when capped | IMPL+WIRED | company_api.py:232; service.py:435 |
| R-13 | Candidate actually receives the invite | PARTIAL (LB-1) | platform.compose.yaml:22 |
| R-14 | Resend, cancel, revoke, re-invite | PARTIAL: routes exist, web has no buttons | company_api.py:247; Grep web "resend/revoke" none |
| R-15 | Invite a person who already has a learner account; recruiter must not learn practice history | IMPL+WIRED | api.py:200-205 reviewer is org-bound |
| R-16 | Invite same address twice | PARTIAL: duplicate live invite refused; `AlreadyStarted` guard dead (LB-6) | service.py:418-421 **FIXED 2026-10-21 (WP-A): a repeat invite after a closed one takes the next generation; `test_invite_lifecycle.py`** |
| R-17 | Daily invite cap, admin override per company | PARTIAL: cap works; admin override has no route | service.py:398; orgs/service.py:614 |
| R-18 | Live monitor: state, countdown, milestones, captures without refresh | IMPL+WIRED (web, not live) | candidates/page.tsx; live/api.py |
| R-19 | Candidate report: score of 1000, per challenge, time to capture, active time, hints, evidence, timeline | IMPL+WIRED (web, not live) | api.py:762; [attemptId]/page.tsx |
| R-20 | Technique label and tags (D-07) | MISSING | api.py:777 `"technique_label": None` |
| R-21 | Integrity flags: read, accept or reject with note, audited | IMPL+WIRED | api.py:724-759 |
| R-22 | Held capture review within 7 days, reminder only | IMPL+WIRED | runtime.py:348, 754 |
| R-23 | Release results to the candidate (`after_release`) | PARTIAL: route and button work; enforcement depends on rule that is never set (C-23) | api.py:522 **FIXED 2026-10-21 (WP-A): enforcement now works because the rule reaches the attempt; `test_template_settings_reach_the_lab.py`** |
| R-24 | Cancel a ready or running attempt (FR-SES-07) | MISSING for recruiter (engine cancel only used by re-invite) | ports/engine_attempts.py:87; no route **FIXED in the API 2026-10-21 (WP-A): cancelAttempt (IF-2 2.2.0), the candidate sees cancelled, the mail is the notification work's; no web button yet; `test_invite_lifecycle.py`** |
| R-25 | Grant extra time or reopen | MISSING | none |
| R-26 | Cohort view and ranking aid (D-93) | IMPL-NOT-WIRED | ports/engine_cohort.py; no route |
| R-27 | Export results CSV and JSON per template, audited, recorded in candidates' view history | IMPL+WIRED | export_api.py:56; exports.py |
| R-28 | Handle candidate deletion requests; delete a candidate now | IMPL-NOT-WIRED | deletion.py:182-220; no route |
| R-29 | Retention: 30 to 365 days, auto-delete, see when a record goes | PARTIAL: job built, off live (LB-3), no UI to show date | candidates.py; compose |
| R-30 | Write-up required, similarity review | MISSING | FR-ACH-04 not found |
| R-31 | Notifications: submission, withdrawal, deletion request | MISSING (live events only; no mail templates) | grep enqueue_email list |
| R-32 | Every report or evidence view logged and shown to candidate by company | IMPL+WIRED | api.py:259-275 |
| R-33 | Company suspended or deleted while attempts run | PARTIAL: sessions end, attempts keep running, no cancel, data not erased until retention | orgs/service.py:409-444 |
| R-34 | Cross-company isolation | IMPL+WIRED | api.py:200-205; FR-ORG-06 tests |

## 5. Admin scenarios (A)

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| A-01 | Seed admin, mandatory TOTP; session without MFA has no admin role | IMPL+WIRED | seed_admin.py; sessions.py:236 |
| A-02 | Admin idle timeout 15 min, absolute 12 h | IMPL+WIRED | sessions.py:152 |
| A-03 | Approval queue: approve, reject (reason), suspend, reinstate company | IMPL+WIRED | admin/api.py:93-104 |
| A-04 | Delete a company | IMPL-NOT-WIRED | orgs/service.py:409; decision literal lacks `delete` (admin/api.py:43) |
| A-05 | Suspend one recruiter | IMPL+WIRED via user lock | ops.py:208 |
| A-06 | User search, lock, unlock, reset password, delete (audited, reads logged) | IMPL+WIRED | ops.py:168-221 |
| A-07 | Delete participant who holds assessment data: locked instead | IMPL+WIRED | ops.py:236 |
| A-08 | Create further admins, change roles | PARTIAL: seed command only by design; role service has no route | roles.py:77; FR-ACC-11 |
| A-09 | Set per-user, company, global instance quotas | PARTIAL: stored and audited, never enforced (LB-5) | kernel/quota.py; no use in lab/ **FIXED 2026-10-21 (WP-A): the lab enforces user, company and platform limits at request time; `test_lab_quota.py`** |
| A-10 | Edit settings with ranges and audit | PARTIAL: instance, hint and flag-rate settings unused by runtime | ops.py:287; Grep result **PARTIAL, improved 2026-10-21 (WP-A): the quota and rate-limit settings, hints and the template's flag limit are used; idle and max minutes stay as before; `test_lab_quota.py`** |
| A-11 | Capacity view: instances, memory, mail queue, failures | PARTIAL: no instance queue depth | ops.py:362-377 |
| A-12 | Capacity full policy: queue or reserve for assessments | MISSING | api.py:150 only 429 **FIXED 2026-10-21 (WP-A): a reserve of places for assessments, a full platform is 503 INST-NO-CAPACITY; `test_lab_quota.py`** |
| A-13 | Force-stop an instance; owner mailed; audit | IMPL+WIRED (attempt state unchanged, candidate not told in-app) | ops.py:252; runtime.py:697 |
| A-14 | Job status and failures; retention runs visible | PARTIAL: view exists, scheduler off live (LB-3) | admin/api.py:181 |
| A-15 | Read audit log (hash chain, anchor, pseudonymised), reads logged | IMPL+WIRED | breakglass.py audit_entries; kernel/audit.py |
| A-16 | Break-glass: reason 20-500 chars, 15 min, other admins and company owner mailed, another admin reviews | IMPL+WIRED | breakglass.py:1-10, 35 |
| A-17 | Admin tries to read candidate answers without break-glass or a learner's practice | IMPL+WIRED (404) | api.py:200-205 |
| A-18 | Incident notification to affected users | PARTIAL: operator CLI only (D-95) | admin/incident.py |
| A-19 | Escalated candidate deletion request (company silent 14 days) | PARTIAL: only an audit entry, no admin action | deletion.py:243-251 |
| A-20 | Failed mail retry visible | PARTIAL: counts only | ops.py:367 |
| A-21 | Backup, restore, key shredding | PARTIAL: runbook and manual scripts, no schedule or off-host copy (audit 2026-10-18) | docs/runbooks/backup-restore.md |
| A-22 | Revoke candidate role or lock cheating learner | PARTIAL: lock only | roles.py:81 |
| A-23 | Admin dashboard reachable live | MISSING (LB-2) | live-deploy.md:8 |
| A-24 | Per-company invite cap override | IMPL-NOT-WIRED | orgs/service.py:614 |
| A-25 | Monitoring and alerts (health, certs, budget) | MISSING | lab-stream-audit "no monitoring" |
| A-26 | Orchestrator restart or host loss: reconciler repairs, access healed | IMPL+WIRED | runtime.py:801; D-55 |
| A-27 | Admin sees assessments waiting or failing to start | MISSING | no route |

## 6. Cross-role scenarios (X)

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| X-01 | Learner practises, then recruiter invites the same address; person signs in, accepts, consents, starts | IMPL+WIRED in code (blocked live by LB-1, LB-2) | accept.py:70-135 |
| X-02 | Recruiter never sees practice history, points or runs | IMPL+WIRED | api.py:200-205; account_progress skips org attempts runtime.py:284 |
| X-03 | Practice and assessment attempts separated by `org_id`, template key, instance | IMPL+WIRED | api.py:188; engine.py:89 |
| X-04 | Same person, two live instances (practice and assessment) | PARTIAL: allowed, uncapped, login bump touches both | runtime.py:773-795 **FIXED 2026-10-21 (WP-A): counted per mode and capped; the login bump still touches both; `test_lab_quota.py`** |
| X-05 | Delete learner account that holds candidate data | IMPL+WIRED (locked) | ops.py:231-242 |
| X-06 | Candidate withdraws; practice untouched, FR-ACC-06 | IMPL+WIRED | api.py:538; erase per attempt |
| X-07 | Re-invite after fault end to end (recruiter button, new attempt, old superseded and visible) | PARTIAL (R-14, C-27) | service.py:471 **PARTIAL, improved 2026-10-21 (WP-A): service and lab done, recruiter button missing in the web; `test_invite_lifecycle.py`** |
| X-08 | Repeat assessment same template later (second invite after expiry) | PARTIAL: engine returns the old attempt for same user and template key generation 1 (create returns existing) | engine.py:93-95 **FIXED 2026-10-21 (WP-A): a second invite after a closed one has its own attempt; `test_invite_lifecycle.py`** |
| X-09 | Company suspended or deleted with candidates mid-attempt | PARTIAL (R-33) | orgs/service.py:416 |
| X-10 | Retention expiry across invite, attempt, consent (12 months) | PARTIAL (code complete, off live) | candidates.py; LB-3 |
| X-11 | Capacity exhausted by learners when a candidate presses Start | MISSING: no reservation or priority; total cap unenforced, host `Busy` becomes 429 | api.py:150; LB-5 **FIXED 2026-10-21 (WP-A): reserve for assessments and the 503 answer; `test_lab_quota.py`** |
| X-12 | Instance crash mid-assessment: clock keeps running, candidate restarts, recruiter sees state | PARTIAL (C-22) | runtime.py:452 |
| X-13 | Duplicate flags and sharing across candidates | IMPL+WIRED | C-31, C-32 |
| X-14 | Integrity signals reach recruiter, no auto-reject (GDPR Art. 22 style human review) | IMPL+WIRED | api.py:724; FR-ACH-06 |
| X-15 | Two sessions of one account (laptop and phone) | IMPL+WIRED | FR-SES-11 |
| X-16 | Invite email differs from the person's account email | PARTIAL (C-06) | accept.py:81 |
| X-17 | Minor attempts to register or is invited | PARTIAL (self-declaration) | OI-33 |
| X-18 | Time zones and DST across emails, UI, deadlines | IMPL+WIRED | UTC in API, local display |
| X-19 | Accessibility and accommodations | PARTIAL / MISSING (C-30, L-25) | |
| X-20 | Whole hiring journey on the live site (company sign-up to released result) | MISSING (LB-1, LB-2, LB-3, LB-4) | live-deploy.md:8,27 |
| X-21 | Consent withdrawal evidence kept and company told | PARTIAL (C-24) | **PARTIAL, improved 2026-10-21 (WP-A): the withdrawn record is kept; the company is not mailed yet; `test_invite_lifecycle.py`** |

## 7. Prioritised list: 20 most damaging MISSING or PARTIAL scenarios

1. **C-13 / R-11 / R-08** Template rules never reach the attempt: time limit, resets, results timing, challenge set (LB-4). Every candidate gets all 11 challenges, 120 min, 3 resets.
2. **X-20 / C-01 / R-13** No real email and no deployed recruiter, candidate or admin screens (LB-1, LB-2): the hiring product cannot be used live.
3. **C-23 / R-23** Results visibility `after_release` not enforced server-side; score API leaks after submit.
4. **C-28 / LB-6** Invite expiry kills the attempt page and recruiter report link; `started` never set, `AlreadyStarted` dead.
5. **C-16** Hints for candidates can never be enabled.
6. **A-09 / A-10 / X-11 / L-22** Quotas and instance settings unenforced; no capacity reservation for assessments; platform cap unenforced.
7. **R-24** Recruiter cannot cancel an attempt (FR-SES-07).
8. **R-28 / C-25 / A-19** Company side of deletion requests has no route; GDPR-style erasure by request stalls on the company, escalation only audits.
9. **R-05 / R-06** Colleagues can sign up but never be approved; recruiters limited to the owner alone.
10. **L-08** Next.js learner dashboard cannot run the sequenced deployed lab.
11. **L-15** Retrying a failed challenge needs a full walk from C01.
12. **C-24 / X-21** Withdrawal writes no consent record, does not notify the recruiter, undo does not resume.
13. **R-20 / R-30 / C-37** No technique label, no write-ups, no similarity review (D-07, FR-ACH-04).
14. **C-30 / R-25** No extra time, reopen or accommodation.
15. **C-06 / C-05 / X-16** Wrong-address and unverified-email refusals give no usable guidance or self-service path.
16. **R-14 / R-09** Resend, revoke, re-invite and template edit have no UI.
17. **C-22 / X-12** Candidate UI cannot restart a crashed instance mid-attempt.
18. **LB-3 / R-29 / L-24 / X-10** Retention and warning jobs are off in the deployed config.
19. **C-21** Web countdown ignores server time.
20. **R-26 / A-24 / A-25** Cohort ranking, per-company invite cap override and monitoring not wired.

## 8. Comparable platforms (paraphrased, for design context)

- HackerRank lets a recruiter re-invite a candidate after a power or connection fault without deleting the old attempt; the old report is removed in that process; invite expiry is off by default. Our design keeps the old attempt as `superseded`, which is stricter on evidence. [HackerRank reinvite](https://hackerrank-knowledge-base.help.usepylon.com/articles/1002936098), [invite settings](https://hackerrank-knowledge-base.help.usepylon.com/articles/9544354489-configure-test-invites-settings-for-tests).
- Codility sets expiry per test from 1 to 90 days (opt-in), lets a recruiter reopen a session with a changed time limit, and cancel invites. Supports C-30 and R-25. [expiry](https://support.codility.com/hc/en-us/articles/4415859889175-Screen-Invite-Expiration), [cancel](https://support.codility.com/hc/en-us/articles/360043828653-Cancel-a-Candidate-Invite).
- Hack The Box machines have a fixed lifetime with an extension up to 24 hours; TryHackMe distinguishes terminate from hibernate. Relevant to learner idle and restart (L-17, L-19). [HTB](https://help.hackthebox.com/en/articles/5185338-how-to-play-machines), [THM](https://help.tryhackme.com/en/articles/6498318-instance-termination).
- UK ICO recruitment automated-decision report (2026): human review must be able to change the outcome; candidates should be told they can challenge. Supports ACH-06 and the held-capture design. [DLA Piper summary](https://privacymatters.dlapiper.com/2026/04/uk-ico-report-on-automated-decision-making-in-recruitment/), [Brodies](https://brodies.com/insights/ip-technology-and-data/automated-decision-making-in-recruitment-what-the-icos-latest-report-means-for-employers/).
- PortSwigger Academy and OWASP Juice Shop: no official timer documentation found in this search; not used.
