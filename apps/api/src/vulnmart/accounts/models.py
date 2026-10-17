"""Account tables (architecture 04 section 2.1; owner `accounts` in contracts/db/table-owners.yaml): users, their roles, email tokens.

`users.account_type` is the account type of FR-ACC-05. A participant may hold the Learner and Candidate roles; a recruiter or
admin may hold none. The database enforces it: `user_roles` repeats the account type (always `participant`) and has a composite
foreign key to `users (id, account_type)`, so a role row cannot point at a recruiter or an admin.

`email_ci` is the address in one canonical form (see `accounts.security.normalize_email`) and is unique; `email` keeps what the
person typed for display. A verification or reset link is stored only as a SHA-256 hash of its token (the token itself is 256
bits of randomness, so a plain hash is enough) and is single use.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKeyConstraint, Index, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from vulnmart.kernel.db import Base
from vulnmart.kernel.models import Timestamps

ACCOUNT_TYPES = ("participant", "recruiter", "admin")
USER_STATUSES = ("active", "disabled", "deleted")
ROLES = ("learner", "candidate")
TOKEN_PURPOSES = ("verify", "reset")


class User(Timestamps, Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("account_type IN ('participant', 'recruiter', 'admin')", name="account_type"),
        CheckConstraint("status IN ('active', 'disabled', 'deleted')", name="status"),
        UniqueConstraint("email_ci", name="uq_users_email_ci"),
        UniqueConstraint("id", "account_type", name="uq_users_id_account_type"),  # the target of the role foreign key
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # `u-` and 16 Base32 characters (contracts UserId)
    account_type: Mapped[str] = mapped_column(String(12), nullable=False)
    email: Mapped[str] = mapped_column(String(254), nullable=False)
    email_ci: Mapped[str] = mapped_column(String(254), nullable=False)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)  # Argon2id, PHC string
    display_name: Mapped[str] = mapped_column(String(60), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, server_default="active")
    age_declared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class UserRole(Timestamps, Base):
    __tablename__ = "user_roles"
    __table_args__ = (
        CheckConstraint("role IN ('learner', 'candidate')", name="role"),
        CheckConstraint("account_type = 'participant'", name="participants_only"),
        ForeignKeyConstraint(["user_id", "account_type"], ["users.id", "users.account_type"], ondelete="CASCADE",
                             name="fk_user_roles_user_id_account_type_users"),
    )

    user_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    role: Mapped[str] = mapped_column(String(10), primary_key=True)
    account_type: Mapped[str] = mapped_column(String(12), nullable=False, server_default="participant")


class EmailToken(Timestamps, Base):
    __tablename__ = "email_tokens"
    __table_args__ = (
        CheckConstraint("purpose IN ('verify', 'reset')", name="purpose"),
        ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE", name="fk_email_tokens_user_id_users"),
        Index("ix_email_tokens_user_id_purpose", "user_id", "purpose"),
    )

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)  # SHA-256 hex of the token
    user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    purpose: Mapped[str] = mapped_column(String(8), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
