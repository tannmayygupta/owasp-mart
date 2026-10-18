# Accepting invites, re-invite after a fault and bulk invites (P-21, story 6.2)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-3-akshay-5 / see the pull request |
| Status | Built and tested at service level. Not built: any HTTP route (story 5.3, a contract change), the candidate's and recruiter's pages (P-26, P-27), the real lab port in production (stream L, H-141), the scheduler that calls `expire_all` and `purge_closed_tokens` (P-24). Story 6.2 is `built`, awaiting the developer's confirmation |
| Report tag | invitations, consent before the attempt, binding by verified address, re-invite, bulk queue, BMAD cycle |

## Requirements covered
FR-ASM-04 (accepting an invite), FR-ASM-05 (re-invite after a fault), FR-ASM-06 (bulk invite handling). Related: ADR 0051 (new), ADR 0014, 0046 and 0050, handoffs H-141 (new), H-136 and H-140. No open question for this story.

## Summary (plain language, 3-5 lines)
A candidate who opens the invite link, registers and verifies the address the invite was sent to can now accept it: the consent screen comes first, and only after a grant is the attempt created and the candidate role added; a decline ends the invite and keeps nothing else. A different verified address cannot use the link. A recruiter can grant a re-invite after a fault (a new attempt, the old one cancelled and marked superseded), and can invite up to 500 people at once: every address gets its own invite, a daily cap hands back what it did not reach, and the mail provider's daily cap only delays mail, never loses it.

## Why
P-20 made invites but nothing could use them. The consent flow of P-16 had no attempt in state `consent` to work on, and a recruiter had no way to recover from a fault or to invite a cohort.

## What was built
- `assessments/accept.py`: `InviteAcceptance` (`open_link`, `accept`) and `InviteConsentTargets` (the invite side of the consent port: find the attempt by the id handed out at binding, grant creates the attempt and the candidate role, decline closes the invite).
- `assessments/service.py`: `bind_candidate`, `for_attempt`, `reinvite`, `create_invites` (with `BulkResult`), `purge_closed_tokens`, `AlreadyStarted`, `InviteTaken`; creation refactored into `_create`; the invite view carries `user_id`, `attempt_id`, `generation`, `supersedes_attempt_id`, `superseded_by`.
- Migration 0011: `invites.user_id`, `attempt_id` (unique when set), `generation`, `supersedes_attempt_id`, and the read-only policy `own_invite`; `invites` is a self-visible table of the session guard.
- `privacy/targets.py` and `privacy/consent.py`: the notice shows the invite's own retention; `ports/attempts.py` and `lab_fakes.py`: optional `attempt_id`; `accounts/directory.py`: `UserBrief.email_ci`; `main.py`: `create_app(attempts=)` and `app.state.invite_acceptance`.
- ADR 0051 (Proposed); handoff H-141; the plan of story 6.2.

## How it works
`accept` needs an active, verified participant account whose canonical address equals the invite's, then binds the invite with one conditional update and gives out the attempt id (`a-` and 16 Base32 characters). While the invite is `opened` its attempt is in `consent`; the consent record names that id. A grant moves the invite to `consented`, creates the attempt through the lab port with that id and the consent id, and adds the candidate role; every step can be repeated. A re-invite makes a new invite with the next generation, marks the old one superseded (revoked if it was only consented) in the same transaction, then cancels the old attempt through the lab port when it can. Bulk makes one invite per address in its own transaction and stops at the company cap, returning the rest. The purge empties the token hash of closed invites.

## Files changed
- New: `assessments/accept.py`, `migrations/versions/0011_invite_binding_and_generations.py`, tests `test_invite_acceptance.py`, `test_invite_acceptance_postgres.py`, `docs/adr/0051-*.md`, the plan of story 6.2, `docs/assets/p-21-invites/`.
- Changed: `assessments/{models,service}.py`, `accounts/directory.py`, `privacy/{targets,consent}.py`, `ports/{attempts,lab_fakes}.py`, `main.py`, `test_assessments_postgres.py`, `test_companies.py`, `test_data_minimum.py`, `test_kernel_postgres.py`, `test_kernel_settings.py`, `scripts/e2e/platform-stack.e2e.test.mjs` (the new test; the P-16 and P-20 tests no longer count rows of other tests), `docs/architecture/04-data-and-state.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0051 (Proposed) for confirmation: the verified address must match (not bind-after-confirm), the attempt id handed out at binding, the template key `<template>~n` per generation on the lab port, a re-invite counts against the cap, bulk stops at the cap and returns the rest, a 500-address limit, a proposed `attempt_id` argument on the lab port.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-21-invites/`.
- New tests: `test_invite_acceptance.py` 46 (SQLite, real scoped session, the real attempt engine behind the lab port: opening the link, every refusal of accept, the consent first, grant, decline, repeats, a failure between the invite move and the attempt, a revoke between decision and attempt, who finds the attempt, re-invites and generations, bulk including the cap over three days, the provider cap over four days in order, the purge), `test_invite_acceptance_postgres.py` 13 (as the application role: the policy and columns, a candidate reads only their own invite and cannot change it, the unique attempt id, the whole flow through row-level security, 8 accepts of one link, 2 accounts binding one invite, 8 re-invites of one invite make one, 8 clicks on one consent make one record, one attempt and one role, migration 0011 down and up; run 3 times in a row, 59 of 59 each time).
- Full run of `pytest apps/api/tests` with the two containers on the final code: **2304 passed, 0 failed, 1 skipped** (383 s; the one skip is a Windows file-mode check in the lab tests). An earlier full run had 2 failures I then fixed (the self-visible-tables test and the data inventory test, which both had to learn the new columns, and the inventory test now imports the assessment models).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **26 of 26** on the final code (`platform-stack-e2e-2026-10-18.txt`), after `docker compose ... build api`. The new test: a recruiter invites a candidate with no account; the link is opened (`opened`); the candidate and a stranger register and verify through the real API; the stranger is refused with an answer that does not name the invited address and nothing is bound; the candidate accepts, the consent notice shows the template's 60 days, the candidate role and the attempt exist only after the grant (a repeat changes nothing); a re-invite makes generation 2 that names the old attempt, revokes and marks the old invite, and the new link gives a new attempt id; a bulk invite at a cap of 4 makes two invites, reports a repeat and a bad address, hands back two, and the mails arrive through the real worker; the purge empties the revoked invite's token; no token and no address in the audit log. The lab port in that test is the real attempt engine inside the API process.
- Two earlier stack runs failed and are kept (`...run1-mfa-timing-failure...`, `...run2-rerun-safety-failures...`): run 1 failed only the older MFA test (a 401 where a 200 was expected: a time-step timing flake in a test that was not touched; it passed in the next runs); run 2 failed two older tests because they counted rows written by earlier runs and by the new test (all consent records, and all invite audit actions). Both now count only their own rows; the final run was on the same volume as the failed one, so it also shows the new test can be repeated.
- `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL, 1 not applicable (no contract file is changed). The text-hygiene, progress-page, dev and demo script tests: 70 of 70.
- NOT run: a browser or any route (none exists); anything on the VMs; CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-21-invites/`: the test outputs, including the two failed stack runs.

## Problems met and how they were fixed
- Eight simultaneous clicks on one consent exposed that the invite move was not idempotent under a race: the losers raised `InviteClosed` after the consent record was written. A request that loses the race to the same move now finds the invite already there and goes on; the Postgres test passes 3 runs in a row.
- A bulk invite that stopped at the cap listed a later repeat of an address it had already made as remaining; fixed with a test.
- The docker engine had lost the throwaway test containers; I recreated them from the command in `test_kernel_postgres.py`.
- The data inventory test only passed inside a full run (it did not import the assessment models); it does now.
- Several scripted edits to docs misapplied (one anchor, one README order); I checked the diff and repaired by hand.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: only a verified address equal to the invite's can bind it and the refusal never names the invited address; binding is one conditional update so two accounts cannot both take an invite; a candidate reads only the invite bound to them through a read-only policy (checked as the application role: no company, no update); no attempt exists before a consent grant; a recruiter or admin account cannot accept; a re-invite revokes a consented old invite in the same transaction so its link cannot start a second attempt; the token and the address stay out of the audit log.

## Limitations and follow-ups
- No HTTP route (story 5.3). In production no lab port is given to `create_app`, so the consent routes still answer 404 for every attempt id; stream L wires the real port (H-141). Later generations of a re-invite use a template key `<template>~n` until the port can supersede; the invite's rules are not yet passed to the attempt.
- Only the first way of FR-ASM-04 is built. A bulk list is limited to 500 addresses (a placeholder, OI-25).
- The retention sweep (P-24) and deletion (P-25) decide when `user_id`, `attempt_id` and `email_ci` leave closed invites. ADRs 0040 to 0051 are Proposed; the consent wording is a draft until legal review (OI-33).
- Remind: Excel, P-21 Done = Yes; confirm story 6.2 so it can move to `done`.
