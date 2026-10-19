"""Recruiters and companies: signup, approval, colleagues, admin controls, terms and invite caps (stories P-18 and P-19: FR-ORG-01 to FR-ORG-08, FR-ACC-10).

A person signs up as a recruiter with a work email, a name, a password and the name of their company. If no company claims the domain of the address, the
account (type `recruiter`) and a `pending` company (the person its owner) are made in one transaction and the domain is claimed; if a company already claims
it, the new account asks that company's owner to join instead (FR-ORG-03: colleagues join through the owner), and a free-webmail domain is never claimed or
matched. The verification mail is queued in the same transaction, a known address gets the same answer as a new one, and a disposable address cannot start
a recruiter signup. Free webmail is allowed (OI-10, the developer's answer of 2026-10-18).

The company is what moves; the recruiter's state is derived from it (architecture 04 section 10.4): `unverified_email` -> `pending_approval` -> `active`, or
`rejected` (with the admin's written reason), `suspended`, `deleted`. An admin approves or rejects once for the whole company; a rejected company may apply
again at any time (OI-11). The owner approves or rejects colleagues and can remove a member, who loses access at once (sessions end). An admin can suspend,
reinstate and delete companies and suspend and reinstate recruiters, each with a written reason and an audit entry (FR-ORG-05).

Before a company can invite, its owner accepts the data-processing terms (`terms.py`, FR-ORG-07) and the daily invite cap applies (FR-ORG-08):
`invite_company_of` is the gate the invite stories use, `check_invite_cap` the cap test. A recruiter's session carries their company (`SessionService`'s
`org_resolver` is `membership_of`), so the one central organisation filter applies to everything they read (FR-ORG-06).

Every decision is audited in the same transaction as the change (the entry never carries the reason text). There is no HTTP route yet: IF-1 has no
recruiter or admin routes (a contract change, handoff H-138); an admin or an owner calls these functions with their own scope or user id.
"""
from __future__ import annotations

import logging
import re
import unicodedata
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.directory import UserBrief, UserDirectory
from vulnmart.accounts.models import User
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.security import normalize_email
from vulnmart.accounts.service import AccountService, InvalidInput
from vulnmart.accounts.status import AccountStatusService
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.scope import Role, Scope
from vulnmart.ports.settings import SettingsPort

from . import terms as terms_module
from .disposable import domain_of, is_disposable, is_free_email
from .models import DpaAcceptance, JoinRequest, Organization, OrgMember

logger = logging.getLogger("vulnmart.orgs")

Clock = Callable[[], datetime]
NAME_MAX, REASON_MAX, CAP_MAX = 120, 500, 100_000
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")
_SPACE = re.compile(r"\s+")
RECRUITER_SCOPE_ROLES = frozenset({Role.RECRUITER})
CLAIMING_STATUSES = ("pending", "active", "suspended")  # a rejected or deleted company does not hold its domain


def utc_now() -> datetime:
    return datetime.now(UTC)


class CompanyNotFound(Exception):
    """No such company (or, for an owner, not theirs)."""


class InvalidTransition(Exception):
    """The company (or request) is not in a state this change starts from. `state` is the state it is in."""

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


class NotTheOwner(Exception):
    """Only the owner of the company may do this."""


class DomainMismatch(Exception):
    """The address of a join request is not on the company's domain (FR-ORG-03)."""


class TermsNotAccepted(Exception):
    """The company has not accepted the current data-processing terms, so it cannot invite (FR-ORG-07)."""

    def __init__(self, org_id: str):
        super().__init__(org_id)
        self.org_id = org_id


class TermsStale(Exception):
    """The terms the owner saw are not the current ones."""


class _DomainRace(Exception):
    """Another signup claimed the same domain between our look and our insert: start the signup again as a colleague."""


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
    terms_accepted: bool = False  # the company has accepted the current data-processing terms


@dataclass(frozen=True, slots=True)
class JoinRequestView:
    request_id: str
    user_id: str
    display_name: str
    requested_at: datetime


@dataclass(frozen=True, slots=True)
class MemberView:
    user_id: str
    display_name: str
    role: str


@dataclass(frozen=True, slots=True)
class CapDecision:
    allowed: bool
    cap: int
    remaining: int  # invites still allowed today after `sent_today` (never negative)


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


def _uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise CompanyNotFound from None


class CompanyService:
    def __init__(self, sessions: sessionmaker[Session], accounts: AccountService, directory: UserDirectory, roles: RoleService, audit: AuditPort,
                 scope: ContextScopePort, settings: SettingsPort, status: AccountStatusService, *, public_origin: str,
                 end_sessions: Callable[[str], object] | None = None, now: Clock = utc_now):
        self._sessions, self._accounts, self._directory, self._roles = sessions, accounts, directory, roles
        self._audit, self._scope, self._settings, self._status = audit, scope, settings, status
        self._origin, self._end_sessions, self._now = public_origin.rstrip("/"), end_sessions, now
        terms_module.check_template()  # the shown terms must be the text pinned for their version: refuse to start otherwise

    # ---- helpers ----

    def _as(self, user_id: str, org_id: str | None = None, roles: Iterable[Role] = RECRUITER_SCOPE_ROLES):
        return self._scope.acting_as(Scope(user_id=user_id, org_id=org_id, roles=frozenset(roles)))

    def _mail_outcome(self, session: Session, to_user_id: str, org_name: str, outcome: str, reason: str | None = None) -> None:
        params: dict[str, str] = {"org_name": org_name, "outcome": outcome}
        if outcome == "approved":
            params["login_url"] = f"{self._origin}/login"
        elif reason:
            params["reason"] = reason
        DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params).enqueue_email(template="org.approval_outcome", to_user_id=to_user_id,
                                                                                                      params=params)

    def _claim_domain(self, session: Session, org_id: uuid.UUID, domain: str) -> bool:
        """Claim the work domain for the company (a unique partial index: one company per domain). False when another company holds it. Free webmail is never claimed."""
        if not domain or is_free_email("x@" + domain):
            return True
        try:
            with session.begin_nested():
                session.execute(update(Organization).where(Organization.id == org_id).values(domain_claim=domain))
                session.flush()
            return True
        except IntegrityError:
            return False

    def claimed_by(self, domain: str) -> str | None:
        """The company that claims an email domain, or None (a free-webmail domain, or a rejected or deleted company, claims nothing). The one company lookup
        that needs no company in scope, because a colleague who is signing up has none: it runs as a system scope that may read the company directory."""
        with self._scope.acting_as(Scope(user_id="system:domain-lookup", roles=frozenset({Role.ADMIN}))):
            with self._sessions() as session:
                found = session.scalar(select(Organization.id).where(Organization.domain_claim == domain.lower()))
        return None if found is None else str(found)

    # ---- signup ----

    def signup_recruiter(self, *, email: str, password: str, display_name: str, company_name: str) -> None:
        """Create a recruiter and a pending company (or, when a company claims the domain of the address, a request to join it) and queue the
        verification mail, or (known address) queue the "already registered" mail. Returns nothing either way. Raises InvalidInput for a disposable
        address (`/email`, `disposable_email`), a bad company name, name or password."""
        name = clean_text(company_name, limit=NAME_MAX, pointer="/company_name")
        for attempt in range(2):
            try:
                self._signup_once(email=email, password=password, display_name=display_name, name=name)
                return
            except _DomainRace:
                if attempt == 1:
                    raise

    def _signup_once(self, *, email: str, password: str, display_name: str, name: str) -> None:
        new_org = uuid.uuid4()
        target = new_org  # the company in scope for the whole signup, so the row-level security accepts the insert of what the signup makes
        email_ci = normalize_email(email)
        domain = domain_of(email_ci) if email_ci else ""
        if domain and not is_free_email("x@" + domain):
            claimed = self.claimed_by(domain)
            if claimed is not None:
                target = uuid.UUID(claimed)

        def refuse_disposable(email_ci: str) -> None:
            if is_disposable(email_ci):
                raise InvalidInput("/email", "disposable_email")

        def create(session: Session, user: User) -> None:
            user_domain = domain_of(user.email_ci)
            if target != new_org:  # a colleague: ask the owner of the company that claims the domain
                self._add_join_request(session, target, user)
                return
            claim = None if is_free_email(user.email_ci) else user_domain
            try:
                with session.begin_nested():  # a savepoint: losing the claim to another signup must not look like a known address
                    session.add(Organization(id=new_org, name=name, email_domain=user_domain, domain_claim=claim, status="pending", owner_user_id=user.id,
                                             created_at=self._now()))  # the service clock, so the queue's order is exact (SQLite's own clock has one-second ticks)
                    session.flush()
            except IntegrityError:
                raise _DomainRace from None
            session.add(OrgMember(org_id=new_org, user_id=user.id, role="owner", status="active", created_at=self._now()))
            self._audit.append(actor=user.id, action="org.created", subject=user.id, details={"org": str(new_org)})

        with self._scope.acting_as(Scope(user_id="signup", org_id=str(target), roles=RECRUITER_SCOPE_ROLES)):
            self._accounts.signup_account(email=email, password=password, display_name=display_name, account_type="recruiter",
                                          check_email=refuse_disposable, on_create=create)

    def _add_join_request(self, session: Session, org_id: uuid.UUID, user: User) -> None:
        session.add(JoinRequest(id=uuid.uuid4(), org_id=org_id, user_id=user.id, status="requested", created_at=self._now()))
        self._audit.append(actor=user.id, action="org.join_requested", subject=user.id, details={"org": str(org_id)})

    def request_join(self, user_id: str, org_id: str) -> None:
        """An existing recruiter with no company asks to join one (FR-ORG-03). Refused (DomainMismatch) when the address is not on the company's domain or is
        free webmail, which matches no company; InvalidTransition when the person already has a company or an open request."""
        oid = _uuid(org_id)
        brief = self._directory.brief(user_id)
        if brief is None or brief.account_type != "recruiter" or brief.status != "active":
            raise NotARecruiter
        if self.membership_of(user_id) is not None:
            raise InvalidTransition("member")
        with self._as(user_id, str(oid)):
            with self._sessions.begin() as session:
                org = session.get(Organization, oid)
                if org is None or org.status not in CLAIMING_STATUSES:
                    raise CompanyNotFound
                if is_free_email("x@" + brief.email_domain) or brief.email_domain != org.email_domain:
                    raise DomainMismatch
                user = session.get(User, user_id)
                try:
                    with session.begin_nested():
                        self._add_join_request(session, oid, user)
                        session.flush()
                except IntegrityError:
                    raise InvalidTransition("requested") from None

    # ---- where a recruiter stands ----

    def membership_of(self, user_id: str) -> tuple[str, str] | None:
        """(company id, `owner` or `member`) of the person's active membership, or None. This is what `SessionService` uses to put the company in the
        scope of every request of a recruiter (story P-19); a person reads their own membership with no company in scope."""
        with self._as(user_id):
            with self._sessions() as session:
                member = session.scalar(select(OrgMember).where(OrgMember.user_id == user_id, OrgMember.status == "active"))
        return None if member is None else (str(member.org_id), member.role)

    def company_name_of(self, user_id: str, org_id: str) -> str | None:
        """The name of the company the person works for, read under that company's scope (the view history keeps the name as it was at the time)."""
        with self._as(user_id, org_id):
            with self._sessions() as session:
                return session.scalar(select(Organization.name).where(Organization.id == uuid.UUID(org_id)))

    def standing(self, user_id: str) -> Standing:
        brief = self._directory.brief(user_id)
        if brief is None or brief.account_type != "recruiter":
            raise NotARecruiter
        membership = self.membership_of(user_id)
        if membership is None:
            with self._as(user_id):  # no company: maybe a request to join one
                with self._sessions() as session:
                    request = session.scalar(select(JoinRequest).where(JoinRequest.user_id == user_id).order_by(JoinRequest.created_at.desc()).limit(1))
            if request is None or brief.status != "active":
                return Standing(recruiter_state(brief, None), None, None, None)
            if request.status == "requested":
                return Standing("pending_approval" if brief.email_verified else "unverified_email", None, None, None)
            return Standing("rejected" if request.status == "rejected" else "none", None, None, None)
        org_id, _ = membership
        with self._as(user_id, org_id):
            with self._sessions() as session:
                org = session.get(Organization, uuid.UUID(org_id))
                accepted = org is not None and self._terms_accepted_in(session, org.id)
        if org is None:
            return Standing("none", None, None, None)
        state = recruiter_state(brief, org)
        return Standing(state, org_id, org.name, org.rejected_reason if state == "rejected" else None, accepted)

    def active_company_of(self, user_id: str) -> str:
        """The company id of an active recruiter in an active company. Raises NotActiveRecruiter (with the state) otherwise, and NotARecruiter for an
        account that is not a recruiter. The invite stories use `invite_company_of`, which also needs the terms."""
        standing = self.standing(user_id)
        if standing.state != "active" or standing.org_id is None:
            raise NotActiveRecruiter(standing.state)
        return standing.org_id

    def invite_company_of(self, user_id: str) -> str:
        """The gate for inviting candidates (FR-ORG-01, FR-ORG-07): an active recruiter in an active company that has accepted the current terms.
        Raises NotActiveRecruiter, NotARecruiter, or TermsNotAccepted."""
        standing = self.standing(user_id)
        if standing.state != "active" or standing.org_id is None:
            raise NotActiveRecruiter(standing.state)
        if not standing.terms_accepted:
            raise TermsNotAccepted(standing.org_id)
        return standing.org_id

    # ---- the admin's queue and decisions on companies ----

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
        self._decide(actor, org_id, from_statuses=("pending",), to_status="active", action="org.approved", outcome="approved", reason=None)

    def reject(self, actor: Scope, org_id: str, reason: str) -> None:
        """pending -> rejected with a written reason that the applicant sees. Queues the rejection mail. The company gives up its domain until it applies again."""
        text = clean_text(reason, limit=REASON_MAX, pointer="/reason")
        self._decide(actor, org_id, from_statuses=("pending",), to_status="rejected", action="org.rejected", outcome="rejected", reason=text)

    def suspend(self, actor: Scope, org_id: str, reason: str) -> None:
        """active -> suspended: the company's recruiters stop being active (FR-ORG-05)."""
        text = clean_text(reason, limit=REASON_MAX, pointer="/reason")
        self._decide(actor, org_id, from_statuses=("active",), to_status="suspended", action="org.suspended", outcome=None, reason=text)

    def reinstate(self, actor: Scope, org_id: str, reason: str) -> None:
        """suspended -> active. Every admin action needs a reason (FR-ORG-05)."""
        text = clean_text(reason, limit=REASON_MAX, pointer="/reason")
        self._decide(actor, org_id, from_statuses=("suspended",), to_status="active", action="org.reinstated", outcome=None, reason=text)

    def delete_company(self, actor: Scope, org_id: str, reason: str) -> None:
        """Any state but deleted -> deleted: the company, its recruiters' access and its domain claim end now. The removal of its data follows the retention rules
        and is done by the retention and deletion stories (P-24, P-25), not here."""
        text = clean_text(reason, limit=REASON_MAX, pointer="/reason")
        self._decide(actor, org_id, from_statuses=("pending", "active", "suspended", "rejected"), to_status="deleted", action="org.deleted", outcome=None,
                     reason=text)

    def _decide(self, actor: Scope, org_id: str, *, from_statuses: tuple[str, ...], to_status: str, action: str, outcome: str | None, reason: str | None) -> None:
        admin_id = self._roles.require_admin(actor)
        oid = _uuid(org_id)
        member_ids: list[str] = []
        with self._as(admin_id, str(oid), actor.roles):  # the admin acts for the one company being decided
            with self._sessions.begin() as session:
                org = session.get(Organization, oid)
                if org is None:
                    raise CompanyNotFound
                values: dict[str, object] = {"status": to_status}
                if to_status in ("rejected", "deleted"):
                    values["domain_claim"] = None  # a rejected or deleted company does not hold its domain
                if to_status == "rejected":
                    values["rejected_reason"] = reason
                elif to_status == "suspended":
                    values["suspended_reason"] = reason
                elif to_status == "active":
                    values.update(rejected_reason=None, suspended_reason=None)
                changed = session.execute(update(Organization).where(Organization.id == oid, Organization.status.in_(from_statuses)).values(**values)).rowcount
                if changed != 1:  # another decision came first
                    raise InvalidTransition(session.scalar(select(Organization.status).where(Organization.id == oid)) or org.status)
                if to_status == "deleted":
                    member_ids = list(session.scalars(select(OrgMember.user_id).where(OrgMember.org_id == oid)))
                self._audit.append(actor=admin_id, action=action, subject=org.owner_user_id, details={"org": str(oid), "reason_given": reason is not None})
                if outcome is not None:
                    self._mail_outcome(session, org.owner_user_id, org.name, outcome, reason)
        for user_id in member_ids:  # a deleted company's recruiters lose access at once
            if self._end_sessions is not None:
                self._end_sessions(user_id)

    # ---- the admin's controls over recruiters ----

    def suspend_recruiter(self, actor: Scope, org_id: str, user_id: str, reason: str) -> None:
        """A recruiter of the company cannot sign in or invite until reinstated (FR-ORG-05); their sessions end now."""
        self._require_member(actor, org_id, user_id)
        self._status.suspend(actor, user_id, reason)

    def reinstate_recruiter(self, actor: Scope, org_id: str, user_id: str, reason: str) -> None:
        self._require_member(actor, org_id, user_id)
        self._status.reinstate(actor, user_id, reason)

    def _require_member(self, actor: Scope, org_id: str, user_id: str) -> None:
        admin_id = self._roles.require_admin(actor)
        oid = _uuid(org_id)
        with self._as(admin_id, str(oid), actor.roles):
            with self._sessions() as session:
                member = session.get(OrgMember, (oid, user_id))
        if member is None:
            raise CompanyNotFound

    # ---- applying again ----

    def reapply(self, user_id: str) -> None:
        """rejected -> pending, by the owner, at any time (OI-11). The earlier reason is cleared (it stays in the audit entry only as "a reason was given"). The
        company claims its domain again; if another company claimed it meanwhile the answer is InvalidTransition("domain_claimed")."""
        standing = self.standing(user_id)
        if standing.org_id is None:
            raise CompanyNotFound
        if standing.state != "rejected":
            raise InvalidTransition(standing.state)
        oid = uuid.UUID(standing.org_id)
        with self._as(user_id, standing.org_id):
            with self._sessions.begin() as session:
                member = session.get(OrgMember, (oid, user_id))
                if member is None or member.role != "owner":
                    raise CompanyNotFound  # only the owner applies again
                org = session.get(Organization, oid)
                changed = session.execute(update(Organization).where(Organization.id == oid, Organization.status == "rejected")
                                          .values(status="pending", rejected_reason=None)).rowcount
                if changed != 1:
                    raise InvalidTransition("changed")
                if not self._claim_domain(session, oid, org.email_domain):
                    raise InvalidTransition("domain_claimed")
                self._audit.append(actor=user_id, action="org.reapplied", subject=user_id, details={"org": standing.org_id})

    # ---- colleagues (FR-ORG-03) ----

    def _owner_of(self, user_id: str) -> str:
        membership = self.membership_of(user_id)
        if membership is None or membership[1] != "owner":
            raise NotTheOwner
        return membership[0]

    def join_requests(self, owner_id: str) -> list[JoinRequestView]:
        """The open requests to join the owner's company, oldest first."""
        org_id = self._owner_of(owner_id)
        with self._as(owner_id, org_id, (Role.RECRUITER, Role.ORG_OWNER)):
            with self._sessions() as session:
                rows = session.scalars(select(JoinRequest).where(JoinRequest.status == "requested").order_by(JoinRequest.created_at, JoinRequest.id)).all()
        names = self._directory.briefs(r.user_id for r in rows)
        return [JoinRequestView(str(r.id), r.user_id, names[r.user_id].display_name if r.user_id in names else "", _aware(r.created_at)) for r in rows]

    def approve_join(self, owner_id: str, request_id: str) -> None:
        self._decide_join(owner_id, request_id, approve=True)

    def reject_join(self, owner_id: str, request_id: str) -> None:
        self._decide_join(owner_id, request_id, approve=False)

    def _decide_join(self, owner_id: str, request_id: str, *, approve: bool) -> None:
        org_id = self._owner_of(owner_id)
        oid, rid = uuid.UUID(org_id), _uuid(request_id)
        with self._as(owner_id, org_id, (Role.RECRUITER, Role.ORG_OWNER)):
            with self._sessions.begin() as session:
                org = session.get(Organization, oid)
                request = session.get(JoinRequest, rid)
                if org is None or request is None:
                    raise CompanyNotFound
                if org.status != "active":
                    raise InvalidTransition(org.status)  # a colleague is accepted into a company the admin has approved
                now = self._now()
                changed = session.execute(update(JoinRequest).where(JoinRequest.id == rid, JoinRequest.status == "requested")
                                          .values(status="approved" if approve else "rejected", decided_by=owner_id, decided_at=now)).rowcount
                if changed != 1:
                    raise InvalidTransition(session.scalar(select(JoinRequest.status).where(JoinRequest.id == rid)) or request.status)
                if approve:
                    existing = session.get(OrgMember, (oid, request.user_id))
                    if existing is None:
                        session.add(OrgMember(org_id=oid, user_id=request.user_id, role="member", status="active", created_at=now))
                    else:
                        existing.status = "active"
                self._audit.append(actor=owner_id, action="org.join_approved" if approve else "org.join_rejected", subject=request.user_id, details={"org": org_id})
                self._mail_outcome(session, request.user_id, org.name, "approved" if approve else "rejected")

    def members(self, owner_id: str) -> list[MemberView]:
        org_id = self._owner_of(owner_id)
        with self._as(owner_id, org_id, (Role.RECRUITER, Role.ORG_OWNER)):
            with self._sessions() as session:
                rows = session.scalars(select(OrgMember).where(OrgMember.status == "active")
                                       .order_by((OrgMember.role == "owner").desc(), OrgMember.created_at, OrgMember.user_id)).all()  # the owner first
        names = self._directory.briefs(r.user_id for r in rows)
        return [MemberView(r.user_id, names[r.user_id].display_name if r.user_id in names else "", r.role) for r in rows]

    def remove_member(self, owner_id: str, member_id: str) -> None:
        """The owner removes a colleague, who loses access at once: their sessions end and their company is no longer in their scope. The owner cannot remove
        themselves."""
        org_id = self._owner_of(owner_id)
        if member_id == owner_id:
            raise InvalidTransition("owner")
        oid = uuid.UUID(org_id)
        with self._as(owner_id, org_id, (Role.RECRUITER, Role.ORG_OWNER)):
            with self._sessions.begin() as session:
                changed = session.execute(update(OrgMember).where(OrgMember.org_id == oid, OrgMember.user_id == member_id, OrgMember.status == "active",
                                                                  OrgMember.role == "member").values(status="removed")).rowcount
                if changed != 1:
                    raise CompanyNotFound
                self._audit.append(actor=owner_id, action="org.member_removed", subject=member_id, details={"org": org_id})
        if self._end_sessions is not None:
            self._end_sessions(member_id)

    # ---- the data-processing terms (FR-ORG-07) ----

    def _terms_accepted_in(self, session: Session, org_id: uuid.UUID) -> bool:
        return session.scalar(select(DpaAcceptance.id).where(DpaAcceptance.org_id == org_id, DpaAcceptance.terms_version == terms_module.TERMS_VERSION)) is not None

    def terms_for(self, owner_id: str) -> terms_module.Terms:
        """The terms to show the owner of an active company (the page shown at approval). NotTheOwner, or InvalidTransition(state) when the company is
        not active."""
        org_id = self._owner_of(owner_id)
        with self._as(owner_id, org_id, (Role.RECRUITER, Role.ORG_OWNER)):
            with self._sessions() as session:
                org = session.get(Organization, uuid.UUID(org_id))
        if org is None:
            raise CompanyNotFound
        if org.status != "active":
            raise InvalidTransition(org.status)
        return terms_module.render(company_name=org.name)

    def accept_terms(self, owner_id: str, version: str, sha256: str) -> None:
        """The owner accepts the terms they were shown (the version and the hash of the text). A different text is TermsStale. Accepting again is not an error."""
        shown = self.terms_for(owner_id)
        if version != shown.version or sha256 != shown.sha256:
            raise TermsStale
        org_id = uuid.UUID(self._owner_of(owner_id))
        with self._as(owner_id, str(org_id), (Role.RECRUITER, Role.ORG_OWNER)):
            with self._sessions.begin() as session:
                if self._terms_accepted_in(session, org_id):
                    return
                try:
                    with session.begin_nested():
                        session.add(DpaAcceptance(id=uuid.uuid4(), org_id=org_id, user_id=owner_id, terms_version=shown.version, terms_sha256=shown.sha256,
                                                  accepted_at=self._now()))
                        session.flush()
                except IntegrityError:
                    return  # accepted by a request that came first
                self._audit.append(actor=owner_id, action="org.terms_accepted", subject=owner_id, details={"org": str(org_id), "terms_version": shown.version})

    # ---- the daily invite cap (FR-ORG-08) ----

    def invite_cap(self, org_id: str) -> int:
        """The most invites the company may send a day: the admin's number for this company, else the global setting."""
        oid = _uuid(org_id)
        with self._scope.acting_as(Scope(user_id="system:cap", org_id=str(oid), roles=RECRUITER_SCOPE_ROLES)):
            with self._sessions() as session:
                org = session.get(Organization, oid)
        if org is None:
            raise CompanyNotFound
        return org.invite_cap if org.invite_cap is not None else int(self._settings.get("invite_cap_per_company_per_day"))

    def set_invite_cap(self, actor: Scope, org_id: str, cap: int | None) -> None:
        """An admin sets one company's daily invite cap (None: back to the global setting)."""
        admin_id = self._roles.require_admin(actor)
        if cap is not None and (type(cap) is not int or not 0 <= cap <= CAP_MAX):
            raise InvalidInput("/invite_cap")
        oid = _uuid(org_id)
        with self._as(admin_id, str(oid), actor.roles):
            with self._sessions.begin() as session:
                org = session.get(Organization, oid)
                if org is None:
                    raise CompanyNotFound
                session.execute(update(Organization).where(Organization.id == oid).values(invite_cap=cap))
                self._audit.append(actor=admin_id, action="org.invite_cap_set", subject=org.owner_user_id, details={"org": str(oid), "cap": cap})

    def check_invite_cap(self, org_id: str, sent_today: int, wanted: int = 1) -> CapDecision:
        """Whether `wanted` more invites fit under today's cap after `sent_today` (the invite story counts them). Reaching the cap is a decision, not an error:
        the caller shows the message and keeps its pending list."""
        cap = self.invite_cap(org_id)
        remaining = max(0, cap - max(0, sent_today))
        return CapDecision(allowed=wanted <= remaining, cap=cap, remaining=remaining)
