"""Story P-26: the candidate's invite routes of IF-1 (openInvite, acceptInvite, listMyInvites) through the real session, CSRF and rate-limit layers, over story P-21's service on
SQLite with the real attempt engine behind the lab port. The service itself is tested in test_invite_acceptance.py."""
from __future__ import annotations

import pytest

import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
from test_assessments import CAND, active_company, assessments, basic, mail_rows, token_in  # noqa: F401
from test_companies import audit, clock, companies, ended, sessions  # noqa: F401
from test_consent import add_user, client, make_app, sign_in
from test_invite_acceptance import Rig

CAND_ID, OTHER_ID = "u-CANDCANDCANDCAND", "u-OTHEROTHEROTHERO"
OTHER = "other@example.org"


@pytest.fixture
def rig(sessions, companies, assessments, audit, clock):
    return Rig(sessions, companies, assessments, audit, clock)


@pytest.fixture
def web(rig, sessions, clock):
    add_user(sessions, CAND_ID, CAND)
    add_user(sessions, OTHER_ID, OTHER)
    app = make_app(sessions, clock, rig.consent)
    app.state.assessments, app.state.invite_acceptance = rig.assessments, rig.accept
    with client(app) as c:
        yield c


def test_opening_a_link_needs_no_session_and_says_what_the_assessment_is_but_not_the_address(web, rig):
    _, token = rig.invite()
    web.cookies.clear()
    r = web.post("/api/v1/invites/open", json={"token": token})
    assert r.status_code == 200 and r.headers["cache-control"] == "private, no-store"
    body = r.json()
    assert set(body) == {"state", "company_name", "title", "expires_at", "time_limit_min", "challenge_count", "hints_mode", "hint_cost_pct", "writeup_required",
                         "results_visibility"}
    assert body["state"] == "opened" and body["title"] == rig.template.title and body["company_name"]
    assert body["hints_mode"] == rig.template.hints_mode and body["results_visibility"] == "after_submit"
    assert CAND not in r.text


@pytest.mark.parametrize("token", ["nope", "x" * 200])
def test_a_link_that_opens_nothing_is_400_token_invalid(web, token):
    r = web.post("/api/v1/invites/open", json={"token": token})
    assert (r.status_code, r.json()["code"]) == (400, "AUTH-TOKEN-INVALID")


def test_accepting_needs_a_session_and_the_csrf_header(web, rig):
    _, token = rig.invite()
    web.cookies.clear()
    assert web.post("/api/v1/invites/accept", json={"token": token}).status_code == 401
    sign_in(web, CAND)
    assert web.post("/api/v1/invites/accept", json={"token": token}).status_code == 403


def test_the_candidate_accepts_consents_and_sees_only_their_own_invites(web, rig):
    _, token = rig.invite()
    csrf = sign_in(web, CAND)
    r = web.post("/api/v1/invites/accept", json={"token": token}, headers=csrf)
    assert r.status_code == 200, r.text
    accepted = r.json()
    assert accepted["attempt_id"].startswith("a-") and accepted["state"] == "opened"
    assert web.post("/api/v1/invites/accept", json={"token": token}, headers=csrf).json()["attempt_id"] == accepted["attempt_id"], "repeating is the same attempt"
    # the consent screen of story P-16 is for that attempt
    notice = web.get("/api/v1/consent/notice", params={"attempt_id": accepted["attempt_id"]})
    assert notice.status_code == 200 and notice.json()["company_name"] == accepted["company_name"]
    mine = web.get("/api/v1/me/invites").json()["items"]
    assert [i["attempt_id"] for i in mine] == [accepted["attempt_id"]]
    # another account sees none of it
    web.cookies.clear()
    sign_in(web, OTHER)
    assert web.get("/api/v1/me/invites").json() == {"items": []}


def test_another_account_cannot_accept_and_the_answer_does_not_say_whose_invite_it_is(web, rig):
    _, token = rig.invite()
    csrf = sign_in(web, OTHER)
    r = web.post("/api/v1/invites/accept", json={"token": token}, headers=csrf)
    assert (r.status_code, r.json()["code"]) == (409, "ATT-INVALID-STATE")
    assert CAND not in r.text


def test_a_cancelled_invite_opens_as_closed_and_cannot_be_accepted(web, rig):
    view, token = rig.invite()
    rig.assessments.cancel(rig.owner, view.invite_id)
    assert web.post("/api/v1/invites/open", json={"token": token}).json()["state"] == "cancelled"
    csrf = sign_in(web, CAND)
    r = web.post("/api/v1/invites/accept", json={"token": token}, headers=csrf)
    assert (r.status_code, r.json()["code"]) == (409, "ATT-INVALID-STATE")


def test_my_invites_needs_a_session(web):
    web.cookies.clear()
    r = web.get("/api/v1/me/invites")
    assert (r.status_code, r.json()["code"]) == (401, "AUTH-SESSION-REQUIRED")


def test_opening_links_is_rate_limited_per_visitor(web, rig):
    rig_limit = int(web.app.state.ports.settings.get("rate_verify_per_ip_per_hour"))
    codes = [web.post("/api/v1/invites/open", json={"token": "nope"}).status_code for _ in range(rig_limit + 1)]
    assert codes[-1] == 429 and set(codes[:-1]) == {400}
