"""Work package B: the routes that put company, colleague, admin and account services on IF-1, each through the real session, CSRF, role and rate-limit layers over the real
services on SQLite. One browser-free test per flow, with the negative cases: another company, a member who is not the owner, a learner, no session, no CSRF header.

Flows: the company side of candidate deletion requests (listCompanyDeletionRequests, decideDeletionRequest, deleteCandidateRecord), colleagues (listJoinRequests,
decideJoinRequest, listCompanyMembers, removeCompanyMember), the admin's company list, delete and invite cap (listCompanies, decideCompany "delete", setCompanyInviteCap), the
private cohort view (getCohort), the change of an account's address (requestEmailChange, confirmEmailChange) and the two size rules (break-glass reason, bulk invite body)."""
from __future__ import annotations

import re
from datetime import timedelta

import pytest
from sqlalchemy import select, update

import vulnmart.accounts.models  # noqa: F401
import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from support import ROOT, play  # noqa: F401
from test_assessments import ANA, KEYS, active_company, assessments, basic, mail_rows, token_in  # noqa: F401
from test_companies import ADMIN_SCOPE, GOOD, add_admin, audit, clock, companies, ended, entries, org_row, sessions, signup, user_id, verify  # noqa: F401
from test_company_members import BO, CY, two_colleagues
from test_consent import add_user, client, make_app
from test_deletion import CAND
from test_lab_runtime import make_runtime
from test_wp_b_mail_triggers import MailRig
from vulnmart.accounts import security
from vulnmart.accounts.directory import UserDirectory
from vulnmart.accounts.models import EmailChange, EmailToken, User, UserSession
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.self_service import SelfService
from vulnmart.admin.ops import AdminOps
from vulnmart.assessments.accept import InviteAcceptance
from vulnmart.notifications.models import EmailOutbox
from vulnmart.ports.fakes import FakeSettingsPort

DEE = "dee@other.example"
LEARNER_ID, LEARNER = "u-LEARNERLEARNERLE", "yara@example.org"
ROUTE_ADMIN, ROUTE_ADMIN_EMAIL = "u-ROUTEADMIN555555", "root@vulnmart.example"
NEW_ADDRESS = "yara.work@example.org"
ORIGIN = "https://vulnmart.example"


class World:
    """Ana's Acme (owner Ana, template T, a mail-sending deletion service), Dee's Other company, a learner, an admin, and the app with all of them."""

    def __init__(self, web, rig, companies, sessions, clock, audit, ended):
        self.web, self.rig, self.companies, self.sessions, self.clock, self.audit, self.ended = web, rig, companies, sessions, clock, audit, ended
        self.org = rig.org

    def as_user(self, email: str) -> dict[str, str]:
        self.web.cookies.clear()
        r = self.web.post("/api/v1/session", json={"email": email, "password": GOOD})
        assert r.status_code == 200, r.text
        return {"x-csrf-token": r.json()["csrf_token"]}

    def as_admin(self) -> dict[str, str]:
        csrf = self.as_user(ROUTE_ADMIN_EMAIL)
        with self.sessions.begin() as s:  # an admin session carries the admin role only after the second factor (FR-ACC-07)
            s.execute(update(UserSession).where(UserSession.user_id == ROUTE_ADMIN).values(mfa_at=self.clock.now))
        return csrf

    def outbox(self, template):
        with self.sessions() as s:
            return list(s.scalars(select(EmailOutbox).where(EmailOutbox.template == template).order_by(EmailOutbox.id)))


@pytest.fixture
def world(sessions, clock, companies, assessments, audit, ended):
    rig = MailRig(sessions, companies, assessments, audit, clock)
    app = make_app(sessions, clock, None)
    st = app.state
    st.companies, st.assessments, st.deletion_service = companies, assessments, rig.service
    st.session_service.set_org_resolver(companies.membership_of)
    st.invite_acceptance = InviteAcceptance(assessments, UserDirectory(sessions))
    st.self_service = SelfService(sessions, st.session_service, settings=FakeSettingsPort(), keys=KEYS, public_origin=ORIGIN, audit=audit, now=clock)
    st.admin_ops = AdminOps(sessions=sessions, roles=RoleService(sessions, audit), companies=companies, status=None, accounts=None, settings=None, quotas=None, audit=audit,
                            records=None, deletion=None, end_sessions=lambda uid: None, now=clock)
    signup(companies, email=DEE, company="Other", name="Dee Owner")
    verify(sessions, DEE)
    companies.approve(ADMIN_SCOPE, str(org_row(sessions, DEE).id))
    add_user(sessions, LEARNER_ID, LEARNER)
    with sessions.begin() as s:
        s.add(User(id=ROUTE_ADMIN, account_type="admin", email=ROUTE_ADMIN_EMAIL, email_ci=ROUTE_ADMIN_EMAIL, password_hash=security.hash_password(GOOD), display_name="Admin",
                   status="active", email_verified_at=clock.now))
    st.lab = make_runtime()[0]  # a real lab runtime on a fake host: the cohort route reads its engine
    with client(app) as c:
        yield World(c, rig, companies, sessions, clock, audit, ended)


def problem(r, status, code):
    assert (r.status_code, r.json().get("code")) == (status, code), r.text


# ---- the company side of deletion requests ----------------------------------------------------------------------------

def test_a_company_lists_decides_and_deletes_candidate_requests_over_http(world):
    rig = world.rig
    attempt, _ = rig.candidate_attempt()
    other, _ = rig.candidate_attempt(user="u-OTHERCANDIDATE22")
    first = rig.service.request_candidate(CAND, attempt)
    rig.service.request_candidate("u-OTHERCANDIDATE22", other)
    csrf = world.as_user(ANA)
    listed = world.web.get("/api/v1/company/deletion-requests")
    assert listed.status_code == 200 and listed.headers["cache-control"] == "private, no-store"
    items = {i["attempt_id"]: i for i in listed.json()["items"]}  # both asked in the same second: the order between them is the id's
    assert set(items) == {attempt, other}
    assert set(items[attempt]) == {"request_id", "attempt_id", "candidate_email", "status", "requested_at", "decide_by", "execute_after", "escalated"}
    assert items[attempt]["candidate_email"] == "c1@example.org" and items[attempt]["status"] == "pending" and items[attempt]["escalated"] is False
    approved = world.web.post(f"/api/v1/company/deletion-requests/{first.request_id}/decision", json={"decision": "approve"}, headers=csrf)
    assert approved.status_code == 200 and approved.json()["status"] == "approved" and approved.json()["execute_after"]
    problem(world.web.post(f"/api/v1/company/deletion-requests/{first.request_id}/decision", json={"decision": "decline"}, headers=csrf), 409, "ATT-INVALID-STATE")
    declined = world.web.post(f"/api/v1/company/deletion-requests/{items[other]['request_id']}/decision", json={"decision": "decline"}, headers=csrf)
    assert declined.json()["status"] == "declined"
    assert [i["status"] for i in world.web.get("/api/v1/company/deletion-requests").json()["items"]] == ["approved"]  # the declined one is no longer open
    assert len(world.web.get("/api/v1/company/deletion-requests?open_only=false").json()["items"]) == 2
    assert [a for a in entries(world.audit, "deletion.approved")] and [a for a in entries(world.audit, "deletion.declined")]
    # the company deletes the second record now, with no request
    gone = world.web.delete(f"/api/v1/company/attempts/{other}", headers=csrf)
    assert gone.status_code == 200 and gone.json() == {"attempt_id": other, "attempts_erased": 1}
    assert other in rig.eraser.calls and entries(world.audit, "deletion.company_deleted")
    problem(world.web.delete("/api/v1/company/attempts/a-NOSUCHATTEMPTAAA", headers=csrf), 404, "ATT-NOT-FOUND")  # no such record


def test_the_company_is_told_of_a_new_request_and_sees_when_it_was_escalated(world):
    rig = world.rig
    attempt, _ = rig.candidate_attempt()
    rig.service.request_candidate(CAND, attempt)
    assert [r.to_user_id for r in world.outbox("privacy.deletion_request_for_company")] == [rig.owner.user_id]
    world.as_user(ANA)
    assert world.web.get("/api/v1/company/deletion-requests").json()["items"][0]["escalated"] is False
    rig.run(days=15)
    assert world.web.get("/api/v1/company/deletion-requests").json()["items"][0]["escalated"] is True
    assert entries(world.audit, "deletion.escalated")


def test_another_company_cannot_use_my_deletion_requests_members_or_cohort(world):
    rig = world.rig
    attempt, _ = rig.candidate_attempt()
    req = rig.service.request_candidate(CAND, attempt)
    template = rig.template.template_id
    csrf = world.as_user(DEE)
    assert world.web.get("/api/v1/company/deletion-requests").json() == {"items": []}
    problem(world.web.post(f"/api/v1/company/deletion-requests/{req.request_id}/decision", json={"decision": "approve"}, headers=csrf), 404, "ATT-NOT-FOUND")
    problem(world.web.delete(f"/api/v1/company/attempts/{attempt}", headers=csrf), 404, "ATT-NOT-FOUND")
    problem(world.web.get(f"/api/v1/company/templates/{template}/cohort"), 404, "ATT-NOT-FOUND")
    assert rig.eraser.calls == [] and rig.row(req.request_id).status == "pending", "nothing of Ana's company moved"
    # Dee's colleague routes show only Dee's own company
    assert [m["role"] for m in world.web.get("/api/v1/company/members").json()["items"]] == ["owner"]
    problem(world.web.delete(f"/api/v1/company/members/{rig.owner.user_id}", headers=csrf), 404, "ATT-NOT-FOUND")


def test_the_deletion_routes_need_a_recruiter_a_csrf_header_and_an_active_company(world):
    rig = world.rig
    attempt, _ = rig.candidate_attempt()
    req = rig.service.request_candidate(CAND, attempt)
    url = f"/api/v1/company/deletion-requests/{req.request_id}/decision"
    problem(world.web.get("/api/v1/company/deletion-requests"), 401, "AUTH-SESSION-REQUIRED")
    csrf = world.as_user(LEARNER)
    for r in (world.web.get("/api/v1/company/deletion-requests"), world.web.post(url, json={"decision": "approve"}, headers=csrf),
              world.web.delete(f"/api/v1/company/attempts/{attempt}", headers=csrf)):
        problem(r, 404, "REQ-ROUTE-UNKNOWN")
    csrf = world.as_user(ANA)
    assert world.web.post(url, json={"decision": "approve"}).status_code == 403, "no CSRF header"
    assert world.web.delete(f"/api/v1/company/attempts/{attempt}").status_code == 403
    assert world.web.post(url, json={"decision": "maybe"}, headers=csrf).status_code == 422
    assert world.web.post("/api/v1/company/deletion-requests/not-an-id/decision", json={"decision": "approve"}, headers=csrf).status_code == 422
    admin_csrf = world.as_admin()
    problem(world.web.get("/api/v1/company/deletion-requests"), 404, "REQ-ROUTE-UNKNOWN")  # an admin is not a recruiter
    del admin_csrf
    world.companies.suspend(ADMIN_SCOPE, world.org, "audit")
    world.as_user(ANA)  # a suspended company's recruiter may still sign in, but cannot act
    problem(world.web.get("/api/v1/company/deletion-requests"), 409, "ATT-INVALID-STATE")


# ---- colleagues -------------------------------------------------------------------------------------------------------

def test_the_owner_approves_rejects_lists_and_removes_colleagues_over_http(world, sessions, companies):
    for email, name in ((BO, "Bo Colleague"), (CY, "Cy Colleague")):
        signup(companies, email=email, company="x", name=name)
        verify(sessions, email)
    csrf = world.as_user(ANA)
    requests = world.web.get("/api/v1/company/join-requests").json()["items"]
    assert sorted(r["display_name"] for r in requests) == ["Bo Colleague", "Cy Colleague"]
    assert set(requests[0]) == {"request_id", "display_name", "requested_at"}
    by_name = {r["display_name"]: r["request_id"] for r in requests}
    assert world.web.post(f"/api/v1/company/join-requests/{by_name['Bo Colleague']}/decision", json={"decision": "approve"}, headers=csrf).status_code == 204
    assert world.web.post(f"/api/v1/company/join-requests/{by_name['Cy Colleague']}/decision", json={"decision": "reject"}, headers=csrf).status_code == 204
    problem(world.web.post(f"/api/v1/company/join-requests/{by_name['Bo Colleague']}/decision", json={"decision": "reject"}, headers=csrf), 409, "ATT-INVALID-STATE")
    assert world.web.get("/api/v1/company/join-requests").json() == {"items": []}
    members = world.web.get("/api/v1/company/members").json()["items"]
    assert [(m["display_name"], m["role"]) for m in members] == [("Ana Owner", "owner"), ("Bo Colleague", "member")]
    assert entries(world.audit, "org.join_approved") and entries(world.audit, "org.join_rejected")
    bo = user_id(sessions, BO)
    assert world.web.delete(f"/api/v1/company/members/{bo}", headers=csrf).status_code == 204
    assert bo in world.ended and entries(world.audit, "org.member_removed")
    problem(world.web.delete(f"/api/v1/company/members/{bo}", headers=csrf), 404, "ATT-NOT-FOUND")
    problem(world.web.delete(f"/api/v1/company/members/{world.rig.owner.user_id}", headers=csrf), 409, "ATT-INVALID-STATE")  # the owner cannot remove themselves
    assert [m["role"] for m in world.web.get("/api/v1/company/members").json()["items"]] == ["owner"]


def test_only_the_owner_reaches_the_colleague_routes_and_another_companys_request_is_not_found(world, sessions, companies):
    signup(companies, email=BO, company="x", name="Bo Colleague")
    verify(sessions, BO)
    bo_request = None
    csrf = world.as_user(ANA)
    bo_request = world.web.get("/api/v1/company/join-requests").json()["items"][0]["request_id"]
    assert world.web.post(f"/api/v1/company/join-requests/{bo_request}/decision", json={"decision": "approve"}).status_code == 403, "no CSRF header"
    world.web.post(f"/api/v1/company/join-requests/{bo_request}/decision", json={"decision": "approve"}, headers=csrf)
    # Bo is a member now, not the owner: the colleague routes answer as for a route that does not exist
    csrf = world.as_user(BO)
    for r in (world.web.get("/api/v1/company/members"), world.web.get("/api/v1/company/join-requests"),
              world.web.delete(f"/api/v1/company/members/{world.rig.owner.user_id}", headers=csrf)):
        problem(r, 404, "REQ-ROUTE-UNKNOWN")
    # a learner and no session
    world.as_user(LEARNER)
    problem(world.web.get("/api/v1/company/members"), 404, "REQ-ROUTE-UNKNOWN")
    world.web.cookies.clear()
    problem(world.web.get("/api/v1/company/members"), 401, "AUTH-SESSION-REQUIRED")
    # Dee (another company's owner) cannot decide a request made to Acme
    signup(companies, email=CY, company="x", name="Cy Colleague")
    verify(sessions, CY)
    cy_request = next(r["request_id"] for r in (world.as_user(ANA) and world.web.get("/api/v1/company/join-requests").json()["items"]))
    csrf = world.as_user(DEE)
    problem(world.web.post(f"/api/v1/company/join-requests/{cy_request}/decision", json={"decision": "approve"}, headers=csrf), 404, "ATT-NOT-FOUND")
    assert world.web.get("/api/v1/company/join-requests").json() == {"items": []}
    assert world.web.post("/api/v1/company/join-requests/not-a-uuid/decision", json={"decision": "approve"}, headers=csrf).status_code == 422


# ---- the admin --------------------------------------------------------------------------------------------------------

def test_an_admin_lists_companies_with_status_sets_a_cap_and_deletes_a_company(world, sessions):
    csrf = world.as_admin()
    listed = world.web.get("/api/v1/admin/companies")
    assert listed.status_code == 200
    items = {i["name"]: i for i in listed.json()["items"]}
    assert set(items) == {"Acme", "Other"}
    assert set(items["Acme"]) == {"org_id", "name", "status", "owner_name", "owner_email_domain", "created_at", "members", "invite_cap", "invite_cap_override"}
    assert (items["Acme"]["status"], items["Acme"]["members"], items["Acme"]["invite_cap_override"]) == ("active", 1, None) and items["Acme"]["invite_cap"] > 0
    assert {i["name"] for i in world.web.get("/api/v1/admin/companies?status=active").json()["items"]} == {"Acme", "Other"}
    assert world.web.get("/api/v1/admin/companies?status=bogus").status_code == 422
    org = items["Acme"]["org_id"]
    capped = world.web.put(f"/api/v1/admin/companies/{org}/invite-cap", json={"invite_cap": 7}, headers=csrf)
    assert capped.status_code == 200 and (capped.json()["invite_cap"], capped.json()["invite_cap_override"]) == (7, 7)
    assert world.companies.invite_cap(org) == 7
    reset = world.web.put(f"/api/v1/admin/companies/{org}/invite-cap", json={"invite_cap": None}, headers=csrf)
    assert reset.json()["invite_cap_override"] is None and reset.json()["invite_cap"] == items["Acme"]["invite_cap"]
    for bad in (-1, 100_001, "7", 1.5):
        assert world.web.put(f"/api/v1/admin/companies/{org}/invite-cap", json={"invite_cap": bad}, headers=csrf).status_code == 422
    problem(world.web.put("/api/v1/admin/companies/00000000-0000-0000-0000-000000000009/invite-cap", json={"invite_cap": 3}, headers=csrf), 404, "REQ-ROUTE-UNKNOWN")
    assert entries(world.audit, "org.invite_cap_set") and entries(world.audit, "admin.companies_read")
    # delete: a reason is needed, the company ends, its recruiters lose access, a second delete is a conflict
    assert world.web.post(f"/api/v1/admin/companies/{org}/decision", json={"decision": "delete"}, headers=csrf).status_code == 422
    assert world.web.post(f"/api/v1/admin/companies/{org}/decision", json={"decision": "delete", "reason": "asked by the owner"}, headers=csrf).status_code == 204
    assert world.rig.owner.user_id in world.ended and entries(world.audit, "org.deleted")
    assert {i["name"]: i["status"] for i in world.web.get("/api/v1/admin/companies").json()["items"]}["Acme"] == "deleted"
    assert [i["name"] for i in world.web.get("/api/v1/admin/companies?status=deleted").json()["items"]] == ["Acme"]
    problem(world.web.post(f"/api/v1/admin/companies/{org}/decision", json={"decision": "delete", "reason": "again"}, headers=csrf), 409, "ATT-INVALID-STATE")


def test_the_admin_company_routes_answer_everyone_else_like_unknown_routes(world):
    org = world.org
    world.web.cookies.clear()
    problem(world.web.get("/api/v1/admin/companies"), 401, "AUTH-SESSION-REQUIRED")
    for email in (ANA, LEARNER):
        csrf = world.as_user(email)
        problem(world.web.get("/api/v1/admin/companies"), 404, "REQ-ROUTE-UNKNOWN")
        problem(world.web.put(f"/api/v1/admin/companies/{org}/invite-cap", json={"invite_cap": 1}, headers=csrf), 404, "REQ-ROUTE-UNKNOWN")
        problem(world.web.post(f"/api/v1/admin/companies/{org}/decision", json={"decision": "delete", "reason": "no"}, headers=csrf), 404, "REQ-ROUTE-UNKNOWN")
    assert world.companies.invite_cap(org) > 0 and org_row(world.sessions, ANA).status == "active"
    world.as_admin()
    assert world.web.put(f"/api/v1/admin/companies/{org}/invite-cap", json={"invite_cap": 1}, headers={"x-csrf-token": "wrong"}).status_code == 403


def test_the_break_glass_reason_has_the_same_bounds_in_the_route_the_service_and_the_contract(world):
    csrf = world.as_admin()
    attempt = "a-AAAAAAAAAAAAAAAA"
    for reason in ("", "too short", "x" * 19, "y" * 501):
        assert world.web.post("/api/v1/admin/break-glass", json={"attempt_id": attempt, "reason": reason}, headers=csrf).status_code == 422, len(reason)


# ---- the recruiter's invite size ----------------------------------------------------------------------------------------

def test_a_bulk_invite_of_five_hundred_long_addresses_is_not_refused_for_its_size(world):
    csrf = world.as_user(ANA)
    template = world.rig.template.template_id
    emails = [("a" * 60 + f"{i:04d}" + "@" + "d" * 180 + ".example") for i in range(500)]
    body_size = sum(len(e) + 4 for e in emails)
    assert body_size > 16 * 1024 and body_size < 192 * 1024
    r = world.web.post("/api/v1/company/invites", json={"template_id": template, "emails": emails}, headers=csrf)
    assert r.status_code == 201, r.text
    assert len(r.json()["skipped"]) + len(r.json()["created"]) + len(r.json()["remaining"]) == 500
    huge = world.web.post("/api/v1/company/invites", json={"template_id": template, "emails": ["z" * 250_000]}, headers=csrf)
    assert huge.status_code == 413
    assert world.web.post("/api/v1/company/invites", json={"template_id": template, "emails": [f"{i}@x.example" for i in range(501)]}, headers=csrf).status_code == 422


# ---- the cohort view --------------------------------------------------------------------------------------------------

def test_the_cohort_board_is_off_until_the_template_turns_it_on_and_then_ranks_only_this_company(world):
    rt = world.web.app.state.lab
    rig = world.rig
    template = rig.template.template_id

    class AsTemplate:
        """The lab runs every instance of this runtime from its one lab template; the board is asked for the company's assessment, whose attempts the engine keeps under the
        key of the invite's template (`<template>` or `<template>~n`). Here the attempts are made from the lab template, so the board is asked for that key."""

        def __init__(self, port, key):
            self.port, self.key = port, key

        def cohort(self, scope_org_id, assessment_org_id, assessment_id, enabled):
            assert assessment_id == template, "the route asks for the template of the URL"
            return self.port.cohort(scope_org_id, assessment_org_id, self.key, enabled)

    rt.cohort = AsTemplate(rt.cohort, rt.template_id)

    def finished(user, org, tpl, keys):
        started = rt.start_attempt(user, template_id=None, org_id=org)
        play(rt, started.instance_id)
        for key in keys:
            assert rt.submit_flag(started.attempt_id, key, rt.keys.flag(started.instance_id, key, 1)).result == "correct"
        rt.submit(started.attempt_id)
        return started.attempt_id

    low, high = finished("u-1", rig.org, template, ("C02",)), finished("u-2", rig.org, template, ("C02", "C01"))
    finished("u-3", "other-org", template, ("C02", "C01", "C05"))  # another company's attempt under the same template id never shows
    csrf = world.as_user(ANA)
    assert rig.template.template_id and world.web.get(f"/api/v1/company/templates/{template}").json()["cohort_board"] is False
    problem(world.web.get(f"/api/v1/company/templates/{template}/cohort"), 409, "ATT-INVALID-STATE")
    body = {**basic(title="T"), "cohort_board": True}
    updated = world.web.put(f"/api/v1/company/templates/{template}", json=body, headers=csrf)
    assert updated.status_code == 200 and updated.json()["cohort_board"] is True
    r = world.web.get(f"/api/v1/company/templates/{template}/cohort")
    assert r.status_code == 200 and r.headers["cache-control"] == "private, no-store"
    out = r.json()
    assert out["template_id"] == template and out["label"] == "ranking aid, the recruiter decides"
    assert [i["attempt_id"] for i in out["items"]] == [high, low] and [i["position"] for i in out["items"]] == [1, 2]
    assert set(out["items"][0]) == {"position", "attempt_id", "score", "full_captures", "hint_cost_units", "active_seconds", "last_capture_at", "reason"}
    assert out["items"][0]["score"] > out["items"][1]["score"]
    assert world.web.put(f"/api/v1/company/templates/{template}", json={**basic(), "cohort_board": "yes"}, headers=csrf).status_code == 422
    world.as_user(LEARNER)
    problem(world.web.get(f"/api/v1/company/templates/{template}/cohort"), 404, "REQ-ROUTE-UNKNOWN")


# ---- changing the address ---------------------------------------------------------------------------------------------

def link_token(row) -> str:
    return re.search(r"token=([A-Za-z0-9_-]{32,128})", row.params["link"]).group(1)


def test_a_learner_changes_the_address_with_a_link_to_the_new_one_and_can_then_accept_an_invite_made_for_it(world, sessions):
    rig = world.rig
    invite = world.rig.assessments.create_invite(rig.owner, rig.template.template_id, NEW_ADDRESS)
    token = token_in(mail_rows(sessions)[-1])
    csrf = world.as_user(LEARNER)
    wrong = world.web.post("/api/v1/invites/accept", json={"token": token}, headers=csrf)  # the invite is for another address: the answer points at the account's address
    problem(wrong, 409, "ATT-INVALID-STATE")
    assert wrong.json()["field"] == "/account/email" and NEW_ADDRESS not in wrong.text and "yara.work" not in wrong.text
    assert world.web.post("/api/v1/me/email", json={"new_email": NEW_ADDRESS, "current_password": "wrong password here"}, headers=csrf).status_code == 401
    assert world.web.post("/api/v1/me/email", json={"new_email": NEW_ADDRESS, "current_password": GOOD}).status_code == 403, "no CSRF header"
    r = world.web.post("/api/v1/me/email", json={"new_email": NEW_ADDRESS, "current_password": GOOD}, headers=csrf)
    assert r.status_code == 202 and r.json() == {"status": "accepted"}
    with sessions() as s:
        assert s.get(User, LEARNER_ID).email_ci == LEARNER, "nothing changed yet"
    [mail] = world.outbox("account.email_change")
    assert mail.to_user_id == LEARNER_ID and mail.to_address_sealed and "@" not in repr(mail.params) and mail.params["link"].startswith(ORIGIN + "/confirm-email-change?token=")
    token_new = link_token(mail)
    confirmed = world.web.post("/api/v1/accounts/confirm-email-change", json={"token": token_new})
    assert confirmed.status_code == 200 and confirmed.json() == {"status": "changed"}
    with sessions() as s:
        user = s.get(User, LEARNER_ID)
        assert (user.email_ci, user.email_verified_at is not None) == (NEW_ADDRESS, True)
        assert s.get(EmailChange, LEARNER_ID) is None
    problem(world.web.post("/api/v1/accounts/confirm-email-change", json={"token": token_new}), 400, "AUTH-TOKEN-INVALID")  # single use
    problem(world.web.get("/api/v1/session"), 401, "AUTH-SESSION-REQUIRED")  # every session ended
    [notice] = world.outbox("account.email_changed")
    assert notice.to_user_id == LEARNER_ID and notice.to_address_sealed, "the old address is told, sealed in the row"
    assert world.web.post("/api/v1/session", json={"email": LEARNER, "password": GOOD}).status_code == 401
    csrf = world.as_user(NEW_ADDRESS)
    accepted = world.web.post("/api/v1/invites/accept", json={"token": token}, headers=csrf)
    assert accepted.status_code == 200, accepted.text
    assert invite.invite_id and entries(world.audit, "account.email_changed") and entries(world.audit, "account.email_change_requested")


def test_an_unverified_account_is_told_to_verify_first_and_the_resend_route_answers(world, sessions, clock):
    rig = world.rig
    rig.assessments.create_invite(rig.owner, rig.template.template_id, LEARNER)
    token = token_in(mail_rows(sessions)[-1])
    csrf = world.as_user(LEARNER)  # a person cannot sign in unverified, so the session exists first and the address is unverified after it
    with sessions.begin() as s:
        s.execute(update(User).where(User.id == LEARNER_ID).values(email_verified_at=None))
    refused = world.web.post("/api/v1/invites/accept", json={"token": token}, headers=csrf)
    problem(refused, 403, "AUTH-EMAIL-NOT-VERIFIED")
    assert refused.json()["field"] == "/account/email"
    again = world.web.post("/api/v1/accounts/verify-email/resend", json={"email": LEARNER})
    assert again.status_code == 202, again.text

def test_the_change_of_address_refuses_the_same_address_a_taken_one_an_admin_and_a_replaced_or_late_link(world, sessions, clock):
    csrf = world.as_user(LEARNER)
    same = world.web.post("/api/v1/me/email", json={"new_email": LEARNER.upper(), "current_password": GOOD}, headers=csrf)
    assert same.status_code == 422
    assert world.web.post("/api/v1/me/email", json={"new_email": "not an address", "current_password": GOOD}, headers=csrf).status_code == 422
    # an address that has an account answers the same 202, tells that account, and makes no pending change
    taken = world.web.post("/api/v1/me/email", json={"new_email": ANA, "current_password": GOOD}, headers=csrf)
    assert taken.status_code == 202 and taken.json() == {"status": "accepted"}
    assert world.outbox("account.email_change") == [] and [r.to_user_id for r in world.outbox("account.already_registered")][-1:] == [world.rig.owner.user_id]
    # a second request replaces the first: the first link is dead
    world.web.post("/api/v1/me/email", json={"new_email": "first@example.org", "current_password": GOOD}, headers=csrf)
    world.web.post("/api/v1/me/email", json={"new_email": NEW_ADDRESS, "current_password": GOOD}, headers=csrf)
    first, second = [link_token(r) for r in world.outbox("account.email_change")]
    problem(world.web.post("/api/v1/accounts/confirm-email-change", json={"token": first}), 400, "AUTH-TOKEN-INVALID")
    # a link past its time does nothing
    clock.now += timedelta(hours=25)
    problem(world.web.post("/api/v1/accounts/confirm-email-change", json={"token": second}), 400, "AUTH-TOKEN-INVALID")
    with sessions() as s:
        assert s.get(User, LEARNER_ID).email_ci == LEARNER
    # an administrator does not change the address here
    clock.now -= timedelta(hours=25)
    csrf = world.as_admin()
    problem(world.web.post("/api/v1/me/email", json={"new_email": "admin2@example.org", "current_password": GOOD}, headers=csrf), 409, "ATT-INVALID-STATE")


def test_an_address_taken_after_the_request_and_old_reset_links_do_not_survive_the_change(world, sessions, clock):
    csrf = world.as_user(LEARNER)
    world.web.post("/api/v1/password-reset/request", json={"email": LEARNER})
    reset = next(r for r in world.outbox("account.password_reset"))
    world.web.post("/api/v1/me/email", json={"new_email": NEW_ADDRESS, "current_password": GOOD}, headers=csrf)
    token = link_token(world.outbox("account.email_change")[0])
    assert world.web.post("/api/v1/accounts/confirm-email-change", json={"token": token}).status_code == 200
    reset_token = link_token(reset)
    r = world.web.post("/api/v1/password-reset/confirm", json={"token": reset_token, "new_password": "another long passphrase 42"})
    assert r.status_code == 400, "a reset link made for the old address is dead"
    with sessions() as s:
        assert s.scalar(select(EmailToken.used_at).where(EmailToken.user_id == LEARNER_ID, EmailToken.purpose == "reset")) is not None
    # a request whose address another account takes before the link is used
    csrf = world.as_user(NEW_ADDRESS)
    world.web.post("/api/v1/me/email", json={"new_email": "third@example.org", "current_password": GOOD}, headers=csrf)
    token = link_token(world.outbox("account.email_change")[-1])
    add_user(sessions, "u-SOMEONEELSE22222", "third@example.org")
    problem(world.web.post("/api/v1/accounts/confirm-email-change", json={"token": token}), 400, "AUTH-TOKEN-INVALID")
    with sessions() as s:
        assert s.get(User, LEARNER_ID).email_ci == NEW_ADDRESS


def test_a_recruiter_cannot_move_to_a_disposable_address_and_the_route_needs_a_session(world):
    csrf = world.as_user(ANA)
    r = world.web.post("/api/v1/me/email", json={"new_email": "someone@mailinator.com", "current_password": GOOD}, headers=csrf)
    assert r.status_code == 422, r.text
    world.web.cookies.clear()
    problem(world.web.post("/api/v1/me/email", json={"new_email": NEW_ADDRESS, "current_password": GOOD}, headers=csrf), 401, "AUTH-SESSION-REQUIRED")
