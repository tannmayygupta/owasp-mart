"""Who viewed a candidate's data (story P-25, FR-PRV-11, ADR 0055): company-level view history, company, action and time, nothing more.

`ViewHistory.record` is what every code path that shows or exports a candidate's data to a company calls (the recruiter dashboard, story P-27, and the recruiter export, story
P-29); it is a plain insert, repeated views by the same company on the same day are one entry, so the history stays readable. `list_mine` is the candidate's own view of it: the
company's name as it was at the time, the action (`viewed`, `exported`) and the time, never the recruiter's name or anything about the person who looked. The full trail of who did what
is the audit log, which admins read under the break-glass rules (story P-31). A person reads only their own history.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .models import VIEW_ACTIONS, DataView


@dataclass(frozen=True, slots=True)
class ViewEntry:
    company_name: str
    action: str
    at: datetime


class ViewHistory:
    def __init__(self, sessions: sessionmaker[Session], *, now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._sessions, self._now = sessions, now

    def record(self, *, candidate_user_id: str, org_id: str, org_name: str, action: str) -> bool:
        """Write one entry unless the same company did the same thing to the same person within the last day. True when an entry was written."""
        if action not in VIEW_ACTIONS:
            raise ValueError("unknown view action")
        now = self._now()
        with self._sessions.begin() as session:
            recent = session.scalar(select(DataView.id).where(DataView.candidate_user_id == candidate_user_id, DataView.org_id == org_id, DataView.action == action,
                                                              DataView.at > now - timedelta(days=1)).limit(1))
            if recent is not None:
                return False
            session.add(DataView(candidate_user_id=candidate_user_id, org_id=org_id, org_name=org_name[:120], action=action, at=now))
            return True

    def list_mine(self, user_id: str, limit: int = 50) -> tuple[list[ViewEntry], bool]:
        """The newest entries first, and whether there are more."""
        with self._sessions() as session:
            rows = session.scalars(select(DataView).where(DataView.candidate_user_id == user_id).order_by(DataView.at.desc(), DataView.id.desc()).limit(limit + 1)).all()
        entries = [ViewEntry(r.org_name, r.action, r.at if r.at.tzinfo else r.at.replace(tzinfo=UTC)) for r in rows[:limit]]
        return entries, len(rows) > limit
