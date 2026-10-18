"""Organisation tables (architecture 04 section 2.2; owner `orgs`): the first org-scoped tables.

Both are org-scoped (`kernel.db.org_scoped`): a query needs an organisation in scope, and row-level security in
Postgres hides every other company's rows. `organizations` is scoped by its own `id`. User ids are the contracts'
`u-` ids as text; the foreign key to `users` is added with the accounts tables.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from vulnmart.kernel.db import Base, org_scoped

ORG_STATUSES = ("pending", "active", "rejected", "suspended", "deleted")  # architecture 04 section 10.5


@org_scoped("id", admin_visible=True)  # an admin reads the company directory across companies (story P-18); org_members stay company-only
class Organization(Base):
    __tablename__ = "organizations"
    __table_args__ = (CheckConstraint("status IN ('pending', 'active', 'rejected', 'suspended', 'deleted')", name="status"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email_domain: Mapped[str] = mapped_column(String(253), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="pending")
    owner_user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    rejected_reason: Mapped[str | None] = mapped_column(Text)
    suspended_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


@org_scoped("org_id", self_column="user_id")  # a member reads their own membership without a company in scope (story P-18)
class OrgMember(Base):
    __tablename__ = "org_members"
    __table_args__ = (
        CheckConstraint("role IN ('owner', 'member')", name="role"),
        CheckConstraint("status IN ('active', 'removed')", name="status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(8), nullable=False)
    status: Mapped[str] = mapped_column(String(8), nullable=False, server_default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
