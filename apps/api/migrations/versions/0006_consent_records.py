"""Consent record (story P-16, FR-PRV-02): the append-only `consent_records` table.

Revision ID: 0006
Revises: 0005
Created: 2026-10-18 (story P-16)
Owner module: privacy (stream P).

The application role gets SELECT and INSERT only, so a consent record cannot be changed or removed through the application. There is no
foreign key to `users`, `attempts` or the company table: the record is the proof that a person was asked and must outlive the account (see
`vulnmart.privacy.models`). One partial unique index allows a single granted-or-declined decision per attempt.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    op.create_table(
        "consent_records",
        sa.Column("id", sa.String(18), nullable=False),
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("attempt_id", sa.String(40), nullable=False),
        sa.Column("org_id", sa.String(40)),
        sa.Column("template_id", sa.String(40)),
        sa.Column("notice_version", sa.String(16), nullable=False),
        sa.Column("notice_text_sha256", sa.String(64), nullable=False),
        sa.Column("notice_text_snapshot", sa.Text(), nullable=False),
        sa.Column("retention_days_shown", sa.Integer(), nullable=False),
        sa.Column("controller_name_shown", sa.String(120), nullable=False),
        sa.Column("action", sa.String(10), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("ip_hash", sa.String(64)),
        sa.Column("ua_hash", sa.String(64)),
        sa.Column("method", sa.String(8), nullable=False, server_default="web"),
        sa.Column("audit_seq", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_consent_records"),
        sa.CheckConstraint("action IN ('granted', 'declined', 'withdrawn')", name="ck_consent_records_action"),
        sa.CheckConstraint("method IN ('web')", name="ck_consent_records_method"),
        sa.CheckConstraint("retention_days_shown >= 1", name="ck_consent_records_retention_days_shown"),
    )
    op.create_index("uq_consent_records_decision", "consent_records", ["attempt_id"], unique=True,
                    postgresql_where=sa.text("action IN ('granted', 'declined')"))
    op.create_index("ix_consent_records_user_id_at", "consent_records", ["user_id", "at"])
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT ON consent_records TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_index("ix_consent_records_user_id_at", table_name="consent_records")
    op.drop_index("uq_consent_records_decision", table_name="consent_records")
    op.drop_table("consent_records")
