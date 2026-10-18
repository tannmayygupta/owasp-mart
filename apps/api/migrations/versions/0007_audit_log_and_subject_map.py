"""Audit log (story P-17, FR-PRV-10): audit_log, audit_checkpoint, audit_anchor, and the subject_map behind the pseudonymous ids.

Revision ID: 0007
Revises: 0006
Created: 2026-10-18 (story P-17)
Owner modules: kernel (audit tables), privacy (subject_map).

The application role gets SELECT and INSERT on the three audit tables and on `subject_map`, plus DELETE on `subject_map` (the deletion workflow of
story P-25 removes a person's mapping): it can never update or delete an audit row, a checkpoint or an anchor. The purge of old rows (12 months,
story P-24) needs a privileged path that writes a checkpoint first and is not created here. No foreign keys: the log must outlive every other row.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

APPEND_ONLY = ("audit_log", "audit_checkpoint", "audit_anchor")


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    op.create_table(
        "audit_log",
        sa.Column("seq", sa.BigInteger(), autoincrement=False, nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("actor", sa.String(128), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("subject", sa.String(128)),
        sa.Column("details", sa.Text(), nullable=False),
        sa.Column("prev_hash", sa.String(64), nullable=False),
        sa.Column("row_hash", sa.String(64), nullable=False),
        sa.PrimaryKeyConstraint("seq", name="pk_audit_log"),
        sa.CheckConstraint("seq >= 1", name="ck_audit_log_seq"),
        sa.CheckConstraint("length(row_hash) = 64 AND length(prev_hash) = 64", name="ck_audit_log_hash_length"),
        sa.UniqueConstraint("row_hash", name="uq_audit_log_row_hash"),
    )
    op.create_index("ix_audit_log_subject_seq", "audit_log", ["subject", "seq"])
    op.create_index("ix_audit_log_actor_seq", "audit_log", ["actor", "seq"])
    op.create_index("ix_audit_log_action_seq", "audit_log", ["action", "seq"])
    op.create_table(
        "audit_checkpoint",
        sa.Column("seq", sa.BigInteger(), autoincrement=False, nullable=False),
        sa.Column("hash", sa.String(64), nullable=False),
        sa.Column("reason", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("seq", name="pk_audit_checkpoint"),
    )
    op.create_table(
        "audit_anchor",
        sa.Column("anchor_date", sa.Date(), nullable=False),
        sa.Column("head_seq", sa.BigInteger(), nullable=False),
        sa.Column("head_hash", sa.String(64), nullable=False),
        sa.Column("anchored_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("witness", sa.String(16), nullable=False),
        sa.PrimaryKeyConstraint("anchor_date", name="pk_audit_anchor"),
    )
    op.create_table(
        "subject_map",
        sa.Column("subject_id", sa.String(18), nullable=False),
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("subject_id", name="pk_subject_map"),
        sa.UniqueConstraint("user_id", name="uq_subject_map_user_id"),
    )
    role = app_role()
    append_only = ", ".join(APPEND_ONLY)
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT ON {append_only} TO {role}';
          EXECUTE 'GRANT SELECT, INSERT, DELETE ON subject_map TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_table("subject_map")
    op.drop_table("audit_anchor")
    op.drop_table("audit_checkpoint")
    op.drop_index("ix_audit_log_action_seq", table_name="audit_log")
    op.drop_index("ix_audit_log_actor_seq", table_name="audit_log")
    op.drop_index("ix_audit_log_subject_seq", table_name="audit_log")
    op.drop_table("audit_log")
