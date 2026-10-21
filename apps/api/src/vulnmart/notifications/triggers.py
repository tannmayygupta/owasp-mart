"""The mails that the attempt flows cause (FR-NTF-01, FR-NTF-04): consent withdrawn, time warning, submission received, results released.

The lab owns the places where these things happen (withdrawing, the clock, submitting, releasing) and calls one method here with the attempt id; this module finds out who
to tell and what the assessment is called, and queues the mail in its own short transaction (`DbOutboxPort`, never an address in a row). A missing attempt, invite or
company is logged and answers 0: a mail that cannot be built must never break the flow that caused it.

Who is told: a mail for the candidate goes to the account that took the attempt; a mail for the company goes to the recruiter who made the invite while that person is
still an active member, else to the company's owner.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.models import User
from vulnmart.assessments.models import AssessmentTemplate, Invite
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.lab.models import Attempt
from vulnmart.orgs.models import Organization, OrgMember
from vulnmart.ports.scope import Role, Scope

from .service import DbOutboxPort
from .templates import validate_params

logger = logging.getLogger("vulnmart.notifications")


@dataclass(frozen=True, slots=True)
class AttemptMailContext:
    candidate_id: str
    org_id: str
    org_name: str
    assessment_name: str
    recruiter_id: str  # the invite's author while still an active member, else the owner


class MailTriggers:
    def __init__(self, sessions: sessionmaker[Session], scope: ContextScopePort, *, public_origin: str, now: Callable[[], datetime] = lambda: datetime.now(UTC),
                 keys: Any = None):
        self._sessions, self._scope, self._origin, self._now = sessions, scope, public_origin.rstrip("/"), now
        self._keys = keys  # FieldKeys: seals the address of a person whose account is gone (the deletion-confirmed mail)

    # ---- who and what ----

    def context_for(self, attempt_id: str) -> AttemptMailContext | None:
        """The candidate, the company, the assessment's title and the recruiter to tell, for an assessment attempt. None for a practice attempt or an unknown one."""
        with self._sessions() as session:
            attempt = session.get(Attempt, attempt_id)
            if attempt is None or not attempt.org_id:
                return None
            user_id, org_text = attempt.user_id, str(attempt.org_id)
        try:
            org_id = uuid.UUID(org_text)
        except ValueError:
            return None
        with self._scope.acting_as(Scope(user_id="system:mail", org_id=str(org_id), roles=frozenset({Role.RECRUITER}))):
            with self._sessions() as session:
                org = session.get(Organization, org_id)
                invite = session.scalar(select(Invite).where(Invite.attempt_id == attempt_id))
                if org is None or invite is None:
                    return None
                title = session.scalar(select(AssessmentTemplate.title).where(AssessmentTemplate.id == invite.template_id)) or "assessment"
                active = session.scalar(select(OrgMember.user_id).where(OrgMember.org_id == org_id, OrgMember.user_id == invite.created_by, OrgMember.status == "active"))
                return AttemptMailContext(user_id, org_text, org.name, title, active or org.owner_user_id)

    def _queue(self, mails: list[tuple[str, str, dict]]) -> int:
        with self._sessions.begin() as session:
            outbox = DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params)
            for template, to_user_id, params in mails:
                outbox.enqueue_email(template=template, to_user_id=to_user_id, params=params)
        return len(mails)

    def _for(self, attempt_id: str, what: str, build: Callable[[AttemptMailContext], list[tuple[str, str, dict]]]) -> int:
        try:
            ctx = self.context_for(attempt_id)
            if ctx is None:
                logger.info("no %s mail: attempt %s has no assessment context", what, attempt_id)
                return 0
            return self._queue(build(ctx))
        except Exception:  # noqa: BLE001 - a mail that cannot be built must not break the flow that caused it
            logger.exception("could not queue the %s mail for attempt %s", what, attempt_id)
            return 0

    # ---- the four flows ----

    def consent_withdrawn(self, attempt_id: str, *, deletion_on: str | None = None) -> int:
        """The candidate withdrew consent: the company is told (`recruiter.consent_withdrawn`). Call it where the withdrawal is recorded."""
        def build(c: AttemptMailContext):
            params = {"org_name": c.org_name, "assessment_name": c.assessment_name}
            if deletion_on:
                params["deletion_on"] = deletion_on
            return [("recruiter.consent_withdrawn", c.recruiter_id, params)]
        return self._for(attempt_id, "consent withdrawn", build)

    def time_warning(self, attempt_id: str, minutes_left: int) -> int:
        """The clock reached a warning (15 or 5 minutes left, FR-SES-03): the candidate is told once per warning (the engine records each warning once)."""
        def build(c: AttemptMailContext):
            return [("candidate.time_warning", c.candidate_id,
                     {"assessment_name": c.assessment_name, "minutes_left": int(minutes_left), "link": f"{self._origin}/assessment/{attempt_id}"})]
        return self._for(attempt_id, "time warning", build)

    def submission_received(self, attempt_id: str) -> int:
        """The candidate submitted: both sides are told (`candidate.submission_received`, `recruiter.submission_received`)."""
        def build(c: AttemptMailContext):
            return [("candidate.submission_received", c.candidate_id,
                     {"org_name": c.org_name, "assessment_name": c.assessment_name, "link": f"{self._origin}/assessment/{attempt_id}"}),
                    ("recruiter.submission_received", c.recruiter_id,
                     {"org_name": c.org_name, "assessment_name": c.assessment_name, "link": f"{self._origin}/company/candidates"})]
        return self._for(attempt_id, "submission received", build)

    def results_released(self, attempt_id: str) -> int:
        """The company released the results: the candidate is told (`candidate.results_released`)."""
        def build(c: AttemptMailContext):
            return [("candidate.results_released", c.candidate_id,
                     {"org_name": c.org_name, "assessment_name": c.assessment_name, "link": f"{self._origin}/assessment/{attempt_id}"})]
        return self._for(attempt_id, "results released", build)


    # ---- the deletion requests (FR-PRV-08, FR-PRV-09, FR-NTF-01) ----

    def deletion_requested_learner(self, user_id: str, *, deletion_on: str) -> int:
        """A learner asked for their data to be deleted: `privacy.deletion_requested` with the date and the way to undo."""
        return self._safe("deletion requested", [("privacy.deletion_requested", user_id, {"deletion_on": deletion_on, "undo_link": f"{self._origin}/account"})])

    def deletion_requested_candidate(self, attempt_id: str, *, decide_by: str) -> int:
        """A candidate asked the company to delete an assessment record: the candidate gets the receipt, the company (the invite's author and the owner) gets the request."""
        def build(c: AttemptMailContext):
            mails = [("privacy.deletion_requested", c.candidate_id, {"company_name": c.org_name, "undo_link": f"{self._origin}/account"})]
            for recipient in dict.fromkeys((c.recruiter_id, self._owner(c.org_id) or c.recruiter_id)):
                mails.append(("privacy.deletion_request_for_company", recipient,
                              {"org_name": c.org_name, "assessment_name": c.assessment_name, "decide_by": decide_by, "link": f"{self._origin}/company/privacy"}))
            return mails
        return self._for(attempt_id, "deletion requested", build)

    def deletion_escalated(self, attempt_id: str, *, request_id: str, decide_by: str) -> int:
        """The company did not decide in time (FR-PRV-09): the company's people are reminded (`privacy.deletion_overdue`) and every active admin is told
        (`admin.deletion_escalated`), so the escalation reaches a person and not only the audit log."""
        def build(c: AttemptMailContext):
            mails = [("privacy.deletion_overdue", recipient, {"org_name": c.org_name, "assessment_name": c.assessment_name, "decide_by": decide_by,
                                                              "link": f"{self._origin}/company/privacy"})
                     for recipient in dict.fromkeys((c.recruiter_id, self._owner(c.org_id) or c.recruiter_id))]
            mails += [("admin.deletion_escalated", admin, {"org_name": c.org_name, "request_id": request_id}) for admin in self._admins()]
            return mails
        return self._for(attempt_id, "deletion escalated", build)

    def _admins(self) -> list[str]:
        with self._sessions() as session:
            return list(session.scalars(select(User.id).where(User.account_type == "admin", User.status == "active").order_by(User.id)))

    def deletion_decided(self, attempt_id: str, *, approve: bool, deletion_on: str | None = None) -> int:
        """The company decided: the candidate is told (an approval repeats the receipt with the date, a refusal has its own mail)."""
        def build(c: AttemptMailContext):
            if approve:
                params = {"company_name": c.org_name, "undo_link": f"{self._origin}/account"}
                if deletion_on:
                    params["deletion_on"] = deletion_on
                return [("privacy.deletion_requested", c.candidate_id, params)]
            return [("privacy.deletion_declined", c.candidate_id, {"org_name": c.org_name})]
        return self._for(attempt_id, "deletion decided", build)

    def deletion_confirmed(self, to_user_id: str, *, completed_on: str, address: str | None = None, request_id: str | None = None) -> int:
        """The deletion is done. For an account that still exists the mail goes to it; for one that was just deleted, `address` is sealed into the row (bound to the request id)
        and cleared when the mail has left, so no copy of the address outlives the deletion."""
        params = {"completed_on": completed_on}
        if address is None:
            return self._safe("deletion confirmed", [("privacy.deletion_confirmed", to_user_id, params)])
        if self._keys is None or request_id is None:
            logger.warning("no deletion-confirmed mail for a deleted account: no key to seal the address")
            return 0
        try:
            with self._sessions.begin() as session:
                DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params,
                             address_sealer=lambda a, aad: self._keys.seal(a, account=aad)).enqueue_email(
                    template="privacy.deletion_confirmed", to_user_id=request_id, to_address=address, params=params)
            return 1
        except Exception:  # noqa: BLE001
            logger.exception("could not queue the deletion-confirmed mail")
            return 0

    def _safe(self, what: str, mails: list[tuple[str, str, dict]]) -> int:
        try:
            return self._queue(mails)
        except Exception:  # noqa: BLE001
            logger.exception("could not queue the %s mail", what)
            return 0

    def _owner(self, org_id: str) -> str | None:
        try:
            oid = uuid.UUID(org_id)
        except ValueError:
            return None
        with self._scope.acting_as(Scope(user_id="system:mail", org_id=org_id, roles=frozenset({Role.RECRUITER}))):
            with self._sessions() as session:
                return session.scalar(select(Organization.owner_user_id).where(Organization.id == oid))


def notify_consent_withdrawn(triggers: MailTriggers, attempt_id: str, *, deletion_on: str | None = None) -> int:
    """The function the withdrawal path calls (`LabRuntime.withdraw` / the `withdrawAttempt` route, stream L, outside this module's owner)."""
    return triggers.consent_withdrawn(attempt_id, deletion_on=deletion_on)
