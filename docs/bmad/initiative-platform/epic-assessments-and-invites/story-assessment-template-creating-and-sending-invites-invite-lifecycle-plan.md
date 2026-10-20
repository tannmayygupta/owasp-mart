---
title: 'Assessment template, creating and sending invites, invite lifecycle'
type: 'feature'
ticket: '1'
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

**Problem:** A recruiter cannot define an assessment or invite anyone: there are no templates or invites, the outbox cannot address a person with no account, and nothing tracks an invite (FR-ASM-01, 02, 03).

**Approach:** Module `assessments`: templates (the fields and the fixed-on rules of FR-ASM-01), invites (a 256-bit token behind a company prefix kept only as a hash and bound to the address; the template's rules copied onto the invite; the daily cap and the terms checked; the mail through the outbox with the candidate's address sealed in the outbox row), and the lifecycle with cancel, revoke, resend, expiry and the moves the accepting story needs. Migration 0010. No route (story 5.3).

## Boundaries & Constraints

**Decisions (developer, 2026-10-18):** OI-14 answered: the write-up is a template setting, default optional. OI-15 answered: when a candidate sees results is a template setting, default right after submit. Earlier "continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0050 (Proposed) for confirmation: the sealed address in the outbox, the company-prefixed token, `sent` read from the mail, rules copied onto the invite, conditional moves, 256-bit tokens (OI-25), the research ranges as placeholders.

**Always:** Only the hash of a token is stored and the token is never logged; an invite is bound to one canonical address and has one live invite per template and address; the rules an invite was made with are the rules that run; the cap is counted and the invite inserted under a lock; every move is a conditional update from the state it starts from; every change is audited without the address or the token; a closed invite stays closed and a re-issue is a new invite; per-instance flags, evidence capture, the audit log and the consent screen cannot be switched off; the address of a person with no account is sealed in the outbox row and cleared when the mail has left.

**Never:** No HTTP route (story 5.3, a contract change); no accepting of an invite, consent or attempt (story P-21); no change to the `OutboxPort` protocol of stream L; no scheduler (P-24 calls `expire_all`); no limit on resends.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create a template | valid fields | template with defaults filled, version 1, audit | a bad field: InvalidInput naming it; a switch-off: `cannot_be_switched_off`; unknown member: `unknown_member` |
| Edit a template | valid fields | version raised; earlier invites keep their rules | another company's template: TemplateNotFound |
| Create an invite | active recruiter, terms accepted, under the cap | invite `created`, mail queued with the sealed address, audit | no terms: TermsNotAccepted; cap used: InviteCapReached; live invite exists: InviteExists; bad address: InvalidInput |
| Mail delivered | worker sends | outbox row sent and the address cleared; the invite reads `sent` | n/a |
| Resend | created, sent or opened | new token, old one dead at once, new mail, state `created` | consented or closed: InviteClosed |
| Cancel, revoke | created / sent, opened, consented | `cancelled` / `revoked` | wrong state: InviteClosed |
| Past its expiry | any read, `expire_due`, `expire_all` | `expired`, audited once | n/a |
| Link opened | `find_by_token` | the invite (closed ones show their state) | malformed, wrong prefix or secret: None |
| Two creators, creators at the cap, resend against revoke | concurrent | one invite; never past the cap; exactly one of resend and revoke wins | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/assessments/{models,tokens,service}.py`, `migrations/versions/0010_assessment_templates_invites_and_sealed_recipients.py` (single head 0010).
- `notifications/{models,service,worker}.py` (`to_address_sealed`, `to_address`, `address_opener`), `kernel/entrypoints/worker.py`, `accounts/fieldkeys.py` (`from_settings`), `main.py`, `infra/compose/compose.yaml` (the worker gets the field secret).
- Tests: `test_assessments.py`, `test_assessments_postgres.py`, `test_notifications_sealed.py`; stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] The sealed recipient address in the outbox and the worker.
- [x] Models, migration 0010, the token, templates and their validation.
- [x] Invites: create under the cap and the terms, list and read with the lazy parts, cancel, revoke, resend, expiry, `find_by_token` and `advance`.
- [x] Unit tests on SQLite, Postgres tests as the application role (RLS, privileges, races), the real-stack test with a real mail.

**Acceptance Criteria:**
- Given an active recruiter whose company accepted the terms, then they create a template and send an invite and the email arrives at an address with no account.
- Given the database, then it holds only the hash of the token and the sent outbox row holds neither the token nor the address.
- Given a resend, then the old link is dead at once and the new one works.
- Given an edited template, then invites already made keep their rules.
- Given the company's cap, then no invite is made past it, whatever runs at once.
- Given another company, then none of its templates or invites can be read or changed.

## Implementation Notes

- The first test of a resend against a revoke found a real race: the lazy `created -> sent` step wrote the state unconditionally, so a request that waited on a lock could overwrite a revoked invite with `sent` and then resend it. The step is now a conditional update and the invite is read again afterwards (see the Review Triage Log).
- The architecture's table `template_challenges` did not carry `org_id`; it does now, so the same central filter applies to it.
- `invites.id` is `i-` and 16 Base32 characters (IF-1 has no invite id yet).

## Plan Change Log

## Review Triage Log

### 2026-10-18, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. Things that actually went wrong while building: finding 1 was found by a test, finding 2 was noticed while writing the Postgres tests (before they ran), finding 3 by the first end-to-end runs.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The lazy `created -> sent` and expiry steps wrote state unconditionally; a resend racing a revoke could undo the revoke (1 in 12 runs of the new race test) | high | patch | conditional updates and a re-read; the race test passed 25 times in a row afterwards and its assertion is now strict |
| 2 | `invites.template_id` was `ON DELETE RESTRICT`, which refuses the cascade when a company is deleted | medium | patch | NO ACTION; a test deletes a company with templates and invites |
| 3 | The P-18 end-to-end test shared the domain `example.com` between runs, so after P-19 a second run asked to join the first run's company; and the P-20 test cancelled an invite whose mail had already left | low | patch (tests) | the P-18 test uses a domain of its own per run; the P-20 test revokes |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api`) -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
