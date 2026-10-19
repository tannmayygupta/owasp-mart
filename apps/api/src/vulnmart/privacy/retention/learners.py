"""Learner retention (story P-24, FR-PRV-05, FR-PRV-16, ADR 0054): a learner's data goes 12 months after their last login, with a warning email 30 days before.

- `warn`: an active, verified learner whose deletion is `learner_warning_days` away or nearer, and who was not warned yet, gets the `learner.retention_warning` mail; the
  mail and the mark `users.retention_warned_at` are written in one transaction.
- A login clears the mark (`SessionService.open_session`), so a login before the date cancels the deletion and a later silence earns a new warning.
- `delete`: a learner who was warned at least `learner_warning_days` ago and is still past the 12 months loses their practice attempts (the lab erases each) and their account
  (the sessions, tokens, second factor and roles go with it); their audit pseudonym is forgotten, so the log entries identify nobody. An account that took part in an
  assessment (a candidate attempt or a consent record exists) keeps its account until that data is gone by its own retention; its practice data is still erased.

The 30-day warning is good practice, not a claimed legal duty (FR-PRV-16): the mail says only that the data will be deleted and how to keep it. A learner can also delete
their data at any time (the deletion workflow, story P-25). Months are 365/12 days.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.models import User, UserRole
from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.settings import SettingsPort
from vulnmart.privacy.subjects import SubjectService

from .candidates import NoEraser, months
from .records import SqlAttemptRecords

logger = logging.getLogger("vulnmart.retention")
BATCH = 200


def _aware(moment: datetime) -> datetime:
    from datetime import UTC

    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


class LearnerRetention:
    def __init__(self, sessions: sessionmaker[Session], records: SqlAttemptRecords, settings: SettingsPort, audit: AuditPort, subjects: SubjectService | None,
                 eraser: Callable[[str], None] | None, *, public_origin: str):
        self._sessions, self._records, self._settings, self._audit, self._subjects, self._eraser = sessions, records, settings, audit, subjects, eraser
        self._origin = public_origin.rstrip("/")

    def _delete_at(self, user: User) -> datetime:
        last = _aware(user.last_login_at or user.created_at)
        return last + months(int(self._settings.get("learner_retention_months")))

    def _learners(self, session: Session):
        return (select(User).join(UserRole, UserRole.user_id == User.id)
                .where(User.account_type == "participant", User.status == "active", UserRole.role == "learner").order_by(User.id))

    def warn(self, now: datetime) -> str:
        lead = timedelta(days=int(self._settings.get("learner_warning_days")))
        warned = 0
        with self._sessions() as session:
            candidates = [u.id for u in session.scalars(self._learners(session).where(User.retention_warned_at.is_(None), User.email_verified_at.is_not(None)))]
        for user_id in candidates:
            with self._sessions.begin() as session:
                user = session.get(User, user_id)
                if user is None or user.retention_warned_at is not None or user.status != "active":
                    continue
                due = self._delete_at(user)
                if due - lead > now:
                    continue
                outbox = DbOutboxPort(lambda: session, None, now=lambda: now, validator=validate_params)
                outbox.enqueue_email(template="learner.retention_warning", to_user_id=user.id,
                                     params={"delete_on": max(due, now + lead).date().isoformat(), "login_url": f"{self._origin}/login"})
                user.retention_warned_at = now
                warned += 1
                if warned >= BATCH:
                    break
        return f"{warned} warned"

    def delete(self, now: datetime) -> str:
        lead = timedelta(days=int(self._settings.get("learner_warning_days")))
        deleted = kept = 0
        with self._sessions() as session:
            due = [(u.id, u.retention_warned_at) for u in session.scalars(self._learners(session).where(User.retention_warned_at.is_not(None)))
                   if _aware(u.retention_warned_at) <= now - lead and self._delete_at(u) <= now][:BATCH]
        for user_id, _ in due:
            attempts = self._records.learner_attempts(user_id)
            if attempts and self._eraser is None:
                raise NoEraser
            for attempt in attempts:
                self._eraser(attempt.attempt_id)  # type: ignore[misc]
            if self._records.has_candidate_data(user_id):
                kept += 1
                continue
            self._audit.append(actor="job:learner_retention", action="retention.learner_deleted", subject=user_id, details={"attempts": len(attempts)})
            with self._sessions.begin() as session:
                session.execute(delete(User).where(User.id == user_id))
            if self._subjects is not None:
                self._subjects.forget(user_id)
            deleted += 1
        return f"{deleted} learners deleted, {kept} kept for assessment data"
