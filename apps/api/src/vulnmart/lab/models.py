"""Lab tables (architecture 04 sections 2.5 and 2.6; owners `attempts`, `instances`, `ingest`, `scoring`, `flags`): the stored
state of the lab runtime. Stream L (Tanmay), migration 0008.

What each table keeps, and what no table keeps:
- `attempts`: the attempt record of `vulnmart_attempts` (the full record in `record`, the columns the engine searches by outside it).
  The write is a compare-and-set on `version`.
- `events`: the IF-4 envelope as received (metadata only, FR-DET-03), once per `(instance_id, epoch, seq)`. `digest` is the SHA-256 of
  the canonical body the receiver compared; `engine_seen` marks that the milestone engine processed the event.
- `milestones`: the best level per challenge. `held_captures`: a capture that waits for a human, and the decision.
- `evidence`: sealed bytes only (AES-256-GCM, the key is in the keystore, never here).
- No table keeps a flag, a flag digest, a pasted text, a cookie or a password (FR-FLG-05, FR-DET-03).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    LargeBinary,
    PrimaryKeyConstraint,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from vulnmart.kernel.db import Base
from vulnmart.kernel.models import JsonValue

ATTEMPT_STATES = ("ready", "running", "expired", "submitted", "reported", "cancelled", "withdrawn", "deleted")
MILESTONE_LEVELS = ("M1", "M2", "M3")
HELD_STATUSES = ("open", "accepted", "rejected")
INTEGRITY_KINDS = ("decoy", "sharing", "timing", "activity", "similarity")

_now = func.now()


def _tz() -> Any:
    return DateTime(timezone=True)


class Attempt(Base):
    __tablename__ = "attempts"
    __table_args__ = (
        CheckConstraint("state IN ('ready', 'running', 'expired', 'submitted', 'reported', 'cancelled', 'withdrawn', 'deleted')", name="state"),
        CheckConstraint("version >= 0", name="version"),
        UniqueConstraint("user_id", "template_id", name="uq_attempts_user_id_template_id"),
        Index("ix_attempts_state", "state"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    template_id: Mapped[str] = mapped_column(String(64), nullable=False)
    org_id: Mapped[str | None] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(12), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    record: Mapped[Any] = mapped_column(JsonValue, nullable=False)
    created_at: Mapped[datetime] = mapped_column(_tz(), nullable=False, server_default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tz(), nullable=False, server_default=_now)


class Instance(Base):
    """The platform's directory of instances: whose attempt, template, current flag epoch and challenges (`InstanceDirectory`)."""

    __tablename__ = "instances"
    __table_args__ = (
        CheckConstraint("epoch >= 1", name="epoch"),
        UniqueConstraint("attempt_id", name="uq_instances_attempt_id"),
        Index("ix_instances_template_id", "template_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    attempt_id: Mapped[str] = mapped_column(String(64), ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False)
    template_id: Mapped[str] = mapped_column(String(64), nullable=False)
    epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    challenge_keys: Mapped[Any] = mapped_column(JsonValue, nullable=False)
    created_at: Mapped[datetime] = mapped_column(_tz(), nullable=False, server_default=_now)
    updated_at: Mapped[datetime] = mapped_column(_tz(), nullable=False, server_default=_now)


class InstanceEpoch(Base):
    """Every flag epoch an instance has had; the current one is the highest (a stale event is recognised by it)."""

    __tablename__ = "instance_epochs"
    __table_args__ = (PrimaryKeyConstraint("instance_id", "epoch", name="pk_instance_epochs"), CheckConstraint("epoch >= 1", name="epoch"))

    instance_id: Mapped[str] = mapped_column(String(64), nullable=False)
    epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    started_at: Mapped[datetime] = mapped_column(_tz(), nullable=False, server_default=_now)


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        UniqueConstraint("instance_id", "epoch", "seq", name="uq_events_instance_id_epoch_seq"),
        Index("ix_events_instance_id_epoch_seq", "instance_id", "epoch", "seq"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    instance_id: Mapped[str] = mapped_column(String(64), nullable=False)
    epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    digest: Mapped[str | None] = mapped_column(String(64))
    event: Mapped[Any] = mapped_column(JsonValue, nullable=False)
    received_at: Mapped[datetime] = mapped_column(_tz(), nullable=False)
    engine_seen: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")


class Milestone(Base):
    __tablename__ = "milestones"
    __table_args__ = (
        PrimaryKeyConstraint("attempt_id", "challenge_key", name="pk_milestones"),
        CheckConstraint("level IN ('M1', 'M2', 'M3')", name="level"),
    )

    attempt_id: Mapped[str] = mapped_column(String(64), ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False)
    challenge_key: Mapped[str] = mapped_column(String(16), nullable=False)
    level: Mapped[str] = mapped_column(String(2), nullable=False)
    reached_at: Mapped[datetime] = mapped_column(_tz(), nullable=False)


class HeldCapture(Base):
    """A capture the activity check held for a human (FR-ACH-07) and the decision on it."""

    __tablename__ = "held_captures"
    __table_args__ = (
        PrimaryKeyConstraint("attempt_id", "challenge_key", name="pk_held_captures"),
        CheckConstraint("status IN ('open', 'accepted', 'rejected')", name="status"),
        Index("ix_held_captures_status", "status"),
    )

    attempt_id: Mapped[str] = mapped_column(String(64), ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False)
    challenge_key: Mapped[str] = mapped_column(String(16), nullable=False)
    held_at: Mapped[datetime] = mapped_column(_tz(), nullable=False)
    milestone: Mapped[str | None] = mapped_column(String(2))  # set by the review (`HeldItem.milestone`)
    fallback: Mapped[str | None] = mapped_column(String(4))
    evidence_ids: Mapped[Any] = mapped_column(JsonValue, nullable=False, server_default="[]")
    status: Mapped[str] = mapped_column(String(10), nullable=False, server_default="open")
    reminded: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    decided_at: Mapped[datetime | None] = mapped_column(_tz())


class ReviewAudit(Base):
    """Every held-capture decision: who, what, when. The note is the reviewer's own words, cut at 500 characters."""

    __tablename__ = "review_audit"
    __table_args__ = (CheckConstraint("decision IN ('accept', 'reject')", name="decision"), Index("ix_review_audit_attempt_id", "attempt_id"))

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    attempt_id: Mapped[str] = mapped_column(String(64), nullable=False)
    challenge_key: Mapped[str] = mapped_column(String(16), nullable=False)
    reviewer: Mapped[str] = mapped_column(String(64), nullable=False)
    decision: Mapped[str] = mapped_column(String(6), nullable=False)
    at: Mapped[datetime] = mapped_column(_tz(), nullable=False)
    note_id: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)


class IntegrityFlag(Base):
    __tablename__ = "integrity_flags"
    __table_args__ = (
        UniqueConstraint("attempt_id", "dedupe_key", name="uq_integrity_flags_attempt_id_dedupe_key"),
        CheckConstraint("kind IN ('decoy', 'sharing', 'timing', 'activity', 'similarity')", name="kind"),
        CheckConstraint("status IN ('open', 'accepted', 'rejected')", name="status"),
        Index("ix_integrity_flags_attempt_id", "attempt_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    attempt_id: Mapped[str] = mapped_column(String(64), ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    dedupe_key: Mapped[str] = mapped_column(String(200), nullable=False)
    challenge_key: Mapped[str | None] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(10), nullable=False, server_default="open")
    created_at: Mapped[datetime] = mapped_column(_tz(), nullable=False, server_default=_now)
    decided_at: Mapped[datetime | None] = mapped_column(_tz())
    decision_note: Mapped[str | None] = mapped_column(Text)
    decided_by: Mapped[str | None] = mapped_column(String(64))


class FlagSubmission(Base):
    """`(attempt, challenge, result word, instant)`. No submitted value is stored (FR-FLG-05)."""

    __tablename__ = "flag_submissions"
    __table_args__ = (Index("ix_flag_submissions_attempt_id", "attempt_id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    attempt_id: Mapped[str] = mapped_column(String(64), ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False)
    challenge_key: Mapped[str] = mapped_column(String(16), nullable=False)
    result: Mapped[str] = mapped_column(String(24), nullable=False)
    at: Mapped[datetime] = mapped_column(_tz(), nullable=False)


class HintUnlock(Base):
    __tablename__ = "hint_unlocks"
    __table_args__ = (
        PrimaryKeyConstraint("attempt_id", "challenge_key", "level", name="pk_hint_unlocks"),
        CheckConstraint("level BETWEEN 1 AND 3", name="level"),
    )

    attempt_id: Mapped[str] = mapped_column(String(64), ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False)
    challenge_key: Mapped[str] = mapped_column(String(16), nullable=False)
    level: Mapped[int] = mapped_column(Integer, nullable=False)
    at: Mapped[datetime] = mapped_column(_tz(), nullable=False)


class Evidence(Base):
    __tablename__ = "evidence"
    __table_args__ = (Index("ix_evidence_attempt_id_captured_at", "attempt_id", "captured_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    attempt_id: Mapped[str] = mapped_column(String(64), ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False)
    challenge_key: Mapped[str] = mapped_column(String(16), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(_tz(), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    dek_id: Mapped[str] = mapped_column(String(64), nullable=False)
    kek_version: Mapped[int] = mapped_column(Integer, nullable=False)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    aad: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    held_empty: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")


class ActivityBucket(Base):
    """Counts per `(instance, epoch, minute)`; no body, no query, no user text (FR-DET-08)."""

    __tablename__ = "activity_buckets"
    __table_args__ = (PrimaryKeyConstraint("instance_id", "epoch", "minute", name="pk_activity_buckets"),)

    instance_id: Mapped[str] = mapped_column(String(64), nullable=False)
    epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    minute: Mapped[datetime] = mapped_column(_tz(), nullable=False)
    requests: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    by_status_class: Mapped[Any] = mapped_column(JsonValue, nullable=False, server_default="{}")
    by_method: Mapped[Any] = mapped_column(JsonValue, nullable=False, server_default="{}")
    crs_by_tag: Mapped[Any] = mapped_column(JsonValue, nullable=False, server_default="{}")
    routes: Mapped[Any] = mapped_column(JsonValue, nullable=False, server_default="[]")


class AttemptEvent(Base):
    """The ids-only attempt event log (FR-TIM-04): names, ids, states, levels and instants."""

    __tablename__ = "attempt_events"
    __table_args__ = (Index("ix_attempt_events_attempt_id_id", "attempt_id", "id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    attempt_id: Mapped[str] = mapped_column(String(64), ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False)
    event: Mapped[Any] = mapped_column(JsonValue, nullable=False)


class BotVisit(Base):
    __tablename__ = "bot_visits"
    __table_args__ = (
        UniqueConstraint("instance_id", "epoch", "visit_id", "phase", name="uq_bot_visits_instance_id_epoch_visit_id_phase"),
        Index("ix_bot_visits_instance_id", "instance_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    instance_id: Mapped[str] = mapped_column(String(64), nullable=False)
    epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    visit_id: Mapped[str] = mapped_column(String(64), nullable=False)
    ticket_id: Mapped[str] = mapped_column(String(64), nullable=False)
    phase: Mapped[str] = mapped_column(String(8), nullable=False)
    at: Mapped[datetime] = mapped_column(_tz(), nullable=False)


class SecurityEvent(Base):
    """A refused event worth a human's eye (a bad signature or a replay with another body): ids and numbers only."""

    __tablename__ = "security_events"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    kind: Mapped[str] = mapped_column(String(48), nullable=False)
    instance_id: Mapped[str] = mapped_column(String(64), nullable=False)
    epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(_tz(), nullable=False, server_default=_now)
