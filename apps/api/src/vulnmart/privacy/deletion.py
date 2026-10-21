"""The deletion workflow (story P-25, FR-PRV-08, FR-PRV-09, ADR 0055): asking for data to be deleted, the 7-day undo window, the company's part, and the job that carries it out.

- **A learner** asks for their practice data and account to go (`request_learner`). The request is held `consent_withdraw_undo_days` (7) days and the person can undo it any time
  before (`cancel`); after that the job deletes the practice attempts (the lab erases each) and the account, and forgets the audit pseudonym, so the log entries identify nobody.
  A learner who also took part in an assessment keeps the account until the company's data is gone (the same rule as the 12-month retention, ADR 0054); that data is deleted by
  a candidate request, not by this one. Nothing is locked while the request waits: the account works as before, so an undo has nothing to restore.
- **A candidate** asks for the assessment record of one attempt to be deleted (`request_candidate`). It goes to the company that holds it (`decide`: approve or decline); the
  company is asked to decide within `deletion_decide_days` (14) and the admins are told when it does not (`deletion.escalated`; the numbers are placeholders from the requirements).
  An approved request waits the same 7 days (undo by the candidate), then the job deletes the record the way the retention job does: the lab erases the attempt, the consent
  records are scheduled to go 12 months later (OI-37), the invite and the person's view history for that company go.
- **The company** can delete a candidate's record at any time (`company_delete`): no request, no wait.

Authorisation is the caller's (the routes know the session; the company side has no routes yet, story 5.3): every method that takes a person's id acts only on that person's
requests, and every company method acts only on its own company's attempts. A request that is not yours is "not found". Audit entries name the company and counts; the person's own
requests carry their pseudonym (forgotten with the account).
"""
from __future__ import annotations

import base64
import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.models import User, UserRole
from vulnmart.assessments.service import AssessmentService
from vulnmart.notifications.triggers import MailTriggers
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.settings import SettingsPort

from .models import ConsentRecord, DataView, DeletionRequest
from .retention.candidates import NoEraser, months, schedule_consent_erase
from .retention.records import SqlAttemptRecords
from .subjects import SubjectService

logger = logging.getLogger("vulnmart.privacy")
BATCH = 200
OPEN = ("pending", "approved")


class DeletionNotFound(Exception):
    """No such request or attempt for this person or company (someone else's is the same answer)."""


class DeletionState(Exception):
    """The request is not open any more (done, declined or undone), or the attempt is not over yet."""


class DeletionExists(Exception):
    """The person already has an open request of this kind."""


class NotLearner(Exception):
    """Only a learner account asks for the learner deletion."""


@dataclass(frozen=True, slots=True)
class RequestView:
    request_id: str
    kind: str
    status: str
    requested_at: datetime
    attempt_id: str | None
    company_name: str | None
    decide_by: datetime | None
    decided_at: datetime | None
    execute_after: datetime | None
    finished_at: datetime | None

    @property
    def can_undo(self) -> bool:
        return self.status in OPEN


@dataclass(frozen=True, slots=True)
class CompanyRequest:
    """What the company sees of a candidate's request: the attempt (its own record) and the deadline, never the person's account."""

    request_id: str
    attempt_id: str
    status: str
    requested_at: datetime
    decide_by: datetime | None
    execute_after: datetime | None
    escalated: bool = False  # the company did not decide in time and the admins were told (FR-PRV-09)


def new_request_id() -> str:
    return "d-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)  # SQLite hands back naive times; Postgres never does


class DeletionService:
    def __init__(self, sessions: sessionmaker[Session], assessments: AssessmentService | None, records: SqlAttemptRecords, settings: SettingsPort, audit: AuditPort,
                 subjects: SubjectService | None, eraser: Callable[[str], None] | None, *, now: Callable[[], datetime] = lambda: datetime.now(UTC),
                 mail: MailTriggers | None = None):
        self._sessions, self._assessments, self._records, self._settings, self._audit = sessions, assessments, records, settings, audit
        self._subjects, self._eraser, self._now = subjects, eraser, now
        self._mail = mail  # the notice mails (story WP-B); None in a process that sends none

    # ---- the person's side ----

    def _view(self, row: DeletionRequest, company: str | None = None) -> RequestView:
        return RequestView(row.id, row.kind, row.status, _aware(row.requested_at), row.attempt_id, company, _aware(row.decide_by), _aware(row.decided_at),
                           _aware(row.execute_after), _aware(row.finished_at))

    def _company_name(self, session: Session, user_id: str, attempt_id: str | None) -> str | None:
        if attempt_id is None:
            return None
        return session.scalar(select(ConsentRecord.controller_name_shown).where(ConsentRecord.attempt_id == attempt_id, ConsentRecord.user_id == user_id).limit(1))

    def request_learner(self, user_id: str) -> RequestView:
        """Ask for a learner's practice data and account to be deleted after the undo window. Raises NotLearner, DeletionExists."""
        now = self._now()
        undo = timedelta(days=int(self._settings.get("consent_withdraw_undo_days")))
        row = DeletionRequest(id=new_request_id(), kind="learner", user_id=user_id, status="pending", requested_at=now, execute_after=now + undo)
        try:
            with self._sessions.begin() as session:
                learner = session.scalar(select(UserRole.user_id).join(User, User.id == UserRole.user_id)
                                         .where(UserRole.user_id == user_id, UserRole.role == "learner", User.account_type == "participant"))
                if learner is None:
                    raise NotLearner
                session.add(row)
                session.flush()
                view = self._view(row)
        except IntegrityError:
            raise DeletionExists from None
        self._audit.append(actor=user_id, action="deletion.requested", subject=user_id, details={"kind": "learner", "request": view.request_id,
                                                                                               "execute_after": view.execute_after.isoformat()})
        if self._mail is not None:
            self._mail.deletion_requested_learner(user_id, deletion_on=view.execute_after.date().isoformat())
        return view

    def request_candidate(self, user_id: str, attempt_id: str) -> RequestView:
        """Ask the company that holds an assessment record to have it deleted. Raises DeletionNotFound (not your attempt), DeletionState (the attempt is not over), DeletionExists."""
        info = self._records.get(attempt_id)
        if info is None or info.user_id != user_id or info.org_id is None:
            raise DeletionNotFound
        if info.ended_at is None:
            raise DeletionState
        now = self._now()
        decide = timedelta(days=int(self._settings.get("deletion_decide_days")))
        row = DeletionRequest(id=new_request_id(), kind="candidate", user_id=user_id, attempt_id=attempt_id, org_id=str(info.org_id), status="pending", requested_at=now,
                              decide_by=now + decide)
        try:
            with self._sessions.begin() as session:
                session.add(row)
                session.flush()
                view = self._view(row, self._company_name(session, user_id, attempt_id))
        except IntegrityError:
            raise DeletionExists from None
        self._audit.append(actor=user_id, action="deletion.requested", subject=user_id, details={"kind": "candidate", "request": view.request_id, "org": str(info.org_id),
                                                                                               "decide_by": view.decide_by.isoformat()})
        if self._mail is not None:
            self._mail.deletion_requested_candidate(attempt_id, decide_by=view.decide_by.date().isoformat())
        return view

    def cancel(self, user_id: str, request_id: str) -> RequestView:
        """Undo: stop an open request of this person's. Raises DeletionNotFound (not theirs), DeletionState (already done, declined or undone)."""
        now = self._now()
        with self._sessions.begin() as session:
            moved = session.execute(update(DeletionRequest).where(DeletionRequest.id == request_id, DeletionRequest.user_id == user_id, DeletionRequest.status.in_(OPEN))
                                    .values(status="cancelled", finished_at=now)).rowcount
            row = session.get(DeletionRequest, request_id)
            if row is None or row.user_id != user_id:
                raise DeletionNotFound
            if not moved:
                raise DeletionState
            view = self._view(row, self._company_name(session, user_id, row.attempt_id))
        self._audit.append(actor=user_id, action="deletion.cancelled", subject=user_id, details={"kind": view.kind, "request": request_id})
        return view

    def mine(self, user_id: str, limit: int = 50) -> list[RequestView]:
        with self._sessions() as session:
            rows = session.scalars(select(DeletionRequest).where(DeletionRequest.user_id == user_id).order_by(DeletionRequest.requested_at.desc(), DeletionRequest.id).limit(limit)).all()
            return [self._view(r, self._company_name(session, user_id, r.attempt_id)) for r in rows]

    # ---- the company's side ----

    def for_company(self, org_id: str, *, open_only: bool = True, limit: int = 100) -> list[CompanyRequest]:
        query = select(DeletionRequest).where(DeletionRequest.kind == "candidate", DeletionRequest.org_id == org_id)
        if open_only:
            query = query.where(DeletionRequest.status.in_(OPEN))
        with self._sessions() as session:
            rows = session.scalars(query.order_by(DeletionRequest.requested_at, DeletionRequest.id).limit(limit)).all()
            return [CompanyRequest(r.id, r.attempt_id or "", r.status, _aware(r.requested_at), _aware(r.decide_by), _aware(r.execute_after), r.escalated_at is not None)
                    for r in rows]

    def decide(self, org_id: str, request_id: str, *, approve: bool, actor_id: str) -> CompanyRequest:
        """The company approves (the 7-day hold starts) or declines a candidate's request. Raises DeletionNotFound (not this company's), DeletionState (already decided)."""
        now = self._now()
        hold = timedelta(days=int(self._settings.get("consent_withdraw_undo_days")))
        values = {"status": "approved", "decided_at": now, "execute_after": now + hold} if approve else {"status": "declined", "decided_at": now, "finished_at": now}
        with self._sessions.begin() as session:
            moved = session.execute(update(DeletionRequest).where(DeletionRequest.id == request_id, DeletionRequest.kind == "candidate", DeletionRequest.org_id == org_id,
                                                                  DeletionRequest.status == "pending").values(**values)).rowcount
            row = session.get(DeletionRequest, request_id)
            if row is None or row.kind != "candidate" or row.org_id != org_id:
                raise DeletionNotFound
            if not moved:
                raise DeletionState
            out = CompanyRequest(row.id, row.attempt_id or "", row.status, _aware(row.requested_at), _aware(row.decide_by), _aware(row.execute_after), row.escalated_at is not None)
        self._audit.append(actor=actor_id, action="deletion.approved" if approve else "deletion.declined", subject=None, details={"org": org_id, "request": request_id})
        if self._mail is not None and out.attempt_id:
            self._mail.deletion_decided(out.attempt_id, approve=approve, deletion_on=out.execute_after.date().isoformat() if out.execute_after else None)
        return out

    def company_delete(self, org_id: str, attempt_id: str, *, actor_id: str) -> int:
        """The company deletes a candidate's record now (FR-PRV-08). Raises DeletionNotFound when the attempt (or its invite) is not this company's. Returns the attempts erased."""
        now = self._now()
        info = self._records.get(attempt_id)
        if info is not None and str(info.org_id) != org_id:
            raise DeletionNotFound
        with self._sessions() as session:
            asked_by = list(session.scalars(select(DeletionRequest.user_id).where(DeletionRequest.kind == "candidate", DeletionRequest.attempt_id == attempt_id,
                                                                                  DeletionRequest.org_id == org_id, DeletionRequest.status.in_(OPEN))))
        erased, invites = self._erase_candidate(org_id, attempt_id, info.user_id if info else None, now)
        if info is None and invites == 0:
            raise DeletionNotFound
        with self._sessions.begin() as session:
            session.execute(update(DeletionRequest).where(DeletionRequest.kind == "candidate", DeletionRequest.attempt_id == attempt_id, DeletionRequest.org_id == org_id,
                                                          DeletionRequest.status.in_(OPEN)).values(status="done", finished_at=now))
        self._audit.append(actor=actor_id, action="deletion.company_deleted", subject=None, details={"org": org_id, "attempts": erased, "invites": invites})
        if self._mail is not None:
            for user_id in asked_by:  # the person who asked is told it is done
                self._mail.deletion_confirmed(user_id, completed_on=now.date().isoformat())
        return erased

    def _erase_candidate(self, org_id: str, attempt_id: str, user_id: str | None, now: datetime) -> tuple[int, int]:
        """The steps of the retention job for one attempt, in its order, each safe to repeat: the lab erases the attempt, the consent records are scheduled, the invite and the
        view history for this company go."""
        erased = 0
        if self._records.get(attempt_id) is not None:
            if self._eraser is None:
                raise NoEraser
            self._eraser(attempt_id)
            erased = 1
        schedule_consent_erase(self._sessions, attempt_id, now + months(int(self._settings.get("consent_record_extra_months"))))
        invites = self._assessments.delete_attempt_invite(org_id, attempt_id) if self._assessments is not None else 0
        if user_id is not None:
            with self._sessions.begin() as session:
                session.execute(delete(DataView).where(DataView.candidate_user_id == user_id, DataView.org_id == org_id))
        return erased, invites

    # ---- the job ----

    def run(self, now: datetime) -> str:
        escalated = 0
        with self._sessions() as session:
            late = [(r.id, r.org_id, r.attempt_id, r.decide_by) for r in session.scalars(select(DeletionRequest).where(
                DeletionRequest.kind == "candidate", DeletionRequest.status == "pending", DeletionRequest.escalated_at.is_(None), DeletionRequest.decide_by <= now).limit(BATCH))]
        for request_id, org, late_attempt, due_by in late:
            with self._sessions.begin() as session:
                moved = session.execute(update(DeletionRequest).where(DeletionRequest.id == request_id, DeletionRequest.status == "pending", DeletionRequest.escalated_at.is_(None))
                                        .values(escalated_at=now)).rowcount
            if moved:
                escalated += 1
                self._audit.append(actor="job:deletion_requests", action="deletion.escalated", subject=None, details={"org": org, "request": request_id})
                if self._mail is not None and late_attempt:
                    self._mail.deletion_escalated(late_attempt, request_id=request_id, decide_by=_aware(due_by).date().isoformat())
        with self._sessions() as session:
            due = [r.id for r in session.scalars(select(DeletionRequest).where(DeletionRequest.status.in_(OPEN), DeletionRequest.execute_after.is_not(None),
                                                                              DeletionRequest.execute_after <= now).order_by(DeletionRequest.execute_after).limit(BATCH))]
        learners = candidates = kept = 0
        for request_id in due:
            with self._sessions() as session:
                row = session.get(DeletionRequest, request_id)
                if row is None or row.status not in OPEN:
                    continue
                kind, user_id, attempt_id, org_id = row.kind, row.user_id, row.attempt_id, row.org_id
            address = None
            if kind == "learner":
                with self._sessions() as session:
                    address = session.scalar(select(User.email_ci).where(User.id == user_id))  # read now: the account may go in the next step
                if self._execute_learner(user_id, now):
                    learners += 1
                else:
                    kept += 1
                    address = None  # the account is still there: the mail goes by its id
            else:
                erased, invites = self._erase_candidate(org_id or "", attempt_id or "", user_id, now)
                self._audit.append(actor="job:deletion_requests", action="deletion.candidate_done", subject=None, details={"org": org_id, "attempts": erased, "invites": invites})
                candidates += 1
            with self._sessions.begin() as session:
                session.execute(update(DeletionRequest).where(DeletionRequest.id == request_id, DeletionRequest.status.in_(OPEN)).values(status="done", finished_at=now))
            if self._mail is not None:
                self._mail.deletion_confirmed(user_id, completed_on=now.date().isoformat(), address=address, request_id=request_id)
        return f"{learners} learner requests done ({kept} kept the account for assessment data), {candidates} candidate requests done, {escalated} escalated"

    def delete_learner_account(self, user_id: str) -> bool:
        """An admin deletes a participant's account now (story P-28, FR-ADM-02): the practice attempts are erased and, unless the account holds assessment data, the account and its
        pseudonym go. True when the account went, False when it was kept for that data (the caller locks it instead)."""
        return self._execute_learner(user_id, self._now())

    def _execute_learner(self, user_id: str, now: datetime) -> bool:
        """Delete the practice attempts and, unless the account holds assessment data, the account. True when the account went."""
        attempts = self._records.learner_attempts(user_id)
        if attempts and self._eraser is None:
            raise NoEraser
        for attempt in attempts:
            self._eraser(attempt.attempt_id)  # type: ignore[misc]
        keep = self._records.has_candidate_data(user_id)
        self._audit.append(actor="job:deletion_requests", action="deletion.learner_done", subject=user_id, details={"attempts": len(attempts), "account_kept": keep})
        if keep:
            return False
        with self._sessions.begin() as session:
            session.execute(delete(DataView).where(DataView.candidate_user_id == user_id))
            session.execute(delete(User).where(User.id == user_id))
        if self._subjects is not None:
            self._subjects.forget(user_id)
        return True
