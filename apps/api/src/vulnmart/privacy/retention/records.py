"""What the retention jobs read about attempts (story P-24): the lab's `attempts` table through a small read-only view, so the jobs do not depend on the lab's classes.

An attempt *ends* when it reaches a terminal state: the instant it was submitted, cancelled or withdrawn, or the deadline of an expired one (the first of those the record
has; the row's last update when the record has none). `destroyed_at` is when the instance was claimed for destruction (the lab does not keep the instant it finished;
the claim is the nearest thing it stores), or the end of the attempt when only the flag is set.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.lab.models import Attempt, Evidence
from vulnmart.privacy.models import ConsentRecord

TERMINAL = ("expired", "submitted", "reported", "cancelled", "withdrawn", "deleted")


@dataclass(frozen=True, slots=True)
class AttemptInfo:
    attempt_id: str
    user_id: str
    org_id: str | None
    state: str
    ended_at: datetime | None  # None while the attempt is not over
    destroyed_at: datetime | None  # None while the instance still exists


def _when(value: Any) -> datetime | None:
    if value is None:
        return None
    moment = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _info(row: Attempt) -> AttemptInfo:
    record = row.record or {}
    ended = None
    if row.state in TERMINAL:
        ended = (_when(record.get("submitted_at")) or _when(record.get("cancelled_at")) or _when(record.get("withdrawn_at"))
                 or (_when(record.get("deadline_at")) if row.state == "expired" else None) or _when(record.get("reported_at")) or _when(row.updated_at))
    destroyed = None
    if record.get("destroyed"):
        destroyed = _when(record.get("destroy_claim_at")) or ended
    return AttemptInfo(row.id, row.user_id, row.org_id, row.state, ended, destroyed)


class SqlAttemptRecords:
    def __init__(self, sessions: sessionmaker[Session]):
        self._sessions = sessions

    def get(self, attempt_id: str) -> AttemptInfo | None:
        with self._sessions() as session:
            row = session.get(Attempt, attempt_id)
            return None if row is None else _info(row)

    def learner_attempts(self, user_id: str) -> list[AttemptInfo]:
        """The practice attempts (no company) of one account."""
        with self._sessions() as session:
            return [_info(r) for r in session.scalars(select(Attempt).where(Attempt.user_id == user_id, Attempt.org_id.is_(None)))]

    def learner_attempts_with_evidence(self, *, limit: int = 500) -> list[AttemptInfo]:
        """Practice attempts that still have captured evidence, oldest first (the job deletes the evidence of those whose instance was destroyed long enough ago,
        FR-PRV-06; asking only for attempts that still have evidence means a finished attempt drops out of the list and never starves a newer one)."""
        with self._sessions() as session:
            rows = session.scalars(select(Attempt).where(Attempt.org_id.is_(None), Attempt.id.in_(select(Evidence.attempt_id).distinct()))
                                   .order_by(Attempt.updated_at).limit(limit))
            return [_info(r) for r in rows]

    def has_candidate_data(self, user_id: str) -> bool:
        """The account took part in an assessment (a candidate attempt or a consent record exists): that data is the company's to keep until its own date."""
        with self._sessions() as session:
            attempt = session.scalar(select(Attempt.id).where(Attempt.user_id == user_id, Attempt.org_id.is_not(None)).limit(1))
            consent = session.scalar(select(ConsentRecord.id).where(ConsentRecord.user_id == user_id).limit(1))
        return attempt is not None or consent is not None
