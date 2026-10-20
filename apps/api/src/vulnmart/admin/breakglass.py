"""Break-glass access (story P-31, FR-ADM-03, FR-ADM-08; D-94 answers OI-12) and the admin's reading of the audit log (FR-ADM-07).

An admin has no standing access to a candidate's answers, write-ups or evidence (the lab's reviewer routes answer an admin like anyone else: not found). Break-glass is
the one way: `open` a session for one candidate attempt with a written reason (20 to 500 characters); it lasts 15 minutes (D-94); the other active admins and the owner of
the company whose candidate it is are mailed at once (the real-time alert). During the window the session's own admin `read`s the attempt's results, evidence and
timeline (read from the lab runtime of this process, flag-shaped text redacted); every read is recorded in the session row (when, what) and audited. The admin can
`close` it early. Afterwards another admin `review`s it (never the session's own admin; the table refuses it too). A learner's practice attempt is not reachable this way.

The reason text is kept in the session row; the audit entries carry the session id, never the reason. Reading the audit log (`audit_entries`) is audited itself.
"""
from __future__ import annotations

import base64
import secrets
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.models import User
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.service import InvalidInput
from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.scope import Scope
from vulnmart.privacy.exports import attempt_results, redact, stamp

from .models import BreakGlassSession

WINDOW = timedelta(minutes=15)  # D-94
REASON_MIN, REASON_MAX = 20, 500
TIMELINE = {"session_started": "attempt.started", "milestone_reached": "milestone.reached", "flag_submitted": "flag.submitted", "hint_unlocked": "hint.unlocked",
            "instance_reset": "instance.reset", "session_submitted": "attempt.submitted", "session_expired": "attempt.expired"}


class SessionNotFound(Exception):
    """No such break-glass session, or not the caller's to use (the same answer)."""


class SessionState(Exception):
    """The session is over (expired or closed), still open where it must be over, already reviewed, or the reviewer is its own admin."""


@dataclass(frozen=True, slots=True)
class SessionView:
    session_id: str
    admin_id: str
    admin_name: str
    attempt_id: str
    org_id: str
    reason: str
    started_at: datetime
    expires_at: datetime
    closed_at: datetime | None
    reads: tuple[dict[str, Any], ...]
    reviewed_by: str | None
    reviewed_at: datetime | None
    review_note: str | None
    state: str  # open, over, reviewed


def new_session_id() -> str:
    return "g-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _clean_text(raw: Any, pointer: str, low: int, high: int) -> str:
    if not isinstance(raw, str):
        raise InvalidInput(pointer)
    text = " ".join(unicodedata.normalize("NFC", raw).split())
    if not low <= len(text) <= high:
        raise InvalidInput(pointer)
    return text


class BreakGlassService:
    def __init__(self, *, sessions: sessionmaker[Session], roles: RoleService, audit: AuditPort, companies: Any, lab: Callable[[], Any | None],
                 now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._sessions, self._roles, self._audit, self._companies, self._lab, self._now = sessions, roles, audit, companies, lab, now

    # ---- the audit log (FR-ADM-07) ----

    def audit_entries(self, actor: Scope, *, action: str | None = None, after_seq: int = 0, limit: int = 100) -> list[Any]:
        """Entries after `after_seq`, oldest first, optionally of one action. The read itself is audited (`admin.audit_read`)."""
        admin_id = self._roles.require_admin(actor)
        limit = max(1, min(limit, 200))
        reader = getattr(self._audit, "entries", None)
        if reader is not None:
            rows = reader(action=action, after_seq=after_seq, limit=limit)
        else:  # the in-memory audit of the tests and of a process without a database
            rows = [r for r in getattr(self._audit, "records", []) if r.seq > after_seq and (action is None or r.action == action)][:limit]
        self._audit.append(actor=admin_id, action="admin.audit_read", subject=None, details={"count": len(rows), "action": action, "after_seq": after_seq})
        return list(rows)

    # ---- break-glass (FR-ADM-03) ----

    def _view(self, session: Session, row: BreakGlassSession, now: datetime) -> SessionView:
        admin = session.get(User, row.admin_id)
        over = row.closed_at is not None or _aware(row.expires_at) <= now
        state = "reviewed" if row.reviewed_at is not None else ("over" if over else "open")
        return SessionView(row.id, row.admin_id, admin.display_name if admin is not None else "(deleted)", row.attempt_id, row.org_id, row.reason,
                           _aware(row.started_at), _aware(row.expires_at), _aware(row.closed_at), tuple(row.what_read or ()), row.reviewed_by,
                           _aware(row.reviewed_at), row.review_note, state)

    def open(self, actor: Scope, attempt_id: str, reason: Any) -> SessionView:
        """Open a 15-minute session for one candidate attempt. Raises SessionNotFound (no lab, unknown attempt, or a learner's practice attempt) and InvalidInput."""
        admin_id = self._roles.require_admin(actor)
        text = _clean_text(reason, "/reason", REASON_MIN, REASON_MAX)
        rt = self._lab()
        if rt is None:
            raise SessionNotFound
        try:
            rec = rt.engine.get(attempt_id)
        except Exception:  # noqa: BLE001 - an unknown attempt is "not found", whatever the store raises
            raise SessionNotFound from None
        org_id = getattr(rec, "org_id", None)
        if rec is None or not org_id:
            raise SessionNotFound  # practice data is never opened this way
        now = self._now()
        sid = new_session_id()
        minutes = str(int(WINDOW.total_seconds() // 60))
        owner = self._company_owner(str(org_id))  # read before the transaction: a second session inside it would end it on a shared connection
        with self._sessions.begin() as session:
            session.add(BreakGlassSession(id=sid, admin_id=admin_id, attempt_id=attempt_id, org_id=str(org_id), reason=text, started_at=now,
                                          expires_at=now + WINDOW, what_read=[]))
            outbox = DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params)
            others = session.scalars(select(User.id).where(User.account_type == "admin", User.status == "active", User.id != admin_id)).all()
            for other in others:
                outbox.enqueue_email(template="admin.break_glass_opened", to_user_id=other, params={"grant_id": sid, "minutes": minutes})
            if owner is not None:
                outbox.enqueue_email(template="company.break_glass_opened", to_user_id=owner, params={"minutes": minutes})
            session.flush()
            view = self._view(session, session.get(BreakGlassSession, sid), now)
        self._audit.append(actor=admin_id, action="breakglass.opened", subject=None,
                           details={"session": sid, "attempt": attempt_id, "org": str(org_id), "minutes": int(minutes), "alerted_admins": len(others),
                                    "alerted_company": owner is not None})
        return view

    def _company_owner(self, org_id: str) -> str | None:
        return self._companies.owner_of_org(org_id) if self._companies is not None else None

    def sessions(self, actor: Scope, limit: int = 50) -> list[SessionView]:
        self._roles.require_admin(actor)
        now = self._now()
        with self._sessions() as session:
            rows = session.scalars(select(BreakGlassSession).order_by(BreakGlassSession.started_at.desc(), BreakGlassSession.id).limit(max(1, min(limit, 100)))).all()
            return [self._view(session, r, now) for r in rows]

    def read(self, actor: Scope, session_id: str) -> dict[str, Any]:
        """The attempt's results, evidence and timeline, for the session's own admin while it is open. Each read is recorded and audited."""
        admin_id = self._roles.require_admin(actor)
        now = self._now()
        with self._sessions() as session:
            row = session.get(BreakGlassSession, session_id)
            if row is None or row.admin_id != admin_id:
                raise SessionNotFound
            if row.closed_at is not None or _aware(row.expires_at) <= now:
                raise SessionState("over")
            attempt_id = row.attempt_id
        rt = self._lab()
        if rt is None:
            raise SessionNotFound
        rec = rt.engine.get(attempt_id)
        results = attempt_results(rt, rec, now, evidence=True)
        timeline = [{"at": stamp(e["at"]) if isinstance(e.get("at"), datetime) else e.get("at"), "type": TIMELINE[e.get("event", "")],
                     "challenge_key": e.get("challenge_key"), "detail": redact(str(e.get("result") or e.get("level") or "")) or None}
                    for _, e in rt.attempt_log.read_keyed(attempt_id) if e.get("event") in TIMELINE]
        what = ["report", "evidence", "timeline"]
        with self._sessions.begin() as session:
            row = session.get(BreakGlassSession, session_id)
            reads = list(row.what_read or [])
            reads.append({"at": stamp(now), "what": what})
            session.execute(update(BreakGlassSession).where(BreakGlassSession.id == session_id).values(what_read=reads))
        self._audit.append(actor=admin_id, action="breakglass.read", subject=None, details={"session": session_id, "attempt": attempt_id, "what": what})
        return {"session_id": session_id, "attempt_id": attempt_id, "expires_at": stamp(_aware(row.expires_at)), "results": results, "timeline": timeline}

    def close(self, actor: Scope, session_id: str) -> SessionView:
        admin_id = self._roles.require_admin(actor)
        now = self._now()
        with self._sessions.begin() as session:
            row = session.get(BreakGlassSession, session_id)
            if row is None or row.admin_id != admin_id:
                raise SessionNotFound
            if row.closed_at is not None or _aware(row.expires_at) <= now:
                raise SessionState("over")
            session.execute(update(BreakGlassSession).where(BreakGlassSession.id == session_id).values(closed_at=now))
            session.flush()
            session.refresh(row)
            view = self._view(session, row, now)
        self._audit.append(actor=admin_id, action="breakglass.closed", subject=None, details={"session": session_id})
        return view

    def review(self, actor: Scope, session_id: str, note: Any) -> SessionView:
        """The later review, by another admin, once the session is over."""
        admin_id = self._roles.require_admin(actor)
        text = _clean_text(note, "/note", 1, 500)
        now = self._now()
        with self._sessions.begin() as session:
            row = session.get(BreakGlassSession, session_id)
            if row is None:
                raise SessionNotFound
            over = row.closed_at is not None or _aware(row.expires_at) <= now
            if row.admin_id == admin_id or not over or row.reviewed_at is not None:
                raise SessionState("not reviewable")
            session.execute(update(BreakGlassSession).where(BreakGlassSession.id == session_id).values(reviewed_by=admin_id, reviewed_at=now, review_note=text))
            session.flush()
            session.refresh(row)
            view = self._view(session, row, now)
        self._audit.append(actor=admin_id, action="breakglass.reviewed", subject=None, details={"session": session_id})
        return view

