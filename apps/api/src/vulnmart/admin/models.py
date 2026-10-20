"""The admin module's table (story P-31, FR-ADM-03): break-glass grants.

A grant lets one named admin read one candidate attempt's answers, write-ups and evidence for 15 minutes (D-94), for a written reason. The row keeps who, why, when it
opened, when it ends or was closed, every read (when and what), and the later review by another admin. The reason text lives here, not in the audit log (the audit
entries carry the grant id). The application role may insert and select, and update only the columns that record what was read, the closing and the review.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from vulnmart.kernel.db import Base
from vulnmart.kernel.models import JsonValue


class BreakGlassSession(Base):
    __tablename__ = "break_glass_sessions"
    __table_args__ = (
        CheckConstraint("expires_at > started_at", name="window"),
        CheckConstraint("reviewed_by IS NULL OR reviewed_by <> admin_id", name="other_reviewer"),
        Index("ix_break_glass_sessions_admin_id", "admin_id", "started_at"),
        Index("ix_break_glass_sessions_attempt_id", "attempt_id"),
    )

    id: Mapped[str] = mapped_column(String(18), primary_key=True)
    admin_id: Mapped[str] = mapped_column(String(32), nullable=False)
    attempt_id: Mapped[str] = mapped_column(String(40), nullable=False)
    org_id: Mapped[str] = mapped_column(String(40), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    what_read: Mapped[Any] = mapped_column(JsonValue, nullable=False, default=list)  # [{"at": "...", "what": ["report", "evidence", "timeline"]}]
    reviewed_by: Mapped[str | None] = mapped_column(String(32))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(String(500))
