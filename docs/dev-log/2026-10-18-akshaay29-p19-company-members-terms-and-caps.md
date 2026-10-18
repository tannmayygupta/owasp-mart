# Company members, admin controls, data scoping, terms and invite caps (P-19, story 5.2)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-3-akshay-3 / see the pull request |
| Status | Built and tested at service level. Not built: any HTTP route (story 5.3, a contract change), the invites and counting them (P-20), erasing a deleted company's data (P-24, P-25), the screens. Story 5.2 is `built`, awaiting the developer's confirmation |
| Report tag | company membership, admin controls, tenant isolation, data-processing terms, invite limits, BMAD cycle |

## Requirements covered
FR-ORG-03 (colleagues join through the owner), FR-ORG-05 (admin controls over companies and recruiters), FR-ORG-06 (the company in every recruiter's scope, the central filter), FR-ORG-07 (the data-processing terms), FR-ORG-08 (the daily invite cap). Related: ADR 0049 (new), ADR 0014 and 0048, handoffs H-138 (partly answered) and H-139 (new), OI-33 (the terms wording is unreviewed).

## Summary (plain language, 3-5 lines)
A recruiter who signs up with a work address on a domain that a company already holds now asks that company's owner to join instead of starting a second company; the owner approves, rejects or removes people, and a removed person is signed out at once. The owner accepts a short data-processing text before the company can invite, an admin can set how many invites a company may send a day, and an admin can suspend a recruiter (who is signed out immediately) or delete a company. Every recruiter's requests now carry their company, so what they can read is limited to it.

## Why
Company approval (P-18) made one-person companies. The invite stories (P-20, P-21) need colleagues, the terms, the cap, and a request scope that carries the company so the company wall of ADR 0014 works for real; the admin controls complete FR-ORG-05.

## What was built
- `orgs/service.py` (`CompanyService`): the domain claim and joining (`signup_recruiter` now joins or creates, `request_join`, `join_requests`, `approve_join`, `reject_join`, `members`, `remove_member`), `standing` for a colleague with a request, the admin controls (`delete_company`, `suspend_recruiter`, `reinstate_recruiter`, `reinstate` and the others now with reasons), the terms (`terms_for`, `accept_terms`), the gate `invite_company_of`, the cap (`invite_cap`, `set_invite_cap`, `check_invite_cap`), `membership_of` (the company of a person).
- `orgs/terms.py` and `data/dpa-terms.txt` (the draft terms, pinned to their version by a hash); `orgs/data/free-email-domains.txt` (43 domains from memory) and `is_free_email`.
- `accounts/status.py` (`AccountStatusService`: suspend and reinstate an account, ending its sessions); `accounts/sessions.py` (`org_resolver`, `ResolvedSession.org_id`, the owner role in the scope); `ports/settings.py` (`invite_cap_per_company_per_day`).
- Migration 0009: `join_requests` and `dpa_acceptances` (forced row-level security, the requester reads their own request, the acceptance is append-only for the application role), `organizations.domain_claim` (unique where not null) and `invite_cap`.
- `main.py` wiring; ADR 0049 (Proposed); handoff H-139; the plan of story 5.2.

## How it works
The first company of a work domain stores the domain in `domain_claim` (a unique partial index, so two simultaneous first signups cannot both win; the loser starts again as a colleague). A later recruiter on that domain gets a join request, which only the owner of an approved company can decide. A recruiter's session asks the company service for their active membership and carries that company in its scope, so the central filter and the row-level security apply to everything they read. The terms are rendered with the company name, hashed, and accepted by sending the hash back; the acceptance is one append-only record per company and version. The cap is a number (the admin's for the company, else the setting) and a pure check that the invite story calls with the count of today's invites. Suspending a recruiter disables the account and revokes its sessions in the same transaction.

## Files changed
- New: `orgs/terms.py`, `orgs/data/{dpa-terms,free-email-domains}.txt`, `accounts/status.py`, `migrations/versions/0009_company_members_terms_and_caps.py`, tests `test_company_members.py`, `test_company_members_postgres.py`, `docs/adr/0049-*.md`, the plan of story 5.2.
- Changed: `orgs/{service,models,disposable}.py`, `accounts/{sessions,service}.py` (no change to the service in this story beyond P-18's hooks), `ports/settings.py`, `main.py`, `test_companies.py`, `test_companies_postgres.py`, `test_kernel_settings.py`, `test_kernel_postgres.py`, `test_data_minimum.py`, `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/architecture/04-data-and-state.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: earlier OI-10 and OI-11 answers and "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0049 (Proposed) for confirmation: the domain claim as a unique column of `organizations`, joining at signup, the terms pinned like the consent notice, the cap as a decision function, the company set from the session, reuse of the approval-outcome mail for a colleague's outcome, deleting a company as a state change.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-19-members/`.
- New and changed tests: `test_company_members.py` 34 and `test_companies.py` 51 on SQLite with the real scoped session (joining, deciding, removing, the session scope, the terms, the cap, the admin controls, the rule that every table with an `org_id` is scoped or listed on purpose), `test_company_members_postgres.py` 14 and `test_companies_postgres.py` 13 as the application role (forced row-level security and its policy on every scoped table, privileges, the unique claim, 8 first signups of one new domain make one company and seven requests, 8 decisions on one request leave one member and one mail, 8 acceptances of the terms make one record, migrations 0009 and 0008 down and up).
- Full run of `pytest apps/api/tests` with the two containers: **2140 passed, 0 failed, 1 skipped** (469 s; the one skip is a Windows file-mode check in the lab tests) (`pytest-2026-10-18.txt`).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **24 of 24** (`platform-stack-e2e-2026-10-18.txt`), after `docker compose ... build api`, on a dev volume that already held 0008. The new test drives the service inside the API container as the application database role, with real login and session over HTTP: the first recruiter of a domain starts the company and claims it, the second asks to join, both verify their address, the admin approves the company, the owner accepts the colleague, the gate refuses until the owner accepts the terms, the cap is 50 and then the admin's 5, the colleague signs in over HTTP and the resolved session carries the company (and not the owner role), a suspension ends the session at once and refuses a new sign-in, reinstating restores it, removal and deletion work, and the audit entries are under pseudonyms with no reason text.
- `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL, 1 NOT-APPLICABLE (`contract-rules-2026-10-18.txt`; no contract file is changed). The text-hygiene, progress-page, dev and demo script tests: 70 of 70.
- NOT run: a browser or any route (none exists); anything on the VMs; CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-19-members/`: the test outputs.

## Problems met and how they were fixed
- My first design kept the domain claim in a new table `company_domains`; the contract rules then failed on the change to `contracts/db/table-owners.yaml` (a registered contract the checker cannot compare, so any change must be declared BREAKING and raised by a major version). I dropped the table, its table-owners row and its changelog entry and made the claim a unique column of `organizations`, read through the admin-visible read of P-18 with a system scope (recorded in the plan's change log and ADR 0049).
- Members of one company came back in a random order when two joined in the same second (SQLite's clock ticks once a second): `created_at` now comes from the service clock and the owner is listed first.
- A test of P-16/P-17 era still named two forced-RLS tables; it now names four.
- Edits made by script slipped twice (a replace that did not match and one that swallowed a line); each was caught by an import or a failing test and repaired with precise edits.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: only the owner decides joins and removals and a removed or suspended person loses the session at once; the company in the session scope makes the central filter work for recruiters (checked in Python and Postgres); two tests fail on a table with an `org_id` that is neither scoped nor listed on purpose, or that lacks forced row-level security; the claim is unique at the database; the terms are pinned to their version and the acceptance cannot be changed or deleted by the application role; the reason of an admin action is never copied into the audit log; a first-come domain claim and a free-webmail list from memory are weak and said to be.

## Limitations and follow-ups
- No HTTP route (story 5.3, a contract change). The cap is a decision function until P-20 counts invites; the cross-company test over assessments, invites and candidates comes with P-20 and P-21.
- A person is in one company; nothing checks that a domain belongs to the company named; the one admin approval is the only gate (OI-10, OI-11 as answered); OI-11's company-name verification was not asked.
- The terms wording and the free-webmail list are drafts from memory (OI-33).
- Deleting a company does not remove its data (P-24, P-25); the application role cannot delete `dpa_acceptances` or `join_requests` rows (H-136, H-139).
- OI-10, OI-11, OI-28 and OI-37 are answered but not yet in `initial.md`. ADRs 0040 to 0049 are Proposed.
- Remind: Excel, P-19 Done = Yes; confirm story 5.2 so it can move to `done`.
