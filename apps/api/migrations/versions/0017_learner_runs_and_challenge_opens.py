"""Learner runs and the per-challenge countdown (stream L, decisions of the developer, 2026-10-20).

Revision ID: 0017
Revises: 0016
Created: 2026-10-20
Owner module: attempts (stream L).

Two changes:

* `attempts` allowed one attempt per `(user_id, template_id)` for ever, so a learner whose run had ended (all challenges done, or timed out) had no way to start again.
  The unique constraint is replaced by one partial unique index that holds for a company attempt in any state (one attempt per invite, it never restarts) and for an
  UNFINISHED practice run (state ready, running or expired). A finished practice run (submitted, reported, withdrawn, cancelled, deleted) no longer holds the pair, so the
  learner can start a new run and the old one stays as history.
* `challenge_opens`: when a learner began each challenge of a sequenced run, the start of its countdown (Easy 20, Medium 40, Hard 60 minutes). One row per attempt and challenge,
  written once. The application role may insert, select and delete (the purge of an attempt's data).

The downgrade refuses to run when a learner already has more than one attempt for a template, because the old constraint could not hold.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

CURRENT = "org_id IS NOT NULL OR state IN ('ready', 'running', 'expired')"


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    op.drop_constraint("uq_attempts_user_id_template_id", "attempts", type_="unique")
    op.create_index("uq_attempts_current", "attempts", ["user_id", "template_id"], unique=True, postgresql_where=sa.text(CURRENT))
    op.create_table(
        "challenge_opens",
        sa.Column("attempt_id", sa.String(64), nullable=False),
        sa.Column("challenge_key", sa.String(16), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["attempt_id"], ["attempts.id"], name=op.f("fk_challenge_opens_attempt_id_attempts"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("attempt_id", "challenge_key", name="pk_challenge_opens"),
    )
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT, DELETE ON challenge_opens TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_table("challenge_opens")
    op.drop_index("uq_attempts_current", table_name="attempts")
    dup = op.get_bind().execute(sa.text("SELECT 1 FROM attempts GROUP BY user_id, template_id HAVING count(*) > 1 LIMIT 1")).first()
    if dup is not None:
        raise RuntimeError("cannot restore the one-attempt constraint: a learner has more than one attempt for a template")
    op.create_unique_constraint("uq_attempts_user_id_template_id", "attempts", ["user_id", "template_id"])
