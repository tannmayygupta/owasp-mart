# 0073. Company administration, privacy workflows and real mail (work package B)

- **Status:** Accepted (confirmed by the leader on 2026-10-21: work package B instruction)
- **Date:** 2026-10-21
- **Deciders:** the leader (Tanmay) with Claude
- **Requirements:** FR-PRV-08, FR-PRV-09, FR-ORG-03, FR-ADM-01, FR-ADM-05, FR-ACC-09, FR-ASM-04, FR-NTF-01, FR-NTF-03, FR-NTF-04; wiring audit F-03, F-09, F-10, F-12; role scenarios R-05, R-06, R-17, R-28, R-31, A-04, A-19, A-24, C-05, C-06, C-24, C-25, X-16, X-21

## Context
The wiring and role-scenario audits of 2026-10-21 found services that were built and tested but never reached by a route, mail types that were never enqueued, and a deployed stack that
sent all mail to a catcher. Candidates could ask for deletion and nobody could answer; colleagues could ask to join and nobody could approve; an admin could not delete a company or raise a
company's invite cap; a person invited under another address had no way forward.

## Options considered
1. **Routes only.** Quick, but the mails and the production mail check stay open. Rejected: the audits name them as P0/P1.
2. **Call the mail triggers from each lab code path.** Many call sites in stream L code, easy to forget one. Rejected.
3. **Routes over the existing services, one mail trigger module, mails started by the attempt log, a production check at process start.** Chosen.

## Decision
- **Routes** (IF-1 1.8.0, no new error code; the registry codes already cover not found, invalid state and unknown route): company deletion requests (list, decide, delete a record now),
  colleagues (join requests, members, remove), the admin's company list, delete and per-company invite cap, the change of an account's address (a link to the new address, single use, the old
  address is told, every session ends). Every route is backend-enforced: role, CSRF, the caller's own company from the database and the session scope, rate limit on the decisions. A request,
  attempt, member or template of another company is 404 exactly as for one that does not exist. The cohort view route (`getCohort`) was also built in the draft of this package; the leader
  assigned the cohort board to WP-F, so the lead decides which of the two keeps the operation (see Consequences).
- **Mails** (`notifications/triggers.py`): consent withdrawn, time warning, submission (candidate and recruiter), results released, deletion requested (receipt for the person and notice for the
  company), deletion declined, deletion confirmed (a deleted account is told through its address sealed into the row and cleared when the mail has left), and the escalation after 14 days: the company
  is reminded and every active admin is told. The attempt flows cause their mails through `MailingAttemptLog`, a wrapper of the ids-only attempt log: the engine's clock, the withdrawal and the
  release route already append `time_warning_sent`, `session_submitted`, `attempt_withdrawn` and `results_released` there, so no caller has to remember. A failing mail never fails the step. There is
  no cancel mail: the engine writes no named event for a cancellation (only a state change) and no template exists; recorded as a follow-up.
- **Address guidance.** `acceptInvite` answers an unverified account with 403 AUTH-EMAIL-NOT-VERIFIED and a wrong-address account with 409 ATT-INVALID-STATE plus the Problem member `field`
  `/account/email`; the invite's address is never said. The client sends the person to `resendVerification` or `requestEmailChange`. `ProblemError` can now carry a fixed `field` pointer.
- **Production mail check** (`notifications/config.py`): with `VULNMART_ENV=production` the API process (`create_entry_app`) and the mail worker (`make_provider`) refuse to start unless the provider
  is Brevo, the key is present (value or file), the sender is a real address (not `.invalid`, `.example`), and no SMTP host names a catcher. The same rules read the deployed compose in a test.
- **Migration** `0018_email_changes` (renumbered from 0017, which `main` uses for learner runs): one pending change per account; only the hash of the link is stored.

## Consequences
- The deployed compose (`infra/deploy/platform.compose.yaml`, WP-C) still names Mailpit; with this change the API and worker will not start there until WP-C sets Brevo, the key file and the
  sender. The compose test is marked xfail with that reason and must lose the marker with WP-C's change.
- `getCohort` is in both this package's spec and WP-F's plan: whichever merges second drops one.
- Mail volume: a submission is two mails, an escalation one per company person plus one per admin. Brevo's free plan (300 a day) is the limit to watch (unverified for transactional mail).
- Admin action on an escalated request (A-19) is still only the mail and the audit entry; the company decides, or the admin contacts it.

## Evidence
- OWASP Forgot Password / change-email guidance: confirm the new address with a single-use, expiring token sent to the new address, notify the old one, end sessions (cheatsheetseries.owasp.org).
- RFC 9457 problem details: extension members such as `field` are allowed; ours is a fixed pointer, never a submitted value (NFR-SEC-03).
- Brevo transactional API as in ADR of P-09; the 300 a day limit for transactional mail is unconfirmed.
