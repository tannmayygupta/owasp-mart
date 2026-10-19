# 0055. Deletion requests: the 7-day undo window, the company's part, and the company-level view history

- **Status:** Proposed (the builder's design for the developer to confirm; the numbers 14 days and 7 days are placeholders from the requirements, OI-33's legal review is still open)
- **Date:** 2026-10-19
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-PRV-08, FR-PRV-09, FR-PRV-11, FR-PRV-10 (the audit entries), ADR 0047, 0050, 0051, 0054
- **Handoffs:** H-145

## Context
A learner can ask for their data to go (FR-PRV-08: learner requests go to VulnMart and run at once, with the undo window of FR-PRV-09). A candidate's assessment record belongs to the company that invited them, so a candidate's request goes to that company, which decides, and VulnMart then carries it out (FR-PRV-08); the company can also delete a candidate directly. Every deletion is held 7 days so it can be undone (FR-PRV-09), and a candidate can see which companies viewed or exported their data (FR-PRV-11). ADR 0054 left the pieces (the lab's erase, the consent schedule, the invite delete, the pseudonym forget, the scheduler) for this story to reuse. Questions: what a request is stored as, what the hold means for the account, how the company side works without routes, what "who viewed me" holds, and how errors are named.

## Options considered
1. **During the hold:** lock the account / leave it working.
2. **A candidate's request:** deleted at once / goes to the company, then a hold.
3. **Where the request lives:** the audit log / its own table.
4. **The view history:** read from the audit log / its own small table of company, action and time.
5. **Error codes:** a new `PRV` family in the registry / the existing `ATT-NOT-FOUND` and `ATT-INVALID-STATE`.

## Decision
- **One table `deletion_requests`** (migration 0015): kind `learner` or `candidate`, who asked, the attempt and company for a candidate, a status (`pending`, `approved`, `declined`, `cancelled`, `done`) and the dates. The application role may insert, select and update five columns that move a request on; it cannot change who asked or what for or delete a request. Two partial unique indexes give one open request per learner and one per candidate and attempt (two simultaneous clicks make one row). The row has no foreign key to `users`, so the job never fails on an account already gone.
- **A learner's request** is `pending` with `execute_after` = now + `consent_withdraw_undo_days` (7, the existing setting). The account keeps working during the hold (nothing is locked, so an undo has nothing to restore and a stolen session gains nothing it did not have). `DELETE /api/v1/me/deletion-requests/{id}` undoes it any time before the job runs. The job `deletion_requests` (hourly) runs what is due: the lab erases the practice attempts, the account goes (sessions, tokens, roles cascade), the audit pseudonym is forgotten. A learner who also took part in an assessment keeps the account until the company's data is gone (the rule of ADR 0054); that data is deleted by a candidate request.
- **A candidate's request** names one finished attempt of theirs (an attempt that is not over is refused; someone else's is "not found"). It is `pending` with `decide_by` = now + `deletion_decide_days` (14, a placeholder from RS-H). The company approves (`DeletionService.decide`: `approved`, the 7-day hold starts, the candidate can still undo) or declines (`declined`, nothing happens). A request nobody decides deletes nothing; after 14 days the job marks it escalated once and writes the audit entry `deletion.escalated` for the admins (the admin screens are P-28 and P-30; no email, OI-12 and OI-34). When the hold is over the job does what the retention job does for one attempt, in the same order and each step safe to repeat: the lab erases the attempt, the consent records are scheduled to go 12 months later (OI-37), the company's invite and the person's view history for that company are deleted.
- **The company** deletes a candidate directly with `DeletionService.company_delete` (no request, no wait; it settles an open request for the same attempt). The company's side (`for_company`, `decide`, `company_delete`) has **no routes**: the recruiter routes come with story 5.3, and each method acts only on its own company's requests and attempts (anything else is "not found"). Their authorisation is the caller's, as for every service of the recruiter side so far.
- **Who viewed me:** a small table `data_views` (company id and name, action `viewed` or `exported`, time) written by `ViewHistory.record`, which the recruiter dashboard (P-27) and the recruiter export (P-29) call. The same company doing the same thing to the same person within a day is one entry. The candidate reads their own with `GET /api/v1/me/data-views` and sees the company's name as it was, the action and the time, never a recruiter's name or anything else. The application role may insert, select and delete (the history goes with the person's data and after 12 months, `log_retention_months`) and never update. The full trail of who did what remains the audit log, which admins read under the break-glass rules (P-31).
- **Routes** (IF-1 0.x additions, all need a session, the two that change state need the CSRF header and are limited per account by `rate_deletion_per_user_per_day`): `createDeletionRequest`, `listMyDeletionRequests`, `cancelDeletionRequest`, `listMyDataViews`. A second open request, a request that is not open any more, an attempt that is not over and a learner request from an account that is not a learner are 409 `ATT-INVALID-STATE`; a request or attempt that is not yours is 404 `ATT-NOT-FOUND`. The registry has no deletion codes: the existing two are used instead of opening a new family (a contract change for every consumer); a `PRV` family is the cleaner design if the developer wants one.
- **Audit:** `deletion.requested`, `deletion.cancelled`, `deletion.approved`, `deletion.declined`, `deletion.learner_done`, `deletion.candidate_done`, `deletion.company_deleted`, `deletion.escalated`. A person's own entries carry their pseudonym (forgotten with the account); every company or job entry names the company and counts, never a person.

## Consequences
- A learner's data is gone 7 days after the request at the earliest and within an hour of that moment; an undo is a plain status change.
- A candidate whose company never decides is never deleted early; the retention rule (ADR 0054) still deletes the record when its time is up.
- A deletion after consent withdrawal (FR-PRV-09) is not a separate path: withdrawing consent is the candidate's request for the attempt. The `withdrawn` consent row stays unused; the record is scheduled for erasure with the data instead.
- No email confirms a decision or a deletion to the parties (FR-PRV-08 asks for one); the mail templates are a follow-up (FR-NTF-01 lists the types, OI-12).
- The view history is only as complete as the code that calls `ViewHistory.record`: the dashboards and exports of P-27 and P-29 must call it (H-145).
- The learner's account stays usable during the hold; if the developer wants access locked (or a banner shown) that is a small change in the session layer.

## Evidence
- `test_deletion.py` (25), `test_deletion_api.py` (16), `test_deletion_postgres.py` (6, as the application role).
- Real stack: see the dev-log.
- **Not verified:** the lawyer's view of the 7-day and 14-day periods (OI-33); the emails to the parties; a browser.
