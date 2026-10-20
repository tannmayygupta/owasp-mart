---
title: 'Accepting invites, re-invite after a fault and bulk invites'
type: 'feature'
ticket: '2'
created: '2026-10-18'
status: done
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/architecture/05-key-flows.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** An invited candidate cannot get from the link to an attempt: nothing opens the link, matches the verified address, binds the invite, puts the consent screen first, or creates the attempt and the candidate role after a grant; a recruiter cannot grant a re-invite after a fault; and 200 invites at once have no handling (FR-ASM-04, 05, 06).

**Approach:** `InviteAcceptance` (open the link, accept as a signed-in account whose verified address matches) and `InviteConsentTargets` (the invite side of the consent port: the consent first, a grant creates the attempt through the lab port with an id the invite handed out at binding and gives the candidate role, a decline closes the invite); `AssessmentService.reinvite` (a new generation that supersedes the old attempt), `create_invites` (bulk, per-address outcomes, the cap hands back the rest) and `purge_closed_tokens` (so the invite purge can see closed invites). Migration 0012. No route (story 5.3).

## Boundaries & Constraints

**Decisions (developer):** "continue automatically", branch, pull request and merge per task; no open question for this story in the PRD (FR-ASM-04 allows either of two ways to stop a different person using the link). Claude's choices, in ADR 0051 (Proposed) for confirmation: the verified address must match (not a bind-after-confirm), the attempt id handed out at binding, a template key per generation for the lab port, a re-invite counts against the cap, bulk stops at the cap and returns the rest, a proposed `attempt_id` argument on the lab port.

**Always:** only an active, verified participant whose canonical address equals the invite's can bind it, and the refusal never says what the invite's address is; binding is one conditional update; the consent record names the attempt id and no attempt exists in the lab before a grant; a decline closes the invite and creates nothing; every move is a conditional update and a request that lost a race to the same move goes on; a re-invite supersedes the old attempt in the same transaction as the new invite is made and a refusal leaves the old one as it was; a candidate reads only the invite bound to them and cannot change it; a bulk invite never loses an address; every change is audited without the address or the token.

**Never:** No HTTP route (story 5.3, a contract change); no registration or verification code of its own (the accounts module's); no change to the lab engine; no scheduler (P-24 calls `expire_all` and `purge_closed_tokens`); no real lab wiring in production (stream L).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open the link | any live token | invite `opened` (counts as delivered) | unknown or purged token: None |
| Accept | signed-in verified participant, same address | invite bound, attempt id given out; repeat gives the same id | other address: AddressMismatch; recruiter, admin, unverified, disabled: NotEligible; closed invite: InviteClosed(state); bound to another: InviteTaken |
| Consent grant | attempt in `consent` | invite `consented`, attempt created `ready` with that id, candidate role; repeat changes nothing | revoked meanwhile: nothing created |
| Consent decline | attempt in `consent` | invite `declined`, no attempt, no role | n/a |
| Re-invite | invite `consented` or `started` | new invite generation + 1 names the old attempt, old invite marked (revoked if consented), old attempt cancelled when the lab allows | other states or already superseded: InviteClosed; cap or terms refuse and change nothing |
| Plain invite for a started address | `started` invite exists | refused | AlreadyStarted |
| Bulk | up to 500 addresses | one invite and one mail each; skipped addresses with reasons; at the cap the rest is returned | empty, too many or wrong shape: InvalidInput `/emails` |
| Purge | closed invites | token hash emptied; the link opens nothing | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/assessments/{accept,service,models}.py`, `migrations/versions/0012_invite_binding_and_generations.py` (single head 0012).
- `privacy/targets.py` (`ConsentTarget.retention_days`), `privacy/consent.py`, `ports/attempts.py` and `ports/lab_fakes.py` (`attempt_id`), `accounts/directory.py` (`UserBrief.email_ci`), `kernel/db.py` untouched (the self-visible table list comes from the model), `main.py` (`create_app(attempts=)`, `app.state.invite_acceptance`).
- Tests: `test_invite_acceptance.py`, `test_invite_acceptance_postgres.py`; stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] Model and migration 0012 (binding columns, generations, `own_invite`), the self-visible guard for invites.
- [x] `InviteAcceptance` and `InviteConsentTargets`; the consent notice shows the invite's retention.
- [x] `reinvite`, `create_invites`, `purge_closed_tokens`, `AlreadyStarted`.
- [x] Unit tests with the real attempt engine, Postgres tests as the application role (policy, races), the real-stack test.

**Acceptance Criteria:**
- Given an invited candidate who registered and verified the same address, then they can accept, see the consent first, and a grant creates the attempt and the candidate role.
- Given a different verified address, then the link cannot be used.
- Given a decline, then the invite is `declined` and nothing else is kept.
- Given a re-invite, then a new attempt is possible, the old one is marked superseded and cancelled, and the candidate cannot start a second attempt on their own.
- Given 200 invites and a lower daily mail cap, then all are sent over time in order.
- Given the invite purge, then it can see expired invites and empty their tokens.

## Implementation Notes

- Eight simultaneous clicks on one consent found that the invite move was not idempotent under a race (the losers raised InviteClosed after the record was written). A request that loses the race to the same move now goes on.
- `UserBrief` carries the canonical address for this one caller (the address comparison).
- The lab engine allows one attempt per account and template, so later generations are given the template key `<template>~n` on the port call; stream L should replace it (H-141).

## Plan Change Log

## Review Triage Log

### 2026-10-18, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | Eight concurrent grants: the invite move raised InviteClosed for the losers after the consent record was written | high | patch | `_move` accepts the invite already being in the target state; the Postgres test passes 3 runs in a row |
| 2 | A bulk invite that stopped at the cap listed an address already created (a repeat later in the list) as remaining | low | patch | the remaining list excludes what was made or skipped; test added |
| 3 | The data inventory test only passed in a full run (it did not import the assessment models) | low | patch (tests) | the import is in the test |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api`) -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
