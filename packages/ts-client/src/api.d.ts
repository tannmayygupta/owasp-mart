// GENERATED from contracts/api/bundle/openapi.json (IF-1 and IF-2). Do not edit: run `node scripts/generate-api-code.mjs`.
export interface paths {
    "/api/v1/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Is the platform answering
         * @description Public. 200 when the API and its stores answer, 503 when one does not. The answer names no
         *     store and no host: only `ok` or `degraded`. The dashboards skeleton (P-07) uses it.
         */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign up as a learner
         * @description Public. Creates a learner account (FR-ACC-01) and sends a verification link by email (FR-ACC-02).
         *     Needs the declaration that the person is 18 or over (FR-PRV-13), recorded at signup. Answers 202
         *     with the same body whether or not the address already has an account, so the answer is not an
         *     oracle; an existing address gets an email that says so. A password that appears in a breach list is
         *     refused with 422 (FR-ACC-08). Rate limited per address and per email, 429 (FR-ACC-10). Whether a
         *     CAPTCHA token is needed is OPEN (OI-29): the field is optional and marked pending.
         */
        post: operations["createAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/accounts/verify-email": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Use an email verification link
         * @description Public. The token of the link. Single use and stored only as a hash (FR-ACC-02); using it twice,
         *     or after it expired (24 hours, placeholder), is 400 AUTH-TOKEN-INVALID. The answer does not tell
         *     which of the two it was.
         */
        post: operations["verifyEmail"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/accounts/verify-email/resend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send the verification link again
         * @description Public. 202 whatever the address is (no oracle). Rate limited, 429.
         */
        post: operations["resendVerification"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The current session
         * @description The signed-in user and a CSRF token for this session, so a reloaded page can continue. 401
         *     AUTH-SESSION-REQUIRED without a valid session.
         */
        get: operations["getSession"];
        put?: never;
        /**
         * Log in
         * @description Public. Email and password (FR-ACC-03). On success the platform sets the cookie
         *     `__Host-vm_session` (HttpOnly, Secure, SameSite=Lax, no Domain, a new session id) and answers 200
         *     with the session, whose `csrf_token` the browser keeps in memory and sends as X-CSRF-Token. An
         *     account that needs a second factor (every admin; a recruiter who turned it on, FR-ACC-07) gets
         *     200 with status `mfa_required` and a short-lived `mfa_ticket` instead, and no cookie yet; the
         *     browser then calls completeMfaLogin. A wrong email or password is 401 AUTH-INVALID-CREDENTIALS,
         *     the same for an unknown email. An address that is not verified yet is 403
         *     AUTH-EMAIL-NOT-VERIFIED (only after the password was right). Repeated failures are throttled with
         *     back-off, never a permanent lockout (FR-ACC-08): 429.
         */
        post: operations["createSession"];
        /**
         * Log out
         * @description Ends the session on the server at once; the old cookie no longer works (FR-ACC-03). The answer
         *     clears the cookie. The body is empty.
         */
        delete: operations["deleteSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/session/mfa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish a login with the second factor
         * @description Public (the first factor was already accepted; the ticket proves it). The authenticator-app (TOTP)
         *     code, or one recovery code. A wrong code or an expired ticket is 401 AUTH-MFA-INVALID. On success
         *     the same answer and cookie as createSession.
         */
        post: operations["completeMfaLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The signed-in user */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Change my profile
         * @description Self-service profile (FR-ACC-09). Today only the display name; an email change needs its own
         *     verification step and is added later. Members that are not in the body are left as they are.
         */
        patch: operations["updateMe"];
        trace?: never;
    };
    "/api/v1/me/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Change my password
         * @description The current and the new password (FR-ACC-09). A wrong current password is 401
         *     AUTH-INVALID-CREDENTIALS (the session stays). A new password in a breach list or too short is
         *     422. On success every other session of the user ends and the session id changes (FR-ACC-03).
         */
        post: operations["changePassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/mfa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start setting up an authenticator app
         * @description Gives the TOTP secret as an otpauth URI once (FR-ACC-07). The second factor is not active until
         *     confirmMfaEnrolment succeeds. Calling it again before confirming replaces the pending secret.
         *     409 when a second factor is already active.
         */
        post: operations["startMfaEnrolment"];
        /**
         * Turn the second factor off
         * @description A recruiter may turn TOTP off with a re-login (FR-ACC-07). The body holds the password. An admin
         *     cannot turn it off: 409. The session id changes.
         */
        delete: operations["disableMfa"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/mfa/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm the authenticator app
         * @description One code from the app activates the second factor and returns the recovery codes once (the only
         *     time they are shown). A wrong code is 401 AUTH-MFA-INVALID. The session id changes.
         */
        post: operations["confirmMfaEnrolment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/password-reset/request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ask for a password reset link
         * @description Public. 202 whatever the address is (FR-ACC-08: no oracle). The link is single use, stored only
         *     as a hash and expires (24 hours, placeholder). Rate limited, 429.
         */
        post: operations["requestPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/password-reset/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set a new password with a reset link
         * @description Public. The token of the link and the new password. A used or expired token is 400
         *     AUTH-TOKEN-INVALID. A weak or breached password is 422. On success every session of the user
         *     ends.
         */
        post: operations["confirmPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/consent/notice": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The consent text for an attempt
         * @description The stand-alone consent screen of FR-PRV-01 for a candidate attempt in state `consent`: the
         *     notice version, the exact text and its hash, the retention days shown and the company that
         *     decides how results are used. The text lists what is recorded and what is not. The attempt must
         *     be the caller's: another attempt is the same 404. An attempt that is not in state `consent` is 409
         *     ATT-INVALID-STATE.
         */
        get: operations["getConsentNotice"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/consent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Grant or decline consent
         * @description Writes an append-only consent record (FR-PRV-02). The request repeats the notice version and the
         *     hash of the text the person saw: a mismatch with the current notice is 409 (the screen is stale).
         *     `granted` moves the attempt on to `ready`; `declined` ends it (state `cancelled`). The agree box
         *     is not pre-ticked: the browser sends `granted` only after an explicit click. Withdrawal is a
         *     later route (P-25). What the record keeps and for how long is partly OPEN (OI-37).
         */
        post: operations["recordConsent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/consents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * My consent records
         * @description The caller's own records, newest first (FR-PRV-02). `has_more` says whether more exist.
         */
        get: operations["listMyConsents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/deletion-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * My deletion requests
         * @description The caller's own requests, newest first, with their status and dates (FR-PRV-08, the candidate sees the status of the request).
         */
        get: operations["listMyDeletionRequests"];
        put?: never;
        /**
         * Ask for my data to be deleted
         * @description A learner (`kind: learner`) asks for the practice data and the account to be deleted: the request is held 7 days and can be undone any time before (FR-PRV-09); nothing is
         *     locked meanwhile. A candidate (`kind: candidate`, with the `attempt_id` of a finished attempt of theirs) asks for the assessment record to be deleted: it goes to the company that
         *     holds it, which is asked to decide within 14 days (placeholder from RS-H, FR-PRV-08); an approved request waits the same 7 days, then VulnMart deletes it. A second open request of the
         *     same kind (and attempt), a request for an attempt that is not over, and a learner request from an account that is not a learner are 409 ATT-INVALID-STATE; an attempt that is
         *     not the caller's is 404. The registry has no deletion codes yet (ADR 0055).
         */
        post: operations["createDeletionRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/deletion-requests/{request_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Undo a deletion request
         * @description Stops an open request (pending, or approved and waiting) before it runs (FR-PRV-09). The answer is the request with status `cancelled`. A request that is not the caller's is 404; one
         *     that is already done, declined or undone is 409 ATT-INVALID-STATE.
         */
        delete: operations["cancelDeletionRequest"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/data-views": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Who viewed my data
         * @description Company-level view history of the caller's own data, newest first: the company, the action (`viewed` or `exported`) and the time (FR-PRV-11). Never a recruiter's name or anything
         *     about the person who looked; the same company doing the same thing within a day is one entry. `has_more` says whether more exist.
         */
        get: operations["listMyDataViews"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/invites/open": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open an invite link
         * @description The candidate opened the link of an invite (story P-26 over story P-21, FR-ASM-04): no session is needed, because the candidate may have no account yet. The invite becomes `opened`
         *     (a link that was opened was delivered) and the answer says what the assessment is: the company, the title, the time limit, how many challenges, the hints, write-up and results
         *     rules (OI-14, OI-15) and the expiry. A closed invite (expired, cancelled, revoked, declined) answers its state. The answer never contains the invite's address. A link that opens
         *     nothing (malformed, unknown, or emptied by the invite purge) is 400 AUTH-TOKEN-INVALID, as for the email links; opening is rate limited per visitor.
         */
        post: operations["openInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/invites/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept an invite
         * @description Binds the invite to the signed-in candidate (FR-ASM-04) and answers the `attempt_id` the consent screen is for (`getConsentNotice`, then `recordConsent`); the attempt is created
         *     when consent is granted. Repeating it for the same account answers the same attempt. A closed invite, an invite another account accepted, an account that cannot take an
         *     assessment (not an active, verified participant) and an account whose verified address is not the one the invite was sent to are one 409 ATT-INVALID-STATE: the answer must
         *     not say what the invite's address is, and the registry has no invite codes (ADR 0058).
         */
        post: operations["acceptInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * My invitations
         * @description The invites bound to the caller, newest first (FR-DSH-04): the company, the title, the state, the expiry, the rules the candidate needs to see, and the attempt id. Only the
         *     caller's own invites (the database policy `own_invite`); an account that accepted none gets an empty list.
         */
        get: operations["listMyInvites"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/recruiters": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign up as a recruiter
         * @description A recruiter and a pending company (or, when a company already claims the address's domain, a request to join it), and the verification mail (story P-27 over P-18,
         *     FR-ORG-01). No session is needed; the answer is 202 whether the address is new or known, as for `createAccount`, and the known address gets the "already registered"
         *     mail. A disposable address, a bad name or company name, or a weak password is 422. Rate limited per visitor and per address.
         */
        post: operations["signupRecruiter"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/company": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * My company's standing
         * @description Where the calling recruiter stands (FR-ORG-02): `unverified_email`, `pending_approval`, `active`, `rejected` (with the admin's reason), `suspended`, `deleted` or `none`,
         *     the company's name, whether the current data-processing terms are accepted, and whether the caller is the owner or a member. Only a recruiter's session; anyone else
         *     is answered 404 REQ-ROUTE-UNKNOWN.
         */
        get: operations["getMyCompany"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/company/reapply": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Apply again after a rejection
         * @description The owner of a rejected company applies again (OI-11: at any time); the company is pending again and the earlier reason is cleared. Another state is 409
         *     ATT-INVALID-STATE; a caller who is not the owner is 404 REQ-ROUTE-UNKNOWN. The body is empty.
         */
        post: operations["reapplyCompany"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/company/terms": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The data-processing terms to accept
         * @description The terms the owner of an active company accepts before the company can invite (FR-ORG-07): the version, the text and its SHA-256. Only the owner (others 404
         *     REQ-ROUTE-UNKNOWN); a company that is not active is 409 ATT-INVALID-STATE.
         */
        get: operations["getCompanyTerms"];
        put?: never;
        /**
         * Accept the data-processing terms
         * @description The owner accepts the version and text they were shown (both from `getCompanyTerms`); a different text is 409 ATT-CONSENT-STALE (read them again). Accepting again is
         *     204. The acceptance is recorded with the company, the user, the version and the time.
         */
        post: operations["acceptCompanyTerms"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/company/templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The company's assessment templates
         * @description The templates of the caller's company only (FR-ASM-01, FR-ORG-06). A company that is not active is 409 ATT-INVALID-STATE.
         */
        get: operations["listTemplates"];
        put?: never;
        /**
         * Make an assessment template
         * @description A template of the caller's company (FR-ASM-01): a title, any of the 11 challenges, and the rules (time limit 30 to 480 minutes, hints off or on with a cost of 0 to 100
         *     percent, resets, invite expiry, retention 30 to 365 days, write-up required or optional, when the candidate sees results, flag submissions per minute). A field left out
         *     takes its default; a value outside its range, or a field that cannot be switched off, is 422.
         */
        post: operations["createTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/company/templates/{template_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                template_id: string;
            };
            cookie?: never;
        };
        /**
         * One template
         * @description A template of the caller's company; another company's is 404 ATT-NOT-FOUND.
         */
        get: operations["getTemplate"];
        /**
         * Replace a template
         * @description Replaces every field (a field left out goes back to its default) and raises the version. Invites already sent keep the rules they were made with.
         */
        put: operations["updateTemplate"];
        post?: never;
        /**
         * Delete a template
         * @description A template that invites were made from is 409 ATT-INVALID-STATE.
         */
        delete: operations["deleteTemplate"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/company/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The company's invites and their candidates
         * @description The invites of the caller's company, newest first, with each one's state, dates and attempt id (the live monitor of FR-DSH-03 reads the attempt from the lab's reviewer
         *     routes). Filters: `state`, `template_id`. Never a practice attempt or anything outside the company.
         */
        get: operations["listCompanyInvites"];
        put?: never;
        /**
         * Invite one or more candidates
         * @description One address: the invite, or 409 ATT-INVALID-STATE (a live invite for it exists, or the company has not accepted the terms) or 429 REQ-RATE-LIMITED (the daily cap,
         *     FR-ORG-08). Several (up to 500, FR-ASM-06): 201 with what was created, what was skipped and why (`invalid`, `duplicate`, `exists`, `started`), and what was not tried
         *     because the cap ran out (`remaining`), so nothing is lost. Each invite mails its link.
         */
        post: operations["createInvites"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/company/invites/{invite_id}/actions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invite_id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resend, cancel, revoke or re-invite
         * @description `resend` mails a new link (the old one stops working); `cancel` closes an invite not yet accepted; `revoke` closes one already accepted; `reinvite` makes a new invite
         *     (a new attempt) after a fault (FR-ASM-05). A change that does not start from the invite's state is 409 ATT-INVALID-STATE; another company's invite is 404
         *     ATT-NOT-FOUND. Answers the invite after the change (for `reinvite`, the new one).
         */
        post: operations["actOnInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Export my data
         * @description The caller's own data as a zip of JSON and CSV (story P-29, FR-EXP-01, FR-EXP-02): the profile, the consent history, every attempt of theirs with its results,
         *     timings, hints and evidence requests, the companies that viewed or exported their data, and their deletion requests. No other person's data and no flag value
         *     (anything shaped like a flag in a captured request is replaced by `VM{redacted}`). Every export writes an audit entry (FR-EXP-04). The body is empty. Rate
         *     limited per account.
         */
        post: operations["exportMyData"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/company/exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Export one assessment's results
         * @description The results of one template of the caller's company as a zip of CSV and JSON (story P-29, FR-EXP-03; OI-27 answered by the developer on 2026-10-20: scores as
         *     CSV and JSON, no evidence): per candidate the invite and attempt state, the score of 1000, the times, the hints used, the open integrity flags and the points per
         *     challenge. Every export writes an audit entry (FR-EXP-04) and an `exported` entry in each candidate's view history (FR-PRV-11). Only a recruiter (others 404
         *     REQ-ROUTE-UNKNOWN); another company's template is 404 ATT-NOT-FOUND; a company that is not active is 409 ATT-INVALID-STATE.
         */
        post: operations["exportCompanyResults"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the audit log
         * @description The audit log in order (FR-ADM-07): entries after `after_seq`, optionally of one `action`; actor and subject are pseudonyms. Each read writes its own entry
         *     (`admin.audit_read`). `next_after_seq` is the cursor for the next page (null when this page was not full). Only an admin with a second factor.
         */
        get: operations["listAuditLog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/break-glass": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Break-glass sessions
         * @description Every break-glass session, newest first, with its admin, reason, window, reads and review (FR-ADM-03).
         */
        get: operations["listBreakGlassSessions"];
        put?: never;
        /**
         * Open break-glass access to a candidate's answers
         * @description Opens a 15-minute session (D-94) for one candidate attempt, for a written reason (20 to 500 characters). The other admins and the owner of the candidate's company
         *     are mailed at once. A learner's practice attempt, or an attempt that does not exist, is 404 REQ-ROUTE-UNKNOWN. The reason is kept with the session, not in the
         *     audit log.
         */
        post: operations["openBreakGlass"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/break-glass/{session_id}/attempt": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        /**
         * Read the attempt through an open session
         * @description The attempt's results, evidence (flag-shaped text redacted) and timeline, for the session's own admin while it is open; another admin is 404, a session that is
         *     over is 409 ATT-INVALID-STATE. Every read is recorded in the session and audited (`breakglass.read`).
         */
        get: operations["readBreakGlassAttempt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/break-glass/{session_id}/close": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close a session early
         * @description Only the session's own admin, while it is open; the body is empty.
         */
        post: operations["closeBreakGlass"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/break-glass/{session_id}/review": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Review a session that is over
         * @description The later review of FR-ADM-03, by an admin who is not the session's own, once the session is over (expired or closed); once only. Otherwise 409
         *     ATT-INVALID-STATE.
         */
        post: operations["reviewBreakGlass"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/companies/pending": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Companies waiting for approval
         * @description The approval queue (FR-ADM-01): the companies waiting for a decision, oldest first, with the owner's name and the domain of their address.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        get: operations["listPendingCompanies"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/companies/{org_id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve, reject, suspend or reinstate a company
         * @description One decision on a company (FR-ADM-01). `reject`, `suspend` and `reinstate` need a `reason`; its text is not copied into the audit log. The company's owner is mailed the outcome. A company that is not in a state
         *     the decision starts from (already decided) is 409; an unknown company is 404.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        post: operations["decideCompany"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search accounts
         * @description Accounts for user management (FR-ADM-02): name, address, type, status and roles, newest first, never a password or a hash. `q` matches part of the name or address, or a whole user id.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        get: operations["listUsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{user_id}/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lock, unlock, reset or delete an account
         * @description An action on one account (FR-ADM-02), audited. `lock` disables the account and ends its sessions; `unlock` enables it again; `reset_password` mails a reset link to the account's own address (an admin never sees
         *     or sets a password); `delete` erases a participant's practice data and account (an account that holds assessment data is locked instead, outcome `locked_instead`) or marks a recruiter's account deleted.
         *     `lock`, `unlock` and `delete` need a `reason`, whose text is not copied into the audit log. An admin account, and the admin's own, cannot be changed here: 409. The outcome says what happened.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        post: operations["actOnUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/attempts/{attempt_id}/force-stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Force-stop an instance
         * @description Destroys the instance of an attempt whatever its state (FR-ADM-04); the attempt keeps its state and clock; the owner is mailed. The answer says whether an instance was alive. Audited.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        post: operations["forceStopInstance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * All settings
         * @description Every setting with its current value, its default, whether an admin changed it, and the range a number may be set to (FR-ADM-05).
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        get: operations["listSettings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/settings/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Change a setting
         * @description Sets one setting (FR-ADM-05). The value has the type of the default; a number must be in its range (a candidate retention default outside 30 to 365 days is 422). Old and new value are audited.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        put: operations["updateSetting"];
        post?: never;
        /**
         * Return a setting to its default
         * @description Removes the admin's change of one setting (FR-ADM-05); audited.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        delete: operations["resetSetting"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/quotas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Instance quotas
         * @description The quota rows an admin set (FR-ADM-05, OI-21): a user's, a company's and the global one. A user's beats a company's, which beats the global one; with none the limit is one instance.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        get: operations["listQuotas"];
        /**
         * Set an instance quota
         * @description Inserts or changes one quota (FR-ADM-05); the lab enforces it from the next request. A global quota has no `scope_id`, a user quota a user id, a company quota the company's id. 0 stops a user or company. Audited.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        put: operations["setQuota"];
        post?: never;
        /**
         * Remove an instance quota
         * @description Removes one quota row; the next level applies (FR-ADM-05). `scope_id` is left out for the global quota. A quota that does not exist is 404. Audited.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        delete: operations["removeQuota"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/capacity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Capacity
         * @description Running instances, memory in use, queue depth (mails waiting, events not yet relayed) and failures (mails, jobs, instances) (FR-ADM-06). Counts and states only.
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        get: operations["getCapacity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Scheduled jobs and their last runs
         * @description Every scheduled job with its interval, its last run (status and a fixed summary, or the class of the error) and when it is next due (FR-PRV-18).
         *     Only an admin whose session has proved a second factor reaches this route; anyone else gets 404 REQ-ROUTE-UNKNOWN, the answer of a route that does not exist.
         */
        get: operations["listJobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/challenges": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The challenge catalogue
         * @description The eleven challenges with the facts that do not depend on a person: title, both OWASP tags,
         *     difficulty and tier (IF-7 content). Never a flag, a placement, a test path or a hint. The key is
         *     the IF-2 form `C03`; the catalogue file (IF-7) writes it `c03` and the API maps it. Progress per
         *     person is the lab's listChallenges.
         */
        get: operations["listCatalogue"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/challenges/{challenge_key}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                challenge_key: components["parameters"]["ChallengeKeyPath"];
            };
            cookie?: never;
        };
        /**
         * One catalogue challenge
         * @description The same facts as the list plus the CWE and ATT&CK ids. An unknown key is 404 ATT-CHALLENGE-NOT-FOUND.
         */
        get: operations["getCatalogueChallenge"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/attempts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * My attempts
         * @description The caller's own attempts, newest first, with their state: practice attempts as a learner and
         *     assessment attempts as a candidate. A recruiter's company never reads this list for a person; it
         *     reads candidate attempts through its own routes (later). `has_more` says whether more exist.
         */
        get: operations["listMyAttempts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The live stream (Server-Sent Events)
         * @description The events of IF-3 (contracts/domain-events) for the signed-in user, over SSE (FR-LIV-01). The
         *     audiences come from the session, never from the client (FR-LIV-05). `Last-Event-ID` resumes; an
         *     unknown or too old id gets one `stream.resync` event and the stream ends (the client then reloads
         *     the snapshot and opens a new connection). A heartbeat comment about every 15 seconds. Without
         *     `Last-Event-ID` only events published after the connection arrive. A `Last-Event-ID` that does
         *     not have the shape of an id is treated as an unknown one (one `stream.resync`, as in IF-3), not
         *     as an error. The answer is not buffered (X-Accel-Buffering: no).
         */
        get: operations["openLiveStream"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/live/snapshot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Everything a dashboard needs to start or restart the live view
         * @description The caller's attempts and instances as they are now (FR-LIV-04). The browser reads it before it
         *     opens the stream, after a `stream.resync`, and polls it when the stream keeps failing. The
         *     values are those of the events of IF-3.
         */
        get: operations["getLiveSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/live/ticket": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * A one-time ticket for a direct stream (PENDING spike S-14)
         * @description PENDING. Plan B of ADR 0006: if the Vercel rewrite buffers the stream (spike S-14), the browser
         *     asks for a one-time ticket and opens the stream on a second hostname with it. Until S-14 is
         *     decided the route stays in the draft and the dashboards use `GET /api/v1/live`. If plan A holds,
         *     this route is removed.
         */
        post: operations["createLiveTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/instances": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request a learner instance
         * @description Asks for an instance of the learner's practice attempt. Answers 202 with state `requested`; the
         *     state then advances on its own (poll the instance, or listen to the live stream). Candidate
         *     instances are created by the platform when the attempt starts, not through this route.
         *     409 INST-QUOTA-REACHED when the user already holds an instance (the numbers are OI-21).
         */
        post: operations["requestInstance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/instances/{instance_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                instance_id: components["parameters"]["InstanceIdPath"];
            };
            cookie?: never;
        };
        /** State, access and health of one instance */
        get: operations["getInstance"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/instances/{instance_id}/open": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                instance_id: components["parameters"]["InstanceIdPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Get the one-time URL that opens the instance in a new tab
         * @description Allowed while the instance is ready, active or idle and its access is open. Otherwise 409
         *     INST-NOT-READY. The URL carries a single-use ticket that expires after about a minute. The body is
         *     empty.
         */
        post: operations["openInstance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/instances/{instance_id}/reset": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                instance_id: components["parameters"]["InstanceIdPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reset the instance (new epoch, new flags)
         * @description Needs the body {"confirm": true}. Allowed in state ready, active or idle; otherwise 409
         *     INST-INVALID-STATE (also 409 when the instance is frozen or its attempt is not running). Answers 202: the epoch grows by one and the state is `resetting`.
         */
        post: operations["resetInstance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/instances/{instance_id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                instance_id: components["parameters"]["InstanceIdPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stop the instance
         * @description State becomes `stopping`, then `destroyed`. Answers 202 for a new stop and 200 when the instance
         *     is already stopping or destroyed. 409 INST-INVALID-STATE when the instance is frozen or its attempt is not running (for example after submit; the freeze is not undone). The body is empty.
         */
        post: operations["stopInstance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        /**
         * State and clock of an attempt
         * @description Readable by its owner and, for a candidate attempt, by a recruiter of the company that owns it. Answers 200 with the state also for a withdrawn or cancelled attempt (PROPOSAL, to confirm); a deleted attempt is 404.
         */
        get: operations["getAttempt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/start": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start the clock of a ready attempt (PENDING OI-22)
         * @description PENDING OI-22: whether the candidate presses Start or the clock starts when the instance becomes
         *     ready is open. Both outcomes are recorded in lab-api.md. This route exists for the first outcome;
         *     if the second is chosen it is removed. Allowed only in state `ready`; otherwise 409 ATT-INVALID-STATE.
         *     The body is empty.
         */
        post: operations["startAttempt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/submit": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit early (after a confirmation)
         * @description Needs the body {"confirm": true}. Allowed in state `running`; otherwise 409 ATT-INVALID-STATE.
         *     The attempt becomes `submitted`; the instance is frozen for the freeze period and then destroyed.
         */
        post: operations["submitAttempt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/withdraw": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Withdraw from an assessment (after a confirmation)
         * @description Needs the body {"confirm": true}. Only the owner of a candidate attempt may call it (FR-SES-10); a learner attempt answers 409 ATT-INVALID-STATE.
         *     Allowed in the states `ready`, `running` and `submitted` (an `expired` attempt is first moved on by the lab); `withdrawn` is answered 200 again (idempotent, the first deletion date stays);
         *     every other state is 409 ATT-INVALID-STATE. The instance is destroyed at once, the attempt becomes `withdrawn` and `delete_after` says when its data is
         *     deleted (the undo window, 7 days by default). Nothing is scored after a withdrawal. `undoWithdrawal` cancels the deletion inside the window.
         */
        post: operations["withdrawAttempt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/withdraw/undo": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Undo a withdrawal inside the undo window
         * @description The body is empty. Only the owner of a candidate attempt may call it. Allowed while the attempt is `withdrawn` and the scheduled deletion has not
         *     happened: `delete_after` becomes null and the attempt stays `withdrawn` (D-91: the instance is gone and the attempt is not resumed; the recruiter is
         *     told it was undone). A withdrawn attempt whose deletion is already null answers 200 again. 409 ATT-INVALID-STATE when the attempt is not
         *     `withdrawn`; 410 ATT-GONE when the window has closed.
         */
        post: operations["undoWithdrawal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/flags": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Paste a flag for one challenge
         * @description The answer is 200 with the `result` (correct or incorrect) and the
         *     `credit` (credited, held, none). A wrong value, a decoy, a value of another instance and a value of an earlier epoch all answer
         *     `incorrect`: the reason is never given to the submitter (no oracle), and each of them counts for the rate limit. The submitted text is never echoed in any answer and never stored;
         *     only the result and the challenge are kept. Allowed while the attempt is `running`, otherwise 409
         *     ATT-INVALID-STATE. More than 5 incorrect submissions for one challenge in 10 minutes are refused with
         *     429 ATT-FLAG-RATE-LIMITED and a Retry-After header, even for a correct value (the placeholder
         *     numbers are FR-ACH-01).
         */
        post: operations["submitFlag"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/score": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        /** Current score snapshot */
        get: operations["getScore"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/challenges": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        /**
         * Progress per challenge (milestone, solved, hints used)
         * @description Progress per challenge. Titles, tags and difficulty are catalogue data (IF-7) served by the platform.
         *
         *     A learner's practice run is sequenced (v1.3.0): the learner works on one challenge at a time, so the list holds only the challenges
         *     that have been reached (the ones solved or timed out and the current one) and each entry carries `state`, `title`, `tier` and the
         *     countdown fields. Challenges after the current one are not listed. `total` says how many challenges the run has and `current_key`
         *     names the one to work on. A company assessment is not sequenced: every challenge is listed and the optional fields are absent.
         */
        get: operations["listChallenges"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/challenges/{challenge_key}/begin": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
                challenge_key: components["parameters"]["ChallengeKeyPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Begin the current challenge and start its countdown
         * @description Only for a sequenced practice run (v1.3.0). Starts the countdown of the current challenge: Easy 20, Medium 40, Hard 60 minutes
         *     (the tier of the catalogue). Repeating the call changes nothing and answers the same entry. Until the challenge is begun no flag, hint
         *     or milestone counts for it. A challenge that is not the current one, and a run that is not sequenced, answer 404
         *     ATT-CHALLENGE-NOT-FOUND; an attempt that is not running, or a challenge that already ended (solved or out of time), answers 409
         *     ATT-INVALID-STATE. The body is empty.
         */
        post: operations["beginChallenge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The points on the learner's account
         * @description The best result per challenge over every practice run of the signed-in learner, so a challenge repeated in a new run never counts
         *     twice. `total_points` is shown out of 1000 on the same scale as the score of one run. A learner with no run gets zero everywhere.
         */
        get: operations["getMyProgress"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/challenges/{challenge_key}/hints": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
                challenge_key: components["parameters"]["ChallengeKeyPath"];
            };
            cookie?: never;
        };
        /**
         * The three hint levels of a challenge
         * @description The text of a level is null until it is unlocked. When the attempt has hints off the route answers
         *     404 ATT-HINTS-DISABLED, as does an unknown challenge key (ATT-CHALLENGE-NOT-FOUND).
         */
        get: operations["listHints"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/challenges/{challenge_key}/hints/{level}/unlock": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
                challenge_key: components["parameters"]["ChallengeKeyPath"];
                level: components["parameters"]["HintLevelPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Unlock one hint level
         * @description Repeating the call for an unlocked level answers 200 with the same hint and costs nothing more.
         *     Hints off: 404 ATT-HINTS-DISABLED. Attempt not running: 409 ATT-INVALID-STATE. Levels unlock in order (2 needs 1, 3 needs 1 and 2); an early level is 409 ATT-INVALID-STATE and nothing is unlocked. The body is empty.
         */
        post: operations["unlockHint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/evidence": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        /**
         * The captured requests of an attempt (redacted)
         * @description For a reviewer (a recruiter of the owning company for a candidate attempt, the owner for a learner
         *     attempt). Bodies are capped at 8 KiB and redacted before storage. Whether a candidate sees their own
         *     evidence is OI-15.
         */
        get: operations["listEvidence"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/integrity-flags": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        /**
         * Integrity signals of an attempt (evidence for a human)
         * @description Never an automatic fail (FR-ACH-06). Same readers as the evidence. A reader who is the owner of a learner attempt (not a recruiter)
         *     does not see the flags of type decoy or sharing, because they would tell the owner why a submitted value was not correct (the oracle rule of submitFlag).
         */
        get: operations["listIntegrityFlags"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/integrity-flags/{integrity_flag_id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
                integrity_flag_id: components["parameters"]["IntegrityFlagIdPath"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record the review decision on an integrity flag
         * @description accept: the evidence is judged fine (a held capture it points to is credited). reject: the evidence
         *     is judged a real problem (a held capture stays out of the score). One decision per flag; a second
         *     answers 409 ATT-INVALID-STATE. Who may decide is OI-38 (the mock allows a recruiter of the owning
         *     company only). The decision is audited by the platform.
         */
        post: operations["decideIntegrityFlag"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/report": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        /**
         * Per-candidate report
         * @description Score, time, per-challenge results and the number of open integrity flags. Same readers as the evidence.
         */
        get: operations["getReport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attempts/{attempt_id}/timeline": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        /**
         * Ordered list of what happened in an attempt
         * @description Sorted by the key (epoch, seq) of the event, oldest first, so a late event of an earlier epoch sits before the newer ones.
         *     Cursor-paged: pass `next_cursor` as `cursor` to get the entries after the last one already read. Entries are neither skipped
         *     nor repeated when a late event with a smaller key is stored between two page requests; such an event is shown only when the
         *     client reads again from the start (cursor left out). A cursor that is not one we made is 422 with field /query/cursor.
         */
        get: operations["getTimeline"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * Format: date-time
         * @description UTC to the second.
         */
        Timestamp: string;
        InstanceId: string;
        AttemptId: string;
        ChallengeKey: string;
        /** @description u- plus 16 Base32 characters. */
        UserId: string;
        /** @description k- plus 16 Base32 characters. */
        ConsentId: string;
        /** Format: email */
        Email: string;
        /**
         * @description At least 12 and at most 128 characters (a proposal, FR-ACC-08 leaves the quality rules to be tuned;
         *     see the open points). Never in a log or an answer. A password in a breach list is refused with 422.
         */
        Password: string;
        /** @description A link token, URL-safe, single use, stored only as a hash. */
        Token: string;
        /** @description The signed, session-bound CSRF token. */
        CsrfToken: string;
        /** @description A six digit authenticator code, or one recovery code (ten Base32 characters). */
        MfaCode: string;
        ServiceHealth: {
            /** @enum {unknown} */
            status: "ok" | "degraded";
        };
        AcceptedStatus: {
            /** @constant */
            status: "accepted";
        };
        VerifiedStatus: {
            /** @constant */
            status: "verified";
        };
        SignupRequest: {
            email: components["schemas"]["Email"];
            password: components["schemas"]["Password"];
            display_name: string;
            /**
             * @description The person declares to be 18 or over (FR-ACC-01, FR-PRV-13). Only `true` is accepted.
             * @constant
             */
            age_declaration: true;
            /** @description PENDING OI-29 (whether learner signup needs a CAPTCHA). Optional until decided. */
            captcha_token?: string;
        };
        EmailRequest: {
            email: components["schemas"]["Email"];
        };
        TokenRequest: {
            token: components["schemas"]["Token"];
        };
        LoginRequest: {
            email: components["schemas"]["Email"];
            password: string;
        };
        MfaLoginRequest: {
            mfa_ticket: components["schemas"]["Token"];
            code: components["schemas"]["MfaCode"];
        };
        MfaCodeRequest: {
            code: string;
        };
        PasswordConfirmRequest: {
            password: string;
        };
        ChangePasswordRequest: {
            current_password: string;
            new_password: components["schemas"]["Password"];
        };
        ResetPasswordRequest: {
            token: components["schemas"]["Token"];
            new_password: components["schemas"]["Password"];
        };
        UpdateMeRequest: {
            display_name?: string;
        };
        User: {
            user_id: components["schemas"]["UserId"];
            email: components["schemas"]["Email"];
            display_name: string;
            /**
             * @description The account types of the architecture (04 section 2.1). A participant acts as a learner on a practice attempt and as a candidate on an assessment attempt.
             * @enum {unknown}
             */
            account_type: "participant" | "recruiter" | "admin";
            email_verified: boolean;
            mfa_enabled: boolean;
            created_at: components["schemas"]["Timestamp"];
        };
        Session: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "authenticated";
            user: components["schemas"]["User"];
            csrf_token: components["schemas"]["CsrfToken"];
            /** @description When the session ends if nothing happens (30 minutes, admin 15; FR-ACC-04). */
            idle_expires_at: components["schemas"]["Timestamp"];
            /** @description When the session ends whatever happens (12 hours; FR-ACC-04). */
            absolute_expires_at: components["schemas"]["Timestamp"];
        };
        MfaRequired: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "mfa_required";
            mfa_ticket: components["schemas"]["Token"];
            mfa_ticket_expires_at: components["schemas"]["Timestamp"];
        };
        LoginResult: components["schemas"]["Session"] | components["schemas"]["MfaRequired"];
        MfaEnrolment: {
            otpauth_uri: string;
        };
        MfaRecoveryCodes: {
            recovery_codes: string[];
        };
        ConsentNotice: {
            attempt_id: components["schemas"]["AttemptId"];
            notice_version: string;
            notice_text: string;
            notice_text_sha256: string;
            retention_days_shown: number;
            company_name: string;
        };
        ConsentRequest: {
            attempt_id: components["schemas"]["AttemptId"];
            notice_version: string;
            notice_text_sha256: string;
            /** @enum {unknown} */
            decision: "granted" | "declined";
        };
        ConsentRecord: {
            consent_id: components["schemas"]["ConsentId"];
            attempt_id: components["schemas"]["AttemptId"];
            notice_version: string;
            /**
             * @description A withdrawal adds the value `withdrawn` (no route writes it yet; deletion requests, story P-25, delete the record instead).
             * @enum {unknown}
             */
            decision: "granted" | "declined" | "withdrawn";
            recorded_at: components["schemas"]["Timestamp"];
        };
        ConsentRecordList: {
            items: components["schemas"]["ConsentRecord"][];
            has_more: boolean;
        };
        /** @description d- plus 16 Base32 characters. */
        DeletionRequestId: string;
        /** @description A candidate request names the attempt; a learner request does not. */
        DeletionRequestCreate: {
            /** @enum {unknown} */
            kind: "learner" | "candidate";
            attempt_id?: components["schemas"]["AttemptId"];
        };
        DeletionRequest: {
            request_id: components["schemas"]["DeletionRequestId"];
            /** @enum {unknown} */
            kind: "learner" | "candidate";
            /**
             * @description A learner request stays `pending` until it runs; a candidate request is `pending` until the company decides, then `approved` (waiting) or `declined`.
             * @enum {unknown}
             */
            status: "pending" | "approved" | "declined" | "cancelled" | "done";
            requested_at: components["schemas"]["Timestamp"];
            attempt_id: string | null;
            company_name: string | null;
            decide_by: components["schemas"]["Timestamp"] | null;
            decided_at: components["schemas"]["Timestamp"] | null;
            execute_after: components["schemas"]["Timestamp"] | null;
            finished_at: components["schemas"]["Timestamp"] | null;
            can_undo: boolean;
        };
        DeletionRequestList: {
            items: components["schemas"]["DeletionRequest"][];
        };
        DataView: {
            company_name: string;
            /** @enum {unknown} */
            action: "viewed" | "exported";
            at: components["schemas"]["Timestamp"];
        };
        DataViewList: {
            items: components["schemas"]["DataView"][];
            has_more: boolean;
        };
        InviteTokenRequest: {
            /** @description The token of the invite link (the company prefix and the secret); never logged. */
            token: string;
        };
        InviteSummary: {
            /** @enum {unknown} */
            state: "created" | "sent" | "opened" | "consented" | "started" | "declined" | "expired" | "cancelled" | "revoked";
            company_name: string;
            title: string;
            expires_at: components["schemas"]["Timestamp"];
            time_limit_min: number | null;
            challenge_count: number;
            /** @enum {unknown} */
            hints_mode: "off" | "on";
            hint_cost_pct: number;
            writeup_required: boolean;
            /** @enum {unknown} */
            results_visibility: "after_submit" | "after_release";
        };
        MyInvite: {
            invite_id: string;
            attempt_id: components["schemas"]["AttemptId"] | null;
            /** @enum {unknown} */
            state: "created" | "sent" | "opened" | "consented" | "started" | "declined" | "expired" | "cancelled" | "revoked";
            company_name: string;
            title: string;
            expires_at: components["schemas"]["Timestamp"];
            time_limit_min: number | null;
            challenge_count: number;
            /** @enum {unknown} */
            hints_mode: "off" | "on";
            hint_cost_pct: number;
            writeup_required: boolean;
            /** @enum {unknown} */
            results_visibility: "after_submit" | "after_release";
        };
        MyInviteList: {
            items: components["schemas"]["MyInvite"][];
        };
        RecruiterSignupRequest: {
            email: components["schemas"]["Email"];
            password: components["schemas"]["Password"];
            display_name: string;
            company_name: string;
            captcha_token?: string;
        };
        CompanyStanding: {
            /** @enum {unknown} */
            state: "none" | "unverified_email" | "pending_approval" | "active" | "rejected" | "suspended" | "deleted";
            company_name: string | null;
            reason: string | null;
            terms_accepted: boolean;
            /** @enum {unknown} */
            role: "owner" | "member" | null;
        };
        CompanyTerms: {
            version: string;
            text: string;
            sha256: string;
        };
        TermsAcceptRequest: {
            version: string;
            sha256: string;
        };
        TemplateRequest: {
            title: string;
            challenge_keys: components["schemas"]["ChallengeKey"][];
            time_limit_min?: number;
            /** @enum {unknown} */
            hints_mode?: "off" | "on";
            hint_cost_pct?: number;
            reset_limit?: number;
            invite_expiry_days?: number;
            retention_days?: number;
            writeup_required?: boolean;
            /** @enum {unknown} */
            results_visibility?: "after_submit" | "after_release";
            flag_submissions_per_minute?: number;
        };
        Template: {
            /** Format: uuid */
            template_id: string;
            title: string;
            challenge_keys: components["schemas"]["ChallengeKey"][];
            time_limit_min: number;
            /** @enum {unknown} */
            hints_mode: "off" | "on";
            hint_cost_pct: number;
            reset_limit: number;
            invite_expiry_days: number;
            retention_days: number;
            writeup_required: boolean;
            /** @enum {unknown} */
            results_visibility: "after_submit" | "after_release";
            flag_submissions_per_minute: number;
            version: number;
            updated_at: components["schemas"]["Timestamp"];
        };
        TemplateList: {
            items: components["schemas"]["Template"][];
        };
        InvitesRequest: {
            /** Format: uuid */
            template_id: string;
            emails: string[];
        };
        InviteActionRequest: {
            /** @enum {unknown} */
            action: "resend" | "cancel" | "revoke" | "reinvite";
        };
        CompanyInvite: {
            invite_id: string;
            /** Format: uuid */
            template_id: string;
            email: string;
            /** @enum {unknown} */
            state: "created" | "sent" | "opened" | "consented" | "started" | "declined" | "expired" | "cancelled" | "revoked";
            attempt_id: components["schemas"]["AttemptId"] | null;
            generation: number;
            superseded_by: string | null;
            expires_at: components["schemas"]["Timestamp"];
            created_at: components["schemas"]["Timestamp"];
            sent_at: components["schemas"]["Timestamp"] | null;
            opened_at: components["schemas"]["Timestamp"] | null;
            consented_at: components["schemas"]["Timestamp"] | null;
            started_at: components["schemas"]["Timestamp"] | null;
            closed_at: components["schemas"]["Timestamp"] | null;
            time_limit_min: number | null;
            /** @enum {unknown} */
            hints_mode: "off" | "on";
            hint_cost_pct: number;
            /** @enum {unknown} */
            results_visibility: "after_submit" | "after_release";
        };
        CompanyInviteList: {
            items: components["schemas"]["CompanyInvite"][];
        };
        InvitesResult: {
            created: components["schemas"]["CompanyInvite"][];
            skipped: {
                email: string;
                /** @enum {unknown} */
                reason: "invalid" | "duplicate" | "exists" | "started";
            }[];
            remaining: string[];
            cap: number | null;
        };
        CompanyExportRequest: {
            /** Format: uuid */
            template_id: string;
        };
        AuditEntry: {
            seq: number;
            at: string;
            actor: string;
            action: string;
            subject: string | null;
            details: Record<string, never>;
        };
        AuditEntryList: {
            items: components["schemas"]["AuditEntry"][];
            next_after_seq: number | null;
        };
        BreakGlassRequest: {
            attempt_id: components["schemas"]["AttemptId"];
            reason: string;
        };
        BreakGlassReviewRequest: {
            note: string;
        };
        BreakGlassSession: {
            session_id: string;
            admin_id: string;
            admin_name: string;
            attempt_id: components["schemas"]["AttemptId"];
            org_id: string;
            reason: string;
            started_at: components["schemas"]["Timestamp"];
            expires_at: components["schemas"]["Timestamp"];
            closed_at: components["schemas"]["Timestamp"] | null;
            reads: Record<string, never>[];
            reviewed_by: string | null;
            reviewed_at: components["schemas"]["Timestamp"] | null;
            review_note: string | null;
            /** @enum {unknown} */
            state: "open" | "over" | "reviewed";
        };
        BreakGlassSessionList: {
            items: components["schemas"]["BreakGlassSession"][];
        };
        BreakGlassRead: {
            session_id: string;
            attempt_id: components["schemas"]["AttemptId"];
            expires_at: string;
            results: Record<string, never>;
            timeline: Record<string, never>[];
        };
        PendingCompany: {
            org_id: string;
            name: string;
            owner_name: string;
            owner_email_domain: string;
            applied_at: components["schemas"]["Timestamp"];
        };
        PendingCompanyList: {
            items: components["schemas"]["PendingCompany"][];
        };
        CompanyDecisionRequest: {
            /** @enum {unknown} */
            decision: "approve" | "reject" | "suspend" | "reinstate";
            reason?: string;
        };
        AdminUser: {
            user_id: components["schemas"]["UserId"];
            display_name: string;
            email: string;
            /** @enum {unknown} */
            account_type: "participant" | "recruiter" | "admin";
            /** @enum {unknown} */
            status: "active" | "disabled";
            roles: ("learner" | "candidate")[];
            email_verified: boolean;
            created_at: components["schemas"]["Timestamp"];
            last_login_at: components["schemas"]["Timestamp"] | null;
        };
        AdminUserList: {
            items: components["schemas"]["AdminUser"][];
        };
        UserActionRequest: {
            /** @enum {unknown} */
            action: "lock" | "unlock" | "reset_password" | "delete";
            reason?: string;
        };
        UserActionResult: {
            /** @enum {unknown} */
            outcome: "locked" | "unlocked" | "reset_sent" | "deleted" | "locked_instead";
        };
        ForceStopResult: {
            attempt_id: components["schemas"]["AttemptId"];
            instance_stopped: boolean;
        };
        AdminSetting: {
            name: string;
            value: number | boolean | string;
            default: number | boolean | string;
            overridden: boolean;
            minimum: number | null;
            maximum: number | null;
        };
        AdminSettingList: {
            items: components["schemas"]["AdminSetting"][];
        };
        SettingUpdateRequest: {
            value: number | boolean | string;
        };
        Quota: {
            /** @enum {unknown} */
            scope: "user" | "org" | "global";
            scope_id: string | null;
            max_instances: number;
        };
        QuotaList: {
            items: components["schemas"]["Quota"][];
        };
        QuotaRequest: {
            /** @enum {unknown} */
            scope: "user" | "org" | "global";
            scope_id?: string | null;
            max_instances: number;
        };
        Capacity: {
            instances: {
                running: number;
                reported: number;
                failed: number;
            };
            /** @description Null when this process has no lab to ask. */
            memory: {
                capacity_mb: number;
                used_mb: number;
                health: string;
            } | null;
            queue: {
                emails_waiting: number;
                events_unpublished: number;
            };
            failures: {
                emails_failed: number;
                jobs_failed: number;
                instances_failed: number;
            };
        };
        JobStatus: {
            name: string;
            interval_seconds: number;
            last_started_at: components["schemas"]["Timestamp"] | null;
            last_finished_at: components["schemas"]["Timestamp"] | null;
            /** @enum {unknown} */
            last_status: "running" | "succeeded" | "failed" | null;
            last_detail: string | null;
            last_success_at: components["schemas"]["Timestamp"] | null;
            next_due_at: components["schemas"]["Timestamp"];
        };
        JobStatusList: {
            items: components["schemas"]["JobStatus"][];
        };
        Owasp: string;
        CatalogueSummary: {
            challenge_key: components["schemas"]["ChallengeKey"];
            title: string;
            /** @description The OWASP Top 10 2021 category, or null when the challenge has none (IF-7). */
            owasp_2021: components["schemas"]["Owasp"] | null;
            owasp_2025: components["schemas"]["Owasp"];
            difficulty: number;
            /** @enum {unknown} */
            tier: "Easy" | "Medium" | "Hard";
        };
        CatalogueChallenge: {
            challenge_key: components["schemas"]["ChallengeKey"];
            title: string;
            owasp_2021: components["schemas"]["Owasp"] | null;
            owasp_2025: components["schemas"]["Owasp"];
            difficulty: number;
            /** @enum {unknown} */
            tier: "Easy" | "Medium" | "Hard";
            cwe_primary: string;
            attack: string[];
        };
        CatalogueList: {
            items: components["schemas"]["CatalogueSummary"][];
            has_more: boolean;
        };
        AttemptSummary: {
            attempt_id: components["schemas"]["AttemptId"];
            /** @enum {unknown} */
            mode: "learner" | "candidate";
            /**
             * @description The ten attempt states of the architecture (04 section 10.1); the same as IF-2 and IF-3.
             * @enum {unknown}
             */
            state: "invited" | "consent" | "ready" | "running" | "submitted" | "reported" | "withdrawn" | "expired" | "cancelled" | "deleted";
            instance_id: components["schemas"]["InstanceId"] | null;
            created_at: components["schemas"]["Timestamp"];
            deadline_at: components["schemas"]["Timestamp"] | null;
        };
        AttemptSummaryList: {
            items: components["schemas"]["AttemptSummary"][];
            has_more: boolean;
        };
        InstanceSummary: {
            instance_id: components["schemas"]["InstanceId"];
            attempt_id: components["schemas"]["AttemptId"];
            /**
             * @description The ten instance states of IF-5 (identical in IF-2 and IF-3).
             * @enum {unknown}
             */
            state: "requested" | "provisioning" | "starting" | "ready" | "active" | "idle" | "resetting" | "stopping" | "destroyed" | "failed";
            /** @enum {unknown} */
            access: "open" | "frozen" | "closed";
            /** @enum {unknown} */
            health: "unknown" | "healthy" | "unhealthy";
            epoch: number;
            /** @description An INST-* code while the state is failed, otherwise null. */
            error_code: string | null;
        };
        LiveSnapshot: {
            server_time: components["schemas"]["Timestamp"];
            attempts: components["schemas"]["AttemptSummary"][];
            instances: components["schemas"]["InstanceSummary"][];
        };
        LiveTicket: {
            ticket: components["schemas"]["Token"];
            expires_at: components["schemas"]["Timestamp"];
        };
        /**
         * @description The error body of IF-8 (contracts/errors/problem.schema.json), copied here so the fragment is
         *     self-contained; scripts/check_platform_contract.py fails when the two differ. RFC 9457 members
         *     type, title and status plus code, request_id and, for 422, field or errors. Closed.
         */
        Problem: {
            /** @description urn:vulnmart:error: plus the code. */
            type: string;
            /** @description The registry's fixed generic text for the code. */
            title: string;
            status: number;
            code: string;
            request_id: string;
            /** @description One JSON Pointer to the offending field (empty string for the whole body). */
            field?: string;
            /** @description For 422 with several problems: one entry per offending field. The detail is a fixed generic text and never repeats the submitted value. */
            errors?: {
                pointer: string;
                detail: string;
            }[];
        };
        /** @description Proposal: g- plus 16 Base32 characters. */
        IntegrityFlagId: string;
        /** @description Proposal: e- plus 16 Base32 characters. */
        EvidenceId: string;
        /**
         * @description Opaque. base64url (no padding) of a text that holds the direction (f, forward) and the key (epoch, seq) of the last
         *     entry already read. Clients must not build or change one. A cursor that is not one of ours is 422 with field /query/cursor.
         */
        Cursor: string;
        /**
         * @description The instance state machine, identical to IF-5 (FR-INS-07). Only the orchestrator writes it.
         * @enum {unknown}
         */
        State: "requested" | "provisioning" | "starting" | "ready" | "active" | "idle" | "resetting" | "stopping" | "destroyed" | "failed";
        /**
         * @description Identical to IF-5.
         * @enum {unknown}
         */
        Access: "open" | "frozen" | "closed";
        /**
         * @description Identical to IF-5.
         * @enum {unknown}
         */
        Health: "unknown" | "healthy" | "unhealthy";
        /**
         * @description The attempt state machine (architecture 04 section 10.1).
         * @enum {unknown}
         */
        AttemptState: "invited" | "consent" | "ready" | "running" | "submitted" | "reported" | "withdrawn" | "expired" | "cancelled" | "deleted";
        /** @enum {unknown} */
        AttemptMode: "learner" | "candidate";
        /**
         * @description Best milestone reached; none, M1 found, M2 working exploit evidence, M3 flag captured.
         * @enum {unknown}
         */
        Milestone: "none" | "M1" | "M2" | "M3";
        /**
         * @description What the submitter is told. Only two answers exist: `correct` and `incorrect`. A wrong value, a decoy,
         *     a value of another instance and a value of an earlier epoch all answer `incorrect`, so the answer
         *     cannot be used as an oracle (a probe learns nothing about what a wrong value was). The detailed reason is
         *     kept on the server for the integrity review and is never sent to the submitter.
         * @enum {unknown}
         */
        FlagResult: "correct" | "incorrect";
        /**
         * @description Code of a failed instance, `INST-` plus upper-case words (for example INST-HEALTH-TIMEOUT), the same
         *     form as IF-5 and the registry. This is not the code of a problem answer; see Problem.
         */
        ErrorCode: string;
        RequestInstanceRequest: {
            /** @enum {unknown} */
            kind: "learner";
        };
        ConfirmRequest: {
            /** @constant */
            confirm: true;
        };
        /** @description What the browser may know of an instance. Closed on purpose; no host, address, flag or key. */
        Instance: {
            instance_id: components["schemas"]["InstanceId"];
            attempt_id: components["schemas"]["AttemptId"];
            state: components["schemas"]["State"];
            access: components["schemas"]["Access"];
            health: components["schemas"]["Health"];
            epoch: number;
            /** @description Set while the state is failed, otherwise null. */
            error_code: components["schemas"]["ErrorCode"] | null;
            requested_at: components["schemas"]["Timestamp"];
            ready_at: components["schemas"]["Timestamp"] | null;
            expires_at: components["schemas"]["Timestamp"] | null;
            updated_at: components["schemas"]["Timestamp"];
        };
        OpenTicket: {
            /** @description One-time URL on the instance host (architecture 03 section 3). Single use. The ticket is payload.signature (two base64url parts joined by a dot, contracts/edge/gate-ticket.md section 2). */
            url: string;
            expires_at: components["schemas"]["Timestamp"];
        };
        Attempt: {
            attempt_id: components["schemas"]["AttemptId"];
            mode: components["schemas"]["AttemptMode"];
            state: components["schemas"]["AttemptState"];
            hints_enabled: boolean;
            instance_id: components["schemas"]["InstanceId"] | null;
            started_at: components["schemas"]["Timestamp"] | null;
            deadline_at: components["schemas"]["Timestamp"] | null;
            submitted_at: components["schemas"]["Timestamp"] | null;
            frozen_until: components["schemas"]["Timestamp"] | null;
            /** @description Optional. Present only while the attempt is `withdrawn` (the end of the undo window when the deletion is scheduled, null once the withdrawal was undone). Absent in every other state. */
            delete_after?: components["schemas"]["Timestamp"] | null;
            /** @description The server clock; the browser timer is cosmetic (FR-SES-02). */
            server_time: components["schemas"]["Timestamp"];
        };
        FlagSubmissionRequest: {
            challenge_key: components["schemas"]["ChallengeKey"];
            /** @description The pasted text. Never echoed, never stored. */
            flag: string;
        };
        FlagSubmissionResult: {
            challenge_key: components["schemas"]["ChallengeKey"];
            result: components["schemas"]["FlagResult"];
            /**
             * @description credited for a correct value that passed the activity check, held when it did not (FR-ACH-02), none otherwise.
             * @enum {unknown}
             */
            credit: "credited" | "held" | "none";
        };
        ChallengeScore: {
            challenge_key: components["schemas"]["ChallengeKey"];
            best_milestone: components["schemas"]["Milestone"];
            /** @description A capture waits for a human decision and is not counted. */
            held: boolean;
            hints_used: number;
            /** @description Net points after hint cost (FR-SCR-01). */
            points: number;
        };
        Score: {
            attempt_id: components["schemas"]["AttemptId"];
            score: number;
            computed_at: components["schemas"]["Timestamp"];
            per_challenge: components["schemas"]["ChallengeScore"][];
        };
        ChallengeProgress: {
            challenge_key: components["schemas"]["ChallengeKey"];
            best_milestone: components["schemas"]["Milestone"];
            solved: boolean;
            held: boolean;
            hints_used: number;
            /** @description False when the attempt has hints off. */
            hints_available: boolean;
            /** @description Optional. What the challenge is about, in a few plain words (the catalogue text; never a flag). */
            brief?: string;
            /** @description Optional. How to begin, for example the demo account to sign in with and where to look. The accounts are documented demo accounts of the lab shop, not real credentials. */
            start?: string;
            /** @description Optional. Present only for the owner of a practice attempt once the challenge is captured (M3) or timed out; never in an assessment. The weakness and the fix. */
            write_up?: {
                vulnerable: string;
                fix: string;
            };
            /**
             * @description Optional (a sequenced practice run only, v1.3.0). `ready`: the current challenge, not begun. `active`: begun, the countdown runs.
             *     `solved`: captured (or held for review). `expired`: the time ran out; nothing counts for it any more.
             * @enum {unknown}
             */
            state?: "ready" | "active" | "solved" | "expired";
            /** @description Optional (sequenced run). The catalogue title of the challenge. */
            title?: string;
            /**
             * @description Optional (sequenced run). The tier of the catalogue; it sets the time (Easy 20, Medium 40, Hard 60 minutes).
             * @enum {unknown}
             */
            tier?: "Easy" | "Medium" | "Hard";
            /** @description Optional (sequenced run). The time the challenge has once begun. */
            time_limit_seconds?: number;
            /** @description Optional (sequenced run). When the challenge was begun; null before. */
            opened_at?: components["schemas"]["Timestamp"] | null;
            /** @description Optional (sequenced run). When the countdown ends; null before the challenge is begun. */
            expires_at?: components["schemas"]["Timestamp"] | null;
            /** @description Optional (sequenced run). Seconds left when the answer was made; null unless the challenge is `active`. The browser counts down from it. */
            seconds_left?: number | null;
        };
        ChallengeProgressList: {
            items: components["schemas"]["ChallengeProgress"][];
            /**
             * @description Always false here; the list is complete and has a fixed size (not truncated).
             * @constant
             */
            has_more: false;
            /** @description Optional (sequenced run). How many challenges the run has in all, so the browser can show "3 of 11" without listing the ones ahead. */
            total?: number;
            /** @description Optional (sequenced run). The challenge to work on now; null when every challenge is solved or timed out. */
            current_key?: components["schemas"]["ChallengeKey"] | null;
            /** @description Optional (sequenced run). The server clock when the answer was made. */
            server_time?: components["schemas"]["Timestamp"];
        };
        AccountChallengePoints: {
            challenge_key: components["schemas"]["ChallengeKey"];
            /** @description The best net points of this challenge over all runs (the points of one challenge */
            best_points: number;
        };
        AccountProgress: {
            /** @description The best points of every challenge added up and shown out of 1000 */
            total_points: number;
            /** @description How many practice runs the learner has started. */
            runs: number;
            per_challenge: components["schemas"]["AccountChallengePoints"][];
        };
        Hint: {
            level: number;
            /** @enum {unknown} */
            kind: "nudge" | "direction" | "near_solution";
            unlocked: boolean;
            /** @description Cost as a percentage of the challenge points; 0 for a learner (placeholder 10, 20, 30 for a candidate). */
            cost_pct: number;
            /** @description Null until unlocked. A hint never reveals a flag (FR-HNT-01). */
            text: string | null;
        };
        HintList: {
            challenge_key: components["schemas"]["ChallengeKey"];
            items: components["schemas"]["Hint"][];
            /**
             * @description Always false here; the list is complete and has a fixed size (not truncated).
             * @constant
             */
            has_more: false;
        };
        Evidence: {
            evidence_id: components["schemas"]["EvidenceId"];
            challenge_key: components["schemas"]["ChallengeKey"];
            captured_at: components["schemas"]["Timestamp"];
            /** @enum {unknown} */
            method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
            path: string;
            /** @description Redacted request body, at most 8 KiB (FR-DET-03); null when there was none. */
            body: string | null;
            body_truncated: boolean;
        };
        EvidenceList: {
            items: components["schemas"]["Evidence"][];
            /** @description True when more entries exist than limit allowed in this answer (the answer is truncated). The entries are the oldest first. */
            has_more: boolean;
        };
        IntegrityFlag: {
            integrity_flag_id: components["schemas"]["IntegrityFlagId"];
            /** @enum {unknown} */
            type: "decoy" | "sharing" | "timing" | "activity" | "similarity";
            challenge_key: components["schemas"]["ChallengeKey"] | null;
            explanation: string;
            /** @enum {unknown} */
            status: "open" | "accepted" | "rejected";
            /** @description A held capture is linked to this flag and stays out of the score until decided. */
            held: boolean;
            created_at: components["schemas"]["Timestamp"];
            decided_at: components["schemas"]["Timestamp"] | null;
            decision_note: string | null;
        };
        IntegrityFlagList: {
            items: components["schemas"]["IntegrityFlag"][];
            /** @description True when more entries exist than limit allowed in this answer (the answer is truncated). The entries are the oldest first. */
            has_more: boolean;
        };
        IntegrityDecisionRequest: {
            /** @enum {unknown} */
            decision: "accept" | "reject";
            note: string;
        };
        ReportChallenge: {
            challenge_key: components["schemas"]["ChallengeKey"];
            best_milestone: components["schemas"]["Milestone"];
            points: number;
            held: boolean;
            hints_used: number;
            time_to_capture_seconds: number | null;
            /** @description An estimate (FR-DET-07), never changes points; null when unknown. */
            technique_label: string | null;
        };
        Report: {
            attempt_id: components["schemas"]["AttemptId"];
            mode: components["schemas"]["AttemptMode"];
            state: components["schemas"]["AttemptState"];
            generated_at: components["schemas"]["Timestamp"];
            score: number;
            elapsed_seconds: number | null;
            /** @description Estimate (FR-TIM-02); null when not computed. */
            active_seconds: number | null;
            hints_used_total: number;
            integrity_open: number;
            per_challenge: components["schemas"]["ReportChallenge"][];
        };
        TimelineEntry: {
            at: components["schemas"]["Timestamp"];
            /** @enum {unknown} */
            type: "attempt.started" | "milestone.reached" | "flag.submitted" | "hint.unlocked" | "instance.reset" | "attempt.submitted" | "attempt.expired";
            challenge_key: components["schemas"]["ChallengeKey"] | null;
            milestone: ("M1" | "M2" | "M3") | null;
            result: components["schemas"]["FlagResult"] | null;
        };
        /**
         * @description One page of the timeline, sorted by the key (epoch, seq) of the event, oldest first. The key is not part of
         *     an entry; it is inside the cursor. The cursor only moves forward.
         */
        Timeline: {
            items: components["schemas"]["TimelineEntry"][];
            /** @description True when entries with a larger key exist after this page. Exactly when next_cursor is not null. */
            has_more: boolean;
            /**
             * @description Null on the last page. Otherwise pass it as `cursor` to get the entries after the last one of this page.
             *     It never goes back: an event that arrives late with a smaller key than the cursor is not in the following
             *     pages; read again from the start (cursor left out) to see it.
             */
            next_cursor: components["schemas"]["Cursor"] | null;
        };
    };
    responses: {
        /** @description Accepted. The same answer whether or not the address has an account. */
        Accepted: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["AcceptedStatus"];
            };
        };
        /** @description No valid session. AUTH-SESSION-REQUIRED. */
        Unauthenticated: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description No valid session (AUTH-SESSION-REQUIRED), or the password given is not correct (AUTH-INVALID-CREDENTIALS). */
        SessionOrPasswordFailed: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The email address or password is not correct. AUTH-INVALID-CREDENTIALS. */
        InvalidCredentials: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The link was used or has expired. AUTH-TOKEN-INVALID. */
        TokenInvalid: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The CSRF token or the Origin is wrong. AUTH-CSRF-FAILED or AUTH-ORIGIN-FORBIDDEN. */
        CsrfFailed: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The Origin is not the dashboard origin. AUTH-ORIGIN-FORBIDDEN. */
        OriginForbidden: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Not found, or not yours (the same answer). ATT-NOT-FOUND or ATT-CHALLENGE-NOT-FOUND. */
        NotFound: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The attempt's state does not allow it. ATT-INVALID-STATE. */
        Conflict: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The second factor is not in a state that allows it (already active, or an admin turning it off). AUTH-MFA-STATE. */
        MfaStateConflict: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The notice the person saw is not the current one (ATT-CONSENT-STALE), or the attempt is not in state consent (ATT-INVALID-STATE). */
        ConsentConflict: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The invite is closed or taken, or this account cannot accept it (not an active, verified participant, or not the address the invite was sent to) (ATT-INVALID-STATE). */
        InviteConflict: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Not found: a template or invite of another company or none at all (ATT-NOT-FOUND), or the caller is not a recruiter, or not the owner where the owner is needed (REQ-ROUTE-UNKNOWN, the answer of a route that does not exist). */
        CompanyNotFound: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The company is not active, the terms are not accepted, the invite or template is in a state this change does not start from (ATT-INVALID-STATE), or the terms text changed (ATT-CONSENT-STALE). */
        CompanyConflict: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The caller already has an open request of this kind, the request is not open any more, the attempt is not over, or the account is not a learner (ATT-INVALID-STATE). */
        DeletionConflict: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Not found: no such company, account, attempt, setting or quota, or the caller is not an admin with a second factor (the same answer, REQ-ROUTE-UNKNOWN). */
        AdminNotFound: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The change does not start from the state it is asked for (a company already decided, an account not active), or it names an admin account or the admin's own (ATT-INVALID-STATE). */
        AdminConflict: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description There is no challenge with this key. ATT-CHALLENGE-NOT-FOUND. */
        ChallengeNotFound: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The body is over 64 KiB. REQ-TOO-LARGE. */
        TooLarge: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The body is not JSON. REQ-UNSUPPORTED-MEDIA-TYPE. */
        UnsupportedMedia: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description A value is not valid. REQ-VALIDATION, with `field` or `errors` (never the submitted value). */
        Invalid: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Too many requests. REQ-RATE-LIMITED, with Retry-After. */
        RateLimited: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                "Retry-After": components["headers"]["RetryAfter"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Accepted. The instance advances on its own. */
        InstanceAccepted: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Instance"];
            };
        };
        /** @description The instance. */
        InstanceOk: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Instance"];
            };
        };
        /** @description The attempt. */
        AttemptOk: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Attempt"];
            };
        };
        /** @description PROPOSAL, to confirm. The attempt is withdrawn or cancelled, so its derived data is no longer served (ATT-GONE). getAttempt still answers 200 with the state; a deleted attempt answers 404 like a missing one. */
        Gone: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The path exists but not for this method. REQ-METHOD-NOT-ALLOWED with an Allow header. Any path can answer it. */
        MethodNotAllowed: {
            headers: {
                "Cache-Control": components["headers"]["CacheControl"];
                Allow: components["headers"]["Allow"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        ChallengeKeyPath: components["schemas"]["ChallengeKey"];
        /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
        PageLimit: number;
        InstanceIdPath: components["schemas"]["InstanceId"];
        AttemptIdPath: components["schemas"]["AttemptId"];
        HintLevelPath: number;
        IntegrityFlagIdPath: components["schemas"]["IntegrityFlagId"];
        Cursor: components["schemas"]["Cursor"];
        /** @description Page size of the timeline. Default 50, maximum 200; a larger value is 422 REQ-VALIDATION with field /query/limit. */
        Limit: number;
        /** @description Most entries in the answer. Default 100, maximum 100; a larger value is 422 REQ-VALIDATION with field /query/limit. When more exist, has_more is true. */
        ListLimit: number;
    };
    requestBodies: never;
    headers: {
        /** @description Always `private, no-store`. */
        CacheControl: "private, no-store";
        /** @description Seconds to wait. */
        RetryAfter: number;
        /** @description The methods the path supports. */
        Allow: string;
        /**
         * @description `__Host-vm_session=<opaque>; Path=/; Secure; HttpOnly; SameSite=Lax` (no Domain). Cleared on logout.
         *     The value is never in a body.
         */
        SessionCookie: string;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The platform is answering. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceHealth"];
                };
            };
            /** @description A store does not answer. */
            503: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceHealth"];
                };
            };
        };
    };
    createAccount: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SignupRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            403: components["responses"]["OriginForbidden"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    verifyEmail: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TokenRequest"];
            };
        };
        responses: {
            /** @description The address is verified. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerifiedStatus"];
                };
            };
            400: components["responses"]["TokenInvalid"];
            403: components["responses"]["OriginForbidden"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    resendVerification: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmailRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            403: components["responses"]["OriginForbidden"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current session. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    createSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Logged in, or a second factor is needed. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    "Set-Cookie": components["headers"]["SessionCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LoginResult"];
                };
            };
            401: components["responses"]["InvalidCredentials"];
            /** @description Origin not allowed, or the email address is not verified yet. */
            403: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    deleteSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Logged out. */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    "Set-Cookie": components["headers"]["SessionCookie"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
        };
    };
    completeMfaLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaLoginRequest"];
            };
        };
        responses: {
            /** @description Logged in. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    "Set-Cookie": components["headers"]["SessionCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            /** @description The code is not correct or the ticket expired. */
            401: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            403: components["responses"]["OriginForbidden"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The user. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    updateMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateMeRequest"];
            };
        };
        responses: {
            /** @description The updated user. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    changePassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChangePasswordRequest"];
            };
        };
        responses: {
            /** @description The password is changed. */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    "Set-Cookie": components["headers"]["SessionCookie"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["SessionOrPasswordFailed"];
            403: components["responses"]["CsrfFailed"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    startMfaEnrolment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The pending enrolment. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MfaEnrolment"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            409: components["responses"]["MfaStateConflict"];
        };
    };
    disableMfa: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordConfirmRequest"];
            };
        };
        responses: {
            /** @description The second factor is off. */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    "Set-Cookie": components["headers"]["SessionCookie"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["SessionOrPasswordFailed"];
            403: components["responses"]["CsrfFailed"];
            409: components["responses"]["MfaStateConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    confirmMfaEnrolment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaCodeRequest"];
            };
        };
        responses: {
            /** @description The second factor is active. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    "Set-Cookie": components["headers"]["SessionCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MfaRecoveryCodes"];
                };
            };
            /** @description The code is not correct, or the session is missing. */
            401: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            403: components["responses"]["CsrfFailed"];
            409: components["responses"]["MfaStateConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    requestPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmailRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            403: components["responses"]["OriginForbidden"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    confirmPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResetPasswordRequest"];
            };
        };
        responses: {
            /** @description The password is changed. */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["TokenInvalid"];
            403: components["responses"]["OriginForbidden"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    getConsentNotice: {
        parameters: {
            query: {
                attempt_id: components["schemas"]["AttemptId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The notice to show. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConsentNotice"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Invalid"];
        };
    };
    recordConsent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConsentRequest"];
            };
        };
        responses: {
            /** @description The consent record. */
            201: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConsentRecord"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["ConsentConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    listMyConsents: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The records. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConsentRecordList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            422: components["responses"]["Invalid"];
        };
    };
    listMyDeletionRequests: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The requests. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletionRequestList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            422: components["responses"]["Invalid"];
        };
    };
    createDeletionRequest: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeletionRequestCreate"];
            };
        };
        responses: {
            /** @description The request. */
            201: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletionRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["DeletionConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    cancelDeletionRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                request_id: components["schemas"]["DeletionRequestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The request, now cancelled. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletionRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["DeletionConflict"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    listMyDataViews: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The history. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DataViewList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            422: components["responses"]["Invalid"];
        };
    };
    openInvite: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InviteTokenRequest"];
            };
        };
        responses: {
            /** @description What the assessment is. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InviteSummary"];
                };
            };
            400: components["responses"]["TokenInvalid"];
            403: components["responses"]["OriginForbidden"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    acceptInvite: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InviteTokenRequest"];
            };
        };
        responses: {
            /** @description The invite, bound to the caller. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MyInvite"];
                };
            };
            400: components["responses"]["TokenInvalid"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            409: components["responses"]["InviteConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    listMyInvites: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The invitations. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MyInviteList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            422: components["responses"]["Invalid"];
        };
    };
    signupRecruiter: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecruiterSignupRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            403: components["responses"]["OriginForbidden"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    getMyCompany: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The standing. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CompanyStanding"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            422: components["responses"]["Invalid"];
        };
    };
    reapplyCompany: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Done. */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    getCompanyTerms: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The terms. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CompanyTerms"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            422: components["responses"]["Invalid"];
        };
    };
    acceptCompanyTerms: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TermsAcceptRequest"];
            };
        };
        responses: {
            /** @description Done. */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    listTemplates: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The templates. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TemplateList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            422: components["responses"]["Invalid"];
        };
    };
    createTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TemplateRequest"];
            };
        };
        responses: {
            /** @description The template. */
            201: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Template"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    getTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                template_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The template. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Template"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            422: components["responses"]["Invalid"];
        };
    };
    updateTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                template_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TemplateRequest"];
            };
        };
        responses: {
            /** @description The template. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Template"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    deleteTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                template_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Done. */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    listCompanyInvites: {
        parameters: {
            query?: {
                state?: "created" | "sent" | "opened" | "consented" | "started" | "declined" | "expired" | "cancelled" | "revoked";
                template_id?: string;
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The invites. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CompanyInviteList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            422: components["responses"]["Invalid"];
        };
    };
    createInvites: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InvitesRequest"];
            };
        };
        responses: {
            /** @description What was done. */
            201: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitesResult"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    actOnInvite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invite_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InviteActionRequest"];
            };
        };
        responses: {
            /** @description The invite. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CompanyInvite"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    exportMyData: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The zip (JSON and CSV files). */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    /** @description attachment; filename="..." */
                    "Content-Disposition"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/zip": string;
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            429: components["responses"]["RateLimited"];
        };
    };
    exportCompanyResults: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CompanyExportRequest"];
            };
        };
        responses: {
            /** @description The zip (JSON and CSV files). */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    /** @description attachment; filename="..." */
                    "Content-Disposition"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/zip": string;
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["CompanyNotFound"];
            409: components["responses"]["CompanyConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    listAuditLog: {
        parameters: {
            query?: {
                action?: string;
                after_seq?: number;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The entries. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEntryList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["AdminNotFound"];
            422: components["responses"]["Invalid"];
        };
    };
    listBreakGlassSessions: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The sessions. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BreakGlassSessionList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["AdminNotFound"];
            422: components["responses"]["Invalid"];
        };
    };
    openBreakGlass: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BreakGlassRequest"];
            };
        };
        responses: {
            /** @description The session. */
            201: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BreakGlassSession"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            409: components["responses"]["AdminConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    readBreakGlassAttempt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The attempt's data. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BreakGlassRead"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["AdminNotFound"];
            409: components["responses"]["AdminConflict"];
        };
    };
    closeBreakGlass: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BreakGlassSession"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            409: components["responses"]["AdminConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    reviewBreakGlass: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BreakGlassReviewRequest"];
            };
        };
        responses: {
            /** @description The session. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BreakGlassSession"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            409: components["responses"]["AdminConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    listPendingCompanies: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The queue. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PendingCompanyList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["AdminNotFound"];
            422: components["responses"]["Invalid"];
        };
    };
    decideCompany: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                org_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CompanyDecisionRequest"];
            };
        };
        responses: {
            /** @description The decision is made. */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            409: components["responses"]["AdminConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    listUsers: {
        parameters: {
            query?: {
                q?: string;
                status?: "active" | "disabled";
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The accounts. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUserList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["AdminNotFound"];
            422: components["responses"]["Invalid"];
        };
    };
    actOnUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserActionRequest"];
            };
        };
        responses: {
            /** @description What happened. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserActionResult"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            409: components["responses"]["AdminConflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    forceStopInstance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["schemas"]["AttemptId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The instance is gone. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ForceStopResult"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            429: components["responses"]["RateLimited"];
        };
    };
    listSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The settings. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminSettingList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["AdminNotFound"];
        };
    };
    updateSetting: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SettingUpdateRequest"];
            };
        };
        responses: {
            /** @description The setting now. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminSetting"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    resetSetting: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The setting now. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminSetting"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            429: components["responses"]["RateLimited"];
        };
    };
    listQuotas: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The quotas. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuotaList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["AdminNotFound"];
        };
    };
    setQuota: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["QuotaRequest"];
            };
        };
        responses: {
            /** @description The quota now. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Quota"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    removeQuota: {
        parameters: {
            query: {
                scope: "user" | "org" | "global";
                scope_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The quota is removed. */
            204: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["AdminNotFound"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    getCapacity: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The capacity. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Capacity"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["AdminNotFound"];
        };
    };
    listJobs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The jobs. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobStatusList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["AdminNotFound"];
        };
    };
    listCatalogue: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The catalogue. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogueList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    getCatalogueChallenge: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                challenge_key: components["parameters"]["ChallengeKeyPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The challenge. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogueChallenge"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["ChallengeNotFound"];
            422: components["responses"]["Invalid"];
        };
    };
    listMyAttempts: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 50, maximum 100; a larger value is 422 REQ-VALIDATION with field /limit. When more exist, has_more is true. */
                limit?: components["parameters"]["PageLimit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The attempts. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AttemptSummaryList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            422: components["responses"]["Invalid"];
        };
    };
    openLiveStream: {
        parameters: {
            query?: never;
            header?: {
                "Last-Event-ID"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The event stream. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    /** @description Always `no`: no proxy may buffer the stream. */
                    "X-Accel-Buffering"?: "no";
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            401: components["responses"]["Unauthenticated"];
            429: components["responses"]["RateLimited"];
        };
    };
    getLiveSnapshot: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The snapshot. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LiveSnapshot"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            429: components["responses"]["RateLimited"];
        };
    };
    createLiveTicket: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The ticket. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LiveTicket"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            429: components["responses"]["RateLimited"];
        };
    };
    requestInstance: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RequestInstanceRequest"];
            };
        };
        responses: {
            202: components["responses"]["InstanceAccepted"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            409: components["responses"]["Conflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
        };
    };
    getInstance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                instance_id: components["parameters"]["InstanceIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["InstanceOk"];
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["Invalid"];
        };
    };
    openInstance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                instance_id: components["parameters"]["InstanceIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The ticket URL and its expiry. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OpenTicket"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Invalid"];
        };
    };
    resetInstance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                instance_id: components["parameters"]["InstanceIdPath"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmRequest"];
            };
        };
        responses: {
            202: components["responses"]["InstanceAccepted"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
        };
    };
    stopInstance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                instance_id: components["parameters"]["InstanceIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["InstanceOk"];
            202: components["responses"]["InstanceAccepted"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Invalid"];
        };
    };
    getAttempt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AttemptOk"];
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["Invalid"];
        };
    };
    startAttempt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AttemptOk"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Invalid"];
        };
    };
    submitAttempt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmRequest"];
            };
        };
        responses: {
            200: components["responses"]["AttemptOk"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
        };
    };
    withdrawAttempt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmRequest"];
            };
        };
        responses: {
            200: components["responses"]["AttemptOk"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
        };
    };
    undoWithdrawal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AttemptOk"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            410: components["responses"]["Gone"];
            422: components["responses"]["Invalid"];
        };
    };
    submitFlag: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FlagSubmissionRequest"];
            };
        };
        responses: {
            /** @description The result of the check. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FlagSubmissionResult"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
            429: components["responses"]["RateLimited"];
        };
    };
    getScore: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The score out of 1000 and the per-challenge points. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Score"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            410: components["responses"]["Gone"];
            422: components["responses"]["Invalid"];
        };
    };
    listChallenges: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One entry per challenge the learner has reached (all of them for an attempt that is not sequenced). */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChallengeProgressList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            410: components["responses"]["Gone"];
            422: components["responses"]["Invalid"];
        };
    };
    beginChallenge: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
                challenge_key: components["parameters"]["ChallengeKeyPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The challenge with its countdown running. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChallengeProgress"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            410: components["responses"]["Gone"];
            422: components["responses"]["Invalid"];
        };
    };
    getMyProgress: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The account points. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountProgress"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            422: components["responses"]["Invalid"];
        };
    };
    listHints: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
                challenge_key: components["parameters"]["ChallengeKeyPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The hint levels. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HintList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            410: components["responses"]["Gone"];
            422: components["responses"]["Invalid"];
        };
    };
    unlockHint: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
                challenge_key: components["parameters"]["ChallengeKeyPath"];
                level: components["parameters"]["HintLevelPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The unlocked hint. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Hint"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Invalid"];
        };
    };
    listEvidence: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 100, maximum 100; a larger value is 422 REQ-VALIDATION with field /query/limit. When more exist, has_more is true. */
                limit?: components["parameters"]["ListLimit"];
            };
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Evidence entries. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            410: components["responses"]["Gone"];
            422: components["responses"]["Invalid"];
        };
    };
    listIntegrityFlags: {
        parameters: {
            query?: {
                /** @description Most entries in the answer. Default 100, maximum 100; a larger value is 422 REQ-VALIDATION with field /query/limit. When more exist, has_more is true. */
                limit?: components["parameters"]["ListLimit"];
            };
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Integrity flags. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntegrityFlagList"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            410: components["responses"]["Gone"];
            422: components["responses"]["Invalid"];
        };
    };
    decideIntegrityFlag: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
                integrity_flag_id: components["parameters"]["IntegrityFlagIdPath"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IntegrityDecisionRequest"];
            };
        };
        responses: {
            /** @description The flag with its decision. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntegrityFlag"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["CsrfFailed"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            413: components["responses"]["TooLarge"];
            415: components["responses"]["UnsupportedMedia"];
            422: components["responses"]["Invalid"];
        };
    };
    getReport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The report. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Report"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            410: components["responses"]["Gone"];
            422: components["responses"]["Invalid"];
        };
    };
    getTimeline: {
        parameters: {
            query?: {
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size of the timeline. Default 50, maximum 200; a larger value is 422 REQ-VALIDATION with field /query/limit. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                attempt_id: components["parameters"]["AttemptIdPath"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of the timeline. */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControl"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Timeline"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            410: components["responses"]["Gone"];
            422: components["responses"]["Invalid"];
        };
    };
}
