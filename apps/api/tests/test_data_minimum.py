"""Story P-16, FR-PRV-03 (minimum data): what the platform database stores about a person is exactly what the data inventory (PRD section 9) lists.

The columns of every table that can hold data about a person are written out here. A new column on one of them fails this test until the author
adds it below on purpose and adds its row to the inventory in the same change, so nothing is collected by accident. A second test refuses, in every
table, column names that would hold what the consent notice promises is not recorded (screen, camera, microphone, location, exact address,
raw browser string). The lab's own data (attempts, evidence) belongs to stream L and is inventoried by its own stories."""
from __future__ import annotations

import re

import pytest

import vulnmart.accounts.models  # noqa: F401
import vulnmart.kernel.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
import vulnmart.orgs.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from vulnmart.accounts.api import SignupBody
from vulnmart.kernel.db import Base

# table -> (inventory row of PRD section 9 it belongs to, its columns)
INVENTORY = {
    "users": ("Account data: name, email, password hash, age declaration, status, sign-in time",
              {"id", "account_type", "email", "email_ci", "email_verified_at", "password_hash", "display_name", "status", "age_declared_at",
               "last_login_at", "deleted_at", "created_at", "updated_at"}),
    "user_roles": ("Account data: the roles of a participant", {"user_id", "role", "account_type", "created_at"}),
    "sessions": ("Session data: hashed session value, coarse network prefix, browser class, times",
                 {"id_hash", "user_id", "created_at", "last_seen_at", "absolute_expires_at", "revoked_at", "ip_trunc", "ua_class", "mfa_at"}),
    "email_tokens": ("Account data: hashed verification, reset and login-ticket tokens", {"token_hash", "user_id", "purpose", "expires_at", "used_at", "created_at", "attempts"}),
    "mfa_credentials": ("Account data: the sealed second-factor secret", {"user_id", "type", "secret_enc", "enabled_at", "last_used_step", "created_at", "updated_at"}),
    "recovery_codes": ("Account data: keyed hashes of recovery codes", {"code_hash", "user_id", "used_at", "created_at"}),
    "consent_records": ("Consent records: notice version, text snapshot and hash, retention and company shown, hashed address and browser, audit link",
                        {"id", "user_id", "attempt_id", "org_id", "template_id", "notice_version", "notice_text_sha256", "notice_text_snapshot",
                         "retention_days_shown", "controller_name_shown", "action", "at", "ip_hash", "ua_hash", "method", "audit_seq"}),
    "subject_map": ("Audit log: the identity behind a pseudonymous subject id, deleted with the person", {"subject_id", "user_id", "created_at"}),
    "audit_log": ("Audit log: pseudonymous actor and subject, action, details without secrets, hash chain",
                  {"seq", "at", "actor", "action", "subject", "details", "prev_hash", "row_hash"}),
    "audit_checkpoint": ("Audit log: the hash a purge leaves behind", {"seq", "hash", "reason", "created_at"}),
    "audit_anchor": ("Audit log: the daily head hash", {"anchor_date", "head_seq", "head_hash", "anchored_at", "witness"}),
    "email_outbox": ("Email queue: template name, parameters, state; the address is looked up from the user at send time",
                     {"id", "to_user_id", "template", "params", "state", "attempts", "next_attempt_at", "claimed_until", "sent_at", "provider_message_id",
                      "last_error_code", "created_at", "updated_at"}),
    "organizations": ("Company data: name, email domain, status, reasons", {"id", "name", "email_domain", "status", "owner_user_id", "rejected_reason",
                                                                             "suspended_reason", "created_at", "updated_at"}),
    "org_members": ("Company data: who belongs to a company", {"org_id", "user_id", "role", "status", "created_at", "updated_at"}),
}

# What the consent notice says is NOT recorded, and the exact values the notice says are only kept coarsely or as hashes.
FORBIDDEN = re.compile(r"(screen|webcam|camera|microphone|audio|video|keystroke|clipboard|geoloc|latitude|longitude|gps|phone|birth|dob|"
                       r"ip_address|raw_ip|user_agent|fingerprint|device_id|national_id|passport|gender|ethnic|religio|health)", re.I)


def columns(table: str) -> set[str]:
    return {c.name for c in Base.metadata.tables[table].columns}


@pytest.mark.parametrize("table", sorted(INVENTORY))
def test_a_table_about_a_person_holds_exactly_the_inventoried_columns(table):
    row, expected = INVENTORY[table]
    assert columns(table) == expected, f"{table} no longer matches the data inventory row '{row}': update the inventory (PRD section 9) and this test on purpose"


def test_no_table_has_a_column_for_what_the_notice_says_is_not_recorded():
    offenders = [(t, c) for t, table in Base.metadata.tables.items() for c in (col.name for col in table.columns) if FORBIDDEN.search(c)]
    assert offenders == []


def test_every_table_with_a_user_or_email_column_is_in_the_inventory():
    """A new table that points at a person must be listed above (settings, quotas and job runs hold no person data)."""
    person = {t for t, table in Base.metadata.tables.items() if any(re.search(r"user|email|owner", c.name) for c in table.columns)}
    assert person <= set(INVENTORY), sorted(person - set(INVENTORY))


def test_signup_accepts_only_the_listed_fields():
    ok = {"email": "a@example.com", "password": "correct horse battery staple", "display_name": "Ada", "age_declaration": True}
    SignupBody.model_validate(ok)
    for extra in ("phone", "date_of_birth", "address", "gender", "ip_address"):
        with pytest.raises(ValueError):
            SignupBody.model_validate({**ok, extra: "x"})


def test_signup_does_not_store_the_age_only_the_declaration():
    assert "age_declared_at" in columns("users") and not {c for c in columns("users") if re.search(r"age$|^age_|birth|dob", c)} - {"age_declared_at"}
