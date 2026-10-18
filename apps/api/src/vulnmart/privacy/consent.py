"""The consent service (story P-16, FR-PRV-01, FR-PRV-02): the notice for an attempt, the append-only record of a decision, a person's own records.

A decision is made by the person whose attempt it is, on an attempt in state `consent`, against the notice the server renders now: the
request repeats the notice version and the hash of the text the person saw, and a different hash is stale (ATT-CONSENT-STALE), so nobody
can be recorded as agreeing to text they were not shown. One granted-or-declined decision exists per attempt: the work of a request
runs under an advisory lock on the attempt in one transaction (check, audit entry, insert), and a partial unique index is the backstop. A
repeated request with the same decision returns the existing record and finishes moving the attempt on (so a failure between the two steps
heals on retry); the opposite decision is a conflict. The audit entry is written before the transaction commits and its sequence number is
kept in the record (the link into the audit chain). The record stores a keyed hash of the address and browser, never the values.
"""
from __future__ import annotations

import base64
import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.settings import SettingsPort

from .models import ConsentRecord
from .notice import Notice, check_template, render
from .targets import ConsentTarget, ConsentTargets

logger = logging.getLogger("vulnmart.privacy")

DECISIONS = ("granted", "declined")
MAX_USER_AGENT = 300


class ConsentNotFound(Exception):
    """No such attempt for this person (someone else's attempt is the same answer)."""


class ConsentState(Exception):
    """The attempt is not waiting for a decision, or it was already decided the other way."""


class ConsentStale(Exception):
    """The notice the person saw is not the current one."""


@dataclass(frozen=True, slots=True)
class ConsentView:
    consent_id: str
    attempt_id: str
    notice_version: str
    decision: str
    recorded_at: datetime


def new_consent_id() -> str:
    return "k-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")


def _view(row: ConsentRecord) -> ConsentView:
    at = row.at if row.at.tzinfo else row.at.replace(tzinfo=UTC)  # SQLite (the fast tests) hands back naive times; Postgres never does
    return ConsentView(row.id, row.attempt_id, row.notice_version, row.action, at)


class ConsentService:
    def __init__(self, sessions: sessionmaker[Session], targets: ConsentTargets, audit: AuditPort, settings: SettingsPort, keys: FieldKeys, *,
                 now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        check_template()  # the shown text must be the text pinned for its version: refuse to start otherwise
        self._sessions, self._targets, self._audit, self._settings, self._keys, self._now = sessions, targets, audit, settings, keys, now

    # ---- the notice ----

    def _notice_for(self, target: ConsentTarget) -> Notice:
        days = target.retention_days if target.retention_days is not None else int(self._settings.get("candidate_retention_days"))
        return render(company_name=target.company_name, retention_days=days,
                      record_months=int(self._settings.get("consent_record_extra_months")))

    def _own_target(self, user_id: str, attempt_id: str) -> ConsentTarget:
        target = self._targets.find(attempt_id)
        if target is None or target.user_id != user_id:
            raise ConsentNotFound
        return target

    def notice(self, user_id: str, attempt_id: str) -> tuple[ConsentTarget, Notice]:
        target = self._own_target(user_id, attempt_id)
        if target.state != "consent":
            raise ConsentState
        return target, self._notice_for(target)

    # ---- the decision ----

    def record(self, *, user_id: str, attempt_id: str, notice_version: str, notice_sha256: str, decision: str, ip: str | None,
               user_agent: str | None) -> ConsentView:
        if decision not in DECISIONS:
            raise ValueError("decision is granted or declined")
        target = self._own_target(user_id, attempt_id)
        notice = self._notice_for(target)
        ip_hash = self._keys.context_hash("ip", ip) if ip else None
        ua_hash = self._keys.context_hash("ua", user_agent[:MAX_USER_AGENT]) if user_agent else None
        with self._sessions.begin() as session:
            if session.get_bind().dialect.name == "postgresql":  # the fast tests run on sqlite, where one writer at a time is the rule anyway
                session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": f"consent:{attempt_id}"})
            existing = session.scalar(select(ConsentRecord).where(ConsentRecord.attempt_id == attempt_id, ConsentRecord.action.in_(DECISIONS)))
            if existing is not None:
                if existing.action != decision or existing.user_id != user_id:
                    raise ConsentState
                view = _view(existing)  # a repeat of the same decision: the same record, and the attempt is moved on below if it was not yet
            else:
                if target.state != "consent":
                    raise ConsentState
                if notice_version != notice.version or notice_sha256 != notice.sha256:
                    raise ConsentStale
                row = self._insert(session, user_id, target, notice, decision, ip_hash, ua_hash)
                view = _view(row)
        try:
            self._targets.proceed(attempt_id, decision=decision, consent_id=view.consent_id)
        except Exception:
            # The record is written and cannot be taken back; repeating the same request finishes the move. Say so in the log, never in the answer.
            logger.error("consent %s recorded but the attempt could not be moved on; the same request repeated will finish it", view.consent_id)
            raise
        return view

    def _insert(self, session: Session, user_id: str, target: ConsentTarget, notice: Notice, decision: str, ip_hash: str | None,
                ua_hash: str | None) -> ConsentRecord:
        consent_id = new_consent_id()
        audit = self._audit.append(actor=user_id, action=f"consent.{decision}", subject=user_id, details={
            "consent": consent_id, "attempt": target.attempt_id, "org": target.org_id, "notice_version": notice.version, "notice_sha256": notice.sha256,
        })
        row = ConsentRecord(
            id=consent_id, user_id=user_id, attempt_id=target.attempt_id, org_id=target.org_id, template_id=target.template_id,
            notice_version=notice.version, notice_text_sha256=notice.sha256, notice_text_snapshot=notice.text,
            retention_days_shown=notice.retention_days_shown, controller_name_shown=notice.company_name, action=decision, at=self._now(),
            ip_hash=ip_hash, ua_hash=ua_hash, method="web", audit_seq=audit.seq,
        )
        session.add(row)
        session.flush()
        return row

    # ---- a person's own records ----

    def list_mine(self, user_id: str, limit: int) -> tuple[list[ConsentView], bool]:
        with self._sessions() as session:
            rows = session.scalars(select(ConsentRecord).where(ConsentRecord.user_id == user_id)
                                   .order_by(ConsentRecord.at.desc(), ConsentRecord.id.desc()).limit(limit + 1)).all()
        return [_view(r) for r in rows[:limit]], len(rows) > limit
