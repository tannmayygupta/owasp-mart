"""Privacy tables (architecture 04 section 2.7; owner `privacy` in contracts/db/table-owners.yaml): the consent record.

`consent_records` is append-only (FR-PRV-02): the application role has SELECT and INSERT and nothing else, so a record is never changed
or removed through the application. A grant, a decline and (story P-25) a withdrawal each add a row. There is deliberately no foreign key
to `users`: the record is the proof that a person was asked, and it must outlive the account (the deletion workflow of story P-25 replaces
the identity behind `user_id` with a pseudonym, it does not delete the row). `attempt_id` and `org_id` point into tables of other streams
(attempts, companies) and are plain text for the same reason. One partial unique index allows a single decision (granted or declined) per
attempt, which is what makes two simultaneous clicks write one record.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Index, Integer, String, Text, UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column

from vulnmart.kernel.db import Base

ACTIONS = ("granted", "declined", "withdrawn")
METHODS = ("web",)


class ConsentRecord(Base):
    __tablename__ = "consent_records"
    __table_args__ = (
        CheckConstraint("action IN ('granted', 'declined', 'withdrawn')", name="action"),
        CheckConstraint("method IN ('web')", name="method"),
        CheckConstraint("retention_days_shown >= 1", name="retention_days_shown"),
        Index("uq_consent_records_decision", "attempt_id", unique=True, postgresql_where=text("action IN ('granted', 'declined')"),
              sqlite_where=text("action IN ('granted', 'declined')")),  # sqlite: the in-memory databases of the fast tests
        Index("ix_consent_records_user_id_at", "user_id", "at"),
    )

    id: Mapped[str] = mapped_column(String(18), primary_key=True)  # `k-` and 16 Base32 characters (contracts ConsentId)
    user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    attempt_id: Mapped[str] = mapped_column(String(40), nullable=False)
    org_id: Mapped[str | None] = mapped_column(String(40))
    template_id: Mapped[str | None] = mapped_column(String(40))
    notice_version: Mapped[str] = mapped_column(String(16), nullable=False)
    notice_text_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    notice_text_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
    retention_days_shown: Mapped[int] = mapped_column(Integer, nullable=False)
    controller_name_shown: Mapped[str] = mapped_column(String(120), nullable=False)
    action: Mapped[str] = mapped_column(String(10), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ip_hash: Mapped[str | None] = mapped_column(String(64))
    ua_hash: Mapped[str | None] = mapped_column(String(64))
    method: Mapped[str] = mapped_column(String(8), nullable=False, server_default="web")
    audit_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)

class SubjectMap(Base):
    """The identity behind a pseudonymous subject id of the audit log (FR-PRV-10). Deleting the row (deletion workflow, story P-25) leaves the audit
    rows in place and identifying nobody. No foreign key to `users`: a pseudonym is needed while the user row is still being created in another
    transaction, and the mapping is removed explicitly, not by a cascade."""

    __tablename__ = "subject_map"
    __table_args__ = (UniqueConstraint("user_id", name="uq_subject_map_user_id"),)

    subject_id: Mapped[str] = mapped_column(String(18), primary_key=True)  # `s-` and 16 Base32 characters
    user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
