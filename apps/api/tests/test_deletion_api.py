"""Story P-25: the routes of IF-1 for deletion requests and the view history (createDeletionRequest, listMyDeletionRequests, cancelDeletionRequest, listMyDataViews), through the
real session, CSRF and rate-limit layers on SQLite. The service itself is tested in test_deletion.py."""
from __future__ import annotations

import pytest

import vulnmart.lab.models  # noqa: F401
from test_consent import ALICE, BOB, T0, add_user, audit, client, clock, make_app, service, sessions, sign_in, targets  # noqa: F401
from vulnmart.accounts.models import UserRole
from vulnmart.lab.models import Attempt
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.privacy.deletion import DeletionService
from vulnmart.privacy.retention.records import SqlAttemptRecords
from vulnmart.privacy.views import ViewHistory

AT_MINE, AT_THEIRS, AT_RUNNING = "a-MINEMINEMINEMINE"[:18], "a-THEIRSTHEIRSTHEI"[:18], "a-RUNNINGRUNNINGRU"[:18]
ORG = "00000000-0000-0000-0000-0000000000aa"


class Eraser:
    def __init__(self):
        self.calls = []

    def __call__(self, attempt_id):
        self.calls.append(attempt_id)


@pytest.fixture
def web(sessions, clock, service, audit):
    add_user(sessions, ALICE, "alice@example.com")
    add_user(sessions, BOB, "bob@example.com")
    with sessions.begin() as s:
        s.add(UserRole(user_id=ALICE, role="learner", account_type="participant"))
        s.add(Attempt(id=AT_MINE, user_id=ALICE, template_id="t1", org_id=ORG, state="submitted", version=0, record={"submitted_at": T0.isoformat()}))
        s.add(Attempt(id=AT_THEIRS, user_id=BOB, template_id="t1", org_id=ORG, state="submitted", version=0, record={"submitted_at": T0.isoformat()}))
        s.add(Attempt(id=AT_RUNNING, user_id=ALICE, template_id="t2", org_id=ORG, state="running", version=0, record={}))
    app = make_app(sessions, clock, service)
    app.state.deletion_service = DeletionService(sessions, None, SqlAttemptRecords(sessions), FakeSettingsPort(), audit, None, Eraser(), now=clock)
    app.state.view_history = ViewHistory(sessions, now=clock)
    with client(app) as c:
        c.app_state = app.state
        yield c


def test_the_routes_need_a_session(web):
    web.cookies.clear()
    for r in (web.get("/api/v1/me/deletion-requests"), web.get("/api/v1/me/data-views"), web.post("/api/v1/me/deletion-requests", json={"kind": "learner"}),
              web.delete("/api/v1/me/deletion-requests/d-AAAAAAAAAAAAAAAA")):
        assert r.status_code == 401 and r.json()["code"] == "AUTH-SESSION-REQUIRED"


def test_the_two_state_changing_routes_need_the_csrf_header(web):
    sign_in(web)
    assert web.post("/api/v1/me/deletion-requests", json={"kind": "learner"}).status_code == 403
    assert web.delete("/api/v1/me/deletion-requests/d-AAAAAAAAAAAAAAAA").status_code == 403


def test_a_learner_asks_lists_and_undoes_over_http(web):
    csrf = sign_in(web)
    created = web.post("/api/v1/me/deletion-requests", json={"kind": "learner"}, headers=csrf)
    body = created.json()
    assert created.status_code == 201 and created.headers["cache-control"] == "private, no-store"
    assert set(body) == {"request_id", "kind", "status", "requested_at", "attempt_id", "company_name", "decide_by", "decided_at", "execute_after", "finished_at", "can_undo"}
    assert (body["kind"], body["status"], body["can_undo"], body["attempt_id"]) == ("learner", "pending", True, None)
    assert body["requested_at"] == "2026-10-18T10:00:07Z" and body["execute_after"] == "2026-10-25T10:00:07Z"
    assert web.get("/api/v1/me/deletion-requests").json() == {"items": [body]}
    undone = web.delete(f"/api/v1/me/deletion-requests/{body['request_id']}", headers=csrf)
    assert undone.status_code == 200 and undone.json()["status"] == "cancelled" and undone.json()["can_undo"] is False
    again = web.delete(f"/api/v1/me/deletion-requests/{body['request_id']}", headers=csrf)
    assert (again.status_code, again.json()["code"]) == (409, "ATT-INVALID-STATE")


def test_a_second_open_request_is_409(web):
    csrf = sign_in(web)
    assert web.post("/api/v1/me/deletion-requests", json={"kind": "learner"}, headers=csrf).status_code == 201
    r = web.post("/api/v1/me/deletion-requests", json={"kind": "learner"}, headers=csrf)
    assert (r.status_code, r.json()["code"]) == (409, "ATT-INVALID-STATE")


def test_a_candidate_request_goes_to_the_company_and_is_listed_with_its_deadline(web):
    csrf = sign_in(web)
    r = web.post("/api/v1/me/deletion-requests", json={"kind": "candidate", "attempt_id": AT_MINE}, headers=csrf)
    body = r.json()
    assert r.status_code == 201 and (body["kind"], body["status"], body["attempt_id"]) == ("candidate", "pending", AT_MINE)
    assert body["decide_by"] == "2026-11-01T10:00:07Z" and body["execute_after"] is None


def test_someone_elses_attempt_is_404_and_one_that_is_not_over_is_409(web):
    csrf = sign_in(web)
    other = web.post("/api/v1/me/deletion-requests", json={"kind": "candidate", "attempt_id": AT_THEIRS}, headers=csrf)
    assert (other.status_code, other.json()["code"]) == (404, "ATT-NOT-FOUND")
    going = web.post("/api/v1/me/deletion-requests", json={"kind": "candidate", "attempt_id": AT_RUNNING}, headers=csrf)
    assert (going.status_code, going.json()["code"]) == (409, "ATT-INVALID-STATE")


def test_someone_elses_request_cannot_be_undone_or_listed(web):
    csrf = sign_in(web)
    mine = web.post("/api/v1/me/deletion-requests", json={"kind": "learner"}, headers=csrf).json()
    web.cookies.clear()
    bob_csrf = sign_in(web, "bob@example.com")
    r = web.delete(f"/api/v1/me/deletion-requests/{mine['request_id']}", headers=bob_csrf)
    assert (r.status_code, r.json()["code"]) == (404, "ATT-NOT-FOUND")
    assert web.get("/api/v1/me/deletion-requests").json() == {"items": []}


@pytest.mark.parametrize("body", [
    {"kind": "candidate"}, {"kind": "learner", "attempt_id": AT_MINE}, {"kind": "other"}, {}, {"kind": "learner", "extra": 1}, {"kind": "candidate", "attempt_id": "nope"},
])
def test_a_body_that_does_not_fit_is_422(web, body):
    csrf = sign_in(web)
    r = web.post("/api/v1/me/deletion-requests", json=body, headers=csrf)
    assert r.status_code == 422 and r.json()["code"] == "REQ-VALIDATION"


def test_a_malformed_request_id_is_422(web):
    csrf = sign_in(web)
    r = web.delete("/api/v1/me/deletion-requests/not-an-id", headers=csrf)
    assert r.status_code == 422 and r.json()["code"] == "REQ-VALIDATION"


def test_the_requests_are_limited_per_account(web):
    csrf = sign_in(web)
    codes = []
    for _ in range(12):
        made = web.post("/api/v1/me/deletion-requests", json={"kind": "learner"}, headers=csrf)
        codes.append(made.status_code)
        if made.status_code == 201:
            web.delete(f"/api/v1/me/deletion-requests/{made.json()['request_id']}", headers=csrf)
    assert 429 in codes and codes[0] == 201


def test_who_viewed_me_is_company_action_and_time_and_only_mine(web):
    views = web.app.state.view_history
    views.record(candidate_user_id=ALICE, org_id=ORG, org_name="Acme Security Ltd", action="viewed")
    views.record(candidate_user_id=BOB, org_id=ORG, org_name="Not For Alice", action="viewed")
    sign_in(web)
    r = web.get("/api/v1/me/data-views")
    assert r.status_code == 200 and r.headers["cache-control"] == "private, no-store"
    assert r.json() == {"items": [{"company_name": "Acme Security Ltd", "action": "viewed", "at": "2026-10-18T10:00:07Z"}], "has_more": False}
