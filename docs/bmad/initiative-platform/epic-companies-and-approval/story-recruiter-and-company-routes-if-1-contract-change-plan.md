---
title: "Recruiter and company routes (IF-1 contract change)"
ticket: 3
status: built
---

# Recruiter and company routes (IF-1 contract change)

**Covers:** FR-ORG-01, FR-ORG-02. **After:** story 5.1 (P-18).

## Scope as found (2026-10-20)
The routes this story was planned for were built by later tasks, each with its own contract change:
- `signupRecruiter`, `getMyCompany`, `reapplyCompany` (and the terms): story P-27, IF-1 1.4.0, ADR 0059, `orgs/company_api.py`.
- `listPendingCompanies`, `decideCompany` (approve, reject, suspend, reinstate): story P-28, IF-1 1.2.0, ADR 0057, `admin/api.py`.

Each half was tested on its own (`test_company_api.py` with the real company service; `test_admin_api.py` with a recording stand-in), and the stack test approves through the service, not the route. What was left is the story's verify line: one test from signup to approval through the routes.

## Plan
1. Add `test_a_recruiter_signs_up_and_an_admin_approves_through_the_routes` to `apps/api/tests/test_company_api.py`: the real `CompanyService` behind both the recruiter routes and `AdminOps`; signup (202), the owner sees `pending_approval`, the admin (second factor done) lists the queue and approves (204, a second approval 409), the owner then sees `active`.
2. No contract change, no generated code, no migration.

**Commands:**
- `.venv/Scripts/python -m pytest apps/api/tests/test_company_api.py apps/api/tests/test_admin_api.py apps/api/tests/test_companies.py -q` -- result: 108 passed

**Results (2026-10-20):** as above; evidence `docs/assets/story-5-3-recruiter-and-company-routes/tests-2026-10-20.txt`.
