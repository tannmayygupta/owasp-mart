"""Account tables (story P-11, FR-ACC-01, FR-ACC-02): users, user_roles, email_tokens.

Revision ID: 0003
Revises: 0002
Created: 2026-10-17 (story P-11)
Owner module: accounts (stream P).

Not org-scoped (a person belongs to no company). `user_roles` carries the account type and a composite foreign key to
`users (id, account_type)`, so only a participant can hold a role (FR-ACC-05, architecture 04 section 2.1). The app role gets row
rights, as in 0001 and 0002.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

TABLES = ("users", "user_roles", "email_tokens")


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def _ts(name: str, *, nullable: bool = False, default: bool = True) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), server_default=sa.func.now() if default else None, nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(32), nullable=False),
        sa.Column("account_type", sa.String(12), nullable=False),
        sa.Column("email", sa.String(254), nullable=False),
        sa.Column("email_ci", sa.String(254), nullable=False),
        _ts("email_verified_at", nullable=True, default=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("display_name", sa.String(60), nullable=False),
        sa.Column("status", sa.String(10), nullable=False, server_default="active"),
        _ts("age_declared_at", nullable=True, default=False),
        _ts("last_login_at", nullable=True, default=False),
        _ts("deleted_at", nullable=True, default=False),
        _ts("created_at"),
        _ts("updated_at"),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
        sa.CheckConstraint("account_type IN ('participant', 'recruiter', 'admin')", name="ck_users_account_type"),
        sa.CheckConstraint("status IN ('active', 'disabled', 'deleted')", name="ck_users_status"),
        sa.UniqueConstraint("email_ci", name="uq_users_email_ci"),
        sa.UniqueConstraint("id", "account_type", name="uq_users_id_account_type"),
    )
    op.create_table(
        "user_roles",
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("role", sa.String(10), nullable=False),
        sa.Column("account_type", sa.String(12), nullable=False, server_default="participant"),
        _ts("created_at"),
        sa.PrimaryKeyConstraint("user_id", "role", name="pk_user_roles"),
        sa.CheckConstraint("role IN ('learner', 'candidate')", name="ck_user_roles_role"),
        sa.CheckConstraint("account_type = 'participant'", name="ck_user_roles_participants_only"),
        sa.ForeignKeyConstraint(["user_id", "account_type"], ["users.id", "users.account_type"], ondelete="CASCADE",
                                name="fk_user_roles_user_id_account_type_users"),
    )
    op.create_table(
        "email_tokens",
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("purpose", sa.String(8), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        _ts("used_at", nullable=True, default=False),
        _ts("created_at"),
        sa.PrimaryKeyConstraint("token_hash", name="pk_email_tokens"),
        sa.CheckConstraint("purpose IN ('verify', 'reset')", name="ck_email_tokens_purpose"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE", name="fk_email_tokens_user_id_users"),
    )
    op.create_index("ix_email_tokens_user_id_purpose", "email_tokens", ["user_id", "purpose"])
    role = app_role()
    tables = ", ".join(TABLES)
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON {tables} TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_index("ix_email_tokens_user_id_purpose", table_name="email_tokens")
    op.drop_table("email_tokens")
    op.drop_table("user_roles")
    op.drop_table("users")
