"""Retention (story P-24, FR-PRV-04, 05, 14, 15, 18): users.retention_warned_at, consent_records.erase_after, invites DELETE, and two privileged functions.

Revision ID: 0014
Revises: 0013
Created: 2026-10-19 (story P-24)
Owner modules: accounts, privacy, assessments, kernel (stream P).

- `users.retention_warned_at`: when a learner's retention warning was queued (a login clears it, so a login before the date cancels the deletion).
- `consent_records.erase_after`: set when the assessment record is deleted: the short consent record outlives it by `consent_record_extra_months` (OI-37). The
  application role may update this one column and nothing else of a record.
- `invites`: the application role may now DELETE (row-level security still applies): the retention job deletes the invites of deleted assessment records.
- `security_events` (stream L's table, insert-only in migration 0011): the application role may now DELETE, because the security and system logs are purged after 12 months (FR-PRV-15).
- `purge_audit_log(before)`: deletes the audit rows older than `before` but never newer than 12 months and never the newest entry, in one transaction that first writes the checkpoint (the hash of
  the last purged row) so the chain still verifies from the next row. SECURITY DEFINER, so the application role keeps SELECT and INSERT only on the log itself.
- `purge_consent_records()`: deletes the consent records whose `erase_after` has passed and nothing else.
Both functions refuse to do more than their name says whatever their caller passes; they are executable by the application role and nobody else.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


PURGE_AUDIT = """
CREATE FUNCTION purge_audit_log(p_before timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  cutoff timestamptz;
  first_keep bigint;
  last_seq bigint;
  last_hash text;
  first_seq bigint;
  head_seq bigint;
  removed bigint;
BEGIN
  cutoff := LEAST(p_before, now() - interval '12 months');
  SELECT min(seq) INTO first_seq FROM audit_log;
  IF first_seq IS NULL THEN
    RETURN 0;
  END IF;
  SELECT max(seq) INTO head_seq FROM audit_log;
  SELECT min(seq) INTO first_keep FROM audit_log WHERE at >= cutoff;
  IF first_keep IS NULL THEN
    last_seq := head_seq - 1;  -- the newest entry always stays: the next entry chains to it, and the log is never empty
  ELSE
    last_seq := first_keep - 1;
  END IF;
  IF last_seq < first_seq THEN
    RETURN 0;
  END IF;
  SELECT row_hash INTO last_hash FROM audit_log WHERE seq = last_seq;
  IF last_hash IS NULL THEN
    RAISE EXCEPTION 'the audit log has no entry %', last_seq;
  END IF;
  INSERT INTO audit_checkpoint (seq, hash, reason) VALUES (last_seq, last_hash, 'retention') ON CONFLICT (seq) DO NOTHING;
  DELETE FROM audit_log WHERE seq <= last_seq;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$fn$;
"""

PURGE_CONSENT = """
CREATE FUNCTION purge_consent_records() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM consent_records WHERE erase_after IS NOT NULL AND erase_after <= now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$fn$;
"""


def upgrade() -> None:
    op.add_column("users", sa.Column("retention_warned_at", sa.DateTime(timezone=True)))
    op.add_column("consent_records", sa.Column("erase_after", sa.DateTime(timezone=True)))
    op.create_index("ix_consent_records_erase_after", "consent_records", ["erase_after"], postgresql_where=sa.text("erase_after IS NOT NULL"))
    op.execute(PURGE_AUDIT)
    op.execute(PURGE_CONSENT)
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT DELETE ON invites TO {role}';
          EXECUTE 'GRANT DELETE ON security_events TO {role}';
          EXECUTE 'GRANT UPDATE (erase_after) ON consent_records TO {role}';
          EXECUTE 'REVOKE ALL ON FUNCTION purge_audit_log(timestamptz) FROM PUBLIC';
          EXECUTE 'REVOKE ALL ON FUNCTION purge_consent_records() FROM PUBLIC';
          EXECUTE 'GRANT EXECUTE ON FUNCTION purge_audit_log(timestamptz) TO {role}';
          EXECUTE 'GRANT EXECUTE ON FUNCTION purge_consent_records() TO {role}';
        END $$;
    """)


def downgrade() -> None:
    role = app_role()
    op.execute("DROP FUNCTION IF EXISTS purge_consent_records()")
    op.execute("DROP FUNCTION IF EXISTS purge_audit_log(timestamptz)")
    op.execute(f"REVOKE DELETE ON invites FROM {role}")
    op.execute(f"REVOKE DELETE ON security_events FROM {role}")
    op.drop_index("ix_consent_records_erase_after", table_name="consent_records")
    op.drop_column("consent_records", "erase_after")
    op.drop_column("users", "retention_warned_at")
