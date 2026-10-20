"""Break-glass grants (story P-31, FR-ADM-03): the table `break_glass_sessions`.

Revision ID: 0016
Revises: 0015
Created: 2026-10-20 (story P-31)
Owner module: admin (stream P).

One row per grant: the named admin, the candidate attempt and its company, the written reason, the 15-minute window (D-94), when it was closed, every read (when and what),
and the review by another admin. The application role may insert and select, and update only `closed_at`, `what_read` and the three review columns: it can never change who
opened a grant, for which attempt, why, or when. A check keeps the reviewer different from the grant's admin.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    op.create_table(
        "break_glass_sessions",
        sa.Column("id", sa.String(18), nullable=False),
        sa.Column("admin_id", sa.String(32), nullable=False),
        sa.Column("attempt_id", sa.String(40), nullable=False),
        sa.Column("org_id", sa.String(40), nullable=False),
        sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True)),
        sa.Column("what_read", sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"), server_default="[]", nullable=False),
        sa.Column("reviewed_by", sa.String(32)),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("review_note", sa.String(500)),
        sa.PrimaryKeyConstraint("id", name="pk_break_glass_sessions"),
        sa.CheckConstraint("expires_at > started_at", name="ck_break_glass_sessions_window"),
        sa.CheckConstraint("reviewed_by IS NULL OR reviewed_by <> admin_id", name="ck_break_glass_sessions_other_reviewer"),
    )
    op.create_index("ix_break_glass_sessions_admin_id", "break_glass_sessions", ["admin_id", "started_at"])
    op.create_index("ix_break_glass_sessions_attempt_id", "break_glass_sessions", ["attempt_id"])
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT ON break_glass_sessions TO {role}';
          EXECUTE 'GRANT UPDATE (closed_at, what_read, reviewed_by, reviewed_at, review_note) ON break_glass_sessions TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_table("break_glass_sessions")
