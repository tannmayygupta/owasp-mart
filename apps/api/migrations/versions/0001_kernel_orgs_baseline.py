"""Baseline: kernel tables (settings, quotas, job_runs) and the first org-scoped tables (organizations, org_members).

Revision ID: 0001
Revises: (none, the root of the one history)
Created: 2026-10-12 (story P-06)
Owner module(s): kernel (settings, quotas, job_runs) and orgs (organizations, org_members); both stream P.

Organisation scope in Postgres (ADR 0014): row-level security is enabled AND forced on the two org tables, and the
policy compares each row with the per-transaction setting `vulnmart.org_id` that the API's session sets. An unset or
empty setting matches no row. The app role (VULNMART_APP_ROLE, default `vulnmart_app`) gets row rights only: it owns
nothing and has no BYPASSRLS (it is created by the Compose init script or by the operator before migrating; the
migration stops when it does not exist), so the policies bind it.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

ORG_TABLES = {"organizations": "id", "org_members": "org_id"}
APP_TABLES = ("settings", "quotas", "job_runs", "organizations", "org_members")


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def _ts(name: str, *, nullable: bool = False, default: bool = True) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), server_default=sa.func.now() if default else None, nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "settings",
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("value", postgresql.JSONB(), nullable=False),
        sa.Column("updated_by", sa.String(64)),
        _ts("created_at"),
        _ts("updated_at"),
        sa.PrimaryKeyConstraint("key", name="pk_settings"),
    )
    op.create_table(
        "quotas",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scope", sa.String(8), nullable=False),
        sa.Column("scope_id", sa.String(64)),
        sa.Column("max_instances", sa.Integer(), nullable=False),
        _ts("created_at"),
        _ts("updated_at"),
        sa.PrimaryKeyConstraint("id", name="pk_quotas"),
        sa.CheckConstraint("scope IN ('user', 'org', 'global')", name="ck_quotas_scope"),
        sa.CheckConstraint("(scope = 'global') = (scope_id IS NULL)", name="ck_quotas_global_has_no_scope_id"),
        sa.CheckConstraint("max_instances >= 0", name="ck_quotas_max_instances"),
        sa.UniqueConstraint("scope", "scope_id", name="uq_quotas_scope_scope_id", postgresql_nulls_not_distinct=True),
    )
    op.create_table(
        "job_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("job", sa.String(64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("detail", sa.Text()),
        _ts("created_at"),
        _ts("updated_at"),
        sa.PrimaryKeyConstraint("id", name="pk_job_runs"),
        sa.CheckConstraint("status IN ('running', 'succeeded', 'failed')", name="ck_job_runs_status"),
    )
    op.create_index("ix_job_runs_job", "job_runs", ["job"])
    op.create_table(
        "organizations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("email_domain", sa.String(253), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("owner_user_id", sa.String(32), nullable=False),
        sa.Column("rejected_reason", sa.Text()),
        sa.Column("suspended_reason", sa.Text()),
        _ts("created_at"),
        _ts("updated_at"),
        sa.PrimaryKeyConstraint("id", name="pk_organizations"),
        sa.CheckConstraint("status IN ('pending', 'active', 'rejected', 'suspended', 'deleted')", name="ck_organizations_status"),
    )
    op.create_table(
        "org_members",
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("role", sa.String(8), nullable=False),
        sa.Column("status", sa.String(8), nullable=False, server_default="active"),
        _ts("created_at"),
        _ts("updated_at"),
        sa.PrimaryKeyConstraint("org_id", "user_id", name="pk_org_members"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name="fk_org_members_org_id_organizations", ondelete="CASCADE"),
        sa.CheckConstraint("role IN ('owner', 'member')", name="ck_org_members_role"),
        sa.CheckConstraint("status IN ('active', 'removed')", name="ck_org_members_status"),
    )
    op.create_index("ix_org_members_user_id", "org_members", ["user_id"])

    for table, column in ORG_TABLES.items():
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        rule = f"{column}::text = current_setting('vulnmart.org_id', true)"
        op.execute(f"CREATE POLICY org_scope ON {table} USING ({rule}) WITH CHECK ({rule})")

    role = app_role()
    tables = ", ".join(APP_TABLES)
    # Row rights only. A missing role stops the migration (a silent skip would leave an API that can never become ready).
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: create it first (infra/compose/postgres/initdb/10-app-role.sql; on an old Compose volume, remove vulnmart_pg-data) or set VULNMART_APP_ROLE';
          END IF;
          EXECUTE 'GRANT USAGE ON SCHEMA public TO {role}';
          EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON {tables} TO {role}';
        END $$;
    """)


def downgrade() -> None:
    for table in ORG_TABLES:
        op.execute(f"DROP POLICY IF EXISTS org_scope ON {table}")
    op.drop_index("ix_org_members_user_id", table_name="org_members")
    op.drop_table("org_members")
    op.drop_table("organizations")
    op.drop_index("ix_job_runs_job", table_name="job_runs")
    op.drop_table("job_runs")
    op.drop_table("quotas")
    op.drop_table("settings")
