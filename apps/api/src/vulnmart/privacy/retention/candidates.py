"""Candidate retention (story P-24, FR-PRV-04, FR-PRV-18, OI-37, ADR 0054): a candidate's assessment record is deleted when its time is up.

The time is the template's `retention_days` (30 to 365, copied onto the invite; the platform default of 180 when the invite has none) counted from **the end of the
attempt**, or, when the candidate never started, **from the invite date**. When it is up, in this order and each step safe to repeat:

1. the lab erases the attempt (the key is shredded, the rows go, the attempt is marked purged), through `eraser`;
2. the consent records of the attempt are scheduled to go `consent_record_extra_months` later (OI-37: the short proof of consent outlives the assessment record);
3. the invite (the address the recruiter typed, the account and attempt it was bound to) is deleted.

An invite whose attempt is still going (not over) is never due. An attempt whose row is already gone makes its invite due at once. The company deleting a candidate
earlier is story P-25. The audit entry names the company and counts, never a person.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy import update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.assessments.service import AssessmentService, RetentionInvite
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.settings import SettingsPort
from vulnmart.privacy.models import ConsentRecord

from .records import SqlAttemptRecords

logger = logging.getLogger("vulnmart.retention")

SHORTEST_DAYS = 30  # the shortest retention a template may set (FR-PRV-04): nothing is due before an invite is this old
MONTH = 365 / 12


def months(count: int) -> timedelta:
    return timedelta(days=round(count * MONTH))


class NoEraser(RuntimeError):
    """An attempt's data is due for deletion and this process has no way to erase it (the lab runs in another process): the job fails instead of deleting around it."""


class CandidateRetention:
    def __init__(self, sessions: sessionmaker[Session], assessments: AssessmentService, records: SqlAttemptRecords, settings: SettingsPort, audit: AuditPort,
                 eraser: Callable[[str], None] | None):
        self._sessions, self._assessments, self._records, self._settings, self._audit, self._eraser = sessions, assessments, records, settings, audit, eraser

    def due_at(self, invite: RetentionInvite, retention_days: int) -> datetime | None:
        """When this invite's candidate record is due for deletion, or None while it cannot be (the attempt is not over)."""
        keep = timedelta(days=retention_days)
        if invite.attempt_id and invite.state in ("consented", "started"):
            info = self._records.get(invite.attempt_id)
            if info is None:
                return invite.created_at  # the attempt's record is already gone: nothing is left to wait for
            return None if info.ended_at is None else info.ended_at + keep
        return invite.created_at + keep  # never started: the clock runs from the invite date

    def run(self, now: datetime) -> str:
        default_days = int(self._settings.get("candidate_retention_days"))
        extra = months(int(self._settings.get("consent_record_extra_months")))
        erased = 0
        by_org: dict[str, list[str]] = {}
        attempts_by_org: dict[str, int] = {}
        for invite in self._assessments.retention_invites(now - timedelta(days=SHORTEST_DAYS)):
            due = self.due_at(invite, invite.retention_days or default_days)
            if due is None or due > now:
                continue
            if invite.attempt_id:
                info = self._records.get(invite.attempt_id)
                if info is not None:
                    if self._eraser is None:
                        raise NoEraser
                    self._eraser(invite.attempt_id)
                    erased += 1
                    attempts_by_org[invite.org_id] = attempts_by_org.get(invite.org_id, 0) + 1
                self._schedule_consent_erase(invite.attempt_id, now + extra)
            by_org.setdefault(invite.org_id, []).append(invite.invite_id)
        deleted = 0
        for org, ids in by_org.items():
            count = self._assessments.delete_invites(org, ids)
            deleted += count
            self._audit.append(actor="job:candidate_retention", action="retention.candidate_deleted", subject=None,
                               details={"org": org, "invites": count, "attempts": attempts_by_org.get(org, 0)})
        return f"{deleted} invites deleted, {erased} attempts erased"

    def _schedule_consent_erase(self, attempt_id: str, erase_after: datetime) -> None:
        with self._sessions.begin() as session:
            session.execute(update(ConsentRecord).where(ConsentRecord.attempt_id == attempt_id, ConsentRecord.erase_after.is_(None)).values(erase_after=erase_after))
