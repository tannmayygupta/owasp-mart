"""Story P-19 (FR-ORG-03, FR-ORG-05, FR-ORG-06, FR-ORG-07, FR-ORG-08) at service level, on SQLite with the real scoped session: colleagues joining through the owner,
removing a member, the admin controls over companies and recruiters, the data-processing terms, the invite cap, the company in a recruiter's session scope,
and the rule that every table with an organisation column is scoped on purpose. The row-level security and the races are in test_company_members_postgres.py."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update

import vulnmart.orgs.models  # noqa: F401
from test_companies import (  # noqa: F401 - the fixtures and helpers of story P-18
    ADMIN, ADMIN_SCOPE, GOOD, ORIGIN, T0, add_admin, audit, clock, companies, ended, entries, mails, org_row, sessions, signup, user_id, verify,
)
from vulnmart.accounts import security
from vulnmart.accounts.models import User, UserSession
from vulnmart.accounts.roles import NotAnAdmin, UnknownUser
from vulnmart.accounts.service import InvalidInput
from vulnmart.accounts.sessions import InvalidCredentials, SessionService
from vulnmart.accounts.status import AccountStatusService, InvalidAccountState
from vulnmart.kernel.db import ORG_SCOPED, Base
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.orgs import terms
from vulnmart.orgs.models import DpaAcceptance, JoinRequest, Organization, OrgMember
from vulnmart.orgs.service import (
    CompanyNotFound, DomainMismatch, InvalidTransition, NotActiveRecruiter, NotARecruiter, NotTheOwner, TermsNotAccepted, TermsStale,
)
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.scope import Role, Scope

ANA, BO, CY = "ana@acme.example", "bo@acme.example", "cy@acme.example"


def two_colleagues(companies, sessions):
    """Ana owns an approved Acme; Bo and Cy asked to join (their addresses verified)."""
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana Owner")
    signup(companies, email=BO, company="x", name="Bo Colleague")
    signup(companies, email=CY, company="x", name="Cy Colleague")
    for e in (ANA, BO, CY):
        verify(sessions, e)
    companies.approve(ADMIN_SCOPE, str(org_row(sessions, ANA).id))
    return user_id(sessions, ANA), user_id(sessions, BO), user_id(sessions, CY)


def add_recruiter(sessions, email, status="active", verified=True):
    uid = "u-" + uuid.uuid4().hex[:16].upper().translate(str.maketrans("0189", "ABCD"))
    with sessions.begin() as s:
        s.add(User(id=uid, account_type="recruiter", email=email, email_ci=email, password_hash=security.hash_password(GOOD), display_name="R", status=status,
                   email_verified_at=T0 if verified else None))
    return uid


# ---- colleagues join through the owner (FR-ORG-03) ------------------------------------------------------------------------------------------

def test_a_colleague_waits_unverified_then_pending_and_the_owner_sees_the_request(companies, sessions, audit):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana Owner")
    signup(companies, email=BO, company="x", name="Bo Colleague")
    bo, ana = user_id(sessions, BO), user_id(sessions, ANA)
    assert companies.standing(bo).state == "unverified_email"
    verify(sessions, BO)
    assert companies.standing(bo).state == "pending_approval" and companies.membership_of(bo) is None
    [req] = companies.join_requests(ana)
    assert (req.user_id, req.display_name) == (bo, "Bo Colleague")
    assert entries(audit, "org.join_requested") == [("org.join_requested", bo, bo, {"org": str(org_row(sessions, ANA).id)})]
    assert [m[0] for m in mails(sessions)] == ["account.verify", "account.verify"]


def test_a_colleague_is_accepted_only_into_an_approved_company_and_then_is_active(companies, sessions, audit):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana Owner")
    signup(companies, email=BO, company="x", name="Bo Colleague")
    verify(sessions, ANA)
    verify(sessions, BO)
    ana, bo = user_id(sessions, ANA), user_id(sessions, BO)
    [req] = companies.join_requests(ana)
    with pytest.raises(InvalidTransition) as e:
        companies.approve_join(ana, req.request_id)  # the admin has not approved the company yet
    assert e.value.state == "pending"
    companies.approve(ADMIN_SCOPE, str(org_row(sessions, ANA).id))
    companies.approve_join(ana, req.request_id)
    assert companies.membership_of(bo) == (str(org_row(sessions, ANA).id), "member")
    standing = companies.standing(bo)
    assert (standing.state, standing.org_name) == ("active", "Acme") and companies.active_company_of(bo) == standing.org_id
    assert companies.join_requests(ana) == []
    assert [(m.display_name, m.role) for m in companies.members(ana)] == [("Ana Owner", "owner"), ("Bo Colleague", "member")], "the owner first"
    template, to, params = mails(sessions)[-1]
    assert (template, to, params["outcome"]) == ("org.approval_outcome", bo, "approved")
    assert entries(audit, "org.join_approved") == [("org.join_approved", ana, bo, {"org": standing.org_id})]
    with pytest.raises(InvalidTransition) as again:
        companies.approve_join(ana, req.request_id)
    assert again.value.state == "approved"


def test_the_owner_may_reject_a_colleague(companies, sessions, audit):
    ana, bo, cy = two_colleagues(companies, sessions)
    requests = {r.user_id: r.request_id for r in companies.join_requests(ana)}
    companies.reject_join(ana, requests[bo])
    assert companies.standing(bo).state == "rejected" and companies.membership_of(bo) is None
    assert [r.user_id for r in companies.join_requests(ana)] == [cy]
    template, to, params = mails(sessions)[-1]
    assert (template, to, params["outcome"]) == ("org.approval_outcome", bo, "rejected")
    assert entries(audit, "org.join_rejected")[0][:3] == ("org.join_rejected", ana, bo)
    with pytest.raises(InvalidTransition):
        companies.approve_join(ana, requests[bo])


def test_only_the_owner_decides_requests_and_manages_members(companies, sessions):
    ana, bo, cy = two_colleagues(companies, sessions)
    [req_bo, req_cy] = sorted(companies.join_requests(ana), key=lambda r: r.user_id != bo)
    companies.approve_join(ana, req_bo.request_id)
    for call in (lambda: companies.join_requests(bo), lambda: companies.approve_join(bo, req_cy.request_id), lambda: companies.reject_join(bo, req_cy.request_id),
                 lambda: companies.members(bo), lambda: companies.remove_member(bo, ana), lambda: companies.terms_for(bo), lambda: companies.join_requests(cy),
                 lambda: companies.join_requests("u-NOBODYNOBODYNOBO")):
        with pytest.raises(NotTheOwner):
            call()


def test_another_companys_owner_cannot_see_or_decide_a_request(companies, sessions):
    ana, bo, cy = two_colleagues(companies, sessions)
    signup(companies, email="dee@other.example", company="Other", name="Dee Owner")
    verify(sessions, "dee@other.example")
    dee = user_id(sessions, "dee@other.example")
    companies.approve(ADMIN_SCOPE, str(org_row(sessions, "dee@other.example").id))
    [req, *_] = companies.join_requests(ana)
    assert companies.join_requests(dee) == []
    for call in (lambda: companies.approve_join(dee, req.request_id), lambda: companies.reject_join(dee, req.request_id)):
        with pytest.raises(CompanyNotFound):
            call()
    assert len(companies.join_requests(ana)) == 2, "nothing changed"


def test_a_request_from_another_domain_or_free_webmail_is_refused(companies, sessions):
    ana, _, _ = two_colleagues(companies, sessions)
    org_id = str(org_row(sessions, ANA).id)
    outsider = add_recruiter(sessions, "eve@elsewhere.example")
    gmail = add_recruiter(sessions, "fay@gmail.com")
    for uid in (outsider, gmail):
        with pytest.raises(DomainMismatch):
            companies.request_join(uid, org_id)
    colleague = add_recruiter(sessions, "gus@acme.example")
    companies.request_join(colleague, org_id)
    assert colleague in [r.user_id for r in companies.join_requests(ana)]
    with pytest.raises(InvalidTransition) as e:
        companies.request_join(colleague, org_id)
    assert e.value.state == "requested"
    with pytest.raises(InvalidTransition) as e2:
        companies.request_join(ana, org_id)  # already a member of a company
    assert e2.value.state == "member"
    with pytest.raises(CompanyNotFound):
        companies.request_join(colleague, "00000000-0000-0000-0000-000000000000")
    with pytest.raises(NotARecruiter):
        companies.request_join("u-NOBODYNOBODYNOBO", org_id)


def test_a_company_that_gave_up_its_domain_takes_no_requests(companies, sessions):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana Owner")
    org = org_row(sessions, ANA)
    companies.reject(ADMIN_SCOPE, str(org.id), "no")
    assert companies.claimed_by("acme.example") is None, "a rejected company does not hold its domain"
    with pytest.raises(CompanyNotFound):
        companies.request_join(add_recruiter(sessions, "gus@acme.example"), str(org.id))


def test_removing_a_member_ends_their_access_at_once(companies, sessions, audit, ended):
    ana, bo, cy = two_colleagues(companies, sessions)
    for r in companies.join_requests(ana):
        companies.approve_join(ana, r.request_id)
    assert companies.membership_of(bo) is not None
    companies.remove_member(ana, bo)
    assert companies.membership_of(bo) is None and ended == [bo], "the member's sessions were ended"
    assert companies.standing(bo).state == "none"
    assert [m.user_id for m in companies.members(ana)] == [ana, cy]
    assert entries(audit, "org.member_removed")[0][:3] == ("org.member_removed", ana, bo)
    with pytest.raises(CompanyNotFound):
        companies.remove_member(ana, bo)  # already gone
    with pytest.raises(InvalidTransition) as e:
        companies.remove_member(ana, ana)
    assert e.value.state == "owner"
    with pytest.raises(CompanyNotFound):
        companies.remove_member(ana, "u-NOBODYNOBODYNOBO")


def test_an_owner_cannot_remove_someone_from_another_company(companies, sessions):
    ana, bo, _ = two_colleagues(companies, sessions)
    companies.approve_join(ana, [r for r in companies.join_requests(ana) if r.user_id == bo][0].request_id)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    verify(sessions, "dee@other.example")
    dee = user_id(sessions, "dee@other.example")
    companies.approve(ADMIN_SCOPE, str(org_row(sessions, "dee@other.example").id))
    with pytest.raises(CompanyNotFound):
        companies.remove_member(dee, bo)
    assert companies.membership_of(bo) is not None


# ---- the company in the session scope (FR-ORG-06) ------------------------------------------------------------------------------------------

def make_session_service(sessions, companies, clock):
    service = SessionService(sessions, FakeSettingsPort(), b"k" * 32, now=clock)
    service.set_org_resolver(companies.membership_of)
    return service


def test_a_recruiters_session_carries_their_company_and_an_owner_the_owner_role(companies, sessions, clock):
    ana, bo, cy = two_colleagues(companies, sessions)
    for r in companies.join_requests(ana):
        if r.user_id == bo:
            companies.approve_join(ana, r.request_id)
    service = make_session_service(sessions, companies, clock)
    org_id = str(org_row(sessions, ANA).id)
    owner = service.resolve(service.open_session(ana, ip_trunc=None, ua_class=None, mfa=False).token)
    member = service.resolve(service.open_session(bo, ip_trunc=None, ua_class=None, mfa=False).token)
    waiting = service.resolve(service.open_session(cy, ip_trunc=None, ua_class=None, mfa=False).token)
    assert (owner.scope.org_id, member.scope.org_id, waiting.scope.org_id) == (org_id, org_id, None)
    assert Role.ORG_OWNER in owner.roles and Role.ORG_OWNER not in member.roles and Role.RECRUITER in member.roles
    companies.remove_member(ana, bo)
    again = service.resolve(service.open_session(bo, ip_trunc=None, ua_class=None, mfa=False).token)
    assert again.scope.org_id is None, "a removed member's next request has no company"


def test_a_participant_and_an_admin_never_get_a_company(companies, sessions, clock):
    add_admin(sessions)
    with sessions.begin() as s:
        s.add(User(id="u-LEARNERLEARNER22", account_type="participant", email="l@x.example", email_ci="l@x.example", password_hash="x", display_name="L",
                   status="active", email_verified_at=T0))
    service = make_session_service(sessions, companies, clock)
    assert service.resolve(service.open_session("u-LEARNERLEARNER22", ip_trunc=None, ua_class=None, mfa=False).token).scope.org_id is None
    assert service.resolve(service.open_session(ADMIN, ip_trunc=None, ua_class=None, mfa=True).token).scope.org_id is None


def test_the_scope_of_a_session_reads_only_its_own_company(companies, sessions, clock):
    ana, bo, cy = two_colleagues(companies, sessions)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    service = make_session_service(sessions, companies, clock)
    scope = service.resolve(service.open_session(ana, ip_trunc=None, ua_class=None, mfa=False).token).scope
    other_org = org_row(sessions, "dee@other.example")
    with ContextScopePort().acting_as(scope):
        with sessions() as s:
            assert [o.name for o in s.scalars(select(Organization)).all()] == ["Acme"]
            assert s.get(Organization, other_org.id) is None, "another company's id finds nothing"
            assert all(r.org_id == scope.org_id or str(r.org_id) == scope.org_id for r in s.scalars(select(JoinRequest)).all())
    with ContextScopePort().acting_as(scope):
        with sessions.begin() as s:
            assert s.execute(update(Organization).where(Organization.id == other_org.id).values(name="hijacked")).rowcount == 0


def test_every_table_with_an_organisation_column_is_scoped_or_listed_here_on_purpose():
    """A new table with an `org_id` must register with `org_scoped` (and get a row-level security policy), or be added below with the reason."""
    import vulnmart.accounts.models  # noqa: F401
    import vulnmart.kernel.models  # noqa: F401
    import vulnmart.lab.models  # noqa: F401  (so the answer does not depend on which test imported them first)
    import vulnmart.admin.models  # noqa: F401 - break_glass_sessions (story P-31)
    import vulnmart.privacy.models  # noqa: F401

    on_purpose = {
        "attempts": "stream L: the lab runtime and the event receiver work without a session scope, so a row-level policy would stop them; access is decided in the lab API "
                    "(the owner, or a reviewer of the company: vulnmart.lab.api reviewable, same 404 for anyone else). A follow-up may add a policy once the runtime acts with a scope",
        "consent_records": "an append-only proof that outlives the company; org_id is a plain pointer, read by the candidate (story P-16)",
        "deletion_requests": "a person's request, read and decided by service code that checks the caller (the person, or the company named on the request); org_id is a plain pointer, never a scope (story P-25)",
        "data_views": "the candidate reads their own history; org_id and the company name are plain values written when a company looks (story P-25)",
        "break_glass_sessions": "an admin-only record of break-glass access; org_id names the candidate's company for the alert, never a scope (story P-31)",
    }
    with_org_column = {name for name, table in Base.metadata.tables.items() if "org_id" in table.columns}
    assert with_org_column - set(ORG_SCOPED) == set(on_purpose), sorted(with_org_column - set(ORG_SCOPED) - set(on_purpose))
    assert {"organizations", "org_members", "join_requests", "dpa_acceptances"} <= set(ORG_SCOPED)


# ---- the data-processing terms (FR-ORG-07) -----------------------------------------------------------------------------------------------

def shown(companies, owner):
    t = companies.terms_for(owner)
    return t.version, t.sha256


def test_the_terms_are_shown_to_the_owner_of_an_approved_company_only(companies, sessions):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana Owner")
    verify(sessions, ANA)
    ana = user_id(sessions, ANA)
    with pytest.raises(InvalidTransition) as e:
        companies.terms_for(ana)
    assert e.value.state == "pending"
    companies.approve(ADMIN_SCOPE, str(org_row(sessions, ANA).id))
    t = companies.terms_for(ana)
    assert t.version == terms.TERMS_VERSION and "Data-processing terms for Acme" in t.text and "{{" not in t.text and not any(l.startswith("#") for l in t.text.splitlines())
    assert "18 or over" in t.text and "controller" in t.text and "processor" in t.text


def test_a_company_cannot_invite_until_the_owner_accepts_the_terms(companies, sessions, audit):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana Owner")
    verify(sessions, ANA)
    ana = user_id(sessions, ANA)
    with pytest.raises(NotActiveRecruiter):
        companies.invite_company_of(ana)  # not approved yet
    org = org_row(sessions, ANA)
    companies.approve(ADMIN_SCOPE, str(org.id))
    with pytest.raises(TermsNotAccepted) as e:
        companies.invite_company_of(ana)
    assert e.value.org_id == str(org.id) and companies.active_company_of(ana) == str(org.id) and companies.standing(ana).terms_accepted is False
    version, digest = shown(companies, ana)
    with pytest.raises(TermsStale):
        companies.accept_terms(ana, version, "0" * 64)
    with pytest.raises(TermsStale):
        companies.accept_terms(ana, "2020-01-01.1", digest)
    with pytest.raises(TermsNotAccepted):
        companies.invite_company_of(ana)
    companies.accept_terms(ana, version, digest)
    assert companies.invite_company_of(ana) == str(org.id) and companies.standing(ana).terms_accepted is True
    companies.accept_terms(ana, version, digest)  # again: not an error, not a second record
    with ContextScopePort().acting_as(Scope(user_id=ana, org_id=str(org.id), roles=frozenset({Role.RECRUITER}))):
        with sessions() as s:
            [row] = s.scalars(select(DpaAcceptance)).all()
    assert (str(row.org_id), row.user_id, row.terms_version, row.terms_sha256) == (str(org.id), ana, version, digest)
    assert row.accepted_at.replace(tzinfo=None) == T0.replace(tzinfo=None)
    assert entries(audit, "org.terms_accepted") == [("org.terms_accepted", ana, ana, {"org": str(org.id), "terms_version": version})]


def test_a_colleague_of_an_accepting_company_passes_the_gate_and_a_suspended_company_does_not(companies, sessions):
    ana, bo, _ = two_colleagues(companies, sessions)
    for r in companies.join_requests(ana):
        if r.user_id == bo:
            companies.approve_join(ana, r.request_id)
    version, digest = shown(companies, ana)
    companies.accept_terms(ana, version, digest)
    org_id = str(org_row(sessions, ANA).id)
    assert companies.invite_company_of(bo) == org_id
    companies.suspend(ADMIN_SCOPE, org_id, "review")
    for uid in (ana, bo):
        with pytest.raises(NotActiveRecruiter) as e:
            companies.invite_company_of(uid)
        assert e.value.state == "suspended"


def test_the_terms_text_is_pinned_to_its_version(monkeypatch):
    terms.check_template()
    assert terms.render(company_name="Acme").sha256 != terms.render(company_name="Globex").sha256
    for bad in ("", "   ", "x" * 121, "A\x00B"):
        with pytest.raises(terms.TermsError):
            terms.render(company_name=bad)
    monkeypatch.setitem(terms.TEMPLATE_HASHES, terms.TERMS_VERSION, "0" * 64)
    with pytest.raises(terms.TermsError):
        terms.check_template()


def test_the_service_does_not_start_with_changed_terms(monkeypatch, sessions, audit):
    from vulnmart.accounts.directory import UserDirectory
    from vulnmart.accounts.passwords import PasswordPolicy
    from vulnmart.accounts.roles import RoleService
    from vulnmart.accounts.service import AccountService
    from vulnmart.orgs.service import CompanyService

    monkeypatch.setitem(terms.TEMPLATE_HASHES, terms.TERMS_VERSION, "0" * 64)
    settings = FakeSettingsPort()
    roles = RoleService(sessions, audit)
    with pytest.raises(terms.TermsError):
        CompanyService(sessions, AccountService(sessions, settings, public_origin=ORIGIN, policy=PasswordPolicy()), UserDirectory(sessions), roles, audit,
                       ContextScopePort(), settings, AccountStatusService(sessions, roles, audit), public_origin=ORIGIN)


# ---- the daily invite cap (FR-ORG-08) ------------------------------------------------------------------------------------------------------

def test_the_cap_is_the_global_setting_until_an_admin_sets_one_for_the_company(companies, sessions, audit):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana")
    oid = str(org_row(sessions, ANA).id)
    assert companies.invite_cap(oid) == 50
    companies.set_invite_cap(ADMIN_SCOPE, oid, 10)
    assert companies.invite_cap(oid) == 10
    companies.set_invite_cap(ADMIN_SCOPE, oid, 0)
    assert companies.invite_cap(oid) == 0, "zero is a cap: no invites"
    companies.set_invite_cap(ADMIN_SCOPE, oid, None)
    assert companies.invite_cap(oid) == 50
    assert [e[3]["cap"] for e in entries(audit, "org.invite_cap_set")] == [10, 0, None]


@pytest.mark.parametrize("bad", [-1, 100_001, True, "10", 1.5])
def test_a_bad_cap_is_refused(companies, sessions, bad):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana")
    with pytest.raises(InvalidInput):
        companies.set_invite_cap(ADMIN_SCOPE, str(org_row(sessions, ANA).id), bad)


def test_only_an_admin_sets_a_cap_and_an_unknown_company_is_not_found(companies, sessions):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana")
    oid = str(org_row(sessions, ANA).id)
    for actor in (Scope(user_id=user_id(sessions, ANA), roles=frozenset({Role.RECRUITER})), Scope(user_id=ADMIN)):
        with pytest.raises(NotAnAdmin):
            companies.set_invite_cap(actor, oid, 5)
    for call in (lambda: companies.set_invite_cap(ADMIN_SCOPE, "00000000-0000-0000-0000-000000000000", 5), lambda: companies.invite_cap("nope"),
                 lambda: companies.check_invite_cap("00000000-0000-0000-0000-000000000000", 0)):
        with pytest.raises(CompanyNotFound):
            call()


def test_reaching_the_cap_is_a_decision_not_an_error(companies, sessions):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana")
    oid = str(org_row(sessions, ANA).id)
    companies.set_invite_cap(ADMIN_SCOPE, oid, 10)
    assert companies.check_invite_cap(oid, 0).allowed and companies.check_invite_cap(oid, 9).remaining == 1
    assert companies.check_invite_cap(oid, 9, wanted=1).allowed is True
    assert (lambda d: (d.allowed, d.cap, d.remaining))(companies.check_invite_cap(oid, 10)) == (False, 10, 0)
    assert (lambda d: (d.allowed, d.remaining))(companies.check_invite_cap(oid, 3, wanted=8)) == (False, 7)
    assert companies.check_invite_cap(oid, 3, wanted=7).allowed is True
    assert companies.check_invite_cap(oid, 50).remaining == 0 and companies.check_invite_cap(oid, -5).remaining == 10, "a negative count counts as none"


# ---- the admin's controls over companies and recruiters (FR-ORG-05) -------------------------------------------------------------------------

def test_deleting_a_company_ends_its_recruiters_access_releases_its_domain_and_needs_a_reason(companies, sessions, audit, ended):
    ana, bo, cy = two_colleagues(companies, sessions)
    for r in companies.join_requests(ana):
        if r.user_id == bo:
            companies.approve_join(ana, r.request_id)
    oid = str(org_row(sessions, ANA).id)
    with pytest.raises(InvalidInput):
        companies.delete_company(ADMIN_SCOPE, oid, "  ")
    assert companies.claimed_by("acme.example") == oid
    companies.delete_company(ADMIN_SCOPE, oid, "Closed at the owner's request")
    assert org_row(sessions, ANA).status == "deleted" and sorted(ended) == sorted([ana, bo]), "the members' sessions ended"
    assert companies.claimed_by("acme.example") is None and companies.standing(ana).state == "deleted"
    with pytest.raises(InvalidTransition) as e:
        companies.delete_company(ADMIN_SCOPE, oid, "again")
    assert e.value.state == "deleted"
    assert entries(audit, "org.deleted") == [("org.deleted", ADMIN, ana, {"org": oid, "reason_given": True})]
    assert "owner's request" not in str(entries(audit))
    signup(companies, email="dan@acme.example", company="Acme Again", name="Dan")  # the freed domain can start a new company
    assert org_row(sessions, "dan@acme.example").name == "Acme Again" and org_row(sessions, "dan@acme.example").id != org_row(sessions, ANA).id


def test_a_pending_or_rejected_company_can_be_deleted_too(companies, sessions):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana")
    signup(companies, email="bo@bo.example", company="Bo", name="Bo")
    companies.reject(ADMIN_SCOPE, str(org_row(sessions, "bo@bo.example").id), "no")
    for email in (ANA, "bo@bo.example"):
        companies.delete_company(ADMIN_SCOPE, str(org_row(sessions, email).id), "cleanup")
        assert org_row(sessions, email).status == "deleted"


def test_rejecting_releases_the_domain_and_applying_again_claims_it_unless_another_company_took_it(companies, sessions):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme", name="Ana")
    verify(sessions, ANA)
    ana = user_id(sessions, ANA)
    oid = str(org_row(sessions, ANA).id)
    companies.reject(ADMIN_SCOPE, oid, "no")
    assert companies.claimed_by("acme.example") is None
    companies.reapply(ana)
    assert companies.claimed_by("acme.example") == oid
    companies.reject(ADMIN_SCOPE, oid, "still no")
    signup(companies, email="bo@acme.example", company="Bo Acme", name="Bo")  # the domain is free: Bo's company claims it
    assert companies.claimed_by("acme.example") == str(org_row(sessions, "bo@acme.example").id)
    with pytest.raises(InvalidTransition) as e:
        companies.reapply(ana)
    assert e.value.state == "domain_claimed" and org_row(sessions, ANA).status == "rejected"


def test_an_admin_suspends_and_reinstates_a_recruiter_who_cannot_sign_in_meanwhile(companies, sessions, audit, clock):
    ana, bo, cy = two_colleagues(companies, sessions)
    for r in companies.join_requests(ana):
        if r.user_id == bo:
            companies.approve_join(ana, r.request_id)
    oid = str(org_row(sessions, ANA).id)
    with sessions.begin() as s:
        s.execute(update(User).where(User.id == bo).values(password_hash=security.hash_password(GOOD)))
    service = make_session_service(sessions, companies, clock)
    token = service.login(email=BO, password=GOOD).token
    assert service.resolve(token) is not None
    with pytest.raises(InvalidInput):
        companies.suspend_recruiter(ADMIN_SCOPE, oid, bo, "")
    companies.suspend_recruiter(ADMIN_SCOPE, oid, bo, "Policy breach under review")
    assert service.resolve(token) is None, "the session ended at once"
    with pytest.raises(InvalidCredentials):
        service.login(email=BO, password=GOOD)
    assert companies.standing(bo).state == "suspended"
    with pytest.raises(NotActiveRecruiter):
        companies.invite_company_of(bo)
    assert companies.standing(ana).state == "active", "only that recruiter is suspended"
    companies.reinstate_recruiter(ADMIN_SCOPE, oid, bo, "Cleared")
    assert service.login(email=BO, password=GOOD).token and companies.standing(bo).state == "active"
    assert [e[0] for e in entries(audit) if e[0].startswith("account.")] == ["account.suspended", "account.reinstated"]
    assert "breach" not in str(entries(audit)), "the reason text is not in the audit log"


def test_recruiter_controls_need_an_admin_a_member_of_that_company_and_a_live_state(companies, sessions):
    ana, bo, cy = two_colleagues(companies, sessions)
    oid = str(org_row(sessions, ANA).id)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    dee = user_id(sessions, "dee@other.example")
    with pytest.raises(NotAnAdmin):
        companies.suspend_recruiter(Scope(user_id=ana, roles=frozenset({Role.RECRUITER})), oid, ana, "x")
    with pytest.raises(CompanyNotFound):
        companies.suspend_recruiter(ADMIN_SCOPE, oid, dee, "x")  # Dee belongs to another company
    with pytest.raises(CompanyNotFound):
        companies.suspend_recruiter(ADMIN_SCOPE, oid, cy, "x")  # Cy only asked to join
    with pytest.raises(InvalidAccountState) as e:
        companies.reinstate_recruiter(ADMIN_SCOPE, oid, ana, "x")
    assert e.value.state == "active"
    companies.suspend_recruiter(ADMIN_SCOPE, oid, ana, "x")
    with pytest.raises(InvalidAccountState) as e2:
        companies.suspend_recruiter(ADMIN_SCOPE, oid, ana, "again")
    assert e2.value.state == "disabled"


def test_the_account_status_service_never_touches_an_admin_or_a_deleted_or_unknown_account(sessions, audit):
    from vulnmart.accounts.roles import RoleService

    add_admin(sessions)
    other = add_recruiter(sessions, "z@z.example", status="deleted")
    service = AccountStatusService(sessions, RoleService(sessions, audit), audit)
    with pytest.raises(NotAnAdmin):
        service.suspend(ADMIN_SCOPE, ADMIN, "an admin is not suspended here")
    for uid in (other, "u-NOBODYNOBODYNOBO"):
        with pytest.raises(UnknownUser):
            service.suspend(ADMIN_SCOPE, uid, "x")
    with sessions() as s:
        assert s.get(User, ADMIN).status == "active" and s.get(User, other).status == "deleted"
    assert audit.records == []


def test_suspending_a_recruiter_ends_every_session_row(companies, sessions, clock):
    ana, bo, cy = two_colleagues(companies, sessions)
    for r in companies.join_requests(ana):
        if r.user_id == bo:
            companies.approve_join(ana, r.request_id)
    service = make_session_service(sessions, companies, clock)
    for _ in range(3):
        service.open_session(bo, ip_trunc=None, ua_class=None, mfa=False)
    companies.suspend_recruiter(ADMIN_SCOPE, str(org_row(sessions, ANA).id), bo, "x")
    with sessions() as s:
        assert [r.revoked_at is not None for r in s.scalars(select(UserSession).where(UserSession.user_id == bo))] == [True, True, True]


def test_claims_have_one_company_per_domain_and_a_free_domain_has_none(companies, sessions):
    ana, _, _ = two_colleagues(companies, sessions)
    signup(companies, email="gus@gmail.com", company="Gus", name="Gus")
    with ContextScopePort().acting_as(Scope(user_id="system:test", roles=frozenset({Role.ADMIN}))):
        with sessions() as s:
            rows = sorted((o.name, o.domain_claim) for o in s.scalars(select(Organization)).all())
    assert rows == [("Acme", "acme.example"), ("Gus", None)]
    assert companies.claimed_by("ACME.example") == str(org_row(sessions, ANA).id), "domains compare in lower case"
    assert companies.claimed_by("gmail.com") is None and companies.claimed_by("nobody.example") is None
