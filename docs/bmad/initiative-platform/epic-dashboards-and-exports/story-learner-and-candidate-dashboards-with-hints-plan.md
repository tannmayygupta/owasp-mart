---
title: 'Learner and candidate dashboards with hints'
type: 'feature'
ticket: '1'
created: '2026-10-20'
status: done
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/prd/PRD.md'
  - '{project-root}/apps/lab-console/app.js'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** The dashboards app is a one-page tracer bullet: a learner cannot sign up, sign in, set up a second factor, pick a challenge, run an instance, unlock hints or read a write-up there, and a candidate cannot open an invite link, accept it, consent, run the assessment or see its state (FR-DSH-01, FR-DSH-04, FR-HNT-01, FR-HNT-02). The candidate side also has no routes: accepting an invite exists only as service code (P-21, "story 5.3").

**Approach:** Three candidate routes in IF-1 (`openInvite` `POST /api/v1/invites/open`, `acceptInvite` `POST /api/v1/invites/accept`, `listMyInvites` `GET /api/v1/me/invites`) over `InviteAcceptance` and a new `AssessmentService.my_invites`; then the Next.js pages, client components over the same-origin proxy, no new dependency: sign-in (with the second factor), sign-up, verify-email, forgot and reset password, account (password, authenticator set-up), the learner dashboard (catalogue, stars, tags, difficulty, hints, flags, write-up after solving, instance controls, live state) and the candidate dashboard (invitations, the invite page with consent, the attempt with hints only when the template allows them and their cost shown first, results only when `results_visibility` allows, withdraw, deletion request, who viewed my data).

## Boundaries & Constraints

**Decisions (developer):** 2026-10-20 "continue with the sprint 4 tasks one by one and merge it to main, and keep updating the tracker"; the candidate invite routes are added in P-26 ("Add them in P-26"); the recruiter-side routes stay for P-27 or story 5.3. OI-15 was answered 2026-10-18 (ADR 0050): a recruiter setting `results_visibility`, default `after_submit`.

**Always:** every page shows only the caller's own data (the API decides, the page never filters someone else's data out); server text goes on the page as text, never as HTML; no inline script or style (the CSP); the recovery codes and the otpauth address are shown once and never stored; the flag value never appears in the page after it is sent; an invite answer never contains the invite's address.

**Never:** no recruiter or admin pages (P-27, P-30); no exports (P-29); no new error code; no change to IF-2 (the lab's routes are Tanmay's: the server-side rule for `after_release` results is handed to him).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open a link | valid token | 200: company, title, time limit, expiry, state, hints, write-up rule; invite `opened` | malformed or unknown: 400 AUTH-TOKEN-INVALID |
| Open a closed link | expired, revoked | 200 with the state, the page says it is closed | n/a |
| Accept | signed in, verified, address matches | 200 with the attempt id; the consent screen follows | no session 401; closed 409; not a participant or address differs 409 with a fixed sentence |
| My invites | candidate | only invites bound to this account | none: empty list |
| Candidate hints | template hints off | no hint control | unlock refused by the lab (ATT-HINTS-DISABLED) |
| Candidate results | `after_release` | score and report not shown | server side: handoff to stream L |
| Learner | any | catalogue, own attempt, live instance state | 401 sends to sign-in |

</frozen-after-approval>

## Code Map

- API: `apps/api/src/vulnmart/assessments/invite_api.py` (new), `assessments/service.py` (`my_invites`, `describe`), `main.py`; IF-1, bundle, generated models and types, examples; tests `test_invite_api.py`.
- Web: `apps/web/app/**` pages, `apps/web/lib/api.ts` (fetch, CSRF, messages), `apps/web/lib/live.ts` (stream with snapshot fallback), `apps/web/app/globals.css`; tests under `apps/web/test/`.

## Tasks & Acceptance

**Execution:**
- [x] The three invite routes, the contract change and their tests (2026-10-20: 9 route tests, contract rules 18 PASS).
- [x] The web pages and their tests; the stack test (2026-10-20: 11 pages, web unit tests 15 of 15, the stack test 4 of 4 on real Docker).

**Acceptance Criteria:**
- Given a learner, then the dashboard shows the catalogue and their own attempt, the instance state updates live, hints unlock with no cost and the write-up shows after a solve.
- Given a candidate with an invite, then they open the link, accept, consent and see the attempt; with hints off no hint control appears; results follow `results_visibility`.
- Given another account, then no route or page shows the first account's invites or attempts.

## Plan Change Log

- 2026-10-20: the write-up after a solve (FR-DSH-01) had no route. The developer chose "I add it, tell Tanmay": P-26 adds `getWriteup` to IF-2 (1.2.0) in `lab/api.py`, owner only and only after the solve, with the mock, the lab check and a test; handoff H-354. This changes the plan's "no change to IF-2" for that one route. The server-side `after_release` rule is handoff H-355.
- 2026-10-20, later (merged): main brought Tanmay's IF-2 1.2.0 (pull request 54) with `write_up` on `listChallenges` for practice attempts; `getWriteup` was withdrawn before merging and the page reads his field. The plan's "no change to IF-2" holds again.

## Review Triage Log

### 2026-10-20, quick review (lens: quick), loop 1
Run in the main session, not by an independent subagent: the reviewer subagent does not survive this machine's session restarts.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The dashboard and the assessment page load the lab's catalogue together with the invites; a lab outage hides the invites (the assessment page says "not one of yours") | medium | patch | the catalogue (and the attempts on the dashboard) are optional |
| 2 | An already accepted invite (consented, started) still offers "Accept", which then fails | low | patch | the invite page points to the dashboard |
| 3 | A wrong flag shows "Something went wrong" | low | patch | the board says it is not the flag |
| 4 | `after_release` results are hidden only in the page; the lab still answers them | medium | defer | handoff H-355 (stream L, P-27) |
| 5 | The pages are not tested in a browser | medium | defer | dev-log limitation; OI-30 |

## Verification

**Commands:**
- `pytest apps/api/tests` with the Postgres and Valkey addresses set -- expected: pass
- `node --test apps/web/test/*.test.mjs`, `pnpm --filter @vulnmart/web typecheck` and `build` -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL

**Results (2026-10-20):** see the dev-log `docs/dev-log/2026-10-20-akshaay29-p26-learner-and-candidate-dashboards.md`: invite routes 9, write-up test, pins, contract rules 20 PASS, web 15 of 15, build of 11 routes, stack 4 of 4, full pytest in the dev-log.
