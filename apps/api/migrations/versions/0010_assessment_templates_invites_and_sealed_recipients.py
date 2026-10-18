"""Assessment templates and invites (story P-20, FR-ASM-01 to 03): assessment_templates, template_challenges, invites, and email_outbox.to_address_sealed.

Revision ID: 0010
Revises: 0009
Created: 2026-10-18 (story P-20)
Owner modules: assessments (the three tables), notifications (the outbox column).

The three assessment tables are company tables: row-level security as in migration 0001 (a row is visible only when its company is the one in scope).
`invites` is updated in place (state, token on a resend) and never deleted by the application role; the invite purge of story P-24 empties `token_hash`.
`email_outbox.to_address_sealed` holds the address of a person with no account (an invited candidate), sealed with the field key and bound to the invite id,
and is cleared when the mail has left; an outbox row never holds an address in clear (ADR 0040).
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

ORG_TABLES = ("assessment_templates", "template_challenges", "invites")
LIVE = "('created', 'sent', 'opened', 'consented')"


def app_role() -> str:
    role = os.environ.get("VULNMART_APP_ROLE", "vulnmart_app")
    if not role.replace("_", "").isalnum() or not role[0].isalpha():
        raise SystemExit(f"VULNMART_APP_ROLE {role!r} is not a plain role name")
    return role


def upgrade() -> None:
    op.add_column("email_outbox", sa.Column("to_address_sealed", sa.Text()))
    json_type = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
    op.create_table(
        "assessment_templates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("time_limit_min", sa.Integer(), nullable=False),
        sa.Column("hints_mode", sa.String(3), nullable=False, server_default="off"),
        sa.Column("hint_cost_pct", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reset_limit", sa.Integer(), nullable=False),
        sa.Column("invite_expiry_days", sa.Integer(), nullable=False),
        sa.Column("retention_days", sa.Integer(), nullable=False),
        sa.Column("settings", json_type, nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_assessment_templates"),
        sa.CheckConstraint("hints_mode IN ('off', 'on')", name="ck_assessment_templates_hints_mode"),
        sa.CheckConstraint("time_limit_min BETWEEN 30 AND 480", name="ck_assessment_templates_time_limit_min"),
        sa.CheckConstraint("hint_cost_pct BETWEEN 0 AND 100", name="ck_assessment_templates_hint_cost_pct"),
        sa.CheckConstraint("reset_limit BETWEEN 0 AND 10", name="ck_assessment_templates_reset_limit"),
        sa.CheckConstraint("invite_expiry_days BETWEEN 1 AND 30", name="ck_assessment_templates_invite_expiry_days"),
        sa.CheckConstraint("retention_days BETWEEN 30 AND 365", name="ck_assessment_templates_retention_days"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE", name="fk_assessment_templates_org_id_organizations"),
    )
    op.create_index("ix_assessment_templates_org_id", "assessment_templates", ["org_id"])
    op.create_table(
        "template_challenges",
        sa.Column("template_id", sa.Uuid(), nullable=False),
        sa.Column("challenge_key", sa.String(8), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint("template_id", "challenge_key", name="pk_template_challenges"),
        sa.ForeignKeyConstraint(["template_id"], ["assessment_templates.id"], ondelete="CASCADE", name="fk_template_challenges_template_id_assessment_templates"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE", name="fk_template_challenges_org_id_organizations"),
    )
    op.create_index("ix_template_challenges_org_id", "template_challenges", ["org_id"])
    op.create_table(
        "invites",
        sa.Column("id", sa.String(18), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("template_id", sa.Uuid(), nullable=False),
        sa.Column("template_version", sa.Integer(), nullable=False),
        sa.Column("rules", json_type, nullable=False),
        sa.Column("email_ci", sa.String(254), nullable=False),
        sa.Column("token_hash", sa.String(64)),
        sa.Column("state", sa.String(10), nullable=False, server_default="created"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("superseded_by", sa.String(18)),
        sa.Column("outbox_id", sa.BigInteger()),
        sa.Column("created_by", sa.String(32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("opened_at", sa.DateTime(timezone=True)),
        sa.Column("consented_at", sa.DateTime(timezone=True)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("closed_at", sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint("id", name="pk_invites"),
        sa.CheckConstraint("state IN ('created', 'sent', 'opened', 'consented', 'started', 'expired', 'cancelled', 'declined', 'revoked')", name="ck_invites_state"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE", name="fk_invites_org_id_organizations"),
        sa.ForeignKeyConstraint(["template_id"], ["assessment_templates.id"], name="fk_invites_template_id_assessment_templates"),
    )
    op.create_index("ix_invites_template_id", "invites", ["template_id"])
    op.create_index("uq_invites_token_hash", "invites", ["token_hash"], unique=True)
    op.create_index("uq_invites_live_email", "invites", ["template_id", "email_ci"], unique=True, postgresql_where=sa.text(f"state IN {LIVE}"))
    op.create_index("ix_invites_org_state", "invites", ["org_id", "state"])
    for table in ORG_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        rule = "org_id::text = current_setting('vulnmart.org_id', true)"
        op.execute(f"CREATE POLICY org_scope ON {table} USING ({rule}) WITH CHECK ({rule})")
    role = app_role()
    op.execute(f"""
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
            RAISE EXCEPTION 'role {role} does not exist: see migration 0001';
          END IF;
          EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON assessment_templates TO {role}';
          EXECUTE 'GRANT SELECT, INSERT, DELETE ON template_challenges TO {role}';
          EXECUTE 'GRANT SELECT, INSERT, UPDATE ON invites TO {role}';
        END $$;
    """)


def downgrade() -> None:
    op.drop_table("invites")
    op.drop_table("template_challenges")
    op.drop_table("assessment_templates")
    op.drop_column("email_outbox", "to_address_sealed")
