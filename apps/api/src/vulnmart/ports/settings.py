"""SettingsPort: timeouts and caps (IF-9, provided by stream P).

Settings are a closed list: a name that is not in `SETTINGS` is a programming error (UnknownSetting), so a typo
never silently reads a default. The defaults are the placeholders of the requirements; the admin changes the
values in the `settings` table later (FR-ADM).
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

# name -> default. The type of the default is the type of the setting.
SETTINGS: dict[str, int | bool | str] = {
    "session_idle_minutes": 30,  # FR-ACC-04
    "session_idle_minutes_admin": 15,  # FR-ACC-04
    "session_absolute_hours": 12,  # FR-ACC-04
    "instance_idle_minutes": 30,  # FR-INS (placeholder until spike S-4)
    "instance_max_minutes": 240,  # FR-INS (placeholder)
    "instance_company_cap": 5,  # FR-ADM-05, OI-21 (placeholder, story P-28): live instances one company may hold together
    "instance_total_cap": 20,  # FR-ADM-05, OI-21 (placeholder, story P-28): live instances on the whole platform (the global cap)
    "hints_enabled_default": True,
    "evidence_max_bytes": 8192,  # FR-DET-03
    "learner_evidence_days": 30,  # FR-PRV-06
    "candidate_retention_days": 180,  # FR-PRV-04
    "consent_withdraw_undo_days": 7,  # FR-PRV-08
    "deletion_decide_days": 14,  # FR-PRV-08 (placeholder from RS-H): the company is asked to decide a candidate's deletion request within this many days, then the admins are told
    "rate_deletion_per_user_per_day": 10,  # story P-25 (placeholder): deletion requests and undos from one account; a person has one open request, so this only stops a script
    "consent_record_extra_months": 12,  # FR-PRV-02, OI-37 (developer's answer 2026-10-18; [LAWYER] review pending): the short consent record outlives the assessment record by this
    "rate_consent_per_user_per_hour": 30,  # FR-PRV-02 (placeholder): consent decisions from one account; a person decides once per attempt
    "invite_cap_per_company_per_day": 50,  # FR-ORG-08 (placeholder, to be tuned against email limits NFR-CST-02): invites one company may send a day; an admin can set another number for one company
    "flag_submit_per_minute": 10,  # FR-FLG (placeholder)
    "rate_login_per_ip_per_hour": 60,  # FR-ACC-10 (placeholder): every login attempt from one visitor address
    "login_failures_per_window": 10,  # FR-ACC-08, FR-ACC-10 (placeholder): wrong passwords for one address before it waits
    "login_failure_window_minutes": 15,  # how long that wait lasts: a back-off, never a permanent lockout (FR-ACC-08)
    "email_token_hours": 24,  # FR-ACC-02, FR-ACC-08: how long a verification or reset link works (placeholder, to be tuned)
    "rate_signup_per_ip_per_hour": 30,  # FR-ACC-10 (placeholders; a college lab can share one address, so not tighter)
    "rate_signup_per_email_per_hour": 3,  # FR-ACC-10: also bounds how many "already registered" mails one address can receive
    "rate_reset_request_per_ip_per_hour": 30,  # FR-ACC-10 (placeholder): password-reset requests from one visitor address
    "rate_reset_request_per_email_per_hour": 3,  # FR-ACC-10 (placeholder): also bounds the reset mails one address can receive
    "rate_verify_per_ip_per_hour": 30,  # FR-ACC-10: guesses at link tokens (verification and reset links)
    "rate_resend_per_email_per_hour": 3,  # FR-ACC-10
    "learner_retention_months": 12,  # FR-PRV-05: a learner's data goes this many months after the last login
    "learner_warning_days": 30,  # FR-PRV-05: the warning email comes this many days before
    "session_details_days": 90,  # FR-PRV-14: network prefix and browser class of a session are dropped after this long (the session row goes with them)
    "log_retention_months": 12,  # FR-PRV-15: security and system logs, at least 12 (the database function refuses a shorter time for the audit log)
    "invite_token_purge_days": 7,  # FR-PRV-18: the token hash of a closed invite is emptied this long after it closed
    "domain_event_days": 7,  # story P-24: published rows of the live-update outbox are deleted after this long (the replay buffer holds an hour)
    "outbox_failed_address_days": 30,  # story P-24: the sealed address of a mail that never left is cleared after this long
    "email_daily_cap": 300,  # FR-NTF-02: mails sent per UTC day; 0 = no cap. Brevo free plan: 300 a day (unconfirmed for API mail)
}


@runtime_checkable
class SettingsPort(Protocol):
    def get(self, name: str) -> int | bool | str:
        """The current value. Raises UnknownSetting for a name that is not in `SETTINGS`."""
        ...
