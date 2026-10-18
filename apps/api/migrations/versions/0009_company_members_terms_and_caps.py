"""Company members, terms and invite caps (story P-19, FR-ORG-03, FR-ORG-05, FR-ORG-07, FR-ORG-08): join_requests, dpa_acceptances, organizations.domain_claim and invite_cap.

Revision ID: 0009
Revises: 0008
Created: 2026-10-18 (story P-19)
Owner module: orgs (stream P).

`join_requests` and `dpa_acceptances` are company tables: row-level security as in migration 0001 (a row is visible only when its company is the one in
scope), and the requester may also read their own join request (policy `own_join_request`, read only, like `own_membership` of migration 0008).
`dpa_acceptances` is append-only for the application role (SELECT and INSERT): an acceptance is a record, not a setting. `organizations.domain_claim` is the work
email domain a company claims (a unique partial index: one company per domain), so the next recruiter of that domain asks to join instead of starting a company; the
service reads it through the admin-visible read of migration 0008. `organizations.invite_cap` is the admin's override of the daily invite cap of one company; NULL means
the global setting. (A separate lookup table was tried first and dropped: a new table in `contracts/db/table-owners.yaml` is a contract change that the contract rules treat as breaking.)
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

ORG_TABLES = {"join_requests": "org_id", "dpa_acceptances": "org_id"}


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    op.add_column("organizations", sa.Column("domain_claim", sa.String(253)))
    op.create_index("uq_organizations_domain_claim", "organizations", ["domain_claim"], unique=True, postgresql_where=sa.text("domain_claim IS NOT NULL"))
    op.add_column("organizations", sa.Column("invite_cap", sa.Integer()))
    op.create_check_constraint("ck_organizations_invite_cap", "organizations", "invite_cap IS NULL OR invite_cap >= 0")
    op.create_table(
        "join_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("status", sa.String(10), nullable=False, server_default="requested"),
        sa.Column("decided_by", sa.String(32)),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name="pk_join_requests"),
        sa.CheckConstraint("status IN ('requested', 'approved', 'rejected')", name="ck_join_requests_status"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE", name="fk_join_requests_org_id_organizations"),
    )
    op.create_index("ix_join_requests_org_id", "join_requests", ["org_id"])
    op.create_index("ix_join_requests_user_id", "join_requests", ["user_id"])
    op.create_index("uq_join_requests_open", "join_requests", ["org_id", "user_id"], unique=True, postgresql_where=sa.text("status = 'requested'"))
    op.create_table(
        "dpa_acceptances",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.String(32), nullable=False),
        sa.Column("terms_version", sa.String(16), nullable=False),
        sa.Column("terms_sha256", sa.String(64), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_dpa_acceptances"),
        sa.UniqueConstraint("org_id", "terms_version", name="uq_dpa_acceptances_org_version"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE", name="fk_dpa_acceptances_org_id_organizations"),
    )
    for table, column in ORG_TABLES.items():
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        rule = f"{column}::text = current_setting('vulnmart.org_id', true)"
        op.execute(f"CREATE POLICY org_scope ON {table} USING ({rule}) WITH CHECK ({rule})")
    op.execute("CREATE POLICY own_join_request ON join_requests FOR SELECT USING (user_id = current_setting('vulnmart.user_id', true))")
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT, UPDATE ON join_requests TO {role}';
          EXECUTE 'GRANT SELECT, INSERT ON dpa_acceptances TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_table("dpa_acceptances")
    op.drop_index("uq_join_requests_open", table_name="join_requests")
    op.drop_index("ix_join_requests_user_id", table_name="join_requests")
    op.drop_index("ix_join_requests_org_id", table_name="join_requests")
    op.drop_table("join_requests")
    op.drop_constraint("ck_organizations_invite_cap", "organizations", type_="check")
    op.drop_column("organizations", "invite_cap")
    op.drop_index("uq_organizations_domain_claim", table_name="organizations")
    op.drop_column("organizations", "domain_claim")
