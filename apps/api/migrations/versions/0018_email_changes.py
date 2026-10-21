"""Pending email changes (WP-B, FR-ACC-09): the table `email_changes`.

Revision ID: 0018
Revises: 0017
Created: 2026-10-21 (work package B)
Owner module: accounts.

One row per account at most: the new address, the hash of the single-use link that was mailed to it, and when the link ends. The account's own address changes only when
the link is used. The application role may insert, select, update and delete (a new request replaces the row; using the link removes it).
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    op.create_table(
        "email_changes",
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("new_email", sa.String(254), nullable=False),
        sa.Column("new_email_ci", sa.String(254), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("user_id", name="pk_email_changes"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE", name="fk_email_changes_user_id_users"),
        sa.UniqueConstraint("token_hash", name="uq_email_changes_token_hash"),
    )
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON email_changes TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_table("email_changes")