"""Accepting invites (story P-21, FR-ASM-04, FR-ASM-05): invites.user_id, attempt_id, generation, supersedes_attempt_id, and the policy `own_invite`.

Revision ID: 0012
Revises: 0011
Created: 2026-10-18 (story P-21)
Owner module: assessments (stream P).

`user_id` is the candidate account an invite is bound to once their verified address matched; `attempt_id` is the id the attempt will have (given out at binding, named by
the consent record, unique); `generation` counts re-invites (a re-invite is a new attempt); `supersedes_attempt_id` names the earlier attempt a re-invite replaces. The policy
`own_invite` lets a signed-in candidate read the invite that names them with no company in scope (read only, like `own_membership` of migration 0008 and `own_join_request`
of 0009): the consent routes need it, because a candidate has no company.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("invites", sa.Column("user_id", sa.String(32)))
    op.add_column("invites", sa.Column("attempt_id", sa.String(40)))
    op.add_column("invites", sa.Column("generation", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("invites", sa.Column("supersedes_attempt_id", sa.String(40)))
    op.create_index("uq_invites_attempt_id", "invites", ["attempt_id"], unique=True, postgresql_where=sa.text("attempt_id IS NOT NULL"))
    op.create_index("ix_invites_user_id", "invites", ["user_id"])
    op.execute("CREATE POLICY own_invite ON invites FOR SELECT USING (user_id = current_setting('vulnmart.user_id', true))")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS own_invite ON invites")
    op.drop_index("ix_invites_user_id", table_name="invites")
    op.drop_index("uq_invites_attempt_id", table_name="invites")
    op.drop_column("invites", "supersedes_attempt_id")
    op.drop_column("invites", "generation")
    op.drop_column("invites", "attempt_id")
    op.drop_column("invites", "user_id")
