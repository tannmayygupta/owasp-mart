"""Kernel tables (architecture 04 sections 2.7 and 2.8; owner `kernel` in contracts/db/table-owners.yaml): settings, quotas, job runs, and the audit log with its checkpoint and anchor."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import BigInteger, CheckConstraint, Date, DateTime, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from .db import Base

# JSONB in Postgres, plain JSON elsewhere (the unit tests use SQLite).
JsonValue = JSON().with_variant(JSONB(), "postgresql")


class Timestamps:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class SettingRow(Timestamps, Base):
    """An admin's override of one setting of `vulnmart.ports.settings.SETTINGS` (FR-ADM-05)."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JsonValue, nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(64))  # pseudonymous subject id of the admin
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class Quota(Timestamps, Base):
    """How many instances a user may run (OI-21): a user row beats an org row, which beats the global row."""

    __tablename__ = "quotas"
    __table_args__ = (
        CheckConstraint("scope IN ('user', 'org', 'global')", name="scope"),
        CheckConstraint("(scope = 'global') = (scope_id IS NULL)", name="global_has_no_scope_id"),
        CheckConstraint("max_instances >= 0", name="max_instances"),
        UniqueConstraint("scope", "scope_id", name="uq_quotas_scope_scope_id", postgresql_nulls_not_distinct=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    scope: Mapped[str] = mapped_column(String(8), nullable=False)
    scope_id: Mapped[str | None] = mapped_column(String(64))
    max_instances: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class JobRun(Timestamps, Base):
    """One run of a scheduled job (FR-PRV-18), shown on the admin dashboard."""

    __tablename__ = "job_runs"
    __table_args__ = (CheckConstraint("status IN ('running', 'succeeded', 'failed')", name="status"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    job: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text)  # a fixed summary, never an exception text with values
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

class AuditLog(Base):
    """One entry of the hash-chained audit log (FR-PRV-10, architecture 04 section 4). Append-only: the application role has SELECT and INSERT only.

    `details` is the canonical JSON text that the hash covers, so a row can be re-hashed exactly as it was written. `actor` and `subject` are
    pseudonymous ids (`subject_map`) or system names, never an email address or a name."""

    __tablename__ = "audit_log"
    __table_args__ = (
        CheckConstraint("seq >= 1", name="seq"),
        CheckConstraint("length(row_hash) = 64 AND length(prev_hash) = 64", name="hash_length"),
        UniqueConstraint("row_hash", name="uq_audit_log_row_hash"),
        Index("ix_audit_log_subject_seq", "subject", "seq"),
        Index("ix_audit_log_actor_seq", "actor", "seq"),
        Index("ix_audit_log_action_seq", "action", "seq"),
    )

    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)  # strictly 1, 2, 3 ... with no gap (one writer at a time)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)  # whole seconds, UTC
    actor: Mapped[str] = mapped_column(String(128), nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    subject: Mapped[str | None] = mapped_column(String(128))
    details: Mapped[str] = mapped_column(Text, nullable=False)
    prev_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    row_hash: Mapped[str] = mapped_column(String(64), nullable=False)


class AuditCheckpoint(Base):
    """Written when old rows are purged: the hash of the last purged row, so the chain verifies from the next row (architecture 04 section 4)."""

    __tablename__ = "audit_checkpoint"

    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    hash: Mapped[str] = mapped_column(String(64), nullable=False)
    reason: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class AuditAnchor(Base):
    """The head of the chain on one day, also published outside the database (OI-28: a signed line in a file on VM-P that an operator ships off the machine)."""

    __tablename__ = "audit_anchor"

    anchor_date: Mapped[date] = mapped_column(Date, primary_key=True)
    head_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    head_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    anchored_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    witness: Mapped[str] = mapped_column(String(16), nullable=False)  # `file` when a line was also written outside the database, else `db`
