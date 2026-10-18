"""Story P-18 (FR-ORG-01, FR-ORG-02, FR-ORG-04, FR-ACC-10) at service level, on SQLite with the organisation guard of the real scoped session: recruiter
signup, the company and recruiter states, the admin queue and decisions, re-applying, and what the guard lets an admin and a member read.
The row-level security and the races are in test_companies_postgres.py."""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
import vulnmart.kernel.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
import vulnmart.orgs.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from vulnmart.accounts import security
from vulnmart.accounts.directory import UserDirectory
from vulnmart.accounts.models import User, UserRole
from vulnmart.accounts.passwords import PasswordPolicy
from vulnmart.accounts.roles import NotAnAdmin, RoleService
from vulnmart.accounts.service import AccountService, InvalidInput
from vulnmart.accounts.status import AccountStatusService
from vulnmart.kernel.db import ORG_ADMIN_VISIBLE, ORG_SELF_VISIBLE, Base, make_sessions
from vulnmart.kernel.scope import ContextScopePort, scope_or_none
from vulnmart.notifications.models import EmailOutbox
from vulnmart.orgs import disposable
from vulnmart.orgs.disposable import domain_of, is_disposable
from vulnmart.orgs.models import Organization, OrgMember
from vulnmart.orgs.service import (
    CompanyNotFound, CompanyService, InvalidTransition, NotActiveRecruiter, NotARecruiter, recruiter_state,
)
from vulnmart.ports.errors import ScopeMissing
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.ports.scope import Role, Scope

T0 = datetime(2026, 10, 18, 10, 0, 7, tzinfo=UTC)
GOOD = "correct horse battery staple"
ORIGIN = "https://vulnmart.example"
ADMIN = "u-ADMINADMINADMIN2"[:18]
ADMIN_SCOPE = Scope(user_id=ADMIN, roles=frozenset({Role.ADMIN}))


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return make_sessions(engine, scope_or_none)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def audit():
    return FakeAuditPort()


@pytest.fixture
def ended(sessions):
    return []


@pytest.fixture
def companies(sessions, audit, clock, ended):
    settings = FakeSettingsPort()
    accounts = AccountService(sessions, settings, public_origin=ORIGIN, now=clock, policy=PasswordPolicy())
    roles = RoleService(sessions, audit)
    return CompanyService(sessions, accounts, UserDirectory(sessions), roles, audit, ContextScopePort(), settings, AccountStatusService(sessions, roles, audit),
                          public_origin=ORIGIN, end_sessions=ended.append, now=clock)


def add_admin(sessions, uid=ADMIN):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type="admin", email=f"{uid}@example.org", email_ci=f"{uid.lower()}@example.org", password_hash="x", display_name="Admin",
                   status="active", email_verified_at=T0))


def signup(companies, email="ana@acme.example", company="Acme Security Ltd", name="Ana Recruiter", password=GOOD):
    companies.signup_recruiter(email=email, password=password, display_name=name, company_name=company)


def verify(sessions, email="ana@acme.example"):
    with sessions.begin() as s:
        s.scalar(select(User).where(User.email_ci == email)).email_verified_at = T0


def user_id(sessions, email="ana@acme.example") -> str:
    with sessions() as s:
        return s.scalar(select(User.id).where(User.email_ci == email))


def org_row(sessions, email="ana@acme.example") -> Organization:
    uid = user_id(sessions, email)
    with ContextScopePort().acting_as(Scope(user_id=uid, roles=frozenset({Role.RECRUITER}))):
        with sessions() as s:
            member = s.scalar(select(OrgMember).where(OrgMember.user_id == uid))
    with ContextScopePort().acting_as(Scope(user_id=uid, org_id=str(member.org_id), roles=frozenset({Role.RECRUITER}))):
        with sessions() as s:
            return s.get(Organization, member.org_id)


def mails(sessions):
    with sessions() as s:
        return [(r.template, r.to_user_id, dict(r.params)) for r in s.scalars(select(EmailOutbox).order_by(EmailOutbox.id))]


def entries(audit, action=None):
    return [(r.action, r.actor, r.subject, dict(r.details)) for r in audit.records if action is None or r.action == action]


# ---- the disposable list -----------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("address,expected", [
    ("a@mailinator.com", True), ("a@MAILINATOR.COM", True), ("a@x.y.mailinator.com", True), ("a@yopmail.com", True), ("a@guerrillamail.org", True),
    ("a@gmail.com", False), ("a@outlook.com", False), ("a@acme.example", False), ("a@notmailinator.com", False), ("a@mailinator.com.evil.example", False),
    ("a@com", False),
])
def test_disposable_domains_are_found_with_their_subdomains_and_free_webmail_is_not(address, expected):
    assert is_disposable(address) is expected


def test_the_bundled_list_is_clean():
    domains = disposable.disposable_domains()
    assert len(domains) >= 50 and all(d == d.lower() and "." in d and " " not in d and not d.startswith(".") for d in domains)
    assert "gmail.com" not in domains and "outlook.com" not in domains and "yahoo.com" not in domains, "free webmail is allowed (OI-10)"
    assert domain_of("a@B.example.") == "b.example"


# ---- signup ------------------------------------------------------------------------------------------------------------------------------

def test_a_recruiter_signup_makes_the_account_the_pending_company_the_owner_and_the_mail(companies, sessions, audit):
    signup(companies)
    with sessions() as s:
        user = s.scalar(select(User))
        assert (user.account_type, user.email_ci, user.status, user.email_verified_at) == ("recruiter", "ana@acme.example", "active", None)
        assert s.scalar(select(func.count()).select_from(UserRole)) == 0, "a recruiter holds no learner or candidate role"
    org = org_row(sessions)
    assert (org.name, org.email_domain, org.status, org.owner_user_id, org.rejected_reason) == ("Acme Security Ltd", "acme.example", "pending", user.id, None)
    uid = user.id
    with ContextScopePort().acting_as(Scope(user_id=uid, org_id=str(org.id), roles=frozenset({Role.RECRUITER}))):
        with sessions() as s:
            member = s.get(OrgMember, (org.id, uid))
    assert (member.role, member.status) == ("owner", "active")
    [(template, to, params)] = mails(sessions)
    assert (template, to) == ("account.verify", uid) and params["link"].startswith(f"{ORIGIN}/verify-email?token=")
    assert entries(audit) == [("org.created", uid, uid, {"org": str(org.id)})]


def test_no_scope_is_left_behind_after_a_signup(companies):
    signup(companies)
    assert scope_or_none() is None


def test_a_known_address_gets_the_same_answer_and_no_second_company(companies, sessions):
    signup(companies)
    assert signup(companies, company="Another Company", name="Someone Else") is None
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(User)) == 1
    assert [m[0] for m in mails(sessions)] == ["account.verify", "account.already_registered"]
    assert org_row(sessions).name == "Acme Security Ltd", "the second signup changed nothing"


def test_a_known_learner_address_is_also_just_a_known_address(companies, sessions):
    with sessions.begin() as s:
        s.add(User(id="u-LEARNERLEARNER22", account_type="participant", email="ana@acme.example", email_ci="ana@acme.example", password_hash="x",
                   display_name="Ana", status="active", email_verified_at=T0))
    signup(companies)
    add_admin(sessions)
    with sessions() as s:
        assert [u.account_type for u in s.scalars(select(User)) if u.id != ADMIN] == ["participant"]
    assert companies.pending(ADMIN_SCOPE) == [], "a known address creates no company"


@pytest.mark.parametrize("email", ["a@mailinator.com", "a@x.guerrillamail.com", "A@YOPMAIL.com"])
def test_a_disposable_address_cannot_start_a_recruiter_signup(companies, sessions, email):
    with pytest.raises(InvalidInput) as e:
        signup(companies, email=email)
    assert (e.value.pointer, e.value.kind) == ("/email", "disposable_email")
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(User)) == 0 and mails(sessions) == []


@pytest.mark.parametrize("email", ["freelancer@gmail.com", "x@outlook.com", "y@yahoo.com", "z@proton.me"])
def test_free_webmail_is_allowed_without_an_extra_check_oi_10(companies, sessions, email):
    signup(companies, email=email)
    assert org_row(sessions, email).email_domain == email.split("@")[1] and org_row(sessions, email).status == "pending"


@pytest.mark.parametrize("kwargs,pointer", [
    ({"company": ""}, "/company_name"), ({"company": "   "}, "/company_name"), ({"company": "x" * 121}, "/company_name"), ({"company": "\x00\x01"}, "/company_name"),
    ({"name": ""}, "/display_name"), ({"email": "not an email"}, "/email"), ({"password": "short"}, "/password"),
])
def test_bad_input_is_refused_and_nothing_is_made(companies, sessions, kwargs, pointer):
    with pytest.raises(InvalidInput) as e:
        signup(companies, **kwargs)
    assert e.value.pointer == pointer
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(User)) == 0


def test_the_company_name_is_cleaned(companies, sessions):
    signup(companies, company="  Acme\n\tSecurity   Ltd   ")
    assert org_row(sessions).name == "Acme Security Ltd"


def test_a_second_recruiter_of_a_claimed_domain_asks_to_join_instead_of_starting_a_company(companies, sessions):
    """FR-ORG-03: the first recruiter of a work domain creates the company and claims the domain; the next one becomes a request the owner decides."""
    signup(companies, email="ana@acme.example", company="Acme")
    signup(companies, email="bo@acme.example", company="Whatever Bo Typed")
    ana_org = org_row(sessions, "ana@acme.example")
    assert companies.claimed_by("acme.example") == str(ana_org.id)
    bo = user_id(sessions, "bo@acme.example")
    assert companies.membership_of(bo) is None
    assert [(r.user_id, r.display_name) for r in companies.join_requests(user_id(sessions, "ana@acme.example"))] == [(bo, "Ana Recruiter")]


def test_free_webmail_never_claims_a_domain_so_two_gmail_recruiters_each_get_a_company(companies, sessions):
    signup(companies, email="ana@gmail.com", company="Ana Consulting")
    signup(companies, email="bo@gmail.com", company="Bo Consulting")
    assert org_row(sessions, "ana@gmail.com").id != org_row(sessions, "bo@gmail.com").id and companies.claimed_by("gmail.com") is None


# ---- where a recruiter stands -----------------------------------------------------------------------------------------------------------

def test_the_recruiter_goes_from_unverified_to_pending_to_active(companies, sessions):
    signup(companies)
    uid = user_id(sessions)
    assert companies.standing(uid).state == "unverified_email"
    with pytest.raises(NotActiveRecruiter) as e:
        companies.active_company_of(uid)
    assert e.value.state == "unverified_email"
    verify(sessions)
    standing = companies.standing(uid)
    assert (standing.state, standing.org_name, standing.reason) == ("pending_approval", "Acme Security Ltd", None)
    add_admin(sessions)
    companies.approve(ADMIN_SCOPE, standing.org_id)
    active = companies.standing(uid)
    assert active.state == "active" and companies.active_company_of(uid) == standing.org_id


def test_only_an_active_recruiter_in_an_active_company_passes_the_invite_gate(companies, sessions):
    signup(companies)
    verify(sessions)
    uid = user_id(sessions)
    with pytest.raises(NotActiveRecruiter) as e:
        companies.active_company_of(uid)
    assert e.value.state == "pending_approval"


def test_a_participant_and_an_unknown_account_are_not_recruiters(companies, sessions):
    with sessions.begin() as s:
        s.add(User(id="u-LEARNERLEARNER22", account_type="participant", email="l@x.example", email_ci="l@x.example", password_hash="x", display_name="L",
                   status="active", email_verified_at=T0))
    for uid in ("u-LEARNERLEARNER22", "u-NOBODYNOBODYNOBO"):
        with pytest.raises(NotARecruiter):
            companies.standing(uid)
        with pytest.raises(NotARecruiter):
            companies.active_company_of(uid)


def test_the_state_function_covers_every_state_of_the_machine():
    from vulnmart.accounts.directory import UserBrief

    def brief(status="active", verified=True):
        return UserBrief("u-X", "recruiter", status, "N", "d.example", verified)

    def org(status):
        return Organization(name="n", email_domain="d.example", status=status, owner_user_id="u-X")

    assert recruiter_state(brief(verified=False), org("pending")) == "unverified_email"
    assert recruiter_state(brief(), org("pending")) == "pending_approval"
    assert recruiter_state(brief(), org("active")) == "active"
    assert recruiter_state(brief(), org("rejected")) == "rejected"
    assert recruiter_state(brief(), org("suspended")) == "suspended"
    assert recruiter_state(brief(), org("deleted")) == "deleted"
    assert recruiter_state(brief(status="disabled"), org("active")) == "suspended"
    assert recruiter_state(brief(status="deleted"), org("active")) == "deleted"
    assert recruiter_state(brief(), None) == "none"
    assert recruiter_state(brief(verified=False), org("rejected")) == "rejected", "a rejection shows even before the address is verified"


# ---- the admin's queue and decisions ----------------------------------------------------------------------------------------------------

def test_the_queue_lists_pending_companies_oldest_first_with_the_owners_name_and_domain_only(companies, sessions, clock):
    add_admin(sessions)
    signup(companies, email="ana@acme.example", company="Acme", name="Ana A")
    clock.advance(minutes=5)
    signup(companies, email="bo@gmail.com", company="Bo Consulting", name="Bo B")
    queue = companies.pending(ADMIN_SCOPE)
    assert [(c.name, c.owner_name, c.owner_email_domain) for c in queue] == [("Acme", "Ana A", "acme.example"), ("Bo Consulting", "Bo B", "gmail.com")]
    assert all(re.fullmatch(r"[0-9a-f-]{36}", c.org_id) for c in queue) and "@" not in str(queue), "no full address in the queue"


def test_the_queue_and_every_decision_need_an_admin(companies, sessions):
    signup(companies)
    org_id = str(org_row(sessions).id)
    uid = user_id(sessions)
    add_admin(sessions)
    for actor in (Scope(user_id=uid, roles=frozenset({Role.RECRUITER})), Scope(user_id=ADMIN), Scope(user_id="u-NOBODYNOBODYNOBO", roles=frozenset({Role.ADMIN}))):
        with pytest.raises(NotAnAdmin):
            companies.pending(actor)
        with pytest.raises(NotAnAdmin):
            companies.approve(actor, org_id)
        with pytest.raises(NotAnAdmin):
            companies.reject(actor, org_id, "no")
        with pytest.raises(NotAnAdmin):
            companies.suspend(actor, org_id, "no")
        with pytest.raises(NotAnAdmin):
            companies.reinstate(actor, org_id, "no")
    assert org_row(sessions).status == "pending"


def test_an_approval_activates_the_company_audits_it_and_mails_the_owner(companies, sessions, audit):
    add_admin(sessions)
    signup(companies)
    org = org_row(sessions)
    companies.approve(ADMIN_SCOPE, str(org.id))
    assert org_row(sessions).status == "active" and companies.pending(ADMIN_SCOPE) == []
    assert entries(audit, "org.approved") == [("org.approved", ADMIN, org.owner_user_id, {"org": str(org.id), "reason_given": False})]
    template, to, params = mails(sessions)[-1]
    assert (template, to) == ("org.approval_outcome", org.owner_user_id)
    assert params == {"org_name": "Acme Security Ltd", "outcome": "approved", "login_url": f"{ORIGIN}/login"}


def test_a_rejection_needs_a_written_reason_that_the_applicant_sees_in_the_mail_and_in_their_standing(companies, sessions, audit):
    add_admin(sessions)
    signup(companies)
    verify(sessions)
    org = org_row(sessions)
    for bad in ("", "   ", "x" * 501):
        with pytest.raises(InvalidInput):
            companies.reject(ADMIN_SCOPE, str(org.id), bad)
    assert org_row(sessions).status == "pending"
    companies.reject(ADMIN_SCOPE, str(org.id), "We could not match   the company to a\nregistered business.")
    again = org_row(sessions)
    assert (again.status, again.rejected_reason) == ("rejected", "We could not match the company to a registered business.")
    standing = companies.standing(org.owner_user_id)
    assert (standing.state, standing.reason) == ("rejected", again.rejected_reason)
    template, to, params = mails(sessions)[-1]
    assert (template, to) == ("org.approval_outcome", org.owner_user_id) and params["outcome"] == "rejected" and params["reason"] == again.rejected_reason
    assert entries(audit, "org.rejected") == [("org.rejected", ADMIN, org.owner_user_id, {"org": str(org.id), "reason_given": True})]
    assert "registered business" not in str(entries(audit)), "the reason text is not in the audit log"


def test_a_decision_is_made_once(companies, sessions):
    add_admin(sessions)
    signup(companies)
    oid = str(org_row(sessions).id)
    companies.approve(ADMIN_SCOPE, oid)
    for call in (lambda: companies.approve(ADMIN_SCOPE, oid), lambda: companies.reject(ADMIN_SCOPE, oid, "late")):
        with pytest.raises(InvalidTransition) as e:
            call()
        assert e.value.state == "active"
    assert len([m for m in mails(sessions) if m[0] == "org.approval_outcome"]) == 1, "no second mail"


def test_an_unknown_or_malformed_company_is_not_found(companies, sessions):
    add_admin(sessions)
    for oid in ("not-a-uuid", "00000000-0000-0000-0000-000000000000", ""):
        with pytest.raises(CompanyNotFound):
            companies.approve(ADMIN_SCOPE, oid)


def test_suspend_and_reinstate(companies, sessions, audit):
    add_admin(sessions)
    signup(companies)
    verify(sessions)
    org = org_row(sessions)
    uid = org.owner_user_id
    with pytest.raises(InvalidTransition):
        companies.suspend(ADMIN_SCOPE, str(org.id), "too early")  # only an active company can be suspended
    companies.approve(ADMIN_SCOPE, str(org.id))
    with pytest.raises(InvalidTransition):
        companies.reinstate(ADMIN_SCOPE, str(org.id), "too early")
    with pytest.raises(InvalidInput):
        companies.suspend(ADMIN_SCOPE, str(org.id), " ")
    companies.suspend(ADMIN_SCOPE, str(org.id), "Complaint under review")
    assert companies.standing(uid).state == "suspended" and org_row(sessions).suspended_reason == "Complaint under review"
    with pytest.raises(NotActiveRecruiter) as e:
        companies.active_company_of(uid)
    assert e.value.state == "suspended"
    with pytest.raises(InvalidInput):
        companies.reinstate(ADMIN_SCOPE, str(org.id), "")  # every admin action needs a reason
    companies.reinstate(ADMIN_SCOPE, str(org.id), "Complaint withdrawn")
    assert companies.standing(uid).state == "active" and org_row(sessions).suspended_reason is None
    assert [e[0] for e in entries(audit)] == ["org.created", "org.approved", "org.suspended", "org.reinstated"]
    assert [m[0] for m in mails(sessions)].count("org.approval_outcome") == 1, "suspension sends no approval-outcome mail"


# ---- applying again ------------------------------------------------------------------------------------------------------------------------

def test_a_rejected_company_may_apply_again_at_any_time_and_be_rejected_and_apply_again(companies, sessions, audit):
    add_admin(sessions)
    signup(companies)
    org = org_row(sessions)
    uid = org.owner_user_id
    with pytest.raises(InvalidTransition) as e:
        companies.reapply(uid)  # pending: nothing to apply for
    assert e.value.state == "unverified_email"
    verify(sessions)
    with pytest.raises(InvalidTransition):
        companies.reapply(uid)
    for round_ in range(3):
        companies.reject(ADMIN_SCOPE, str(org.id), f"reason {round_}")
        companies.reapply(uid)  # no waiting period (OI-11)
        again = org_row(sessions)
        assert (again.status, again.rejected_reason) == ("pending", None)
    companies.approve(ADMIN_SCOPE, str(org.id))
    assert companies.standing(uid).state == "active"
    assert [e[0] for e in entries(audit)].count("org.reapplied") == 3


def test_a_stranger_cannot_apply_for_a_company_and_an_active_one_has_nothing_to_apply_for(companies, sessions):
    add_admin(sessions)
    signup(companies)
    signup(companies, email="bo@other.example", company="Other")
    ana, bo = user_id(sessions), user_id(sessions, "bo@other.example")
    ana_org = org_row(sessions)
    companies.reject(ADMIN_SCOPE, str(ana_org.id), "no")
    with pytest.raises(InvalidTransition):
        companies.reapply(bo)  # bo's own company is not rejected: bo cannot touch ana's
    assert org_row(sessions).status == "rejected"
    companies.reapply(ana)
    assert org_row(sessions).status == "pending"


# ---- what the organisation guard allows ---------------------------------------------------------------------------------------------------

def test_the_admin_visible_and_self_visible_tables_are_exactly_the_ones_intended(companies):
    assert ORG_ADMIN_VISIBLE == {"organizations"}
    assert ORG_SELF_VISIBLE == {"org_members": "user_id", "join_requests": "user_id"}


def test_the_guard_refuses_company_tables_without_a_scope_and_for_the_wrong_scope(companies, sessions):
    signup(companies)
    add_admin(sessions)
    with sessions() as s:
        for query in (select(Organization), select(OrgMember), select(func.count()).select_from(Organization)):
            with pytest.raises(ScopeMissing):
                s.execute(query).all()
    port = ContextScopePort()
    with port.acting_as(Scope(user_id="u-LEARNERLEARNER22", roles=frozenset({Role.LEARNER}))):
        with sessions() as s:
            with pytest.raises(ScopeMissing):
                s.execute(select(Organization)).all()  # a non-admin without a company reads no company
    with port.acting_as(ADMIN_SCOPE):
        with sessions() as s:
            assert s.scalars(select(OrgMember)).all() == [], "the admin reads the directory, not the members of companies: only their own membership, which is none"
            assert len(s.scalars(select(Organization)).all()) == 1


def test_a_person_without_a_company_in_scope_reads_only_their_own_membership(companies, sessions):
    signup(companies, email="ana@acme.example")
    signup(companies, email="bo@other.example", company="Other")
    ana, bo = user_id(sessions), user_id(sessions, "bo@other.example")
    with ContextScopePort().acting_as(Scope(user_id=ana, roles=frozenset({Role.RECRUITER}))):
        with sessions() as s:
            rows = s.scalars(select(OrgMember)).all()
    assert [r.user_id for r in rows] == [ana]
    with ContextScopePort().acting_as(Scope(user_id=ana, roles=frozenset({Role.RECRUITER}))):
        with sessions() as s:
            assert s.scalars(select(OrgMember).where(OrgMember.user_id == bo)).all() == [], "asking for someone else's row finds nothing"


def test_an_admin_without_a_company_cannot_change_a_company(companies, sessions):
    signup(companies)
    add_admin(sessions)
    from sqlalchemy import update

    with ContextScopePort().acting_as(ADMIN_SCOPE):
        with sessions.begin() as s:
            with pytest.raises(ScopeMissing):
                s.execute(update(Organization).values(status="active"))
    assert org_row(sessions).status == "pending"


def test_a_company_in_scope_sees_only_itself(companies, sessions):
    signup(companies, email="ana@acme.example")
    signup(companies, email="bo@other.example", company="Other")
    ana_org, bo_org = org_row(sessions), org_row(sessions, "bo@other.example")
    with ContextScopePort().acting_as(Scope(user_id="x", org_id=str(ana_org.id), roles=frozenset({Role.RECRUITER}))):
        with sessions() as s:
            assert [o.name for o in s.scalars(select(Organization)).all()] == ["Acme Security Ltd"]
            assert s.get(Organization, bo_org.id) is None
