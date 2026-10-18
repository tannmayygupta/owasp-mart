"""Two read-only policies (story P-18, FR-ORG-02): an admin may read the company directory, and a person may read their own membership.

Revision ID: 0008
Revises: 0007
Created: 2026-10-18 (story P-18)
Owner module: orgs (stream P).

The approval queue lists pending companies of every company, which the one policy of migration 0001 (a row is visible only when its id is the
organisation in scope) forbids. The session of an admin scope that acts for no company sets the transaction setting `vulnmart.admin` to `on` (see
`vulnmart.kernel.db`), and this policy lets exactly that setting read `organizations`. It is a read only: every write still needs the company in
scope. `org_members` and every later table that holds candidate data get no such admin policy (the privacy wall of FR-DSH-06). The second policy lets a person read only the
`org_members` rows that name them (the session sets `vulnmart.user_id`), so "which company am I in" can be answered before any company is in scope.
"""
from __future__ import annotations

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE POLICY admin_read ON organizations FOR SELECT USING (current_setting('vulnmart.admin', true) = 'on')")
    # A person may read their own membership rows without a company in scope ("which company am I in"); `vulnmart.user_id` is set by the session.
    op.execute("CREATE POLICY own_membership ON org_members FOR SELECT USING (user_id = current_setting('vulnmart.user_id', true))")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS own_membership ON org_members")
    op.execute("DROP POLICY IF EXISTS admin_read ON organizations")
