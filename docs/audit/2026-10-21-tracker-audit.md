# Tracker and open-items audit, 2026-10-21

Scope: the three developer trackers (Tanmay stream L, Akshay stream P, Sahil stream T), the task files, `docs/dev/HANDOFFS.md`, the BMAD story plans, the Excel workbook, `initial.md`, `docs/traceability.md` and the code. Repo state: branch `l-tester-login-hint-bugs` (origin/main plus PR #75). Read-only; nothing was edited except this file. No flag values or secrets are written here.

Sibling audits to read with this one: `docs/audit/2026-10-18-lab-stream-audit.md` (lab, with later fixes marked in the task file) and `docs/audit/2026-10-21-wiring-audit.md` (platform and cross-service wiring, same day). I cite the second for platform defects I did not re-derive; items marked "(wiring F-nn)" come from it.

## 0. What I ran myself

| Check | Command | Result |
|---|---|---|
| Platform API tests | `uv run --offline pytest apps/api/tests -q` | 2684 passed, 244 skipped (skips need Postgres or Valkey DSNs, which this PC does not have) |
| Orchestrator tests | `uv run --offline pytest apps/orchestrator -q` | 473 passed |
| Attempt engine tests | `uv run --offline pytest packages/py-attempts -q` | 357 passed |
| Shop, services, challenge tests | `node --test` on apps/shop, services/*, challenges tests | 326 tests, 321 passed, 0 failed, 5 skipped |
| Release gate (all 11 exploits, vulnerable and fixed build) | `node scripts/release-gate.mjs` | 11/11 PASS (C01 to C11) |
| Live evidence files exist | Glob on `docs/assets/production-readiness/` | present (e2e-run19/20/21, l12, l14, l19, l24, l10, l29-*, exploits-live-all/c03b); NOT re-run (needs vm-p, vm-i and the developer's login) |

Not run: any live check against the deployed system, the Postgres and Valkey test modules, browser tests (none exist).

## 1. Headline

- Ticks are broadly honest on the code side. The tick state is wrong in both directions for the lab (L-21, L-22, L-23, L-28 built and "done" in the tracker but unticked; L-12, L-14, L-24, L-29 ticked with a stated live gap).
- The big problem is not any one task. It is that the **deployed system is a learner practice lab only**. The recruiter, candidate and admin web pages (`apps/web`), real e-mail, and the retention scheduler are not deployed (wiring F-02, F-03, F-04; handoff H-358 still open: 29 of 61 deployed checks fail). A real recruiter or candidate cannot use the product today.
- The Excel workbook is at 0 of 95 Done. The top table of `docs/traceability.md` (F1 to F11) is "Not started" for every row. Both are stale.
- Sahil is out. His 31 of 32 ticked tasks hold up locally (the release gate is 11/11 on the code I ran). One task (T-32) is open, plus content and event gaps that Tanmay now owns (section 4.3).

## 2. Counts

| Developer | Tasks | DONE-VERIFIED | DONE-CLAIMED-UNVERIFIED | PARTIAL | NOT STARTED |
|---|---|---|---|---|---|
| Tanmay (L) | 31 | 16 | 6 | 8 | 1 |
| Akshay (P) | 32 | 17 | 4 | 11 | 0 |
| Sahil (T) | 32 | 28 | 1 | 3 | 0 |

Definitions. DONE-VERIFIED: ticked, and I re-ran the tests or the release gate and found the code. DONE-CLAIMED-UNVERIFIED: ticked, the proof is live-only or in test modules I could not run (Postgres, Valkey), so I only saw the evidence file or the claim. PARTIAL: the Done-when is not met or integration defects exist. A "tracker" column shows the state of the story plan under `docs/bmad/initiative-*/` (done, built, in-review, in-progress, blocked).

## 3. Tanmay (stream L, `docs/dev/dev1-tanmay.md`, `initiative-lab`)

### 3.1 Task table

| Id | Title | Ticked | Tracker | Verdict | Evidence |
|---|---|---|---|---|---|
| L-01 | Repository skeleton, tooling | yes | done | DONE-VERIFIED | pins and CI green, 2026-10-18 audit; no branch protection on main |
| L-02 | Instance contract IF-6 | yes | done | DONE-VERIFIED | `contracts/instance/`; Sahil sign-off in `contracts/COMPAT.md` |
| L-03 | Event schema IF-4, fake ingest | yes | done | DONE-VERIFIED | `contracts/events/`; 29 valid, 69 invalid examples |
| L-04 | Orchestrator API IF-5, fake | yes | done | DONE-VERIFIED | orchestrator suite 473 passed (mine); client is hand-written, not generated |
| L-05 | Lab fragment IF-2 + mock | yes | done | DONE-VERIFIED | `apps/api/tests/test_lab_contract.py` in the 2684 passed; ADR 0019 still Proposed |
| L-06 | Stub shop, harness | yes | done | DONE-VERIFIED | harness and conformance in CI (audit) |
| L-07 | Contract checks in CI | yes | done | DONE-VERIFIED | checker tests; a red breaking PR on GitHub was never recorded |
| L-08 | AWS account, two VMs | NO | done (2 stories) | PARTIAL | hosts real; budget e-mail unconfirmed, one dev key, stop/start rehearsal not done, local-only Terraform state (task file line 122, audit B3 now fixed) |
| L-09 | Tag contracts v1.0.0, change rules | NO | in-progress | PARTIAL | tag `contracts-v1.0.0` does not exist; COMPAT rows pending: IF-2 2.1.0 (Akshay), DB 2.2.0 owner (Akshay), DB 2.2.0 consumer (Sahil), plus single-owner rows; IF-2 2.0.0 is breaking with a pending consumer row; no branch protection |
| L-10 | DuckDNS and certificates | yes | built | DONE-CLAIMED-UNVERIFIED | `docs/assets/production-readiness/l10-renewal-live.json` exists, not re-run; S-16 recorded |
| L-11 | Vercel, same-origin rewrite, S-14 | NO | built | PARTIAL | only a throwaway probe project; the real dashboards are not on Vercel; demo site served direct from vm-p with no origin-secret check (task file line 161) |
| L-12 | Image builds and deploy | yes | built | DONE-CLAIMED-UNVERIFIED | `l12-hello-deploy.txt` exists; amd64 only (D-51); deploy is a person running a script, no pipeline |
| L-13 | Orchestrator creates instance | yes | done | DONE-VERIFIED | 473 passed; real shop ready in 6.1 s live (claim) |
| L-14 | Reset, teardown, reconciler | yes | done | DONE-CLAIMED-UNVERIFIED | `l14-reaper-live.json`, `l14-kill-test-live.json` exist; real 60-minute idle wait never sat out; reconciler desired-state is "want everything" (H-123 open, Akshay) |
| L-15 | Isolation and hardening | yes | done | DONE-CLAIMED-UNVERIFIED | probe 18 of 18 live (claim); S-15 emulated, not 20 real instances |
| L-16 | Concurrency and quotas | yes | done | DONE-VERIFIED | build cap and quota tests in suites I ran; capacity numbers are stub numbers, vm-i admits 7 |
| L-17 | Edge and gate | yes | done | DONE-VERIFIED | `apps/edge` tests; gate access map is in memory (wiring: after an edge restart every lab answers "ended") |
| L-18 | Event relay, one active session | yes | done | DONE-VERIFIED | `apps/api/tests/test_login_bump.py`; side effect: a login on any device bumps the epoch of a running assessment too (wiring section 5) |
| L-19 | Flag derivation, secrecy | yes | done | DONE-VERIFIED | flag-leak scan is a CI step in `images.yml`; decoy placement into the catalogue not wired (H-331 open) |
| L-20 | Coraza sidecar, capture, paste | yes | done | DONE-VERIFIED | sidecar tests pass (in my 326); S-6 accuracy mixed, `classifier_accuracy_verified` false; CRS 4.25.0 not the 4.30.0 the PRD names |
| L-21 | Milestone engine, evidence | NO | done | PARTIAL | engine and 33 rules exist, tests pass; open: spec deviations (C01 M2, C03, C07 M1, C08 M2), C09 M2 cannot fire because the shop never emits `shop.security_event_written`, C05 M2 and C08 M1 fire on any hit |
| L-22 | Attempt state machine, clock | NO | done | PARTIAL | `packages/py-attempts` 357 passed; open: template rules did not reach attempts until `ef7d5c7` (wiring F-01, no regression test), invite never becomes `started` (F-05), start ignores invite state (F-06) |
| L-23 | Scoring engine | NO | done | PARTIAL | reproduces PRD Appendix A (tests pass); hint cost and hint mode from the template are ignored by the lab (wiring F-07, H-351) |
| L-24 | Backups, laptop fallback | yes | done | DONE-CLAIMED-UNVERIFIED | `l24-backup-live.json` exists; no copy to cloud storage; keystore not covered by design; backups on the same host plus a manual pull to the dev PC |
| L-25 | Time metrics, event log | yes | done | DONE-VERIFIED | tests in the suites I ran; the invite and consent web events have no live run |
| L-26 | Reset and withdrawal | yes | done | DONE-VERIFIED | `test_lab_review_reset_withdraw.py`; the live check made the candidate attempt through the runtime, not the invite routes |
| L-27 | Anti-cheat, held-capture review | yes | done | DONE-VERIFIED | thresholds are placeholders (OI-25); write-up similarity and idle-gap not wired; a learner's held capture can never be released (wiring section 4) |
| L-28 | Cohort board, ranking aid | NO | done | PARTIAL | `ports/engine_cohort.py` and tests exist; no IF-1 route and no recruiter screen, so a recruiter cannot see the board (H-353) |
| L-29 | Isolation proof, hardening | yes | done | DONE-CLAIMED-UNVERIFIED | `l29-*` evidence (gVisor on vm-i, 18 of 18, 34 of 34) exists; user-namespace remapping failed and was dropped; S-15 emulated |
| L-30 | End-to-end suite, load check | NO | review | PARTIAL | learner journey 34 of 34, 57 of 57 exploit checks (vulnerable build only), load of 6 gave 4 ready and 2 clean 429s; no invite, assessment, recruiter report in the suite; Sahil's T-32 and Akshay's P-32 not closed |
| L-31 | Demo rehearsal, submission pack | NO | in-progress | NOT STARTED | rehearsal never run (task file line 415); the pack checker only counts files |

Note for L-12 and L-14: the task file ticks them and the audit text calls them "TICKED". The stories are `built` (L-10, L-11, L-12) or `done`. Under the rule "a story is done only after the developer confirms", the `built` ones are in a confirmation backlog, not closed.

### 3.2 Open handoffs with Tanmay as owner

Of 177 rows in `docs/dev/HANDOFFS.md`, about 88 carry an open-like status (the 2026-10-21 wiring audit counts 88 as well; my count of rows that are neither done, answered, confirmed nor changed is 112, because "partly", "deferred" and "to re-confirm" rows are in my count).

| Row | Task | What | Needed from Tanmay |
|---|---|---|---|
| H-62 | L-15 | injector `network_mode: none` deviates from architecture 02 drawing | decide whether the drawing is updated |
| H-68 | L-08, L-13 | mutual TLS on the private link (wiring: port 9444 is server TLS only) | build or accept in writing |
| H-75 | L-18 | build ingest and relay as IF-4 says | confirm as built |
| H-79 | L-13, L-16 | `InstancePort` protocol | confirm |
| H-81 | L-09 | replace placeholder error names with registry names | do it before the tag |
| H-82 | L-03, L-04, L-09 | confirm own open points so owner columns are empty before the tag | do it before the tag |
| H-93, H-102, H-103, H-104, H-106, H-108, H-109, H-110, H-111 | L-12, L-13, L-15, L-29 | sidecar start document, host facts, host isolation gap, epoch identity, `transition`, IF-4 re-review, known limits, resumable first boot | answer each in the row |
| H-112, H-113, H-115, H-117, H-119 | T-04, L-11, L-12 | unblocking note, origin-secret check, certificates from host, platform edge, state-report behaviour | close or mark done |
| H-358 | deployment, L-11, L-30 | redeploy main and the dashboards, decide port 80, re-run `scripts/verify-deployed.mjs` | story 12 of the 2026-10-20 plan is not built (git log has no deploy commit) |

Rows Tanmay has open as the sender to Akshay (H-122, H-123, H-126, H-328 to H-330, H-333, H-336 to H-339, H-340, H-342, H-345, H-346, H-348, H-353) need Akshay's answer; several describe code that is built, so the status is simply never closed. Rows H-355, H-356, H-357, H-359 are done.

### 3.3 Open questions and unmade decisions that block user-friendliness (Tanmay's area)

| Item | Why it matters |
|---|---|
| OI-21 quota numbers | Placeholders only; real LabRuntime never reads QuotaPort (wiring F-08), so admin quota settings do nothing |
| OI-23 idle candidate instance | Not answered anywhere in `initial.md`; today an idle assessment instance is reaped on the template limit |
| OI-24 start retries | Open in `initial.md`; code retries once |
| OI-25 tuning numbers (idle, too-fast, warnings, grace) | Placeholders in code; no pilot |
| OI-4 pilot participants, OI-2 load-test requirement, OI-1 submission date | Needed for the report and the demo plan |
| OI-35 CWE, ATT&CK, CRS tag re-verification | `challenge-specs.md` section 1 says some IDs are UNVERIFIED |
| OI-36 Oracle shape | Hosting moved to AWS (D-41); the OI is obsolete and should be closed |
| OI-9 web address | Settled in practice (DuckDNS names plus `*.vercel.app`); not written as closed |
| D-60 to D-68, D-70 to D-79, D-80 to D-88, D-52 to D-59 | "Proposed, decided on delegation" in the traceability rows; the developer has not accepted all of them. CLAUDE.md says record a decision only after the developer confirms |

### 3.4 Inconsistencies (Tanmay)

1. L-21, L-22, L-23, L-28 are unticked while their stories are `done` and the dependent L-25, L-26, L-27 are ticked. Pick one rule.
2. `docs/dev/dev1-tanmay.md` carries 3 to 6 stacked status lines per task ("Closed", "Status", "Audit"), several contradicting each other; the latest line is not marked as authoritative.
3. Excel sheet "1 Tanmay (Lab)": 0 of 31 Yes; L-08 still reads "Oracle account" while the task file says AWS.
4. `docs/traceability.md`: F1 to F11 all "Not started"; rows for FR-SES, FR-SCR, FR-FLG, FR-DET, FR-TIM are "Partial: ... local proof only" and were not updated after the live runs of 2026-10-19 and 2026-10-20; FR-ACH-01, 02, 05, FR-DET-03, 08, 09, FR-SCR-02 to 05, FR-TIM-02, 03 have no row at all.
5. Stories `built` that the task file ticks: L-10, L-11 (not ticked), L-12; `in-review` for 11 stories in `initiative-lab/backlog/` (including the current bug story and PR #75); stories `review` for "an instance created from the real shop" and "deployed verification"; `in-progress` for sprint-1 audit remediation, tag contracts, demo rehearsal; `built` for the S-4 spike story.
6. `contracts/platform` OpenAPI `info.version` 1.0.0 versus 1.7.0 in CHANGELOG, COMPAT and registry (wiring section 4).
7. ADR 0019 Proposed, `COMPAT.md` approvals pending, branch protection absent: change rules "on" in text, advisory in fact.

### 3.5 The 10 things Tanmay must still do (so a real user can use the product)

1. Deploy main (API with migrations 0016 and 0017, `apps/web` dashboards, console) to vm-p and run `scripts/verify-deployed.mjs` green (H-358). Without it no recruiter or candidate page exists for anyone.
2. Turn on the retention scheduler and the real mail provider in `infra/deploy/platform.compose.yaml` (scheduler flag, Brevo key). Both are one-line settings and both are legal promises of the consent notice (wiring F-02, F-03). Also fail closed if the orchestrator URL or the Postgres store is missing (wiring section 3).
3. Fix the invite and attempt lifecycle: invite to `started`, start checks invite state, revoke cancels a ready attempt, expire ready attempts, dangling attempt id on a repeat invite (wiring F-05, F-06 and section 4). Add the regression test that F-01 lacked (stored attempt rules after invite, consent, create).
4. Make template settings reach the attempt: hints mode and cost percent, challenge subset, submissions per minute, write-up required (wiring F-07, H-351). Today candidates never get hints and see all 11 challenges.
5. Wire the quota port into the real runtime (F-08, H-126), add rate limits to the authenticated lab routes, and decide the real numbers (OI-21).
6. Own the shop now (section 5): emit `shop.security_event_written`, tighten C05 M2, C08 M1 and C10 milestones, deliver decoy placement (H-331, H-42, H-43), and close T-32 with the fixed-build leg.
7. Close the contract tag: collect or waive the pending COMPAT rows (IF-2 2.1.0, DB 2.2.0), resolve the version mismatch, tag `contracts-v1.0.0` (or record a decision not to), decide branch protection (L-09).
8. Finish L-08 and L-11 live items: budget alert e-mail, a second SSH key, stop/start rehearsal, a Terraform state backup, and the real Vercel project with the origin-secret check (the demo site currently has none).
9. Run and record the demo rehearsal twice (laptop fallback and online), extend `scripts/e2e-live.mjs` with invite, consent, assessment, release and recruiter report, and re-measure load with the real shop (L-30, L-31).
10. Reconcile the records: tick or untick L-21, L-22, L-23, L-28 by one rule, mark the stories `done` that the developer has confirmed, update the Excel sheets, `docs/traceability.md` (F1 to F11, the stale Partial rows) and close the 112 stale handoff rows. Accept or change the "Proposed" decisions D-52 to D-88 in `initial.md`.

## 4. Akshay (stream P, `docs/dev/dev2-akshay.md`, `initiative-platform`)

### 4.1 Task table

All tasks P-01 to P-31 are ticked; P-32 is not. Story plans are `done` for all except P-32 (`blocked`). Test basis for every row: `apps/api` suite, 2684 passed and 244 skipped on my run.

| Id | Title | Ticked | Tracker | Verdict | Evidence |
|---|---|---|---|---|---|
| P-01 | Platform stack runs locally | yes | done | DONE-VERIFIED | stack tests in suite; compose files present |
| P-02 | Error registry, IF-8 | yes | done | DONE-VERIFIED | `contracts/errors` (36 files); wiring: all error codes in code are registered |
| P-03 | Domain events IF-3 | yes | done | DONE-VERIFIED | `contracts/domain-events` (38 files) |
| P-04 | API fragments, mock, clients | yes | done | DONE-VERIFIED | 91 of 92 operations match code; generated TS client and py-models are used by nothing |
| P-05 | Ports, fakes, table ownership | yes | done | DONE-VERIFIED | `apps/api/src/vulnmart/ports/` |
| P-06 | API skeleton, single-head migrations | yes | done | DONE-VERIFIED | `kernel/` (20 files); migration tests pass |
| P-07 | Dashboards skeleton, proxy | yes | done | DONE-VERIFIED | `apps/web` builds locally; only a probe page is deployed |
| P-08 | Contract sign-off | yes | done | PARTIAL | three rows still pending in `contracts/COMPAT.md` (IF-2 2.1.0 consumer, DB 2.2.0 owner, DB 2.2.0 consumer); review of the L-09 tag PR cannot happen, there is no tag |
| P-09 | Outbox, worker, e-mail provider | yes | done | DONE-VERIFIED | `notifications/`, tests pass; deployed compose points at Mailpit (wiring F-03); OI-32 chose Brevo in the code, not in `initial.md` |
| P-10 | E-mail templates, in-app warnings | yes | done | PARTIAL | four spec'd mail types are never enqueued (deletion requested, request for company, deletion confirmed, consent withdrawn); no mail for time warnings, submit or released results (wiring F-10) |
| P-11 | Learner signup, verification | yes | done | DONE-VERIFIED | `accounts/` tests; resend route has no UI caller (F-12) |
| P-12 | Login, sessions, CSRF | yes | done | DONE-VERIFIED | `test_sessions_service.py`, `test_session_api.py`, `test_my_sessions_api.py` |
| P-13 | Account types, candidate role, admin creation | yes | done | DONE-VERIFIED | `test_roles_and_admins.py`; the candidate role is granted but never used for authorization (wiring section 5) |
| P-14 | Password reset, self-service | yes | done | DONE-VERIFIED | `test_password_reset.py` |
| P-15 | Multi-factor login | yes | done | DONE-VERIFIED | `test_mfa.py`, `test_mfa_api.py`; OI-13 (mandatory or not) still open |
| P-16 | Consent screen, record, 18+ | yes | done | DONE-VERIFIED | `test_consent.py`; wording is a draft until legal review (OI-33) |
| P-17 | Audit log and key service | yes | done | DONE-CLAIMED-UNVERIFIED | `test_audit_postgres.py`, `test_keys_postgres.py` skip without a DSN on my run; CI has Postgres 18; anchor and purge belong to the scheduler, which is off when deployed |
| P-18 | Recruiter signup, approval | yes | done | DONE-VERIFIED | `orgs/company_api.py`, `test_company_api.py`; OI-11 second half (company-name check) not asked |
| P-19 | Company members, scoping, caps | yes | done | DONE-CLAIMED-UNVERIFIED | row-level security tests are Postgres modules (`test_company_members_postgres.py`), skipped on my run |
| P-20 | Template, invites, lifecycle | yes | done | PARTIAL | template settings are stored, shown, and ignored by the lab (F-07); template edit and invite actions have no UI (F-11); invite mail links to a page that is not deployed (F-04) |
| P-21 | Accept invites, re-invite, bulk | yes | done | PARTIAL | invite never reaches `started`, so a running attempt hides behind "expired" (F-05); revoke does not cancel (F-06); repeat invite gets a dangling attempt id; a learner on another e-mail must make a second account |
| P-22 | Live hub: SSE, heartbeat, fan-out | yes | done | DONE-CLAIMED-UNVERIFIED | Valkey tests always skip, no Valkey in CI; only consumer is `apps/web` `useLive`, which is not deployed; console polls |
| P-23 | Stream authorisation, HTTP/2 | yes | done | DONE-CLAIMED-UNVERIFIED | `test_live_authorisation.py` runs; HTTP/2 proven only on the local stack, not through Vercel (S-14 is plan A holds) |
| P-24 | Retention scheduler and rules | yes | done | PARTIAL | code and tests pass, but the deployed compose never sets the scheduler flag: no invite expiry, no retention, no deletion jobs, no audit anchor (F-02) |
| P-25 | Deletion workflow, undo, who viewed me | yes | done | PARTIAL | person routes work; company side has no route and no callers (F-09); decision and confirmation mails never sent (F-10) |
| P-26 | Learner and candidate dashboards | yes | done | PARTIAL | pages exist in `apps/web/app`; not deployed, never opened in a browser (OI-30 open); the board cannot "begin challenge" in sequenced mode that production runs (F-14) |
| P-27 | Recruiter dashboard, live monitor | yes | done | PARTIAL | pages exist; not deployed or browser-tested; no UI for invite actions (F-11); release action added later by Tanmay |
| P-28 | Admin operations | yes | done | PARTIAL | approvals, users, force-stop, settings exist; quota and cap settings are write-only (F-08, H-126); orchestrator uses `FakeSettingsPort`, so idle and max settings do not apply |
| P-29 | Data exports | yes | done | DONE-VERIFIED | `test_exports.py`, `test_exports_company.py`; OI-27 answered (D-96); not browser-tested |
| P-30 | Admin dashboard, privacy wall | yes | done | PARTIAL | `test_privacy_wall.py` classifies every operation (good); admin pages not deployed and not browser-tested |
| P-31 | Break-glass, audit access, incident | yes | done | DONE-VERIFIED | `test_breakglass.py`; works only with two admins and mail (F-15); legal review (OI-33) still has no reviewer |
| P-32 | Deployed verification, ASVS | NO | blocked | PARTIAL | `scripts/verify-deployed.mjs` and the ASVS chapter table exist (chapter level only, not requirement by requirement); deployed run 32 PASS, 29 FAIL; waits for Tanmay's redeploy |

### 4.2 Open handoffs with Akshay as owner

Rows in "For Akshay" still open (73 rows in that section; ids with a non-final status):

- Contract and tag: H-120 (sign off contracts before tag; partly done by H-352 answer, three COMPAT rows still pending), H-345 (additive edit of his `pyproject.toml`, D-95 Proposed).
- Lab seams: H-122 (activity signal; built by Tanmay, confirm), H-123 (reconciler desired state: wants "everything" until Akshay supplies the list), H-124 (images-release output), H-125 (docker socket proxy live run), H-126 (quota numbers and `QuotaPort.limits`), H-328, H-329, H-330, H-333, H-336 to H-339, H-340, H-342, H-346, H-348, H-351, H-353 (confirm what stream L built for his routes: withdraw, undo, cohort, release).
- Own-stream carry-overs: H-128 to H-133, H-136 to H-144 (what stories P-09 to P-24 leave for later stories, routes in story 5.3, deployment needs such as `VULNMART_CSRF_SECRET_FILE`). Several are satisfied by code and never marked.
- Shared: H-100 (public SSH key for the hosts; one row for Akshay and Sahil; neither has answered), H-129 (visitor address for rate limits behind Vercel).

### 4.3 Open questions and unmade decisions that block user-friendliness (Akshay's area)

| Item | Why it matters |
|---|---|
| OI-30 browsers and accessibility | Not decided; zero browser tests exist for any dashboard page (no Playwright, no `next build` in CI) |
| OI-13 mandatory MFA or passkeys | Admins require TOTP in code; recruiters optional |
| OI-33 legal review, OI-31 Hindi notice, OI-37 wording | Consent text and retention periods are drafts; no reviewer named |
| OI-32 e-mail provider | Code supports Brevo; deployment uses Mailpit; the decision is not in `initial.md` |
| OI-21 quota numbers | See section 3.3 |
| OI-11 company-name verification | Asked half only |
| OI-29 CAPTCHA | Answered by choice (rate limits only) but not written into `initial.md` |
| Where do the dashboards run (Vercel or vm-p)? | wiring F-04 asks this; no decision on record, and Caddy serves only the lab console |

### 4.4 Inconsistencies (Akshay)

1. Task-file annotations for P-18 to P-21 say "service level, no routes (story 5.3)" but `company_api.py` and `invite_api.py` now exist; the notes are stale.
2. P-10 note says in-app warnings were moved to story 2.3; that story is `done`, but the P-10 tick box and the task text do not say so.
3. P-08 ticked while COMPAT approvals are pending and the review it cites is against older versions (IF-4 0.2.0, IF-6 0.2.0, DB 0.2.0).
4. Excel sheet "2 Akshay (Platform)": 0 of 32 Yes against 31 ticked.
5. `docs/traceability.md` marks most FR-ACC, FR-ORG, FR-PRV, FR-ADM, FR-ASM, FR-DSH, FR-EXP, FR-LIV rows "Built" or "Built at service level", not "Done", even where the task file says done, and uses the words "state `built`" for stories that are now `done`.
6. The ASVS table says "chapter level; requirements not checked one by one" yet is listed as the P-32 deliverable.
7. Generated clients are in the repo but unused; `apps/web/lib/api.ts` is hand-typed with `unknown` casts, so spec drift is not detected for non-lab routes.
8. Valkey in compose has no persistence, no auth and `allkeys-lru` at 64 MB: queued mail ids and rate-limit counters can be evicted (wiring section 3).

### 4.5 The 10 things Akshay must still do

1. Decide and deploy where the dashboards live; make `/invite`, `/company`, `/admin`, `/assessment` real and reachable on the deployed host (wiring F-04). Without it invite links go nowhere.
2. Run a real-browser pass on every page (Chrome and one more), fix what breaks, add at least a smoke test in CI (OI-30). Nothing was ever opened by a person.
3. Make `apps/web` work in sequenced learner mode (`beginChallenge`, `current_key`), or retire the board for learners (F-14).
4. Fix the invite lifecycle with Tanmay: `started` transition, revoke cancels, expiry of ready attempts, filter by mode in the console (F-05, F-06, section 6 gap 2).
5. Make the company side of deletion real: a route and the notice mail (F-09); enqueue the four missing mail types; add mail for time warnings, submit and released results (F-10).
6. Give recruiters the UI for revoke, resend, re-invite, template edit and the cohort board (F-11; needs the cohort route for L-28, H-353).
7. Sign the remaining COMPAT rows (IF-2 2.1.0 consumer, DB 2.2.0 owner), answer H-353 and the open "For Akshay" rows, and fix the OpenAPI `info.version`.
8. Replace the in-memory fakes in production paths with fail-closed guards (`FakeInstanceHost`, in-memory attempts, `FakeOutboxPort` in `LiveOutbox`) and add rate limits to authenticated lab and company routes.
9. Close P-32: run the ASVS checklist requirement by requirement (it is chapter level now), and the deployed verification after the redeploy.
10. Real e-mail: a verified sender with Brevo, a test that sends one real message per template, and a deployed-compose check that fails if the provider is Mailpit.

## 5. Sahil (stream T, `docs/dev/dev3-sahil.md`, `initiative-target`) and what Tanmay now owns

Sahil has been removed from development. His 31 ticked tasks hold up on the code and the release gate; the shop and challenges are Tanmay's now, together with every open row below. I did not edit any of his files.

### 5.1 Task table

| Id | Title | Ticked | Tracker | Verdict | Evidence |
|---|---|---|---|---|---|
| T-01 | Shop in a container | yes | done | DONE-VERIFIED | `apps/shop/Dockerfile`; shop tests pass |
| T-02 | Catalogue schema, 11 stubs (IF-7) | yes | built | DONE-VERIFIED | `challenges/catalog/c01.yaml` to `c11.yaml`; story never marked done |
| T-03 | Consumer review of IF-6 and IF-4 | yes | done | DONE-VERIFIED | IF-6 sign-off in COMPAT; DB 2.2.0 consumer row pending |
| T-04 | Shop meets the contract in the harness | yes | built | DONE-VERIFIED | `apps/shop/instance-harness/`; real injector wired by Tanmay (H-350, review by Sahil never given) |
| T-05 | Exploit test runner | yes | built | DONE-VERIFIED | `challenges/tests/runner/run-exploit.mjs`; release gate uses it |
| T-06 | Data model, state machines | yes | built | DONE-VERIFIED | `apps/shop/migrations/0001_init.sql`, `db.test.mjs` |
| T-07 | Identity, six roles, hashing | yes | built | DONE-VERIFIED | `apps/shop/src/identity/password.mjs`; scrypt; story never marked done |
| T-08 | Snapshot seeding | yes | built | DONE-VERIFIED | `apps/shop/seed/registry.mjs`; start time measured; story never marked done |
| T-09 | Health, readiness, runtime profile | yes | done | DONE-VERIFIED | harness 12/12 per deferred-work; runs under gVisor live (Tanmay L-29) |
| T-10 | Boundaries, signed app events | yes | done | DONE-VERIFIED | traceability FR-SHP-14 still "Partial" |
| T-11 | Mock services | yes | done | DONE-VERIFIED | `services/mock-services/src/server.mjs`; H-121 emits `meta.request_served` (done there) |
| T-12 | Isolated import service | yes | done | DONE-VERIFIED | `services/import-service/` |
| T-13 | Support-agent bot | yes | done | DONE-CLAIMED-UNVERIFIED | bot is a jsdom visitor (ADR 0061), not a real browser; S-5 memory figure not re-measured; `VM_BOT_BROWSER=0` falls back to a plain GET |
| T-14 | Customer flows | yes | done | DONE-VERIFIED | `apps/shop/src/web/`; login throttling and `needsRehash` wiring deferred (deferred-work) |
| T-15 | Support, finance, admin flows | yes | done | DONE-VERIFIED | `staff-service.mjs` tests; `assignTicket`, `holdPayout` have no UI buttons |
| T-16 | Seeded accounts | yes | done | DONE-VERIFIED | FR-SHP-08 Done; one demo password per account set is an open point (D-02, deferred-work) |
| T-17 | Seller flows | yes | done | DONE-VERIFIED | seller service tests |
| T-18 | Refunds, disputes, payouts | yes | done | DONE-VERIFIED | money tests; `BEGIN IMMEDIATE` stock check deferred |
| T-19 | C01 | yes | done | DONE-VERIFIED | release gate PASS C01 |
| T-20 | C02 | yes | done | DONE-VERIFIED | release gate PASS C02 |
| T-21 | C03 | yes | done | DONE-VERIFIED | release gate PASS; `exploits-live-c03b.json` shows the deployed exploit passing; stale note in deferred-work says live loop deferred |
| T-22 | C04 | yes | done | DONE-VERIFIED | release gate PASS C04 |
| T-23 | C05 | yes | done | DONE-VERIFIED | release gate PASS C05; M2 fires on any hit (wiring section 4) |
| T-24 | C06 | yes | done | DONE-VERIFIED | release gate PASS; live run found and fixed a defect on 2026-10-20 (Tanmay) |
| T-25 | C07 | yes | built | DONE-VERIFIED | release gate PASS; live run found and fixed a defect on 2026-10-20; M1 deviation in spec; story still `built` |
| T-26 | C08 | yes | built | DONE-VERIFIED | release gate PASS; M1 loose |
| T-27 | C09 | yes | built | PARTIAL | release gate PASS, but `shop.security_event_written` is never emitted (`apps/shop/src/challenges/c09-logging-failures.mjs`, `void emit`); the code comment says the schema lacks it, but `contracts/events/app-events.md` lists it now; so the M2 negative-observation signal cannot tell vulnerable from fixed |
| T-28 | C10 | yes | built | DONE-VERIFIED | release gate PASS; live run found and fixed a defect on 2026-10-20 |
| T-29 | C11 | yes | built | DONE-VERIFIED | release gate PASS; H-120 mock error shape open |
| T-30 | Catalogue content | yes | built | PARTIAL | 11 catalogue files, no placeholder hint text; open: decoy placement not delivered to the injector (H-331, H-42), milestone mapping to IF-4 names not settled (H-43), OI-14 write-up timing answered by D-99 but not checked in the pages; story `built` |
| T-31 | Cross-challenge tests, release gate | yes | built | DONE-VERIFIED | `scripts/release-gate.mjs` 11/11 (mine); `challenges/tests/independence.test.mjs`; not confirmed that CI blocks on it |
| T-32 | Deployed verification on VM-I | NO | blocked (in deferred-work) | PARTIAL | Tanmay ran 57 of 57 checks against a deployed instance (`exploits-live-all.json`, vulnerable build only); the "fails on the fixed build, deployed" leg and a formal close are missing |

Count check: 28 DONE-VERIFIED, 1 DONE-CLAIMED-UNVERIFIED (T-13), 3 PARTIAL (T-27, T-30, T-32), 0 NOT STARTED, as in section 2. Sahil's own task file ticks 31 of 32.

Tracker state mismatch: the `initiative-target` plans for T-02, T-04, T-05, T-06, T-07, T-08, T-25 to T-29, T-30, T-31 are `built`, not `done`. His own file says these advance only when he confirms; he cannot, so Tanmay (as product owner's delegate) must close or the developer must.

### 5.2 Open handoffs for Sahil (41 rows in "For Sahil", most unanswered)

Open or partly: H-24, H-25, H-26, H-27, H-28 (partly), H-30, H-31 (partly), H-32, H-33, H-34, H-35, H-37 (partly), H-39, H-40 (deferred), H-41, H-42, H-43, H-44 (partly), H-45 to H-55 (challenge event names; most partly or deferred), H-56, H-92, H-99, H-118, H-331, H-332, H-334, H-335, H-344, H-350 (review of Tanmay's real-shop wiring), H-353 (T-32 part), H-100 (SSH key). The shop is built and passes the harness, so most are satisfied by code; they were never closed in writing. Tanmay should walk them once, mark each done or changed, and record himself as the answerer.

### 5.3 Open items and decisions for the shop (blocks a realistic learner or candidate experience)

- Open questions: OI-35 (re-verify CWE, ATT&CK, CRS names; `challenge-specs.md` section 1 says UNVERIFIED), OI-14 (write-up timing; D-99 gives a template setting, catalogue write-up display unchecked).
- OI-18, OI-19, OI-20 are resolved by `docs/design/challenge-specs.md` sections 3 to 5 but there is no `initial.md` row confirming them (CLAUDE.md: record only after the developer confirms).
- Deferred work in `docs/bmad/initiative-target/deferred-work.md` that nobody owns: login throttling, lockout and security events tied to C07 and C09; rehash on login; `BEGIN IMMEDIATE` stock check; list paging; field length limits; per-instance reseed of seeded passwords (D-02); scoped `can()` context; `assignTicket` and `holdPayout` buttons; `/version` build id; running the instance harness in CI. Several are real vulnerabilities in the non-challenge shop (no length caps, no paging) and would be found by a pentest candidate.
- The C03 note says "live loop deferred" while the live evidence says passed: the document is stale.

### 5.4 What Tanmay must now own, in order

1. Close T-32 properly: add the fixed-build leg on the deployed instance, record both, and mark the story done.
2. Emit `shop.security_event_written` in the C09 pipeline and remove the stale comment; re-check C09 M2 against vulnerable and fixed builds.
3. Tighten the loose milestones (C05 M2, C08 M1, C10) and settle the spec deviations (C01 M2, C03 single key, C07 M1, C08 M2) so scoring matches the catalogue (this is also L-21).
4. Deliver decoy placement (H-331, H-42) and the milestone mapping (H-43) into the catalogue and the injector.
5. Decide the bot: keep jsdom (ADR 0061) and say so in the report, or add a real browser; re-measure S-5.
6. Walk the 41 Sahil handoffs and close them; sign the DB 2.2.0 consumer COMPAT row for the target stream (or record a decision to waive); record who now owns `CODEOWNERS` paths for `apps/shop`, `services/*`, `challenges/`.
7. Mark the `built` stories done where the developer confirms; tick Excel sheet 3 by hand; fix traceability FR-SHP-14 and FR-SHP-15 ("Partial") now that they are done in practice.
8. Take over the shop deferred-work list (5.3) and decide which items ship before submission.
9. Make a CI release gate that actually blocks (confirm the `exploit-runner` job is required, not only run).
10. Check every player-visible text (briefs, hints, write-ups) for flag leakage and for what the shop hides from a candidate; write the unmade decisions into `initial.md` Section 15 only after the developer confirms.

## 6. Cross-developer inconsistencies

| # | Inconsistency | Where |
|---|---|---|
| 1 | Excel workbook shows 0 Done in all three sheets (95 rows); task files tick 22 (Tanmay) + 31 (Akshay) + 31 (Sahil) | `docs/bmad/VulnMart-Tracker.xlsx` vs `docs/dev/*.md` |
| 2 | `docs/traceability.md` top table F1 to F11 all "Not started" | `docs/traceability.md` lines 8 to 20 |
| 3 | Traceability uses "Built", "Partial", "Partly done" where the task file says done; no single rule for "Done" | FR-ACC, FR-ORG, FR-PRV and others |
| 4 | Stories `built`, `in-review`, `review` and `in-progress` coexist with ticked tasks (about 30 stories across the three trackers) | `docs/bmad/initiative-*/` |
| 5 | The CLAUDE.md rule "mark a story done only after the developer confirms" is the reason for most of this backlog; with Sahil gone it can never be satisfied for stream T | CLAUDE.md |
| 6 | HANDOFFS.md: 177 rows, status vocabulary has 15+ spellings (open, Open, partly, deferred, answered, to re-confirm, ...); renumbering of H-127 to H-147 by +200 | `docs/dev/HANDOFFS.md` |
| 7 | Handoff H-358 says the live API predates P-26; story 12 (redeploy) of `docs/plans/2026-10-20-handoffs-h355-to-h359.md` is not done, so everything built since 2026-10-19 is unverified on the live site | `docs/plans/`, git log |
| 8 | Sprint dates run to 4 Nov (submission date OI-1 still "first week of November, exact date open"); Sahil's sprints 3 and 4 are shown as unstarted in his plan header ("Draft plan, not yet approved by the team") | task files line 12 |
| 9 | Lab audit of 2026-10-18 says "10 of 31 complete"; task file now ticks 22 after later fixes; the audit file is not updated, only the task file is | `docs/audit/2026-10-18-lab-stream-audit.md` |
| 10 | Two platform audits dated 2026-10-21 (this one and the wiring audit) are untracked files; nothing in `docs/bmad/` records either | git status |
| 11 | CI scope: Postgres tests run in CI, but Valkey tests never; e2e, edge, ingest and live scripts are not in CI; no browser tests anywhere | wiring section 7 |

## 7. PRD requirement IDs without a Done row in `docs/traceability.md`

Method: all `FR-xxx-nn` ids in `docs/prd/PRD.md` (170) matched against `docs/traceability.md`; mechanical, one row per id, a later "Done" row wins. 41 ids have a Done row, 117 have only a non-Done row, 12 have no row. Ids in the legacy list F1 to F11 are all "Not started" (11 of 11). Check rows in the file before relying on a single id.

### No row at all (12)

FR-ACH-01, FR-ACH-02, FR-ACH-05, FR-DET-03, FR-DET-08, FR-DET-09, FR-SCR-02, FR-SCR-03, FR-SCR-04, FR-SCR-05, FR-TIM-02, FR-TIM-03.

### Row exists but not Done (117)

| Prefix | Ids (number part) | Typical status text |
|---|---|---|
| FR-ACC | 01, 02, 03, 05, 06, 07, 08, 09, 10, 11 | Built / partly done, `state built` |
| FR-ACH | 03, 04, 06, 07 | Library and runtime built, placeholder thresholds |
| FR-ADM | 01 to 08 | Built (story P-28, P-31) |
| FR-ASM | 01 to 06 | Built at service level |
| FR-DET | 01, 04, 05, 06 | Partial, in-memory stores |
| FR-DSH | 01 to 06 | Built (stories P-26, P-27, P-30) |
| FR-EXP | 01 to 04 | Built (story P-29) |
| FR-FLG | 01 to 09 | Partial: material, checker, scan built |
| FR-HNT | 01, 02, 03 | Built in the page |
| FR-INS | 01, 06, 07, 08, 09, 10, 11 | Measured or verified live, or a Proposed decision |
| FR-LIV | 01 to 06 | Built, local stack |
| FR-NTF | 01, 02, 03 | Built, wording draft, Brevo |
| FR-ORG | 01 to 08 | Built at service level |
| FR-PRV | 01 to 20 | Built or prepared; legal review open (19, 20) |
| FR-SCR | 01, 06, 07, 08, 09, 10 | Partial, library |
| FR-SES | 01 to 11 | Partial, local proof |
| FR-SHP | 14, 15 | Partial |
| FR-TIM | 01, 04, 05 | Library and runtime built |

Done rows exist for: FR-CHL-01 to 17, FR-SHP-01 to 13, FR-ACC-04, FR-DET-02, 07, FR-INS-02 to 05, FR-NTF-04.

Reading: the platform and lab rows are not Done mainly because the traceability file was written with a stricter word ("Built") than the task files; many would be Done after a deployed run. FR-SHP-14, 15, FR-SES-*, FR-FLG-*, FR-SCR-* are stale: live evidence exists for several but the rows still say "local proof only".

## 8. Open questions (OI-xx) as of today

Open or only half answered in `initial.md`: OI-1 (submission date), OI-2 (load test required), OI-3 (report writer and roles of the two non-developing authors), OI-4 (pilot participants), OI-5 (final product name), OI-6 (macOS version, Sahil's CPU; moot now), OI-7 (informing the guide), OI-9 (web address; settled in practice), OI-11 second half, OI-13, OI-21, OI-23, OI-24, OI-25, OI-30, OI-31, OI-32 (code chose Brevo, no decision row), OI-33, OI-35, OI-36 (obsolete), plus OI-18, OI-19, OI-20 and OI-29 resolved in design files or in code but not in Section 15. Confirmed in Section 15: OI-8, 10, 11 (first half), 12, 14, 15, 16, 17, 22, 26, 27, 28, 34, 37, 38. The ones that block a human using the product are OI-30 (nobody has tested a browser), OI-32 (no real mail), OI-33 (consent text unreviewed), OI-21 and OI-25 (limits are placeholders) and OI-4 (no real participants to calibrate anything).
