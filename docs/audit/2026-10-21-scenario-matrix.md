# Scenario matrix with evidence, 2026-10-21

Work package G. Every one of the 145 scenarios of [2026-10-21-role-scenarios.md](2026-10-21-role-scenarios.md) was exercised against the code of `origin/main` (db3721b) through the real routes and services of the combined world (`apps/api/tests/scenario_support.py`: the real lab runtime on the fake instance host, the real company, invite, consent, deletion, export, break-glass and admin services on SQLite). A scenario is `VERIFIED` only when a passing test named in the table proves it. `test_scenario_matrix.py` fails when a row names a test that does not exist, when a `VERIFIED` row has no test, or when an id is missing.

Status words: **VERIFIED** (works on main, proved by the named test), **PARTIAL** (part works and is proved, the note says what is missing and who owns it), **MISSING-OWNED-BY-<letter>** (the behaviour does not exist on main; the letter is the work package that builds it: A attempt lifecycle, quotas and template settings; B company deletion, colleagues and mail; C deployment; D shop and challenges; E learner and candidate web; F recruiter and admin web), **MISSING-UNOWNED** (not built and no package has it), **EXTERNAL** (needs the deployed stack, a browser audit or a host, not an API test).

Tests assert behaviour that is correct on main today, not internals, so they keep passing when packages A to F merge. Where a test proves only part of a scenario the note says which part.

## Counts

| Status | Scenarios |
|---|---|
| VERIFIED | 74 |
| PARTIAL | 36 |
| MISSING-OWNED-BY-<letter> | 23 (A: 7, B: 13, C: 1, E: 1, F: 1) |
| MISSING-UNOWNED | 7 |
| EXTERNAL | 5 |
| Total | 145 |

## Findings made while testing

- **Concurrent identical flag pastes journal the capture more than once** (score is right): `test_scenarios_cross.py::test_xc2b_the_milestone_is_journalled_once_when_the_same_flag_is_pasted_at_once` (xfail until fixed). The flag path is touched by package A.
- **The combined world cannot model concurrent HTTP requests**: its test database is one shared SQLite connection (`InterfaceError` under threads). Thread tests therefore call the lab runtime; the invite and company races are proved on Postgres by `test_assessments_postgres.py` and `test_invite_acceptance_postgres.py` (they skip without a database).
- **Suspending a company does not end its recruiters' sessions** (only deleting does); the company is simply unable to invite (`test_a03_...`).
- **An unverified account is refused at sign-in** (403), earlier than the audit's 409 at accept (C-05).
- **The deletion request and force-stop read the SQL attempt table**, which the in-memory lab store of this world does not fill; `test_a13_...` mirrors the row, C-25 cites `test_deletion_api.py`.

## Matrix

| ID | Role | Status | Test | Note |
|---|---|---|---|---|
| L-01 | learner | VERIFIED | `test_scenarios_learner.py::test_l01_signup_queues_the_verification_mail_refuses_weak_and_underage_and_is_rate_limited` | Live mail goes to Mailpit (LB-1): packages B and C. |
| L-02 | learner | VERIFIED | `test_scenarios_learner.py::test_l02_a_verification_link_works_once_expires_and_can_be_sent_again` | 24 h expiry, single use and resend proved. |
| L-03 | learner | VERIFIED | `test_scenarios_learner.py::test_l03_sign_in_sessions_password_reset_and_second_factor` | Sign-in, session list and revoke, reset by mailed link, TOTP enrolment and second step proved. The console has sign-in only; reset and TOTP screens are in the web app (package E). |
| L-04 | learner | VERIFIED | `test_scenarios_learner.py::test_l04_signing_up_with_a_known_address_looks_the_same_and_mails_the_owner` | Same 202 answer for known and unknown address; owner gets the 'already registered' mail. |
| L-05 | learner | VERIFIED | `test_scenarios_learner.py::test_l05_the_catalogue_lists_eleven_challenges_with_both_owasp_tags_difficulty_and_tier` | 11 challenges; every entry has at least one OWASP tag, difficulty and tier. |
| L-06 | learner | VERIFIED | `test_scenarios_learner.py::test_l06_start_becomes_ready_the_shop_opens_through_a_ticket_and_a_second_press_is_refused` | Second press while running answers 409 INST-QUOTA-REACHED. |
| L-07 | learner | VERIFIED | `test_scenarios_learner.py::test_l07_a_sequenced_run_shows_one_challenge_with_the_tier_countdown_and_begin_starts_it` | Runs with `lab.sequenced = True`, the deployed mode. Console only (L-08). |
| L-08 | learner | MISSING-OWNED-BY-E | none | apps/web has no begin, progress or seconds_left; the API side works (L-07). |
| L-09 | learner | VERIFIED | `test_scenarios_learner.py::test_l09_an_expired_countdown_moves_on_and_keeps_earned_points` | Expired challenge moves on, earned points stay (score 0 here because nothing was earned). |
| L-10 | learner | VERIFIED | `test_scenarios_learner.py::test_l10_a_pasted_flag_is_credited_a_flag_without_play_is_held_and_nothing_echoes_the_flag` | Paste path proved (credited, held). Sidecar auto-detection is covered by test_ingest_engine.py, not re-run here. |
| L-11 | learner | PARTIAL | `test_scenarios_learner.py::test_l11_five_wrong_flags_in_ten_minutes_end_in_429_without_a_score_penalty` | 5 wrong pastes per challenge in 10 minutes then 429, no penalty: proved. The 30-per-attempt hard cap of FR-ACH-01 does not exist; the per-minute setting is package A. |
| L-12 | learner | VERIFIED | `test_scenarios_learner.py::test_l12_three_hints_in_order_are_free_for_a_learner_and_never_show_a_flag` | Three hints in order, cost 0 for a learner, no flag in any answer. |
| L-13 | learner | VERIFIED | `test_scenarios_learner.py::test_l13_account_points_count_the_best_result_per_challenge_once_out_of_1000` | Account progress is the best result per challenge over runs (`total_points`, `runs`, `per_challenge`). |
| L-14 | learner | VERIFIED | `test_scenarios_learner.py::test_l14_solving_every_challenge_of_a_sequenced_run_submits_it_frees_the_instance_and_shows_report_and_write_up` | Sequenced run: after the last challenge the tick submits, the report and write-ups are there. A non-sequenced run does not auto-submit. |
| L-15 | learner | PARTIAL | none | No test: every run still starts at C01 by design (sequence); no jump to a challenge. Unowned design question. |
| L-16 | learner | VERIFIED | `test_scenarios_learner.py::test_l16_reset_gives_fresh_flags_keeps_milestones_needs_confirmation_and_a_second_reset_is_refused_while_one_runs` | Confirmation needed, new epoch, milestones kept, earlier-epoch flag refused. |
| L-17 | learner | VERIFIED | `test_scenarios_learner.py::test_l17_stop_then_start_again_keeps_the_same_run` | Stop then start answers the same attempt. |
| L-18 | learner | VERIFIED | `test_scenarios_learner.py::test_l18_the_server_keeps_the_clock_and_a_returning_browser_sees_the_time_left` | Seconds left come from the server clock; a new browser sees the right value. |
| L-19 | learner | PARTIAL | none | Idle destroy after 60 minutes never proven on a live host (lab-stream-audit B1); needs the deployed stack, see the live suite. |
| L-20 | learner | PARTIAL | `test_scenarios_learner.py::test_l20_a_failed_start_is_a_clean_error_without_internals_and_the_learner_can_start_again` | Failed start is a clean problem document without internals and a retry works. The console text for a crash is generic (package E). |
| L-21 | learner | PARTIAL | `test_scenarios_learner.py::test_l21_a_full_platform_answers_429_with_retry_after_not_a_crash` | Full host answers 429 with Retry-After 15, no crash. Text says 'too many tries' and there is no queue (A-12, package A). |
| L-22 | learner | PARTIAL | `test_scenarios_learner.py::test_l22_one_running_instance_per_learner_across_requests` | One running instance per learner proved; admin quota not consulted (package A). |
| L-23 | learner | VERIFIED | `test_scenarios_learner.py::test_l23_a_learner_exports_the_data_and_asks_for_deletion_with_a_cancel` | Export zip (JSON and CSV) and deletion request with cancel proved at API level. Web account page: package E. |
| L-24 | learner | PARTIAL | none | Jobs are built (test_retention_learners.py, test_retention_scheduler.py); the scheduler is off in the deployed config (package C). |
| L-25 | learner | EXTERNAL | none | Needs an assistive-technology and contrast audit in a browser; not an API property. |
| L-26 | learner | PARTIAL | `test_scenarios_learner.py::test_l26_a_registration_without_the_age_declaration_is_refused` | Self-declaration only; OI-33 (date of birth, guardian) is open. |
| C-01 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c01_the_invite_mail_carries_a_company_prefixed_single_use_token_stored_only_as_a_hash_and_hides_the_address` | Token shape, hash-only storage, sealed address in the outbox proved. Live delivery is Mailpit (packages B, C). |
| C-02 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c02_an_invite_link_shows_company_title_and_rules_without_a_session_and_is_rate_limited` | Company and rules shown without a session, unknown token refused, rate limit reached. |
| C-03 | candidate | PARTIAL | `test_scenarios_learner.py::test_l02_a_verification_link_works_once_expires_and_can_be_sent_again`<br>`test_scenarios_candidate.py::test_c04_an_existing_learner_accepts_and_consents_gets_the_candidate_role_and_keeps_the_practice` | API steps proved separately (sign up, verify, accept). The return to the invite after verification is a web matter (package E). |
| C-04 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c04_an_existing_learner_accepts_and_consents_gets_the_candidate_role_and_keeps_the_practice` | Candidate role added on accept, practice run untouched. |
| C-05 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c05_an_unverified_account_cannot_even_sign_in_to_accept_an_invite` | An unverified account cannot sign in (403 AUTH-EMAIL-NOT-VERIFIED), so it cannot accept. The wording the person sees is package E. |
| C-06 | candidate | MISSING-OWNED-BY-B | `test_scenarios_candidate.py::test_c06_an_invite_for_another_address_is_refused_and_leaks_nothing` | The refusal is proved (409, nothing leaked). The change-address path is package B (change-email routes). |
| C-07 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c07_a_revoked_expired_or_declined_invite_is_closed_for_good` | Cancelled, revoked, declined and expired invites are closed for good. |
| C-08 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c06_an_invite_for_another_address_is_refused_and_leaks_nothing` | Another account's accept of a bound invite is 409 without leaking. |
| C-09 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c09_a_recruiter_or_admin_cannot_accept_an_invite` | Recruiter and admin accounts are refused. |
| C-10 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c10_the_consent_needs_the_current_notice_and_a_stale_notice_is_refused` | Stale version or hash refused, consent recorded once granted. |
| C-11 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c11_a_declined_consent_creates_no_attempt_and_the_company_sees_the_state` | Declined: no attempt can start, the company sees `declined`. No mail to the company (package B). |
| C-12 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c12_start_prepares_the_instance_the_clock_starts_at_ready_and_a_second_press_is_the_same_attempt` | Clock starts at ready, second press is the same attempt. |
| C-13 | candidate | PARTIAL | `test_scenarios_candidate.py::test_c13_the_template_time_limit_results_timing_and_reset_limit_reach_the_attempt` | Time limit, results timing and reset limit reach the attempt and are enforced. The challenge subset is ignored (R-11, package A). |
| C-14 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c14_the_deadline_is_the_servers_with_warnings_and_late_flags_are_refused` | Warnings at 15 and 5 minutes, flags refused after deadline plus grace. |
| C-15 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c15_an_attack_credits_milestones_keeps_evidence_and_shows_a_held_capture_as_held` | A paste without shop traffic is held and shown as held; the recruiter sees the open flag. |
| C-16 | candidate | MISSING-OWNED-BY-A | none | hints_enabled() is False for every organisation attempt on main (lab/api.py). |
| C-17 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c17_a_reset_gives_fresh_flags_keeps_milestones_and_the_clock_continues` | Fresh flags, milestones kept, deadline unchanged. |
| C-18 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c18_submitting_needs_confirmation_freezes_and_cannot_be_reopened` | Confirmation, freeze, no second submit, start and flags refused afterwards. |
| C-19 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c19_time_running_out_ends_the_attempt_with_what_was_captured` | Time out ends the attempt with what was captured. |
| C-20 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c20_a_second_login_raises_the_access_epoch_so_the_older_tab_loses_the_instance` | A second sign-in raises the access epoch, so the older tab loses the instance. |
| C-21 | candidate | PARTIAL | `test_scenarios_candidate.py::test_c21_every_attempt_view_carries_the_servers_time_for_the_countdown` | The API sends `server_time` on every view; the web countdown ignores it (package E). |
| C-22 | candidate | PARTIAL | `test_scenarios_candidate.py::test_c22_a_stopped_instance_can_be_started_again_by_start` | Start after a stopped instance works on the API; the web offers Start only in `ready` (package E). |
| C-23 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c23_results_timing_after_submit_is_open_and_after_release_stays_hidden_until_released` | Fixed on main since the audit: the server hides the score until release. |
| C-24 | candidate | PARTIAL | `test_scenarios_candidate.py::test_c24_a_withdrawal_locks_the_attempt_destroys_the_instance_and_can_be_undone_inside_the_window` | Lock, destroy and undo window proved. No consent `withdrawn` record and no recruiter mail (package B); undo does not resume. |
| C-25 | candidate | MISSING-OWNED-BY-B | `test_scenarios_candidate.py::test_c25_the_candidate_side_of_a_deletion_request_validates_and_hides_other_peoples_attempts` | Candidate-side validation proved; the request itself is in test_deletion_api.py. The company's decision has no route (package B). |
| C-26 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c26_a_candidate_exports_their_data_and_sees_which_company_viewed_it` | Export holds the person's data; data-views show the company by name. |
| C-27 | candidate | PARTIAL | `test_scenarios_candidate.py::test_c27_a_recruiter_can_issue_a_new_invite_after_a_fault_and_the_old_attempt_is_kept` | Re-invite route proved: new generation, old invite kept and pointing to it. No recruiter button (package F); the old ready attempt stays startable (package A). |
| C-28 | candidate | MISSING-OWNED-BY-A | none | An invite is expired while the attempt runs (LB-6); the lifecycle story of package A fixes it. |
| C-29 | candidate | PARTIAL | `test_scenarios_candidate.py::test_c29_a_learner_in_a_practice_run_can_also_run_an_assessment_with_separate_attempts_and_instances` | Separate attempts, instances and flags proved. No cross-mode instance cap (package A). |
| C-30 | candidate | MISSING-UNOWNED | none | No route to reopen or extend an attempt. Not assigned to a package. |
| C-31 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c31_pasting_the_same_flag_twice_is_idempotent` | Repeat paste is idempotent. |
| C-32 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c32_a_flag_of_another_instance_or_challenge_never_counts_and_the_recruiter_sees_the_signal` | Another instance's flag and a wrong-challenge flag never count; the recruiter sees a sharing flag, the candidate is not told. |
| C-33 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c33_cheating_signals_are_flags_for_a_human_and_never_fail_the_attempt` | Signals never end the attempt. |
| C-34 | candidate | VERIFIED | `test_scenarios_candidate.py::test_c34_every_time_in_the_api_is_utc_with_a_z_so_the_dashboard_can_show_local_time` | UTC with Z in the API; local display is the web's job. |
| C-35 | candidate | PARTIAL | `test_scenarios_candidate.py::test_c35_an_invited_person_must_have_declared_to_be_adult_at_signup` | Self-declaration only (OI-33). |
| C-36 | candidate | EXTERNAL | none | Accessibility needs a browser audit. |
| C-37 | candidate | MISSING-UNOWNED | none | No write-up route; `writeup_required` is stored only. Not assigned to a package. |
| R-01 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r01_a_recruiter_signs_up_with_a_work_address_and_a_disposable_one_is_refused` | Disposable address refused; no enumeration. The web sign-up page is not live (packages C, F). |
| R-02 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r02_r03_a_verified_company_waits_for_an_admin_who_approves_or_rejects_with_a_reason_and_the_owner_can_reapply` | Pending approval state proved. |
| R-03 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r02_r03_a_verified_company_waits_for_an_admin_who_approves_or_rejects_with_a_reason_and_the_owner_can_reapply` | Reject with reason, re-apply, approve; outcome mails; double approve refused. |
| R-04 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r04_invites_wait_for_the_dpa_terms_and_a_changed_text_is_refused` | No invite before the terms, a changed text is refused. |
| R-05 | recruiter | MISSING-OWNED-BY-B | none | No route lists or decides colleague requests on main. |
| R-06 | recruiter | MISSING-OWNED-BY-B | none | No route removes a member on main. |
| R-07 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r07_a_recruiter_can_turn_on_a_second_factor_and_then_needs_it_at_sign_in` | Enrol, then sign-in asks for the code. |
| R-08 | recruiter | PARTIAL | `test_scenarios_recruiter.py::test_r08_a_template_takes_every_setting_validates_them_and_refuses_to_switch_off_what_is_fixed` | API takes and validates every setting. The web form omits retention, resets, expiry (package F); the challenge subset is ignored by the attempt (package A). |
| R-09 | recruiter | PARTIAL | `test_scenarios_recruiter.py::test_r09_editing_a_template_bumps_the_version_and_invites_keep_their_own_copy` | Edit bumps the version, invites keep their copy. No web screen (package F). |
| R-10 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r10_an_unused_template_can_be_deleted_and_one_with_invites_cannot` | Unused template deleted, a used one refused. |
| R-11 | recruiter | MISSING-OWNED-BY-A | none | The attempt and the report list all 11 challenges whatever the template says. |
| R-12 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r12_a_bulk_invite_reports_what_it_skipped_and_what_the_cap_left_over`<br>`test_scenarios_recruiter.py::test_r12b_the_daily_cap_stops_a_bulk_invite_and_returns_the_rest` | Skipped reasons (invalid, duplicate), cap and remaining proved. |
| R-13 | recruiter | PARTIAL | `test_scenarios_candidate.py::test_c01_the_invite_mail_carries_a_company_prefixed_single_use_token_stored_only_as_a_hash_and_hides_the_address` | The mail is queued correctly; it reaches nobody live (LB-1, packages B and C). |
| R-14 | recruiter | PARTIAL | `test_scenarios_recruiter.py::test_r14_resend_cancel_revoke_and_reinvite_work_through_the_routes` | Resend, cancel, revoke and re-invite routes proved. No web buttons (package F). |
| R-15 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r15_inviting_a_person_with_a_learner_account_shows_the_recruiter_nothing_of_the_practice` | A learner invited keeps practice private from the recruiter. |
| R-16 | recruiter | PARTIAL | `test_scenarios_recruiter.py::test_r16_the_same_address_twice_for_one_template_is_refused_while_the_first_is_live`<br>`test_scenarios_recruiter.py::test_r14_resend_cancel_revoke_and_reinvite_work_through_the_routes` | A live duplicate is refused (409, no mail). The AlreadyStarted guard is dead (package A). |
| R-17 | recruiter | PARTIAL | `test_scenarios_recruiter.py::test_r12b_the_daily_cap_stops_a_bulk_invite_and_returns_the_rest` | Daily cap works. The per-company override has no route (package B). |
| R-18 | recruiter | PARTIAL | `test_scenarios_recruiter.py::test_r18_the_monitor_reads_invite_states_and_attempt_ids_of_its_own_company_and_the_snapshot_is_only_the_callers_own` | Invite states and attempt ids are company-scoped; the snapshot is the caller's own. The company stream needs Valkey (test_live_authorisation.py) and the web monitor is not live (packages C, F). |
| R-19 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r19_the_report_has_the_score_per_challenge_times_hints_evidence_and_a_timeline_without_flags` | Score, per challenge, time to capture, hints, no flag in report, evidence or timeline. |
| R-20 | recruiter | MISSING-UNOWNED | none | `technique_label` is always null. Not assigned to a package. |
| R-21 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r21_r22_a_held_capture_is_accepted_or_rejected_with_a_note_and_each_decision_is_final` | Accept or reject with a note, final, candidate and other company get 404. |
| R-22 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r21_r22_a_held_capture_is_accepted_or_rejected_with_a_note_and_each_decision_is_final` | Accepting a held capture credits M3. The 7-day reminder (`remind_overdue`) is covered by packages/py-attempts/tests/test_review.py, not re-run here. |
| R-23 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r23_the_release_needs_a_finished_attempt_and_only_the_owning_company`<br>`test_scenarios_candidate.py::test_c23_results_timing_after_submit_is_open_and_after_release_stays_hidden_until_released` | Release needs a finished attempt and the owning company; repeat changes nothing. |
| R-24 | recruiter | MISSING-OWNED-BY-A | none | No cancelAttempt route on main (package A, IF-2 2.2.0). |
| R-25 | recruiter | MISSING-UNOWNED | none | No route to grant time or reopen. Not assigned to a package. |
| R-26 | recruiter | MISSING-UNOWNED | none | engine_cohort is not wired to any route. Not assigned (candidate for package F). |
| R-27 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r27_a_company_exports_the_results_of_a_template_and_the_export_is_audited_and_visible_to_the_candidate` | Zip with CSV and JSON, no flag value, other company refused. |
| R-28 | recruiter | MISSING-OWNED-BY-B | none | No company route for deletion requests. |
| R-29 | recruiter | PARTIAL | none | Job built (test_retention_candidates.py); scheduler off in the deployed config (package C); no UI for the date. |
| R-30 | recruiter | MISSING-UNOWNED | none | FR-ACH-04 write-up and similarity review are not built. Not assigned. |
| R-31 | recruiter | MISSING-OWNED-BY-B | none | No mail on submission, withdrawal or deletion request (mail triggers are package B). |
| R-32 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r32_every_look_at_a_candidates_data_is_logged_and_shown_to_the_candidate_by_company_name` | Attempt-log line and a data-view entry by company name; a refused look leaves none. |
| R-33 | recruiter | MISSING-OWNED-BY-B | `test_scenarios_admin.py::test_a03_an_admin_suspends_and_reinstates_a_company_and_a_suspended_company_can_invite_nobody` | A suspended company can invite nobody (proved); its running attempts continue and sessions are not ended; deletion is package B. |
| R-34 | recruiter | VERIFIED | `test_scenarios_recruiter.py::test_r34_another_company_sees_and_changes_nothing_of_a_company` | Another company reads and changes nothing. |
| A-01 | admin | VERIFIED | `test_scenarios_admin.py::test_a01_an_admin_session_without_the_second_factor_reaches_no_admin_function` | A session without the second factor reaches no admin route (answered like an unknown route). |
| A-02 | admin | VERIFIED | `test_scenarios_admin.py::test_a02_an_admin_session_ends_after_15_idle_minutes_and_after_12_hours_in_all` | 15 idle minutes and the 12 hour absolute limit. |
| A-03 | admin | VERIFIED | `test_scenarios_admin.py::test_a03_an_admin_suspends_and_reinstates_a_company_and_a_suspended_company_can_invite_nobody`<br>`test_scenarios_recruiter.py::test_r02_r03_a_verified_company_waits_for_an_admin_who_approves_or_rejects_with_a_reason_and_the_owner_can_reapply` | Approve, reject with reason, suspend, reinstate; a reason is required. |
| A-04 | admin | MISSING-OWNED-BY-B | none | The decision literal has no `delete` on main. |
| A-05 | admin | VERIFIED | `test_scenarios_admin.py::test_a05b_an_admin_can_lock_one_recruiter_and_that_person_can_no_longer_sign_in` | Lock of one recruiter; the other company is unaffected. |
| A-06 | admin | VERIFIED | `test_scenarios_admin.py::test_a05_a06_an_admin_searches_users_locks_unlocks_resets_a_password_and_every_step_is_audited`<br>`test_scenarios_admin.py::test_a07_deleting_a_participant_who_holds_assessment_data_locks_the_account_instead` | Search, lock, unlock, reset password, delete, audited. |
| A-07 | admin | VERIFIED | `test_scenarios_admin.py::test_a07_deleting_a_participant_who_holds_assessment_data_locks_the_account_instead` | Delete of a participant with assessment data locks instead. |
| A-08 | admin | PARTIAL | none | Seed command only, by design (FR-ACC-11); no test of the absence of a route. |
| A-09 | admin | MISSING-OWNED-BY-A | `test_scenarios_admin.py::test_a09_a10_quotas_and_settings_are_stored_validated_and_audited` | Quotas are stored, validated and audited (proved); nothing enforces them. |
| A-10 | admin | PARTIAL | `test_scenarios_admin.py::test_a09_a10_quotas_and_settings_are_stored_validated_and_audited` | Range check, set, reset and audit proved; instance, hint and flag-rate settings are read nowhere (package A). |
| A-11 | admin | PARTIAL | `test_scenarios_admin.py::test_a11_the_capacity_view_shows_the_host_and_the_instances` | Host memory and instances shown; no queue depth (package A). |
| A-12 | admin | MISSING-OWNED-BY-A | none | Capacity-full policy (queue or reserve) is part of package A's quota work. |
| A-13 | admin | VERIFIED | `test_scenarios_admin.py::test_a13_a_force_stop_destroys_the_instance_and_is_audited` | Force stop destroys the instance and is audited; the attempt state is unchanged and the candidate is not told in-app. |
| A-14 | admin | PARTIAL | `test_scenarios_admin.py::test_a14_the_job_view_answers_for_an_admin_only` | The route answers; the scheduler is off in the deployed config (package C). |
| A-15 | admin | VERIFIED | `test_scenarios_admin.py::test_a15_reading_the_audit_log_is_admin_only_pseudonymised_and_itself_audited` | Admin only, no address in the log, the read is audited. |
| A-16 | admin | VERIFIED | `test_scenarios_admin.py::test_a16_a_break_glass_session_needs_a_written_reason_alerts_the_other_admin_and_is_reviewed_by_them` | Reason length, other admin and company owner mailed, closed means closed, own review refused, other admin reviews. |
| A-17 | admin | VERIFIED | `test_scenarios_admin.py::test_a17_without_a_break_glass_session_an_admin_reads_no_candidate_answers_and_no_practice` | 404 for candidate and practice attempts without a session; practice cannot be opened. |
| A-18 | admin | PARTIAL | none | Operator CLI only (D-95); test_incident.py covers the CLI. |
| A-19 | admin | MISSING-OWNED-BY-B | none | Escalation only writes an audit entry; no admin action. |
| A-20 | admin | PARTIAL | none | Mail failure counts only; no retry list. |
| A-21 | admin | EXTERNAL | none | Backup, restore and shredding are runbook and host work (package C), checked on the host. |
| A-22 | admin | PARTIAL | `test_scenarios_admin.py::test_a22_an_admin_can_lock_a_cheating_learner` | Lock only; no route to revoke the candidate role. |
| A-23 | admin | MISSING-OWNED-BY-F | none | No admin dashboard is deployed; the web dashboards are package F, the deployment package C. |
| A-24 | admin | MISSING-OWNED-BY-B | none | Per-company invite cap override has no route on main. |
| A-25 | admin | MISSING-OWNED-BY-C | none | No monitoring or alerts. |
| A-26 | admin | VERIFIED | `test_scenarios_admin.py::test_a26_a_running_attempt_whose_instance_was_adopted_closed_is_opened_again_by_the_next_tick` | A running attempt whose instance was adopted closed is opened again by the next tick. |
| A-27 | admin | MISSING-UNOWNED | none | No route lists assessments waiting or failing to start. Not assigned (candidate for package F). |
| X-01 | cross-role | VERIFIED | `test_scenarios_cross.py::test_x01_a_learner_practises_is_invited_and_goes_through_accept_consent_start_and_submit`<br>`test_scenarios_candidate.py::test_c04_an_existing_learner_accepts_and_consents_gets_the_candidate_role_and_keeps_the_practice` | Practice, invite, accept, consent, start, submit through the routes. |
| X-02 | cross-role | VERIFIED | `test_scenarios_cross.py::test_x02_x03_a_recruiter_never_sees_practice_and_the_two_modes_are_separated_by_org_template_instance_and_flags` | Recruiter gets 404 on every practice route. |
| X-03 | cross-role | VERIFIED | `test_scenarios_cross.py::test_x02_x03_a_recruiter_never_sees_practice_and_the_two_modes_are_separated_by_org_template_instance_and_flags` | Separate org, template, instance and flags. |
| X-04 | cross-role | PARTIAL | `test_scenarios_candidate.py::test_c29_a_learner_in_a_practice_run_can_also_run_an_assessment_with_separate_attempts_and_instances` | Both run at once; no cross-mode cap or capacity priority (package A). |
| X-05 | cross-role | VERIFIED | `test_scenarios_admin.py::test_a07_deleting_a_participant_who_holds_assessment_data_locks_the_account_instead` | Account with candidate data is locked, the company's record stays. |
| X-06 | cross-role | VERIFIED | `test_scenarios_cross.py::test_x06_a_withdrawal_from_an_assessment_leaves_the_practice_data_alone` | Practice progress and run untouched by a withdrawal. |
| X-07 | cross-role | PARTIAL | `test_scenarios_candidate.py::test_c27_a_recruiter_can_issue_a_new_invite_after_a_fault_and_the_old_attempt_is_kept` | Server side proved; no recruiter button (package F); old ready attempt stays startable (package A). |
| X-08 | cross-role | VERIFIED | `test_scenarios_cross.py::test_x08_a_second_invite_after_a_re_invite_gets_an_attempt_of_its_own` | Through a re-invite the second generation gets its own attempt. |
| X-09 | cross-role | MISSING-OWNED-BY-B | `test_scenarios_admin.py::test_a03_an_admin_suspends_and_reinstates_a_company_and_a_suspended_company_can_invite_nobody` | Suspension blocks new invites; running attempts continue; deletion is package B. |
| X-10 | cross-role | PARTIAL | none | Code complete (test_retention_*.py); scheduler off in the deployed config (package C). |
| X-11 | cross-role | MISSING-OWNED-BY-A | none | No reservation or priority; total cap not enforced. |
| X-12 | cross-role | PARTIAL | `test_scenarios_candidate.py::test_c22_a_stopped_instance_can_be_started_again_by_start` | Server restarts the instance on Start; the web does not offer it (package E). |
| X-13 | cross-role | VERIFIED | `test_scenarios_candidate.py::test_c31_pasting_the_same_flag_twice_is_idempotent`<br>`test_scenarios_candidate.py::test_c32_a_flag_of_another_instance_or_challenge_never_counts_and_the_recruiter_sees_the_signal`<br>`test_scenarios_cross.py::test_xc2_the_same_correct_flag_pasted_at_once_is_credited_once_in_the_score` | Repeat, shared and decoy flags; at-once pastes credit the score once. Finding: the milestone is journalled more than once (xc2b, xfail). |
| X-14 | cross-role | VERIFIED | `test_scenarios_candidate.py::test_c33_cheating_signals_are_flags_for_a_human_and_never_fail_the_attempt`<br>`test_scenarios_recruiter.py::test_r21_r22_a_held_capture_is_accepted_or_rejected_with_a_note_and_each_decision_is_final` | Signals reach the recruiter, nothing auto-fails, a human decides. |
| X-15 | cross-role | VERIFIED | `test_scenarios_cross.py::test_x15_two_sessions_of_one_account_work_side_by_side_and_each_can_be_listed` | Two sessions of one account side by side. |
| X-16 | cross-role | MISSING-OWNED-BY-B | `test_scenarios_candidate.py::test_c06_an_invite_for_another_address_is_refused_and_leaks_nothing` | Refusal proved; the link-another-address path is package B. |
| X-17 | cross-role | PARTIAL | `test_scenarios_learner.py::test_l26_a_registration_without_the_age_declaration_is_refused`<br>`test_scenarios_candidate.py::test_c35_an_invited_person_must_have_declared_to_be_adult_at_signup` | Self-declaration only (OI-33). |
| X-18 | cross-role | VERIFIED | `test_scenarios_cross.py::test_x18_all_instants_are_utc_with_a_z_in_every_view` | Every instant is UTC with a Z. |
| X-19 | cross-role | EXTERNAL | none | Accessibility and accommodation need a browser audit and a product decision (C-30). |
| X-20 | cross-role | EXTERNAL | none | Needs the deployed stack: run scripts/e2e-live-journeys.mjs after the deploy (docs/runbooks/live-e2e-journeys.md). |
| X-21 | cross-role | MISSING-OWNED-BY-B | `test_scenarios_candidate.py::test_c24_a_withdrawal_locks_the_attempt_destroys_the_instance_and_can_be_undone_inside_the_window` | No consent `withdrawn` record and no company notice. |
