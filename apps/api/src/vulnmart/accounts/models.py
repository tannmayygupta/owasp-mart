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

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKeyConstraint, Index, Integer, String, Text, UniqueConstraint, func
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
    retention_warned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # the learner's retention warning was queued (story P-24); a login clears it
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


class UserSession(Base):
    """A server-side session (architecture 04 section 2.1, FR-ACC-03). The cookie holds an opaque random value; only its SHA-256
    hash is stored, so a copy of this table cannot be used to sign in. `last_seen_at` drives the idle timeout, `absolute_expires_at`
    the absolute one, `revoked_at` logout and "log out everywhere". `ip_trunc` and `ua_class` are coarse (a network prefix and a
    device class), kept for the user's own session list, not for tracking."""

    __tablename__ = "sessions"
    __table_args__ = (
        ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE", name="fk_sessions_user_id_users"),
        Index("ix_sessions_user_id", "user_id"),
    )

    id_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    absolute_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ip_trunc: Mapped[str | None] = mapped_column(String(64))
    ua_class: Mapped[str | None] = mapped_column(String(16))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    mfa_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # when a second factor was proved in this session (an admin needs it, FR-ACC-07)


class EmailToken(Timestamps, Base):
    __tablename__ = "email_tokens"
    __table_args__ = (
        CheckConstraint("purpose IN ('verify', 'reset', 'mfa')", name="purpose"),
        ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE", name="fk_email_tokens_user_id_users"),
        Index("ix_email_tokens_user_id_purpose", "user_id", "purpose"),
    )

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)  # SHA-256 hex of the token
    user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    purpose: Mapped[str] = mapped_column(String(8), nullable=False)  # `mfa` is the 5-minute ticket between the password and the second factor (P-15)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")  # wrong codes tried with an `mfa` ticket (five at most)


class MfaCredential(Timestamps, Base):
    """The TOTP credential of an account (architecture 04): one per user. `enabled_at` is null while the enrolment is pending (the secret was
    shown but no code from the app has confirmed it). The secret is sealed with the field key and bound to the account (`accounts/fieldkeys.py`).
    `last_used_step` is the time step of the last accepted code: an older or equal step is refused, so a code works once."""

    __tablename__ = "mfa_credentials"
    __table_args__ = (
        CheckConstraint("type IN ('totp')", name="type"),
        ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE", name="fk_mfa_credentials_user_id_users"),
    )

    user_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    type: Mapped[str] = mapped_column(String(8), nullable=False, server_default="totp")
    secret_enc: Mapped[str] = mapped_column(Text, nullable=False)
    enabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_step: Mapped[int | None] = mapped_column(BigInteger)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class RecoveryCode(Timestamps, Base):
    """A one-time recovery code, kept only as a keyed hash (`FieldKeys.recovery_hash`, which includes the account id, so the hash is the key)."""

    __tablename__ = "recovery_codes"
    __table_args__ = (
        ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE", name="fk_recovery_codes_user_id_users"),
        Index("ix_recovery_codes_user_id", "user_id"),
    )

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
