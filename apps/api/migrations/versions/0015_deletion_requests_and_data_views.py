"""Deletion requests and view history (story P-25, FR-PRV-08, 09, 11): the tables `deletion_requests` and `data_views`.

Revision ID: 0015
Revises: 0014
Created: 2026-10-19 (story P-25)
Owner modules: privacy (stream P).

- `deletion_requests`: a learner's request (held 7 days, undo any time) or a candidate's request for one attempt (the company decides, then 7 days). The application role may
  insert and select, and update the five columns that move a request on; it cannot change who asked or what for. Two partial unique indexes allow one open request per learner and
  one per candidate and attempt. No foreign key to `users`: the job must not fail on a user already gone.
- `data_views`: one row per company-level view of a candidate's data (company, action, time). Insert, select and delete (the history goes with the person's data and after 12 months);
  never an update.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    op.create_table(
        "deletion_requests",
        sa.Column("id", sa.String(18), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("attempt_id", sa.String(40)),
        sa.Column("org_id", sa.String(40)),
        sa.Column("status", sa.String(10), nullable=False, server_default="pending"),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decide_by", sa.DateTime(timezone=True)),
        sa.Column("escalated_at", sa.DateTime(timezone=True)),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("execute_after", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint("id", name="pk_deletion_requests"),
        sa.CheckConstraint("kind IN ('learner', 'candidate')", name="ck_deletion_requests_kind"),
        sa.CheckConstraint("status IN ('pending', 'approved', 'declined', 'cancelled', 'done')", name="ck_deletion_requests_status"),
        sa.CheckConstraint("kind = 'learner' OR (attempt_id IS NOT NULL AND org_id IS NOT NULL)", name="ck_deletion_requests_candidate_target"),
    )
    op.create_index("uq_deletion_requests_open_learner", "deletion_requests", ["user_id"], unique=True,
                    postgresql_where=sa.text("kind = 'learner' AND status IN ('pending', 'approved')"))
    op.create_index("uq_deletion_requests_open_candidate", "deletion_requests", ["user_id", "attempt_id"], unique=True,
                    postgresql_where=sa.text("kind = 'candidate' AND status IN ('pending', 'approved')"))
    op.create_index("ix_deletion_requests_user_id", "deletion_requests", ["user_id", "requested_at"])
    op.create_index("ix_deletion_requests_org_id", "deletion_requests", ["org_id", "status"])
    op.create_table(
        "data_views",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("candidate_user_id", sa.String(32), nullable=False),
        sa.Column("org_id", sa.String(40), nullable=False),
        sa.Column("org_name", sa.String(120), nullable=False),
        sa.Column("action", sa.String(10), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_data_views"),
        sa.CheckConstraint("action IN ('viewed', 'exported')", name="ck_data_views_action"),
    )
    op.create_index("ix_data_views_candidate_user_id_at", "data_views", ["candidate_user_id", "at"])
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT ON deletion_requests TO {role}';
          EXECUTE 'GRANT UPDATE (status, escalated_at, decided_at, execute_after, finished_at) ON deletion_requests TO {role}';
          EXECUTE 'GRANT SELECT, INSERT, DELETE ON data_views TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_table("data_views")
    op.drop_table("deletion_requests")
