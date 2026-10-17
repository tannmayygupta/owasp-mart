"""Notification tables (architecture 04 section 2.7; owner `notifications` in contracts/db/table-owners.yaml): the email outbox."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from vulnmart.kernel.db import Base
from vulnmart.kernel.models import JsonValue, Timestamps

STATES = ("pending", "sent", "failed")

# SQLite (the unit tests) only auto-numbers a column declared INTEGER; Postgres gets a BIGINT identity.
Id = BigInteger().with_variant(Integer(), "sqlite")


class EmailOutbox(Timestamps, Base):
    """One email waiting for, or past, delivery (FR-NTF-02). Written in the transaction of its cause; the worker sends it.

    `pending`: not sent yet (a retry also waits here, with a later `next_attempt_at`); `sent`; `failed`: given up, shown to
    admins, and put back with `requeue`. The row holds the recipient as a user id, never an address, and `last_error_code`
    is one of a fixed list of codes, never a provider text (it could contain the address).
    """

    __tablename__ = "email_outbox"
    __table_args__ = (
        CheckConstraint("state IN ('pending', 'sent', 'failed')", name="state"),
        CheckConstraint("attempts >= 0", name="attempts"),
        Index("ix_email_outbox_state_next_attempt_at", "state", "next_attempt_at"),
        Index("ix_email_outbox_sent_at", "sent_at"),
    )

    id: Mapped[int] = mapped_column(Id, primary_key=True, autoincrement=True)  # the outbox order, which delivery keeps
    template: Mapped[str] = mapped_column(String(64), nullable=False)
    to_user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    params: Mapped[Any] = mapped_column(JsonValue, nullable=False)
    state: Mapped[str] = mapped_column(String(8), nullable=False, server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    claimed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # a worker's lease; an expired lease is free
    last_error_code: Mapped[str | None] = mapped_column(String(32))
    provider_message_id: Mapped[str | None] = mapped_column(String(255))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
