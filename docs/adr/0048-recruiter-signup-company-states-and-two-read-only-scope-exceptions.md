# 0048. Recruiter signup, company states derived from the company, and two read-only exceptions to the organisation scope

- **Status:** Proposed (the builder's design for the developer to confirm; the requirements fix the outcome; OI-10 and OI-11 were answered by the developer on 2026-10-18)
- **Date:** 2026-10-18
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-ORG-01, FR-ORG-02, FR-ORG-04, FR-ACC-10, NFR-EXT-01, OI-10, OI-11, ADR 0014

## Context
FR-ORG-02 asks for an admin approval queue that lists pending companies of every company with the owner's name and email domain. ADR 0014 makes every company table readable only with that one company in scope, in Python and in Postgres (row-level security, `org_id::text = current_setting('vulnmart.org_id')`), and the application role has no way around it. So the queue, and also the plain question "which company is this recruiter in" before any company is in scope, cannot be answered by the design as it stands. The architecture also draws a recruiter state machine and a company state machine; storing both invites disagreement. IF-1 has no recruiter or admin route.

## Options considered
1. **The admin queue:** a `BYPASSRLS` role for admin work / `SECURITY DEFINER` functions that trust a parameter / a read-only policy that the session enables for an admin scope with no company.
2. **"Which company am I in":** a copy of the membership in a table without row-level security / a policy that lets a person read the rows that name them.
3. **Recruiter state:** a stored column on the user / derived from the account and the company (the company is the source of truth).
4. **Disposable addresses:** none (FR-ACC-10 says they are blocked for recruiters) / a bundled list / an online service.
5. **Free webmail (OI-10):** block / allow with an extra admin check / allow. The developer chose: **allow, no extra check**.
6. **Re-applying (OI-11):** a waiting period / never / any time. The developer chose: **any time**.
7. **Routes:** add the recruiter and admin routes to IF-1 now (a contract change) / service level now, routes in a story of their own.

## Decision
- **Admin read:** migration 0008 adds the policy `admin_read` on `organizations` (`FOR SELECT`, when `vulnmart.admin` is `on`). The scoped session sets that setting only for an admin scope that acts for no company, and the Python guard lets exactly that scope read the tables registered with `org_scoped(..., admin_visible=True)` (only `organizations`) with no filter. It is a read: every write, and every decision, still needs the one company in scope (an admin acts "for" the company being decided). `org_members` and any table that holds candidate data are not admin-visible, so the privacy wall of FR-DSH-06 stands.
- **Own membership:** migration 0008 adds `own_membership` on `org_members` (`FOR SELECT`, `user_id = current_setting('vulnmart.user_id')`); the session always sets that setting from the scope, and the guard adds `user_id = scope.user_id` in Python for tables registered with `self_column`. A person with no company in scope therefore reads only their own membership, then reads their company with it in scope.
- **Recruiter state:** derived (`recruiter_state`): `unverified_email`, `pending_approval`, `active`, `rejected`, `suspended`, `deleted` from the account status, whether the address is verified and the company status. Only the company is stored, so the two machines cannot disagree. The invite gate is `active_company_of`: an active recruiter in an active company, else `NotActiveRecruiter` with the state.
- **Signup:** `CompanyService.signup_recruiter` reuses `AccountService.signup_account` (a hook refuses a disposable address; a second hook creates the company, its owner membership and the audit entry in the same transaction as the account and the verification mail). A known address gets the same answer as a new one and creates nothing. The new company is put in scope for the whole signup so the row-level security accepts its insert. Two recruiters of one domain each start their own company until story P-19 (joining).
- **Decisions:** `approve`, `reject` (a written reason of 1 to 500 characters, shown to the applicant and mailed), `suspend`, `reinstate` are conditional updates (`WHERE status = from`), so two admins deciding at once leave one decision and one mail; each is audited under the admin and the owner's pseudonym, and the audit entry never carries the reason text. `reapply` moves `rejected` to `pending` for the owner at any time.
- **Disposable list:** a bundled starter list written from memory (about 75 domains and their subdomains); it is not maintained and not verified, and says so in its header. Free webmail is not on it.
- **Routes:** none in this story. IF-1 has no recruiter, company or admin route; a route is a contract change with generated clients, mock and the owner's look, so it is story 5.3 of this epic (handoff H-138).

## Consequences
- The two exceptions are small and read-only, but they are exceptions to the one rule ADR 0014 states; a new table must opt in on purpose (`admin_visible`, `self_column`) and its policy must say the same. A bug in the opt-in is a data leak, which is why the registry is two tiny sets with a test that names them.
- The settings are set by the same code that sets the organisation, so an injection that can set one can set the others; this is the same trust boundary as before, not a new one.
- Until the routes exist nobody can sign up as a recruiter over HTTP; the signup, the queue and the decisions are exercised by tests and by running the service inside the API container.
- A disposable-domain list from memory misses most services. It satisfies the acceptance criterion for the well-known ones and must be replaced by a maintained list before launch.
- Anyone may create a company by signing up with any domain: the admin approval is the only gate (OI-10: no free-email check).
- Re-applying at any time lets a rejected applicant ask again at once; an admin sees each application and can reject again.

## Evidence
- `test_companies.py` (signup, states, queue, decisions, re-applying, the guard), `test_companies_postgres.py` (the policies and their limits as the application role, a company sees only itself, a person reads only their own membership, an admin reads but cannot write, eight simultaneous signups make one account and one company, eight admins deciding at once leave one decision and one mail, migration 0008 down and up).
- Real stack: a recruiter signs up inside the API container as the application role, verifies through the existing route, the queue lists the company, the approval activates it and mails the owner, a second decision is refused, the audit entries are under pseudonyms.
- OWASP ASVS access-control chapter and PostgreSQL row-level security documentation: **not re-read in this story.**
