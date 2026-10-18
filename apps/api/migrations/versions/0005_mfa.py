"""Second factor (story P-15, FR-ACC-07): mfa_credentials, recovery_codes, `email_tokens` for the login ticket, and sessions.mfa_at.

Revision ID: 0005
Revises: 0004
Created: 2026-10-18 (story P-15)
Owner module: accounts (stream P).

`mfa_credentials` holds the sealed TOTP secret (never in clear), `recovery_codes` only keyed hashes. The short-lived ticket between the password and the
second factor is a row of the existing `email_tokens` table (purpose `mfa`, new column `attempts`): it needs the same things (a hash, an expiry, one use)
and reusing the table keeps the table list of contracts/db/table-owners.yaml unchanged. `sessions.mfa_at` records when a second factor was proved in
that session: an admin session without it carries no admin role. The app role gets row rights, as in the earlier migrations.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

TABLES = ("mfa_credentials", "recovery_codes")


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def _created() -> sa.Column:
    return sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())


def upgrade() -> None:
    op.add_column("sessions", sa.Column("mfa_at", sa.DateTime(timezone=True)))
    op.add_column("email_tokens", sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"))
    op.drop_constraint("ck_email_tokens_purpose", "email_tokens", type_="check")
    op.create_check_constraint("ck_email_tokens_purpose", "email_tokens", "purpose IN ('verify', 'reset', 'mfa')")
    op.create_table(
        "mfa_credentials",
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("type", sa.String(8), nullable=False, server_default="totp"),
        sa.Column("secret_enc", sa.Text(), nullable=False),
        sa.Column("enabled_at", sa.DateTime(timezone=True)),
        sa.Column("last_used_step", sa.BigInteger()),
        _created(),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("user_id", name="pk_mfa_credentials"),
        sa.CheckConstraint("type IN ('totp')", name="ck_mfa_credentials_type"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE", name="fk_mfa_credentials_user_id_users"),
    )
    op.create_table(
        "recovery_codes",
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        _created(),
        sa.PrimaryKeyConstraint("code_hash", name="pk_recovery_codes"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE", name="fk_recovery_codes_user_id_users"),
    )
    op.create_index("ix_recovery_codes_user_id", "recovery_codes", ["user_id"])
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
    op.drop_index("ix_recovery_codes_user_id", table_name="recovery_codes")
    op.drop_table("recovery_codes")
    op.drop_table("mfa_credentials")
    op.execute("DELETE FROM email_tokens WHERE purpose = 'mfa'")  # the old constraint would refuse them
    op.drop_constraint("ck_email_tokens_purpose", "email_tokens", type_="check")
    op.create_check_constraint("ck_email_tokens_purpose", "email_tokens", "purpose IN ('verify', 'reset')")
    op.drop_column("email_tokens", "attempts")
    op.drop_column("sessions", "mfa_at")
