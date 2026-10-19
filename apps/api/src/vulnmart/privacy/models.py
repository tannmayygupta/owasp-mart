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
        Index("ix_consent_records_erase_after", "erase_after", postgresql_where=text("erase_after IS NOT NULL"), sqlite_where=text("erase_after IS NOT NULL")),
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
    erase_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # set when the assessment record is deleted: the record goes this long after (OI-37, story P-24)

class SubjectMap(Base):
    """The identity behind a pseudonymous subject id of the audit log (FR-PRV-10). Deleting the row (deletion workflow, story P-25) leaves the audit
    rows in place and identifying nobody. No foreign key to `users`: a pseudonym is needed while the user row is still being created in another
    transaction, and the mapping is removed explicitly, not by a cascade."""

    __tablename__ = "subject_map"
    __table_args__ = (UniqueConstraint("user_id", name="uq_subject_map_user_id"),)

    subject_id: Mapped[str] = mapped_column(String(18), primary_key=True)  # `s-` and 16 Base32 characters
    user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


REQUEST_KINDS = ("learner", "candidate")
REQUEST_STATUSES = ("pending", "approved", "declined", "cancelled", "done")
OPEN_REQUEST = "status IN ('pending', 'approved')"
VIEW_ACTIONS = ("viewed", "exported")


class DeletionRequest(Base):
    """A request to delete data (story P-25, FR-PRV-08, FR-PRV-09). A learner's runs after the 7-day undo window; a candidate's goes to the company that holds the
    assessment record, and after the company approves it waits the same 7 days. `execute_after` is set when the hold starts; the scheduler job `deletion_requests`
    carries out what is due. A person has at most one open request of a kind (and, for a candidate, per attempt): two partial unique indexes."""

    __tablename__ = "deletion_requests"
    __table_args__ = (
        CheckConstraint("kind IN ('learner', 'candidate')", name="kind"),
        CheckConstraint("status IN ('pending', 'approved', 'declined', 'cancelled', 'done')", name="status"),
        CheckConstraint("kind = 'learner' OR (attempt_id IS NOT NULL AND org_id IS NOT NULL)", name="candidate_target"),
        Index("uq_deletion_requests_open_learner", "user_id", unique=True, postgresql_where=text("kind = 'learner' AND status IN ('pending', 'approved')"),
              sqlite_where=text("kind = 'learner' AND status IN ('pending', 'approved')")),
        Index("uq_deletion_requests_open_candidate", "user_id", "attempt_id", unique=True,
              postgresql_where=text("kind = 'candidate' AND status IN ('pending', 'approved')"),
              sqlite_where=text("kind = 'candidate' AND status IN ('pending', 'approved')")),
        Index("ix_deletion_requests_user_id", "user_id", "requested_at"),
        Index("ix_deletion_requests_org_id", "org_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(18), primary_key=True)  # `d-` and 16 Base32 characters
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    user_id: Mapped[str] = mapped_column(String(32), nullable=False)  # no foreign key: the request outlives nothing, but the job must not fail on a user already gone
    attempt_id: Mapped[str | None] = mapped_column(String(40))
    org_id: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(10), nullable=False, server_default="pending")
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    decide_by: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # candidate requests: the company is asked to decide by then (14 days)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # the deadline passed: the admins were told (placeholder numbers, FR-PRV-08)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    execute_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DataView(Base):
    """One company-level view of a candidate's data (story P-25, FR-PRV-11): company, action, time. Insert-only for the application role. The company's name is
    copied so the history still reads after the company is renamed; the candidate sees nothing else (no recruiter name, no address)."""

    __tablename__ = "data_views"
    __table_args__ = (
        CheckConstraint("action IN ('viewed', 'exported')", name="action"),
        Index("ix_data_views_candidate_user_id_at", "candidate_user_id", "at"),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    candidate_user_id: Mapped[str] = mapped_column(String(32), nullable=False)
    org_id: Mapped[str] = mapped_column(String(40), nullable=False)
    org_name: Mapped[str] = mapped_column(String(120), nullable=False)
    action: Mapped[str] = mapped_column(String(10), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
