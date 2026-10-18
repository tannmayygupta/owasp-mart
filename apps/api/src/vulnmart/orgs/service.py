"""Recruiter signup and company approval (story P-18, FR-ORG-01, FR-ORG-02, FR-ORG-04, FR-ACC-10).

A person signs up as a recruiter with a work email, a name, a password and the name of their company. The account (type `recruiter`) and the company
(`pending`, the person its owner) are made in one transaction, the verification mail is queued in the same transaction, and a known address gets the
same answer as a new one (see `AccountService.signup_account`). A disposable address cannot start a recruiter signup. Free webmail is allowed without
an extra check (OI-10, the developer's answer of 2026-10-18).

The company is what moves; the recruiter's state is derived from it (architecture 04 section 10.4), so the two cannot disagree:
`unverified_email` (the address is not verified yet) -> `pending_approval` (verified, the company waits for one admin) -> `active` (the company is approved),
or `rejected` (with the admin's written reason, shown to the applicant), `suspended`, `deleted`.

An admin approves or rejects once for the whole company; no further step is needed per colleague (FR-ORG-02). A rejected company may apply again at
any time (OI-11, the developer's answer of 2026-10-18). Only an active recruiter of an active company may go on to invite candidates: `active_company_of`
is the gate the invite stories use (FR-ORG-01). Every decision is audited and written in the same transaction as the change; approval and rejection
also queue the outcome mail to the owner. There is no HTTP route yet: IF-1 has no recruiter or admin routes (a contract change, see handoff H-138); an
admin calls these functions with their scope.
"""
from __future__ import annotations

import logging
import re
import unicodedata
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.directory import UserBrief, UserDirectory
from vulnmart.accounts.models import User
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.service import AccountService, InvalidInput
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.scope import Role, Scope

from .disposable import domain_of, is_disposable
from .models import Organization, OrgMember

logger = logging.getLogger("vulnmart.orgs")

Clock = Callable[[], datetime]
NAME_MAX, REASON_MAX = 120, 500
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")
_SPACE = re.compile(r"\s+")
RECRUITER_SCOPE_ROLES = frozenset({Role.RECRUITER})


def utc_now() -> datetime:
    return datetime.now(UTC)


class CompanyNotFound(Exception):
    """No such company (or, for an owner, not theirs)."""


class InvalidTransition(Exception):
    """The company is not in a state this change starts from. `state` is the state it is in."""

    def __init__(self, state: str):
        super().__init__(state)
        self.state = state


class NotARecruiter(Exception):
    """The account is not an active recruiter account."""


class NotActiveRecruiter(Exception):
    """An invite needs an active recruiter in an active company; `state` says what this one is."""

    def __init__(self, state: str):
        super().__init__(state)
        self.state = state


@dataclass(frozen=True, slots=True)
class PendingCompany:
    org_id: str
    name: str
    owner_name: str
    owner_email_domain: str
    applied_at: datetime


@dataclass(frozen=True, slots=True)
class Standing:
    """Where a recruiter stands. `state` is one of unverified_email, pending_approval, active, rejected, suspended, deleted, or `none` (no company)."""

    state: str
    org_id: str | None
    org_name: str | None
    reason: str | None  # the admin's written reason, only for `rejected`


def clean_text(raw: str, *, limit: int, pointer: str) -> str:
    text = _SPACE.sub(" ", _CONTROL.sub(" ", unicodedata.normalize("NFC", raw))).strip()
    if not 1 <= len(text) <= limit:
        raise InvalidInput(pointer)
    return text


def recruiter_state(user: UserBrief, org: Organization | None) -> str:
    """The recruiter state machine of architecture 04 section 10.4, derived from the account and the company."""
    if user.status == "deleted":
        return "deleted"
    if user.status != "active":
        return "suspended"
    if org is None:
        return "none"
    if org.status in ("rejected", "suspended", "deleted"):
        return org.status
    if not user.email_verified:
        return "unverified_email"
    return "pending_approval" if org.status == "pending" else "active"


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


class CompanyService:
    def __init__(self, sessions: sessionmaker[Session], accounts: AccountService, directory: UserDirectory, roles: RoleService, audit: AuditPort,
                 scope: ContextScopePort, *, public_origin: str, now: Clock = utc_now):
        self._sessions, self._accounts, self._directory, self._roles = sessions, accounts, directory, roles
        self._audit, self._scope, self._origin, self._now = audit, scope, public_origin.rstrip("/"), now

    # ---- signup ----

    def signup_recruiter(self, *, email: str, password: str, display_name: str, company_name: str) -> None:
        """Create a recruiter and a pending company and queue the verification mail, or (known address) queue the "already registered" mail. Returns
        nothing either way. Raises InvalidInput for a disposable address (`/email`, `disposable_email`), a bad company name, name or password."""
        name = clean_text(company_name, limit=NAME_MAX, pointer="/company_name")
        org_id = uuid.uuid4()

        def refuse_disposable(email_ci: str) -> None:
            if is_disposable(email_ci):
                raise InvalidInput("/email", "disposable_email")

        def create_company(session: Session, user: User) -> None:
            session.add(Organization(id=org_id, name=name, email_domain=domain_of(user.email_ci), status="pending", owner_user_id=user.id,
                                     created_at=self._now()))  # the service clock, so the queue's order is exact (SQLite's own clock has one-second ticks)
            session.flush()
            session.add(OrgMember(org_id=org_id, user_id=user.id, role="owner", status="active"))
            self._audit.append(actor=user.id, action="org.created", subject=user.id, details={"org": str(org_id)})

        # The new company is in scope for the whole signup, so the row-level security of `organizations` accepts its insert.
        with self._scope.acting_as(Scope(user_id="signup", org_id=str(org_id), roles=RECRUITER_SCOPE_ROLES)):
            self._accounts.signup_account(email=email, password=password, display_name=display_name, account_type="recruiter",
                                          check_email=refuse_disposable, on_create=create_company)

    # ---- where a recruiter stands ----

    def standing(self, user_id: str) -> Standing:
        brief = self._directory.brief(user_id)
        if brief is None or brief.account_type != "recruiter":
            raise NotARecruiter
        with self._scope.acting_as(Scope(user_id=user_id, roles=RECRUITER_SCOPE_ROLES)):  # no company yet: a person reads their own membership
            with self._sessions() as session:
                member = session.scalar(select(OrgMember).where(OrgMember.user_id == user_id, OrgMember.status == "active"))
        if member is None:
            return Standing(recruiter_state(brief, None), None, None, None)
        org_id = str(member.org_id)
        with self._scope.acting_as(Scope(user_id=user_id, org_id=org_id, roles=RECRUITER_SCOPE_ROLES)):
            with self._sessions() as session:
                org = session.get(Organization, member.org_id)
        if org is None:
            return Standing("none", None, None, None)
        state = recruiter_state(brief, org)
        return Standing(state, org_id, org.name, org.rejected_reason if state == "rejected" else None)

    def active_company_of(self, user_id: str) -> str:
        """The company id of an active recruiter in an active company: the gate for inviting candidates (FR-ORG-01). Raises NotActiveRecruiter
        (with the state) otherwise, and NotARecruiter for an account that is not a recruiter."""
        standing = self.standing(user_id)
        if standing.state != "active" or standing.org_id is None:
            raise NotActiveRecruiter(standing.state)
        return standing.org_id

    # ---- the admin's queue and decisions ----

    def pending(self, actor: Scope, *, limit: int = 100) -> list[PendingCompany]:
        """The companies waiting for approval, oldest first, with the owner's name and the domain of their address (FR-ORG-02)."""
        admin_id = self._roles.require_admin(actor)
        with self._scope.acting_as(Scope(user_id=admin_id, roles=actor.roles)):  # an admin with no company reads the company directory
            with self._sessions() as session:
                rows = session.scalars(select(Organization).where(Organization.status == "pending")
                                       .order_by(Organization.created_at, Organization.id).limit(max(1, min(limit, 500)))).all()
        owners = self._directory.briefs(r.owner_user_id for r in rows)
        return [PendingCompany(str(r.id), r.name, owners[r.owner_user_id].display_name if r.owner_user_id in owners else "", r.email_domain,
                               _aware(r.created_at)) for r in rows]

    def approve(self, actor: Scope, org_id: str) -> None:
        """pending -> active: one admin approval activates the company and its owner. Queues the approval mail."""
        self._decide(actor, org_id, from_status="pending", to_status="active", action="org.approved", outcome="approved", reason=None)

    def reject(self, actor: Scope, org_id: str, reason: str) -> None:
        """pending -> rejected with a written reason that the applicant sees. Queues the rejection mail."""
        text = clean_text(reason, limit=REASON_MAX, pointer="/reason")
        self._decide(actor, org_id, from_status="pending", to_status="rejected", action="org.rejected", outcome="rejected", reason=text)

    def suspend(self, actor: Scope, org_id: str, reason: str) -> None:
        """active -> suspended: the company's recruiters stop being active (FR-ORG-05)."""
        text = clean_text(reason, limit=REASON_MAX, pointer="/reason")
        self._decide(actor, org_id, from_status="active", to_status="suspended", action="org.suspended", outcome=None, reason=text)

    def reinstate(self, actor: Scope, org_id: str) -> None:
        """suspended -> active."""
        self._decide(actor, org_id, from_status="suspended", to_status="active", action="org.reinstated", outcome=None, reason=None)

    def _decide(self, actor: Scope, org_id: str, *, from_status: str, to_status: str, action: str, outcome: str | None, reason: str | None) -> None:
        admin_id = self._roles.require_admin(actor)
        oid = _uuid(org_id)
        with self._scope.acting_as(Scope(user_id=admin_id, org_id=str(oid), roles=actor.roles)):  # the admin acts for the one company being decided
            with self._sessions.begin() as session:
                org = session.get(Organization, oid)
                if org is None:
                    raise CompanyNotFound
                values: dict[str, object] = {"status": to_status}
                if to_status == "rejected":
                    values["rejected_reason"] = reason
                elif to_status == "suspended":
                    values["suspended_reason"] = reason
                elif to_status == "active":
                    values.update(rejected_reason=None, suspended_reason=None)
                changed = session.execute(update(Organization).where(Organization.id == oid, Organization.status == from_status).values(**values)).rowcount
                if changed != 1:  # another decision came first
                    raise InvalidTransition(session.scalar(select(Organization.status).where(Organization.id == oid)) or org.status)
                self._audit.append(actor=admin_id, action=action, subject=org.owner_user_id, details={"org": str(oid), "reason_given": reason is not None})
                if outcome is not None:
                    params: dict[str, str] = {"org_name": org.name, "outcome": outcome}
                    if outcome == "approved":
                        params["login_url"] = f"{self._origin}/login"
                    elif reason:
                        params["reason"] = reason
                    DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params).enqueue_email(
                        template="org.approval_outcome", to_user_id=org.owner_user_id, params=params)

    # ---- the applicant's side ----

    def reapply(self, user_id: str) -> None:
        """rejected -> pending, by the owner, at any time (OI-11). The earlier reason is cleared (it stays in the audit entry only as "a reason was given")."""
        standing = self.standing(user_id)
        if standing.org_id is None:
            raise CompanyNotFound
        if standing.state != "rejected":
            raise InvalidTransition(standing.state)
        oid = _uuid(standing.org_id)
        with self._scope.acting_as(Scope(user_id=user_id, org_id=standing.org_id, roles=RECRUITER_SCOPE_ROLES)):
            with self._sessions.begin() as session:
                member = session.get(OrgMember, (oid, user_id))
                if member is None or member.role != "owner":
                    raise CompanyNotFound  # only the owner applies again
                changed = session.execute(update(Organization).where(Organization.id == oid, Organization.status == "rejected")
                                          .values(status="pending", rejected_reason=None)).rowcount
                if changed != 1:
                    raise InvalidTransition("changed")
                self._audit.append(actor=user_id, action="org.reapplied", subject=user_id, details={"org": standing.org_id})


def _uuid(org_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(org_id))
    except ValueError:
        raise CompanyNotFound from None
