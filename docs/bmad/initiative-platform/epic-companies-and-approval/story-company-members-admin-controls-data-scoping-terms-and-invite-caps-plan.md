---
title: 'Company members, admin controls, data scoping, terms and invite caps'
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
  - '{project-root}/docs/adr/0014-organization-scoping-app-filter-and-rls.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** A company is one person; colleagues cannot join, nothing records the data-processing terms, there is no daily cap on invites, an admin cannot suspend a recruiter or delete a company, and a recruiter's requests do not carry their company, so the one central company filter has nothing to filter by (FR-ORG-03, 05, 06, 07, 08).

**Approach:** On `CompanyService`: colleagues join through the owner (a work domain is claimed by the first company; the next recruiter of that domain asks to join; the owner approves, rejects and removes), the admin controls (suspend, reinstate and delete companies; suspend and reinstate recruiters, each with a written reason and an audit entry), the data-processing terms (a versioned text pinned by a hash, accepted by the owner, a gate before inviting), the daily invite cap (a global setting and an admin's override per company) and the company in the session scope of a recruiter. Migration 0009. No route (story 5.3).

## Boundaries & Constraints

**Decisions (developer):** earlier OI-10 and OI-11 answers (2026-10-18) and "continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0049 (Proposed) for confirmation: the domain claim as a unique column of `organizations` (a lookup table was dropped: any change of `contracts/db/table-owners.yaml` counts as breaking in the contract rules), joining at signup, the terms pinned like the consent notice, the cap as a decision, the company set from the session, reuse of the approval-outcome mail for a colleague's outcome.

**Always:** Only the owner decides join requests and removes members, and only for an approved company; a removed member's sessions end at once; a free-webmail domain is never claimed or matched; a rejected or deleted company gives up its domain; every admin action has a written reason that is not copied into the audit entry; an acceptance of the terms is one record per company and version and names the text by its hash; the terms text and its version are pinned together; the gate for inviting is an active recruiter in an active company that accepted the current terms; reaching the cap is a decision, not an error; every table with an organisation column is scoped or listed on purpose.

**Never:** No HTTP route (story 5.3, a contract change); no change to `contracts/db/table-owners.yaml`; no removal of a deleted company's data (retention and deletion stories P-24, P-25); no invite and no counting of invites sent today (story P-20); no admin read of join requests, acceptances or members.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Second recruiter of a claimed domain | work address on the domain of an existing company | a join request to that company, no company made | a free-webmail address: its own company, nothing claimed |
| First signups of a new domain at once | 8 simultaneous | one company, seven requests | a lost race starts again as a colleague, never as "known address" |
| Request to join, existing recruiter | `request_join` | request for the company | other domain or free webmail: DomainMismatch; already member or open request: InvalidTransition |
| Owner decides | approve or reject | member added or request closed; colleague mailed; audit | company not active: InvalidTransition; another company's request: CompanyNotFound; not the owner: NotTheOwner |
| Remove member | owner, member | membership removed, sessions ended, audit | the owner themselves: InvalidTransition; unknown: CompanyNotFound |
| Admin suspends a recruiter | company, user, reason | account disabled, sessions ended, sign-in refused | not a member: CompanyNotFound; an admin account: NotAnAdmin |
| Delete company | any live state, reason | deleted, domain released, members' sessions ended | already deleted: InvalidTransition |
| Terms | owner of an active company | text with the company name and its hash | company not active: InvalidTransition; accept with another text: TermsStale |
| Invite gate | recruiter | company id | terms not accepted: TermsNotAccepted; not active: NotActiveRecruiter |
| Cap | admin sets 0 to 100000 or none | the company's cap; `check_invite_cap` says allowed and remaining | other values: InvalidInput |
| Recruiter's session | active membership | scope has the company (and the owner role for an owner) | no membership or removed: no company |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/orgs/service.py` (`CompanyService`), `terms.py` and `data/dpa-terms.txt`, `disposable.py` and `data/free-email-domains.txt`, `models.py` (`JoinRequest`, `DpaAcceptance`, `Organization.domain_claim` and `invite_cap`), `migrations/versions/0009_company_members_terms_and_caps.py` (single head 0009).
- `accounts/status.py` (`AccountStatusService`), `accounts/sessions.py` (`org_resolver`, `ResolvedSession.org_id`), `ports/settings.py` (`invite_cap_per_company_per_day`), `main.py` (the wiring).
- Tests: `test_company_members.py`, `test_company_members_postgres.py`, `test_companies.py` and `test_companies_postgres.py` (updated); stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] Migration 0009 and the models; the claim, join requests, owner decisions, member removal.
- [x] The terms (text, pin, acceptance, gate), the cap, the admin controls, `AccountStatusService`.
- [x] The company in the session scope; the rule that every table with an organisation column is scoped on purpose.
- [x] Unit tests on SQLite with the real scoped session, Postgres tests as the application role (policies, privileges, races), the real-stack test.

**Acceptance Criteria:**
- Given a recruiter with a colleague's address on a claimed domain, then the owner sees a request and only the owner decides it; a removed member is out at once.
- Given a company that has not accepted the current terms, then `invite_company_of` refuses it; after the owner accepts, an active colleague passes.
- Given an admin cap of N, then `check_invite_cap` allows up to N invites a day and says so clearly at the cap.
- Given a recruiter's session, then its scope carries their company and nothing of another company is readable (Python and Postgres).
- Given a suspended recruiter, then their sessions end at once and they cannot sign in until reinstated.

## Implementation Notes

- The terms were meant to be shown "at approval": the owner reads them after the admin approves (the company must be active to be shown them), and the gate holds until they accept.
- Counting invites sent today belongs to the invite story; `check_invite_cap` takes that number.
- A colleague of a company is in one company only for now.
- OI-11's second half (company-name verification beyond the email domain) was not asked and is not built.

## Plan Change Log

### 2026-10-18, during the build
The first design kept the domain claim in a new table `company_domains` (a domain and a company id, readable with no company in scope). `node scripts/check-contract-rules.mjs` failed on the change to `contracts/db/table-owners.yaml`: that file is a registered contract that the checker cannot compare, so any change must be declared BREAKING and raised by a major version with every consumer's approval, which is not proportionate for one row. The claim became a unique column of `organizations`, read through the admin-visible read of story P-18 with a system scope; the table, its row in the table-owners file and its changelog entry were removed.

## Review Triage Log

### 2026-10-18, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. Things that actually went wrong while building (no defect of behaviour on Postgres was found by this pass): finding 1 was found by the contract rules, findings 2 and 3 by failing tests.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The lookup table `company_domains` needed a change to the table-owners contract, which the contract rules treat as breaking | medium | design change | the claim is a column of `organizations`; see the Plan Change Log |
| 2 | Members of one company were listed in a random order when two joined in one second (SQLite ticks once a second) | low | patch | `created_at` comes from the service clock and the owner is listed first |
| 3 | The forced-RLS assertion of an older test named only two tables | low | patch (test) | it names the four company tables |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api`) -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
