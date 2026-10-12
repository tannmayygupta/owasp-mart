"""Kernel tables (architecture 04 section 2.7; owner `kernel` in contracts/db/table-owners.yaml): settings, quotas, job runs."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Integer, String, Text, UniqueConstraint, func
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
