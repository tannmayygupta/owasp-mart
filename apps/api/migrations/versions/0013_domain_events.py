"""The domain-event outbox of the live updates (story P-22, FR-LIV-01, FR-LIV-06): table `domain_events`.

Revision ID: 0013
Revises: 0012
Created: 2026-10-18 (story P-22)
Owner module: live (stream P); the table is already listed for that owner in contracts/db/table-owners.yaml.

One row per published IF-3 event, written in the transaction of its cause and read by the relay that appends it to the Valkey streams. The application role may read,
add and mark rows and delete the old ones (the retention job of story P-24 clears published rows); it may not change what an event says: only the three relay columns
are updatable. Not a company table: an event names an attempt and the relay finds the audiences from it, so there is no row-level policy and nothing a company or a user
could read through a query (the browser only ever reads the streams).
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    json_type = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
    op.create_table(
        "domain_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("type", sa.String(40), nullable=False),
        sa.Column("payload", json_type, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("relay_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("dropped", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.PrimaryKeyConstraint("id", name="pk_domain_events"),
    )
    op.create_index("ix_domain_events_unpublished", "domain_events", ["id"], postgresql_where=sa.text("published_at IS NULL"))
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT, DELETE ON domain_events TO {role}';
          EXECUTE 'GRANT UPDATE (published_at, relay_attempts, dropped) ON domain_events TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_table("domain_events")
