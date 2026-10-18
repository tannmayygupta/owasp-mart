"""Organisation tables (architecture 04 section 2.2; owner `orgs`): the first org-scoped tables.

Both are org-scoped (`kernel.db.org_scoped`): a query needs an organisation in scope, and row-level security in
Postgres hides every other company's rows. `organizations` is scoped by its own `id`. User ids are the contracts'
`u-` ids as text; the foreign key to `users` is added with the accounts tables.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column

from vulnmart.kernel.db import Base, org_scoped

ORG_STATUSES = ("pending", "active", "rejected", "suspended", "deleted")  # architecture 04 section 10.5


@org_scoped("id", admin_visible=True)  # an admin reads the company directory across companies (story P-18); org_members stay company-only
class Organization(Base):
    __tablename__ = "organizations"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'active', 'rejected', 'suspended', 'deleted')", name="status"),
        CheckConstraint("invite_cap IS NULL OR invite_cap >= 0", name="invite_cap"),
        Index("uq_organizations_domain_claim", "domain_claim", unique=True, postgresql_where=text("domain_claim IS NOT NULL"),
              sqlite_where=text("domain_claim IS NOT NULL")),  # one company claims a work domain
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email_domain: Mapped[str] = mapped_column(String(253), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="pending")
    owner_user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    rejected_reason: Mapped[str | None] = mapped_column(Text)
    suspended_reason: Mapped[str | None] = mapped_column(Text)
    # The work email domain this company claims (story P-19, FR-ORG-03): the next recruiter of that domain asks to join instead of starting a company. NULL for
    # free webmail (never claimed), for a rejected company and for a deleted one (they do not hold their domain).
    domain_claim: Mapped[str | None] = mapped_column(String(253))
    invite_cap: Mapped[int | None] = mapped_column(Integer)  # invites this company may send a day; None: the global setting (story P-19, FR-ORG-08)
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

@org_scoped("org_id", self_column="user_id")
class JoinRequest(Base):
    """A colleague's request to join a company (story P-19, FR-ORG-03): `requested`, then `approved` or `rejected` by the owner. The requester reads their own."""

    __tablename__ = "join_requests"
    __table_args__ = (
        CheckConstraint("status IN ('requested', 'approved', 'rejected')", name="status"),
        Index("uq_join_requests_open", "org_id", "user_id", unique=True, postgresql_where=text("status = 'requested'"), sqlite_where=text("status = 'requested'")),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(10), nullable=False, server_default="requested")
    decided_by: Mapped[str | None] = mapped_column(String(32))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


@org_scoped("org_id")
class DpaAcceptance(Base):
    """The company's acceptance of the data-processing terms (story P-19, FR-ORG-07): company, user, version, time. Append-only for the application role."""

    __tablename__ = "dpa_acceptances"
    __table_args__ = (UniqueConstraint("org_id", "terms_version", name="uq_dpa_acceptances_org_version"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    terms_version: Mapped[str] = mapped_column(String(16), nullable=False)
    terms_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
