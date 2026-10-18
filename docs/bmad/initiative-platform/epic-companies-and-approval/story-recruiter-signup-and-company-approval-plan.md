---
title: 'Recruiter signup and company approval'
type: 'feature'
ticket: '1'
created: '2026-10-18'
status: built
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/adr/0014-organization-scoping-app-filter-and-rls.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** A person cannot sign up as a recruiter, nothing creates a company, and nobody can approve or reject one (FR-ORG-01, FR-ORG-02); a disposable address is not blocked for recruiters (FR-ACC-10, FR-ORG-04).

**Approach:** `CompanyService` (module `orgs`): recruiter signup (account type `recruiter`, a pending company with the person as owner, the verification mail, all in one transaction, a disposable address refused), the recruiter state derived from the account and the company, the admin queue and the approve, reject, suspend and reinstate decisions (reasons, outcome mail, audit entries), applying again after a rejection, and the invite gate `active_company_of`. Two read-only exceptions to the organisation scope make the queue and "which company am I in" possible (migration 0008). No route: IF-1 has none.

## Boundaries & Constraints

**Decisions (developer, 2026-10-18):** OI-10 answered: free webmail is allowed with no extra check (disposable stays blocked). OI-11 answered: a rejected company may apply again at any time. Earlier: "continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0048 (Proposed) for confirmation: the admin-visible and self-visible read policies, the recruiter state derived from the company, the starter disposable list, service level now and the routes in story 5.3.

**Always:** One admin approval activates the company and its owner (no step per colleague); a rejection needs a written reason of 1 to 500 characters that the applicant sees; a decision is one conditional update, so two admins at once leave one decision and one mail; an admin acts for the one company being decided and reads other companies only through the directory policy; a known address gets the same answer as a new one and creates nothing; the audit entry is written in the same transaction as the change and never carries the reason text; the queue shows the owner's name and the domain, never the address.

**Never:** No HTTP route (story 5.3, a contract change); no colleague joining, terms, invite caps or the scope set from the session (story P-19); no admin read of `org_members` or of any table with candidate data; no waiting period before re-applying (OI-11); no extra check for free webmail (OI-10).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Recruiter signup | new work email, name, password, company | account (`recruiter`), pending company, owner membership, verification mail, audit `org.created` | disposable address: InvalidInput `/email` `disposable_email`; bad company name, name or password: InvalidInput with the field |
| Signup with a known address | any account | the same answer, an "already registered" mail, nothing created | n/a |
| Free webmail | gmail.com address | accepted like any other | n/a |
| Standing | recruiter | unverified_email, pending_approval, active, rejected (with the reason), suspended, deleted | a participant or unknown account: NotARecruiter |
| Queue | admin scope | pending companies oldest first: name, owner name, domain | not an active admin: NotAnAdmin |
| Approve | pending company | active, owner mailed, audit `org.approved` | not pending: InvalidTransition with the state; unknown: CompanyNotFound |
| Reject | pending company, reason | rejected with the reason, owner mailed with it, audit `org.rejected` | empty or over-long reason: InvalidInput |
| Suspend, reinstate | active, suspended | the other state, audit entries, no outcome mail | wrong state: InvalidTransition |
| Apply again | owner of a rejected company | pending again, reason cleared, audit `org.reapplied` | not rejected: InvalidTransition |
| Invite gate | any recruiter | the company id when active | NotActiveRecruiter with the state |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/orgs/service.py` (`CompanyService`, `recruiter_state`), `disposable.py` and `data/disposable-domains.txt`, `models.py` (the two opt-ins), `migrations/versions/0008_admin_reads_company_directory.py` (single head 0008).
- `kernel/db.py` (`ORG_ADMIN_VISIBLE`, `ORG_SELF_VISIBLE`, the two settings, the guard), `accounts/service.py` (`signup_account`), `accounts/directory.py` (`UserDirectory`), `accounts/roles.py` (`require_admin`), `main.py` (`app.state.companies`).
- Tests: `test_companies.py`, `test_companies_postgres.py`; stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] The guard and migration 0008 (admin directory read, own membership read), with tests of what they refuse.
- [x] Recruiter signup (hooks in `AccountService`), the disposable list, the states, the queue, the decisions, applying again, the invite gate.
- [x] Unit tests on SQLite with the real scoped session, Postgres tests as the application role (policies, races), the real-stack test.

**Acceptance Criteria:**
- Given a new recruiter, then a pending company exists and the recruiter is `unverified_email`, then `pending_approval` after verifying, then `active` after one admin approval, and then, and only then, passes the invite gate.
- Given a rejection, then the applicant sees the written reason in their standing and in the mail, and may apply again at any time.
- Given a disposable address, then no account, company or mail is made.
- Given a recruiter of company A, then company B's rows are invisible to them in Python and in Postgres.

## Implementation Notes

- An admin reading `organizations` with no company in scope is the only cross-company read; `org_members` stay company-only (an admin gets only their own membership, which is none).
- A person with no company in scope reads their own membership through the self-visible rule; the service then switches to the company scope to read the company, in a second transaction.
- The invite gate is a function today; the invite story (P-20) calls it.

## Plan Change Log

## Review Triage Log

### 2026-10-18, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. Things that actually went wrong while building (no defect of behaviour on Postgres was found by this pass): finding 1 was found by a failing test, findings 2 and 3 by the first end-to-end run.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | My test expected the guard to refuse an admin reading `org_members`; the self-visible rule instead gives an admin only their own rows (none) | low | patch (test) | the test now says what the rule does and why |
| 2 | The end-to-end test of story P-17 failed on the second run on a persistent dev volume (it counted every earlier run's shredded attempt) | low | patch (test) | it now looks at its own attempt id; the P-18 test uses fresh emails per run |
| 3 | A one-line mistake in a PowerShell edit mixed Python into a script and nothing ran; and a literal backslash-n ended up in a docstring of the migration | low | patch | repaired by precise edits before any run |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api`) -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
