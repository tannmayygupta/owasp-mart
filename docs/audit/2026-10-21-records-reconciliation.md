# Records reconciliation, 2026-10-21

Scope: make the trackers truthful after `2026-10-21-tracker-audit.md` and `2026-10-21-wiring-audit.md`, now that the project is run by the leader and Claude only (D-102). Evidence only: where I could not find it in code, contracts, tests or evidence files, the item stays open or is listed in section 5. I ran no test suite for this task; I checked that code, contracts and evidence files exist (grep and file checks) and used the audit's verdicts, which come from its own test runs (section 0 of the tracker audit). Not touched: `docs/traceability.md`, `contracts/`, `initial.md`, `scripts/`, CI, the Excel workbook. No flag values or secrets are written here.

## 1. `docs/dev/HANDOFFS.md` (177 rows)

Vocabulary now: `done | open | superseded | in-progress-wp (a-e) | blocked-external`. The header text (rule 3 and 6) is rewritten. Every changed row keeps its history and gets one appended sentence "Records 2026-10-21: status was ... now ...: evidence". Three rows were malformed (H-145 and H-351 had fewer cells than the table header); they were rebuilt with the missing cells.

| Status | Before (spellings) | After |
|---|---|---|
| open / Open | 87 | 9 |
| done (incl. "done (engine; HTTP part ...)") | 14 | 121 |
| answered / answered (Sahil ...) | 48 | 0 |
| confirmed | 6 | 0 |
| changed | 1 | 0 |
| answered, to re-confirm / to confirm | 9 | 0 |
| partly / partly answered / answered for P-26; open for P-17 | 7 | 0 |
| deferred | 3 | 0 |
| (empty status cell) | 2 | 0 |
| superseded | 0 | 36 |
| in-progress-wp | 0 | 11 (a: 2, c: 4, d: 5) |
| Total | 177 | 177 |

Rows left `open` (9, each names the audit item that covers it): H-62 (drawing decision), H-72 (placeholder numbers, OI-21 and OI-25), H-81 (placeholder error names before the tag), H-111 (resumable first boot), H-120 (pending COMPAT rows), H-123 (reconciler desired state), H-125 (docker proxy live run), H-332 (bot visitor decision), H-353 (cohort route and recruiter screen).

Rows `in-progress-wp`: a (lifecycle and quotas) H-66, H-126; c (deploy hardening) H-68, H-113, H-117, H-358; d (shop and challenges) H-42, H-43, H-53, H-331, H-334. No row was mapped to b (company, privacy, mail) or e (web) because no row maps cleanly; the mail and company gaps are tracked in wiring audit F-09 and F-10 inside the `superseded` notes. No row is `blocked-external`.

Mapping rules used: recorded answer or code present gives `done` (note names the file or audit verdict); a question to a person who is gone, where the point is satisfied or is plain backlog, gives `superseded` (note "owner removed, D-102" plus the audit item); a real unsolved point stays `open`.

## 2. Task files (`docs/dev/dev1-tanmay.md`, `dev2-akshay.md`, `dev3-sahil.md`)

- One tick rule added at the top of each file (Done-when met and verified by tests or recorded evidence; PARTIAL stays unticked with the missing items listed).
- Each task now has one authoritative line `Status (2026-10-21)` copied from the audit verdict tables 3.1, 4.1, 5.1 (95 tasks). In `dev1` the older `Closed`, `Status`, `Audit`, `Live` lines sit under a `(history)` marker.
- Excel rows and step 4 marked retired (the xlsx itself is untouched).
- Ticks changed (12): Tanmay none (22 ticked before and after; L-08, L-09, L-11, L-21, L-22, L-23, L-28, L-30, L-31 stay unticked with the missing items listed). Akshay 10 unticked as PARTIAL: P-08, P-10, P-20, P-21, P-24, P-25, P-26, P-27, P-28, P-30 (31 ticked before, 21 after). Sahil 2 unticked as PARTIAL: T-27, T-30 (31 before, 29 after). Nothing newly ticked: no task the audit marks PARTIAL has been closed since.
- Stale annotations fixed: P-18 to P-21 titles ("service level, no routes (story 5.3)": routes now exist in `orgs/company_api.py` and `assessments/invite_api.py`; old wording quoted as stale); P-10 title (story 2.3 is done, only e-mail for time warnings is missing); `docs/bmad/initiative-target/deferred-work.md` C03 "live loop deferred" and the C09 event note get a Status 2026-10-21 line (the old text stays).

## 3. Story plans (`docs/bmad/initiative-*/**/*-plan.md`, 138 plans)

Set to `done` (11, status field only, DONE-VERIFIED task in the audit and a dev-log entry exists for each): T-02 catalogue schema, T-04 shop meets the contract, T-05 exploit runner, T-06 data model, T-07 identity, T-08 snapshot seeding, T-25 C07, T-26 C08, T-28 C10, T-29 C11, T-31 release gate. Quoting style of each file kept (`'done'` or `done`).

Left as they are, with the reason:

| Story plan | State | Why not moved |
|---|---|---|
| T-27 C09 logging failures | built | PARTIAL: `shop.security_event_written` never emitted (work package d) |
| T-30 catalogue content | built | PARTIAL: decoy placement and milestone mapping open (work package d) |
| L-10 DuckDNS, L-12 image builds | built | DONE-CLAIMED-UNVERIFIED (live evidence file only, not re-run) |
| L-11 Vercel rewrite | built | PARTIAL (task unticked) |
| S-4 cold start spike | built | no task verdict in the audit |
| Tag contracts v1.0.0, sprint-1 audit remediation | in-progress | L-09 PARTIAL, tag does not exist |
| Demo rehearsal | in-progress | L-31 NOT STARTED |
| Deployed verification (lab) | review | L-30 PARTIAL |
| Instance from the real shop image | review | no single task verdict; live evidence not re-run |
| Deployed verification and ASVS (platform) | blocked | P-32 PARTIAL, waits on redeploy |
| 11 lab backlog stories in-review (tester login and C02 hint, audit of eleven challenges, catalogue fixes, modern shop UI, renumber bot ADR, results held until released, sequenced learner runs, shop events fit contract, candidate start route, learner console one challenge, time warnings) | in-review | they wait for the leader's confirmation, there is no audit verdict per story, and several belong to the lifecycle, shop and web work packages in progress |

## 4. Counts for the three task files after reconciliation

Ticked: Tanmay 22 of 31, Akshay 21 of 32, Sahil 29 of 32 (72 of 95). The audit's DONE-VERIFIED plus DONE-CLAIMED-UNVERIFIED count is 16+6, 17+4, 28+1 = 72. The two numbers agree.

## 5. What I could not verify (open for the leader)

- Rows marked `done` on code or audit evidence only, no test run by me: H-24 to H-27, H-30, H-36, H-56, H-92 (shop passes the harness per audit 5.1 T-04), H-45 to H-55 (event emitted in code, release gate 11/11 per audit), H-122, H-124, H-131, H-136, H-328 to H-330, H-333, H-336 to H-338, H-340, H-345 (code located by grep). H-103, H-109 and H-115 rely on live evidence files (`docs/assets/production-readiness/l29-*`, `l10-renewal-live.json`) that the audit did not re-run.
- Rows marked `superseded` because the owner is gone but whose point is arguably still backlog: H-100 (second SSH key), H-129 (where the dashboards run), H-137 and H-144 (scheduler and deployment flags, wiring F-02), H-145 (company-side deletion, F-09), H-351 (template settings, F-07). Their notes name the audit item; check that each is on a work package.
- `in-progress-wp` letters are my reading of the brief (a lifecycle and quotas, c deploy, d shop); the lead should confirm H-68, H-113, H-117 (c).
- Pending COMPAT approval rows (H-120) and the contracts tag (L-09) belong to the lead and are unchanged.
- The ticks of DONE-CLAIMED-UNVERIFIED tasks (L-10, L-12, L-14, L-15, L-24, L-29, P-17, P-19, P-22, P-23, T-13) stay ticked on the existence of evidence files or CI tests, not on a fresh run. P-22 and P-23 depend on Valkey tests that never run in CI.
- The story plans have no per-story evidence beyond the dev-log existence check; I did not re-read each plan's body.

## 6. Added by the lead (same day)
- Decision records: the lab records 0040 to 0042 were numbered like three platform records; renumbered 0090 to 0092, references updated, index rows added (also 0036 to 0039 and 0056).
- `scripts/check-records.mjs` (CI step): PRD ids vs traceability, handoff vocabulary, decision-record index and numbers, story plan status.
- D-103 closes OI-9, OI-29, OI-32, OI-36 (evidence already existed).
- CI: Valkey service, release gate. End-to-end test: `test_candidate_journey.py`.
- Not done, needs the leader: COMPAT rows pending for IF-2 2.1.0 (consumer), DB 2.2.0 (owner and target consumer); the `contracts-v1.0.0` tag; branch protection on main (GitHub answered 404, not protected); platform OpenAPI `info.version` label (1.0.0 vs 1.7.0) to be fixed with the next IF-1 version.
