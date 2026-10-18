# 0049. Colleagues join by a domain claim, pinned data-processing terms, an invite cap, and the company in the session scope

- **Status:** Proposed (the builder's design for the developer to confirm; the requirements fix the outcome)
- **Date:** 2026-10-18
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-ORG-03, FR-ORG-05, FR-ORG-06, FR-ORG-07, FR-ORG-08, NFR-EXT-01, OI-33, ADR 0014, ADR 0048

## Context
FR-ORG-03 says recruiters with a matching company email domain request to join a company and only the owner decides. A recruiter who is signing up has no company in scope, so nothing tells the signup which company (if any) holds their domain, and the row-level security of ADR 0014 hides every company from them. FR-ORG-06 wants the company filter applied in one central place for everything a recruiter reads, which needs the company in the scope of every request. FR-ORG-07 wants data-processing terms shown at approval and recorded before inviting, FR-ORG-08 a configurable daily invite cap, FR-ORG-05 admin control over companies and recruiters. IF-1 still has no route for any of it.

## Options considered
1. **Who holds a domain:** a lookup table of domain to company / a unique column on `organizations` read through the admin-visible read / a database function that bypasses row-level security.
2. **A recruiter who is not first:** a second company for the same domain / a request to join the company that holds it / refuse.
3. **Free webmail (gmail.com):** treated like any domain / never claimed and never matched.
4. **The terms:** a free-text page / a versioned text pinned to its version by a hash, like the consent notice.
5. **The invite cap:** a global setting only / a global setting with an admin override per company.
6. **The company in a request's scope:** each route looks it up / the session service sets it once from the person's active membership.
7. **Suspending a recruiter:** a flag on the membership / the account status (`disabled`), which already blocks sign-in and ends sessions.

## Decision
- **Domain claim:** `organizations.domain_claim` (migration 0009), unique where not null, so one company holds a work domain and two simultaneous first signups cannot both create it. It is empty for free webmail (a starter list from memory, `orgs/data/free-email-domains.txt`, with the same caveats as the disposable list), for a rejected company and for a deleted one, so a rejected or deleted company gives up its domain; applying again claims it back unless another company took it (then `InvalidTransition("domain_claimed")`). The service finds the holder with a system scope that may read the company directory (the admin-visible read of migration 0008); no new table and no change to `contracts/db/table-owners.yaml`: a first design with a lookup table was dropped because the contract rules treat any change of that file as a breaking change that needs a major version and every consumer's approval.
- **Joining:** at signup, if a company holds the domain of the work address, the new recruiter gets a join request to it instead of a company (the company name typed is ignored); `request_join` does the same for an existing recruiter with no company and refuses a different domain or free webmail (`DomainMismatch`). Only the owner lists and decides requests, and only for a company the admin has approved. Approval makes a `member`; the answer to the colleague is the existing outcome mail. The owner can remove a member, whose sessions end at once; the owner cannot remove themselves.
- **Race on the first claim:** the losing signup raises inside the account transaction and is started again once as a colleague, so a lost race is never answered like a known address.
- **Admin controls:** `suspend`, `reinstate` (both now need a reason), `reject`, `delete_company` (a state change that ends the members' access and releases the domain; removing its data is for the retention stories), and `suspend_recruiter` / `reinstate_recruiter` over a new `AccountStatusService` (the account status `disabled`: the person cannot sign in and every session ends at once; an admin account cannot be changed this way). Every action has a written reason that is never copied into the audit entry.
- **Terms:** `orgs/data/dpa-terms.txt`, a draft that no lawyer has reviewed (OI-33), pinned to its version by a hash (`TERMS_VERSION`, `TEMPLATE_HASHES`; the service refuses to start otherwise). The owner of an approved company reads it with the company name filled in and accepts it by sending back the version and the hash (a different text is `TermsStale`); the acceptance (`dpa_acceptances`: company, user, version, hash, time) is append-only for the application role, once per company and version. A new version means a new acceptance. `invite_company_of` is the gate for the invite stories: an active recruiter in an active company that accepted the current terms.
- **Cap:** the setting `invite_cap_per_company_per_day` (50, a placeholder) and `organizations.invite_cap` as an admin's override for one company (0 is a cap); `check_invite_cap(org, sent_today, wanted)` answers allowed or not with the remaining number, as a decision rather than an error, so the invite story can keep its pending list. Counting the invites sent today needs the invites, which are story P-20.
- **Session scope:** `SessionService` takes an `org_resolver` (the company service's `membership_of`); for a recruiter with an active membership every resolved session carries that company in its scope (and the owner role for an owner), so the one central organisation filter and the row-level security apply to everything they read. Participants and admins never get a company.
- **Join outcome mail:** reuses the template `org.approval_outcome` (its approved text says "your company has been approved"), because a new template changes the list that FR-NTF-01 names; a dedicated template is a follow-up.

## Consequences
- A recruiter's company is whoever signs up first for a work domain: nothing checks that the domain belongs to the company named, so the single admin approval is the only gate (OI-10, OI-11 as answered). A person who signs up first with a domain that is not on the free list (a small provider) holds it.
- One person is in at most one company for now (a membership that is `active`); changing company means being removed and asking again.
- The free-webmail list is a starter list: a missing provider can be claimed by its first user, whose company then receives requests from strangers who use that provider.
- The wording of the terms is a draft; accepting it records the hash of what the owner saw.
- Until the routes exist (story 5.3) none of this is reachable over HTTP; the session scope is.
- Rolling back migration 0009 drops the join requests, acceptances, claims and caps.

## Evidence
- `test_company_members.py` (joining, deciding, removing, the session scope, the terms, the cap, the admin controls, the rule that every table with an `org_id` column is scoped or listed on purpose), `test_company_members_postgres.py` (row-level security and forced RLS on every scoped table, privileges as the application role, the unique claim, eight first signups of one new domain make one company and seven requests, eight decisions on one request, eight acceptances of the terms), `test_companies*.py` updated.
- Real stack: a colleague joins through the owner, the terms gate the invite check, the cap applies, a suspended recruiter's session ends at once and a login is refused, removal and deletion, the audit entries under pseudonyms.
- OWASP ASVS access-control chapter and the lawyer's view of the terms: **not read and not verified** (OI-33).
