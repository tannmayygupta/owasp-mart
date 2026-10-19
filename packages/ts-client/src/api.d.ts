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
         * @description Progress only. Titles, tags and difficulty are catalogue data (IF-7) served by the platform.
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
             * @description A withdrawal is a later route (P-25) and adds the value `withdrawn`.
             * @enum {unknown}
             */
            decision: "granted" | "declined" | "withdrawn";
            recorded_at: components["schemas"]["Timestamp"];
        };
        ConsentRecordList: {
            items: components["schemas"]["ConsentRecord"][];
            has_more: boolean;
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
        };
        ChallengeProgressList: {
            items: components["schemas"]["ChallengeProgress"][];
            /**
             * @description Always false here; the list is complete and has a fixed size (not truncated).
             * @constant
             */
            has_more: false;
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
            /** @description One entry per challenge of the attempt. */
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
