"""The email outbox table (story P-09, FR-NTF-02).

Revision ID: 0002
Revises: 0001
Created: 2026-10-17 (story P-09)
Owner module: notifications (stream P).

Not org-scoped: an email belongs to a user, not to a company, and holds no address (the worker looks it up). The app role gets row
rights like the tables of 0001; the table is declared in contracts/db/table-owners.yaml since sprint zero.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    op.create_table(
        "email_outbox",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("template", sa.String(64), nullable=False),
        sa.Column("to_user_id", sa.String(32), nullable=False),
        sa.Column("params", postgresql.JSONB(), nullable=False),
        sa.Column("state", sa.String(8), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("claimed_until", sa.DateTime(timezone=True)),
        sa.Column("last_error_code", sa.String(32)),
        sa.Column("provider_message_id", sa.String(255)),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_email_outbox"),
        sa.CheckConstraint("state IN ('pending', 'sent', 'failed')", name="ck_email_outbox_state"),
        sa.CheckConstraint("attempts >= 0", name="ck_email_outbox_attempts"),
    )
    op.create_index("ix_email_outbox_state_next_attempt_at", "email_outbox", ["state", "next_attempt_at"])
    op.create_index("ix_email_outbox_sent_at", "email_outbox", ["sent_at"])
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON email_outbox TO {role}';
          EXECUTE 'GRANT USAGE ON SEQUENCE email_outbox_id_seq TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_index("ix_email_outbox_sent_at", table_name="email_outbox")
    op.drop_index("ix_email_outbox_state_next_attempt_at", table_name="email_outbox")
    op.drop_table("email_outbox")
