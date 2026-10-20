"""Story P-27: the recruiter's routes of IF-1 (signupRecruiter, getMyCompany, reapplyCompany, the terms, the templates, the invites) through the real session, CSRF and
rate-limit layers, over the services of P-18 to P-21 on SQLite. The services themselves are tested in test_companies.py and test_assessments.py."""
from __future__ import annotations

import pytest
from sqlalchemy import select

import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
from test_assessments import ANA, CAND, active_company, assessments, basic, mail_rows  # noqa: F401
from test_companies import ADMIN_SCOPE, GOOD, add_admin, audit, clock, companies, ended, org_row, sessions, signup, user_id, verify  # noqa: F401
from test_consent import add_user, client, make_app, sign_in
from vulnmart.accounts.models import User

OTHER_OWNER = "olga@globex.example"
LEARNER_ID = "u-LEARNERLEARNERLE"


@pytest.fixture
def web(sessions, clock, companies, assessments):
    app = make_app(sessions, clock, None)
    app.state.companies, app.state.assessments = companies, assessments
    app.state.session_service.set_org_resolver(companies.membership_of)  # as main.py does: a recruiter acts for their company
    with client(app) as c:
        yield c


def login(web, email):
    r = web.post("/api/v1/session", json={"email": email, "password": GOOD})
    assert r.status_code == 200, r.text
    return {"x-csrf-token": r.json()["csrf_token"]}


def test_recruiter_signup_needs_no_session_and_answers_202_for_a_new_and_a_known_address(web, sessions):
    body = {"email": "rita@initech.example", "password": GOOD, "display_name": "Rita", "company_name": "Initech"}
    first = web.post("/api/v1/recruiters", json=body)
    again = web.post("/api/v1/recruiters", json=body)
    assert (first.status_code, again.status_code) == (202, 202) and first.json() == again.json() == {"status": "accepted"}
    with sessions() as s:
        assert s.scalar(select(User.account_type).where(User.email_ci == "rita@initech.example")) == "recruiter"
    assert org_row(sessions, "rita@initech.example").status == "pending"
    bad = web.post("/api/v1/recruiters", json={**body, "company_name": ""})
    assert bad.status_code == 422


def test_a_pending_company_sees_its_standing_and_cannot_make_templates(web, companies, sessions):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme")
    verify(sessions, ANA)
    csrf = login(web, ANA)
    standing = web.get("/api/v1/company").json()
    assert standing == {"state": "pending_approval", "company_name": "Acme", "reason": None, "terms_accepted": False, "role": "owner"}
    r = web.post("/api/v1/company/templates", json=basic(), headers=csrf)
    assert (r.status_code, r.json()["code"]) == (409, "ATT-INVALID-STATE")


def test_a_rejected_owner_reapplies(web, companies, sessions):
    add_admin(sessions)
    signup(companies, email=ANA, company="Acme")
    verify(sessions, ANA)
    companies.reject(ADMIN_SCOPE, str(org_row(sessions, ANA).id), "not a company")
    csrf = login(web, ANA)
    assert web.get("/api/v1/company").json()["state"] == "rejected"
    assert web.post("/api/v1/company/reapply", headers=csrf).status_code == 204
    assert web.get("/api/v1/company").json()["state"] == "pending_approval"


def test_the_owner_reads_and_accepts_the_terms_then_invites(web, companies, sessions):
    active_company(companies, sessions, terms=False)
    csrf = login(web, ANA)
    template = web.post("/api/v1/company/templates", json=basic(), headers=csrf)
    assert template.status_code == 201, template.text
    tid = template.json()["template_id"]
    before = web.post("/api/v1/company/invites", json={"template_id": tid, "emails": [CAND]}, headers=csrf)
    assert (before.status_code, before.json()["code"]) == (409, "ATT-INVALID-STATE"), "no invite before the terms (FR-ORG-07)"
    terms = web.get("/api/v1/company/terms").json()
    assert set(terms) == {"version", "text", "sha256"} and "Acme" in terms["text"]
    stale = web.post("/api/v1/company/terms", json={"version": terms["version"], "sha256": "0" * 64}, headers=csrf)
    assert (stale.status_code, stale.json()["code"]) == (409, "ATT-CONSENT-STALE")
    assert web.post("/api/v1/company/terms", json={"version": terms["version"], "sha256": terms["sha256"]}, headers=csrf).status_code == 204
    assert web.get("/api/v1/company").json()["terms_accepted"] is True
    made = web.post("/api/v1/company/invites", json={"template_id": tid, "emails": [CAND]}, headers=csrf)
    assert made.status_code == 201
    created = made.json()["created"]
    assert [i["email"] for i in created] == [CAND] and created[0]["state"] == "created" and created[0]["invite_id"].startswith("i-")
    assert mail_rows(sessions), "the invite mail is queued"


def test_templates_list_get_replace_and_delete(web, companies, sessions):
    active_company(companies, sessions)
    csrf = login(web, ANA)
    tid = web.post("/api/v1/company/templates", json=basic(hints_mode="on", hint_cost_pct=10), headers=csrf).json()["template_id"]
    listed = web.get("/api/v1/company/templates").json()["items"]
    assert [t["template_id"] for t in listed] == [tid] and listed[0]["hints_mode"] == "on" and listed[0]["hint_cost_pct"] == 10
    replaced = web.put(f"/api/v1/company/templates/{tid}", json=basic(title="Renamed"), headers=csrf)
    assert replaced.status_code == 200 and replaced.json()["title"] == "Renamed" and replaced.json()["version"] == 2
    assert web.get(f"/api/v1/company/templates/{tid}").json()["title"] == "Renamed"
    bad = web.post("/api/v1/company/templates", json=basic(time_limit_min=5), headers=csrf)
    assert bad.status_code == 422
    assert web.delete(f"/api/v1/company/templates/{tid}", headers=csrf).status_code == 204
    gone = web.get(f"/api/v1/company/templates/{tid}")
    assert (gone.status_code, gone.json()["code"]) == (404, "ATT-NOT-FOUND")


def test_bulk_invites_answer_address_by_address_and_invite_actions_work(web, companies, sessions):
    active_company(companies, sessions)
    csrf = login(web, ANA)
    tid = web.post("/api/v1/company/templates", json=basic(), headers=csrf).json()["template_id"]
    bulk = web.post("/api/v1/company/invites", json={"template_id": tid, "emails": [CAND, "not-an-address", CAND]}, headers=csrf).json()
    assert [i["email"] for i in bulk["created"]] == [CAND]
    assert {(s["email"], s["reason"]) for s in bulk["skipped"]} == {("not-an-address", "invalid"), (CAND, "duplicate")}
    invite_id = bulk["created"][0]["invite_id"]
    again = web.post("/api/v1/company/invites", json={"template_id": tid, "emails": [CAND]}, headers=csrf)
    assert (again.status_code, again.json()["code"]) == (409, "ATT-INVALID-STATE"), "a live invite exists"
    listed = web.get("/api/v1/company/invites").json()["items"]
    assert [i["invite_id"] for i in listed] == [invite_id]
    cancelled = web.post(f"/api/v1/company/invites/{invite_id}/actions", json={"action": "cancel"}, headers=csrf)
    assert cancelled.status_code == 200 and cancelled.json()["state"] == "cancelled"
    twice = web.post(f"/api/v1/company/invites/{invite_id}/actions", json={"action": "cancel"}, headers=csrf)
    assert (twice.status_code, twice.json()["code"]) == (409, "ATT-INVALID-STATE")
    assert web.get("/api/v1/company/invites", params={"state": "cancelled"}).json()["items"][0]["invite_id"] == invite_id


def test_another_company_sees_none_of_it(web, companies, sessions):
    active_company(companies, sessions)
    csrf = login(web, ANA)
    tid = web.post("/api/v1/company/templates", json=basic(), headers=csrf).json()["template_id"]
    invite_id = web.post("/api/v1/company/invites", json={"template_id": tid, "emails": [CAND]}, headers=csrf).json()["created"][0]["invite_id"]
    web.cookies.clear()
    # a second company, approved by the same admin
    signup(companies, email=OTHER_OWNER, company="Globex")
    verify(sessions, OTHER_OWNER)
    companies.approve(ADMIN_SCOPE, str(org_row(sessions, OTHER_OWNER).id))
    theirs = login(web, OTHER_OWNER)
    assert web.get("/api/v1/company/templates").json() == {"items": []}
    assert web.get("/api/v1/company/invites").json() == {"items": []}
    for r in (web.get(f"/api/v1/company/templates/{tid}"), web.post(f"/api/v1/company/invites/{invite_id}/actions", json={"action": "cancel"}, headers=theirs),
              web.delete(f"/api/v1/company/templates/{tid}", headers=theirs)):
        assert r.status_code in (404, 409), r.text
        assert r.json()["code"] in ("ATT-NOT-FOUND", "ATT-INVALID-STATE")
    assert web.get("/api/v1/company").json()["company_name"] == "Globex"


def test_a_learner_finds_no_company_routes(web, sessions):
    add_user(sessions, LEARNER_ID, "lena@example.org")
    csrf = sign_in(web, "lena@example.org")
    for r in (web.get("/api/v1/company"), web.get("/api/v1/company/templates"), web.get("/api/v1/company/invites"), web.get("/api/v1/company/terms"),
              web.post("/api/v1/company/templates", json=basic(), headers=csrf)):
        assert (r.status_code, r.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")


def test_a_member_who_is_not_the_owner_cannot_read_the_terms(web, companies, sessions):
    active_company(companies, sessions)
    signup(companies, email="mo@acme.example", company="ignored", name="Mo Member")  # same domain: a request to join Acme
    verify(sessions, "mo@acme.example")
    owner = user_id(sessions, ANA)
    request_id = companies.join_requests(owner)[0].request_id
    companies.approve_join(owner, request_id)
    login(web, "mo@acme.example")
    assert web.get("/api/v1/company").json()["role"] == "member"
    r = web.get("/api/v1/company/terms")
    assert (r.status_code, r.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")
    assert web.get("/api/v1/company/templates").status_code == 200, "a member works with the company's templates"


def test_the_routes_need_a_session_and_the_changes_need_csrf(web, companies, sessions):
    active_company(companies, sessions)
    web.cookies.clear()
    for r in (web.get("/api/v1/company"), web.get("/api/v1/company/invites")):
        assert r.status_code == 401
    login(web, ANA)
    assert web.post("/api/v1/company/templates", json=basic()).status_code == 403
