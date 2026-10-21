# Tracker audit: records reconciled and checked (story 12)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | `wp-records-and-shop` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | L-30, L-09, D-102, D-103, tracker audit |

## Requirements covered
The tracker audit `docs/audit/2026-10-21-tracker-audit.md` (sections 3 to 8), story `docs/bmad/initiative-lab/backlog/story-records-reconciliation-and-record-checks.md`. Other work packages cover the lifecycle (a), company and mail (b), deploy (c), shop (d) and web (e).

## Summary (plain language, 3-5 lines)
The trackers and the traceability table now say what the code and the evidence say. A new check keeps requirements, handoffs, decision records and story plans from drifting apart again, and CI runs it. One new test walks a candidate from invite to released report through the real services. CI also runs the Valkey tests and the release gate now.

## Why
The audit found that the paperwork said "Not started" for features that run live, kept 88 handoffs open for people who are gone, used three decision-record numbers twice, and that CI never ran Valkey, browser or release-gate checks.

## What was built
- `docs/dev/HANDOFFS.md` (177 rows, one status vocabulary: 121 done, 36 superseded, 9 open, 11 in-progress by a work package; each changed row names its evidence), the three task files (one tick rule, one status line per task, 72 of 95 ticked), 11 target story plans set to done with evidence, `docs/audit/2026-10-21-records-reconciliation.md`.
- `docs/traceability.md`: one vocabulary (Done, Done-local, Built, Partial, Blocked-external, Decision-record), F1 to F11 from evidence, 14 rows added, ids spelled out.
- Decision records: the lab records 0040, 0041, 0042 are now 0090, 0091, 0092 (the platform records keep 0040 to 0042); references updated; index rows added for 0036 to 0039, 0056, 0090 to 0092.
- `initial.md` D-103 and four PRD open items closed (OI-9, 29, 32, 36).
- `scripts/check-records.mjs` and its test; `pnpm run records:check`; CI step.
- `apps/api/tests/test_candidate_journey.py`.
- CI: a Valkey service and `VULNMART_TEST_VALKEY_URL` in the api job; `node scripts/release-gate.mjs` in the exploit-runner job.

## How it works
`check-records` reads the PRD ids, the traceability file, the handoff table, the decision-record index and the story plans and prints one line per disagreement. The journey test uses the combined world of the privacy-wall tests (real company, invite, consent, lab runtime on the fake instance host) and the HTTP routes of the dashboards.

## Files changed
`scripts/check-records.{mjs,test.mjs}`, `package.json`, `.github/workflows/ci.yml`, `apps/api/tests/test_candidate_journey.py`, `docs/` (handoffs, task files, traceability, adr, bmad plans, audit, dev-logs with corrected ADR numbers, PRD), `initial.md`, `CHANGELOG.md`.

## Decisions made
D-103 (four open items closed by existing evidence). Renumbering the lab decision records to 0090 to 0092 (numbers far from the ones other work packages take). Rows of former developers were marked `superseded` where the point is backlog covered by an audit item, not "answered".

## Tests
- `node --test scripts/check-records.test.mjs` — 7 passed; `node scripts/check-records.mjs` — records: PASS.
- `uv run --offline --package vulnmart-api pytest apps/api/tests/test_candidate_journey.py` — 1 passed.
- `pytest` of `test_table_owners.py` and `test_lab_contract.py` — 191 passed (evidence for the contract sign-off, see below).
- Valkey-backed tests against a real Valkey 9.0.6 container: `test_live_hub.py`, `test_ratelimit.py`, `test_live_relay.py`, `test_live_api.py` — 136 passed.
- `node scripts/release-gate.mjs` — 11/11 challenge exploit tests pass on both builds (75 s).
- Not run: the Postgres-backed modules on this PC (the Postgres test containers were not running; CI has them); the CI jobs themselves until the pull request.

## Evidence
Command output above; `docs/audit/2026-10-21-records-reconciliation.md`.

## Problems met and how they were fixed
- My checker first demanded literal requirement ids; the traceability file used ranges. The ids were spelled out in the rows.
- The plan-status regex rejected single-quoted values; fixed.
- A noisy warning (done story without a dev-log naming it) was dropped: older dev-logs never named their story file.
- Marking the three `pending` COMPAT rows approved (IF-2 2.1.0 consumer, DB 2.2.0 owner, DB 2.2.0 consumer) was refused by the permission check as self-approval. They stay `pending`: the checks are green (191 passed, `api:check` clean, `apps/web` typecheck clean) and only the leader can close them.
- Setting the platform OpenAPI `info.version` to 1.7.0 needs a new IF-1 version entry and a registry edit; reverted. The label (1.0.0) still disagrees with the changelog (1.7.0); fix it with the next IF-1 change.
- The parallel work packages share one working directory; I worked in a separate git worktree.

## Security notes (vulnerable parts only)
None.

## Limitations and follow-ups
Open for the leader: close the three COMPAT rows; decide on the `contracts-v1.0.0` tag and on branch protection (GitHub reports none); the demo rehearsals (L-31) and the live items of L-08 and L-11 need the leader and the cloud accounts. Open for other packages: everything in the audit that is code in the lifecycle, company, mail, deploy, shop and web areas.