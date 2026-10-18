"""The domain-event outbox (architecture 04 section 2.7, owner `live` in contracts/db/table-owners.yaml; story P-22, ADR 0052).

A publisher writes one row per event in the transaction of its cause (`DbEventPublisher`); the relay reads the unpublished rows in order, resolves the audiences
from the attempt and appends the event to the stream of each (`relay.py`). The row holds the IF-3 event exactly as the browser will read it, ids and states only: no
audience, no address, no flag. `relay_attempts` and `dropped` exist for the one case the relay cannot finish: an event whose attempt cannot be found after
`MAX_RELAY_ATTEMPTS` passes is dropped (and logged by id and type), never retried forever, never published to a guessed audience.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from vulnmart.kernel.db import Base
from vulnmart.kernel.models import JsonValue


class DomainEvent(Base):
    __tablename__ = "domain_events"
    __table_args__ = (
        Index("ix_domain_events_unpublished", "id", postgresql_where=text("published_at IS NULL"), sqlite_where=text("published_at IS NULL")),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    payload: Mapped[Any] = mapped_column(JsonValue, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    relay_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    dropped: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
