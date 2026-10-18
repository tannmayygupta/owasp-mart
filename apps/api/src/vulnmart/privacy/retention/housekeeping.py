"""The other jobs of the scheduler (story P-24, FR-PRV-06, 14, 15, 18, ADR 0054): each is a small class or function that takes `now` and returns a fixed summary.

- `InviteJobs`: close the invites that ran out (`expire_all`) and empty the token hash of those closed for a while (`purge_closed_tokens`).
- `AccountHousekeeping` (FR-PRV-14): sessions that ended `session_details_days` ago are deleted, and with them the network prefix and the browser class; used up and
  expired email tokens are deleted 30 days after they expired.
- `EvidenceRetention` (FR-PRV-06): a learner's captured evidence goes `learner_evidence_days` after the instance was destroyed.
- `LogPurge` (FR-PRV-15): audit entries older than `log_retention_months` (never less than 12: the database function refuses) with a checkpoint so the chain still
  verifies; refused-event records, finished job runs and sent mail rows older than that; the sealed address of a mail that never left is cleared after
  `outbox_failed_address_days`.
- `ConsentPurge` (OI-37): consent records whose `erase_after` has passed.
- `LiveCleanup`: published rows of the live-update outbox after `domain_event_days`, and idle live streams (their entries are ids and states; an idle stream is only
  trimmed when it is next appended to).
- `anchor_audit`: the daily anchor of the audit log (story P-17), failing loudly when the chain does not verify.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import delete, text, update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.models import EmailToken, UserSession
from vulnmart.assessments.service import AssessmentService
from vulnmart.kernel.audit import AuditAnchors
from vulnmart.kernel.models import JobRun
from vulnmart.lab.models import Evidence, SecurityEvent
from vulnmart.live.models import DomainEvent
from vulnmart.live.store import StreamWriter
from vulnmart.notifications.models import EmailOutbox
from vulnmart.ports.settings import SettingsPort

from .candidates import months
from .records import SqlAttemptRecords

logger = logging.getLogger("vulnmart.retention")
TOKEN_DAYS = 30


class InviteJobs:
    def __init__(self, assessments: AssessmentService, settings: SettingsPort):
        self._assessments, self._settings = assessments, settings

    def expire(self, now: datetime) -> str:
        return f"{self._assessments.expire_all()} invites expired"

    def purge_tokens(self, now: datetime) -> str:
        days = int(self._settings.get("invite_token_purge_days"))
        return f"{self._assessments.purge_closed_tokens(now - timedelta(days=days))} tokens emptied"


class AccountHousekeeping:
    def __init__(self, sessions: sessionmaker[Session], settings: SettingsPort):
        self._sessions, self._settings = sessions, settings

    def run(self, now: datetime) -> str:
        days = int(self._settings.get("session_details_days"))
        with self._sessions.begin() as session:
            gone = session.execute(delete(UserSession).where(UserSession.absolute_expires_at < now - timedelta(days=days))).rowcount
            tokens = session.execute(delete(EmailToken).where(EmailToken.expires_at < now - timedelta(days=TOKEN_DAYS))).rowcount
        return f"{gone} sessions and {tokens} tokens deleted"


class EvidenceRetention:
    def __init__(self, sessions: sessionmaker[Session], records: SqlAttemptRecords, settings: SettingsPort):
        self._sessions, self._records, self._settings = sessions, records, settings

    def run(self, now: datetime) -> str:
        cutoff = now - timedelta(days=int(self._settings.get("learner_evidence_days")))
        due = [a.attempt_id for a in self._records.learner_attempts_with_evidence() if a.destroyed_at is not None and a.destroyed_at <= cutoff]
        removed = 0
        if due:
            with self._sessions.begin() as session:
                removed = session.execute(delete(Evidence).where(Evidence.attempt_id.in_(due))).rowcount
        return f"evidence of {len(due)} attempts deleted ({removed} items)"


class LogPurge:
    def __init__(self, sessions: sessionmaker[Session], settings: SettingsPort):
        self._sessions, self._settings = sessions, settings

    def run(self, now: datetime) -> str:
        cutoff = now - months(int(self._settings.get("log_retention_months")))
        failed_before = now - timedelta(days=int(self._settings.get("outbox_failed_address_days")))
        with self._sessions.begin() as session:
            audit = 0
            if session.get_bind().dialect.name == "postgresql":
                audit = session.execute(text("SELECT purge_audit_log(:b)"), {"b": cutoff}).scalar_one()
            events = session.execute(delete(SecurityEvent).where(SecurityEvent.created_at < cutoff)).rowcount
            runs = session.execute(delete(JobRun).where(JobRun.finished_at.is_not(None), JobRun.finished_at < cutoff)).rowcount
            mails = session.execute(delete(EmailOutbox).where(EmailOutbox.state == "sent", EmailOutbox.sent_at < cutoff)).rowcount
            cleared = session.execute(update(EmailOutbox).where(EmailOutbox.state == "failed", EmailOutbox.to_address_sealed.is_not(None),
                                                                EmailOutbox.updated_at < failed_before).values(to_address_sealed=None)).rowcount
        return f"{audit} audit entries, {events} security events, {runs} job runs, {mails} mails purged; {cleared} sealed addresses cleared"


class ConsentPurge:
    def __init__(self, sessions: sessionmaker[Session]):
        self._sessions = sessions

    def run(self, now: datetime) -> str:
        with self._sessions.begin() as session:
            if session.get_bind().dialect.name != "postgresql":
                return "0 consent records purged (no database function here)"
            return f"{session.execute(text('SELECT purge_consent_records()')).scalar_one()} consent records purged"


class LiveCleanup:
    def __init__(self, sessions: sessionmaker[Session], settings: SettingsPort, streams: StreamWriter | None):
        self._sessions, self._settings, self._streams = sessions, settings, streams

    def run(self, now: datetime) -> str:
        cutoff = now - timedelta(days=int(self._settings.get("domain_event_days")))
        with self._sessions.begin() as session:
            rows = session.execute(delete(DomainEvent).where(DomainEvent.published_at.is_not(None), DomainEvent.published_at < cutoff)).rowcount
        swept = self._streams.sweep(now) if self._streams is not None and hasattr(self._streams, "sweep") else 0
        return f"{rows} event rows deleted, {swept} idle streams cleared"


def anchor_audit(anchors: AuditAnchors):
    def run(now: datetime) -> str:
        result = anchors.anchor()
        return f"anchored entry {result.head_seq}" if result.created else f"already anchored today at entry {result.head_seq}"

    return run
