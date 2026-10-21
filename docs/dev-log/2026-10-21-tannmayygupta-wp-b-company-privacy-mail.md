# Company administration, privacy workflows and real mail (work package B)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | `wp-b-company-privacy-mail` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | IF-1 1.8.0, ADR 0073, F-03, F-09, F-10, F-12 |

## Requirements covered
FR-PRV-08, FR-PRV-09, FR-ORG-03, FR-ADM-01, FR-ADM-05, FR-ACC-09, FR-ASM-04, FR-NTF-01, FR-NTF-03, FR-NTF-04; wiring audit F-03, F-09, F-10, F-12; role scenarios R-05, R-06, R-17, R-28, R-31, A-04, A-19, A-24, C-05, C-06, C-24, C-25, X-16, X-21. Story: `docs/bmad/initiative-lab/backlog/story-wp-b-company-privacy-mail.md`.

## Summary (plain language, 3-5 lines)
Services that were built but never reached by a route now have routes: a company decides candidate deletion requests, colleagues join and are removed, an admin deletes a company or raises its invite cap, and a person can change the address of an account. The mails the requirements promise are sent (withdrawal, deletion, time warnings, submission, release), and a production API or mail worker refuses to start unless real mail is configured.

## Why
The audits found built services without routes, mail types never enqueued, and a deployed stack that sent all mail to a catcher.

## What was built
See ADR 0073 (the decision record; it was written as 0072 in the work package and renumbered 0073 because 0072 is the shop decision on main): routes (IF-1 1.8.0), `notifications/triggers.py` with `MailingAttemptLog`, `notifications/config.py` (production mail check), the address-change flow and its migration `0018_email_changes`, `orgs/colleague_api.py`, `orgs/company_privacy_api.py`, guidance for wrong-address and unverified invites.

## How it works
Routes sit over the existing services; every decision is backend-enforced (role, CSRF, own company from the session scope, 404 for another company's data, rate limit). Mails are started by the attempt log events, so no caller has to remember them; a failing mail never fails the step.

## Files changed
`apps/api/src/vulnmart/{orgs,privacy,notifications,accounts,admin}/...`, `apps/api/migrations/versions/0018_email_changes.py`, `apps/api/tests/test_wp_b_*.py`, `contracts/api/platform/*` (IF-1 1.8.0, examples, bundle), `contracts/db/table-owners.yaml`, `packages/*` (generated), docs.

## Decisions made
ADR 0073: routes over existing services, mails started by the attempt log, a fail-closed production mail check. The `getCohort` operation was built here in the draft and is also in the plan of the recruiter web package: see Limitations.

## Tests
- Full `apps/api` suite in the package worktree before the merge with main: 2527 passed, 242 skipped, 1 xfailed, 3 failed. The 3 failures are the migration-head tests: the worktree was based on an older main without migration 0017, so `0018` had no parent; they pass after merging main (see the pull request checks).
- New files: `test_wp_b_routes.py`, `test_wp_b_mail_triggers.py`, `test_wp_b_mail_config.py`.
- Not run: real Brevo delivery (needs the key and a verified sender), live deployment.

## Evidence
Command output above and in the pull request checks.

## Problems met and how they were fixed
Migration 0017 and ADR 0072 collided with main; renumbered to 0018 and 0073. The agent that wrote the package hit its session limit twice; the lead finished the documents and integrated it.

## Security notes (vulnerable parts only)
None. Production mail check: the deployed compose still names Mailpit until work package C sets Brevo, the key file and the sender; with `VULNMART_ENV=production` the API and worker will not start without them.

## Limitations and follow-ups
No cancel mail (the engine writes no named event for a cancellation). Admin action on an escalated request is the mail and the audit entry only. The compose test is marked xfail until the compose change lands.