"""Story P-28: the admin routes of IF-1 through the real session, role, CSRF and origin layers on SQLite. The operations themselves are tested in test_admin_ops.py; the company
service is a recording stand-in here (its rules are tested in test_companies.py)."""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import update

import vulnmart.lab.models  # noqa: F401
import vulnmart.live.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from test_session_api import EMAIL, ORIGIN, PASSWORD, T0, Clock, add_user, client, log_in, make_app, sessions  # noqa: F401 - fixtures
from vulnmart.accounts.http import timestamp
from vulnmart.accounts.models import UserRole, UserSession
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.status import AccountStatusService
from vulnmart.admin.ops import AdminOps
from vulnmart.kernel.quota import DbQuotaPort
from vulnmart.lab.models import Attempt
from vulnmart.orgs.service import CompanyNotFound, InvalidTransition, PendingCompany
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.privacy.deletion import DeletionService
from vulnmart.privacy.retention.records import SqlAttemptRecords
from vulnmart.privacy.subjects import SubjectService

ADMIN_ID, ADMIN_EMAIL = "u-ADMINROUTES22222", "admin@example.com"
LEARNER_ID, LEARNER_EMAIL = "u-AAAAAAAAAAAAAAAA", EMAIL
OTHER_ID, OTHER_EMAIL = "u-BBBBBBBBBBBBBBBB", "other@example.com"
ORG = "6f1c8f0e-0a5e-4a1c-9d5a-3f2d6a8b9c01"
ATTEMPT = "a-PRACTICEONE22222"


class Companies:
    """What the routes need of the company service: the queue and the decisions."""

    def __init__(self):
        self.decided = []

    def pending(self, actor, *, limit=100):
        return [PendingCompany(ORG, "Acme Security Ltd", "Ana Owner", "acme.example", T0)]

    def _decide(self, name, actor, org_id, reason=None):
        if org_id != ORG:
            raise CompanyNotFound
        if self.decided:
            raise InvalidTransition("active")
        self.decided.append((name, org_id, reason))

    def approve(self, actor, org_id):
        self._decide("approve", actor, org_id)

    def reject(self, actor, org_id, reason):
        self._decide("reject", actor, org_id, reason)

    def suspend(self, actor, org_id, reason):
        self._decide("suspend", actor, org_id, reason)

    def reinstate(self, actor, org_id, reason):
        self._decide("reinstate", actor, org_id, reason)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def web(sessions, clock):
    add_user(sessions, ADMIN_ID, ADMIN_EMAIL, account_type="admin")
    add_user(sessions, LEARNER_ID, LEARNER_EMAIL)
    add_user(sessions, OTHER_ID, OTHER_EMAIL)
    app = make_app(sessions, clock)
    settings, audit = FakeSettingsPort(), FakeAuditPort()
    roles = RoleService(sessions, audit)
    stopped = []
    app.state.companies_stub = Companies()
    app.state.admin_ops = AdminOps(
        sessions=sessions, roles=roles, companies=app.state.companies_stub, status=AccountStatusService(sessions, roles, audit),
        accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock), settings=settings, quotas=DbQuotaPort(sessions, settings), audit=audit,
        records=SqlAttemptRecords(sessions), deletion=DeletionService(sessions, None, SqlAttemptRecords(sessions), settings, audit, SubjectService(sessions), lambda a: None, now=clock),
        end_sessions=lambda uid: None, stopper=lambda attempt_id: stopped.append(attempt_id) or "inst-1",
        host_status=lambda: SimpleNamespace(capacity_memory_mb=4096, used_memory_mb=1024, instances=2, health=SimpleNamespace(value="ok")),
        instance_states=lambda: {"i1": "ready"},
        job_status=lambda: [SimpleNamespace(name="log_purge", interval=timedelta(days=1), last_started_at=T0, last_finished_at=T0, last_status="succeeded", last_detail="0 purged",
                                            last_success_at=T0, next_due_at=T0 + timedelta(days=1))], now=clock)
    app.state.audit_stub, app.state.stopped = audit, stopped
    with client(app) as c:
        yield c


def sign_in_admin(web, sessions, email=ADMIN_EMAIL, *, second_factor=True):
    r = log_in(web, email)
    assert r.status_code == 200, r.text
    if second_factor:  # an admin session carries the admin role only after the second factor (FR-ACC-07)
        with sessions.begin() as s:
            s.execute(update(UserSession).values(mfa_at=T0))
    return {"x-csrf-token": r.json()["csrf_token"]}


CALLS = [
    ("GET", "/api/v1/admin/companies/pending", None),
    ("POST", f"/api/v1/admin/companies/{ORG}/decision", {"decision": "approve"}),
    ("GET", "/api/v1/admin/users", None),
    ("POST", f"/api/v1/admin/users/{LEARNER_ID}/actions", {"action": "lock", "reason": "x"}),
    ("POST", f"/api/v1/admin/attempts/{ATTEMPT}/force-stop", None),
    ("GET", "/api/v1/admin/settings", None),
    ("PUT", "/api/v1/admin/settings/email_daily_cap", {"value": 5}),
    ("DELETE", "/api/v1/admin/settings/email_daily_cap", None),
    ("GET", "/api/v1/admin/quotas", None),
    ("PUT", "/api/v1/admin/quotas", {"scope": "global", "scope_id": None, "max_instances": 2}),
    ("DELETE", "/api/v1/admin/quotas?scope=global", None),
    ("GET", "/api/v1/admin/capacity", None),
    ("GET", "/api/v1/admin/jobs", None),
]


def call(web, method, path, body=None, headers=None):
    return web.request(method, path, json=body, headers=headers or {})


@pytest.mark.parametrize("method,path,body", CALLS)
def test_every_admin_route_needs_a_session(web, method, path, body):
    r = call(web, method, path, body)
    assert (r.status_code, r.json()["code"]) == (401, "AUTH-SESSION-REQUIRED")


@pytest.mark.parametrize("method,path,body", CALLS)
def test_a_learner_and_an_admin_without_a_second_factor_get_the_answer_of_a_route_that_is_not_there(web, sessions, method, path, body):
    headers = sign_in_admin(web, sessions, LEARNER_EMAIL, second_factor=False)
    learner = call(web, method, path, body, headers)
    web.cookies.clear()
    headers = sign_in_admin(web, sessions, ADMIN_EMAIL, second_factor=False)
    no_mfa = call(web, method, path, body, headers)
    missing = call(web, method, "/api/v1/admin/does-not-exist", None, headers)
    for r in (learner, no_mfa):
        assert (r.status_code, r.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")
        assert {k: v for k, v in r.json().items() if k != "request_id"} == {k: v for k, v in missing.json().items() if k != "request_id"}
    assert web.app.state.stopped == [] and web.app.state.companies_stub.decided == []


@pytest.mark.parametrize("method,path,body", [c for c in CALLS if c[0] != "GET"])
def test_a_state_changing_route_needs_the_csrf_header_and_the_origin(web, sessions, method, path, body):
    headers = sign_in_admin(web, sessions)
    assert call(web, method, path, body).status_code == 403, "no CSRF token"
    assert call(web, method, path, body, {**headers, "origin": "https://evil.example"}).status_code == 403, "another site"


def test_the_queue_and_a_decision(web, sessions):
    csrf = sign_in_admin(web, sessions)
    r = web.get("/api/v1/admin/companies/pending")
    assert r.status_code == 200 and r.headers["cache-control"] == "private, no-store"
    assert r.json() == {"items": [{"org_id": ORG, "name": "Acme Security Ltd", "owner_name": "Ana Owner", "owner_email_domain": "acme.example", "applied_at": timestamp(T0)}]}
    decided = web.post(f"/api/v1/admin/companies/{ORG}/decision", json={"decision": "approve"}, headers=csrf)
    assert decided.status_code == 204 and decided.content == b""
    again = web.post(f"/api/v1/admin/companies/{ORG}/decision", json={"decision": "approve"}, headers=csrf)
    assert (again.status_code, again.json()["code"]) == (409, "ATT-INVALID-STATE")
    unknown = web.post("/api/v1/admin/companies/00000000-0000-0000-0000-0000000000ff/decision", json={"decision": "approve"}, headers=csrf)
    assert (unknown.status_code, unknown.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")


@pytest.mark.parametrize("body", [{"decision": "reject"}, {"decision": "delete"}, {}, {"decision": "approve", "extra": 1}, {"decision": "suspend", "reason": ""}])
def test_a_decision_body_that_does_not_fit_is_422(web, sessions, body):
    csrf = sign_in_admin(web, sessions)
    r = web.post(f"/api/v1/admin/companies/{ORG}/decision", json=body, headers=csrf)
    assert r.status_code == 422 and r.json()["code"] == "REQ-VALIDATION"
    assert web.app.state.companies_stub.decided == []


def test_users_are_listed_and_searched_without_a_password_hash(web, sessions):
    sign_in_admin(web, sessions)
    r = web.get("/api/v1/admin/users", params={"q": "other"})
    assert r.status_code == 200
    [row] = r.json()["items"]
    assert row["user_id"] == OTHER_ID and row["email"] == OTHER_EMAIL and row["roles"] == ["learner"] and row["account_type"] == "participant"
    assert set(row) == {"user_id", "display_name", "email", "account_type", "status", "roles", "email_verified", "created_at", "last_login_at"}
    assert "hash" not in r.text and PASSWORD not in r.text
    assert web.get("/api/v1/admin/users", params={"status": "bogus"}).status_code == 422
    assert web.get("/api/v1/admin/users", params={"limit": 101}).status_code == 422


def test_lock_unlock_reset_and_the_refusals(web, sessions):
    csrf = sign_in_admin(web, sessions)
    url = f"/api/v1/admin/users/{OTHER_ID}/actions"
    assert web.post(url, json={"action": "lock", "reason": "abuse"}, headers=csrf).json() == {"outcome": "locked"}
    again = web.post(url, json={"action": "lock", "reason": "abuse"}, headers=csrf)
    assert (again.status_code, again.json()["code"]) == (409, "ATT-INVALID-STATE")
    assert web.post(url, json={"action": "unlock", "reason": "mistake"}, headers=csrf).json() == {"outcome": "unlocked"}
    assert web.post(url, json={"action": "reset_password"}, headers=csrf).json() == {"outcome": "reset_sent"}
    needs_reason = web.post(url, json={"action": "lock"}, headers=csrf)
    assert needs_reason.status_code == 422 and needs_reason.json()["code"] == "REQ-VALIDATION"
    own = web.post(f"/api/v1/admin/users/{ADMIN_ID}/actions", json={"action": "lock", "reason": "x"}, headers=csrf)
    assert (own.status_code, own.json()["code"]) == (409, "ATT-INVALID-STATE")
    missing = web.post("/api/v1/admin/users/u-NOSUCHACCOUNT222/actions", json={"action": "lock", "reason": "x"}, headers=csrf)
    assert (missing.status_code, missing.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")
    assert web.post("/api/v1/admin/users/not-an-id/actions", json={"action": "lock", "reason": "x"}, headers=csrf).status_code == 422
    assert web.post(url, json={"action": "promote", "reason": "x"}, headers=csrf).status_code == 422


def test_force_stop_over_http(web, sessions):
    with sessions.begin() as s:
        s.add(Attempt(id=ATTEMPT, user_id=LEARNER_ID, template_id="t1", org_id=None, state="running", version=0, record={}))
    csrf = sign_in_admin(web, sessions)
    r = web.post(f"/api/v1/admin/attempts/{ATTEMPT}/force-stop", headers=csrf)
    assert r.status_code == 200 and r.json() == {"attempt_id": ATTEMPT, "instance_stopped": True} and web.app.state.stopped == [ATTEMPT]
    missing = web.post("/api/v1/admin/attempts/a-NOSUCHATTEMPT222/force-stop", headers=csrf)
    assert (missing.status_code, missing.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")


def test_settings_over_http_with_the_retention_range(web, sessions):
    csrf = sign_in_admin(web, sessions)
    listed = web.get("/api/v1/admin/settings").json()["items"]
    retention = next(i for i in listed if i["name"] == "candidate_retention_days")
    assert retention == {"name": "candidate_retention_days", "value": 180, "default": 180, "overridden": False, "minimum": 30, "maximum": 365}
    ok = web.put("/api/v1/admin/settings/candidate_retention_days", json={"value": 90}, headers=csrf)
    assert ok.status_code == 200 and ok.json()["value"] == 90 and ok.json()["overridden"] is True
    for bad in (29, 366, "90", True):
        r = web.put("/api/v1/admin/settings/candidate_retention_days", json={"value": bad}, headers=csrf)
        assert r.status_code == 422 and r.json()["code"] == "REQ-VALIDATION", bad
    assert web.put("/api/v1/admin/settings/no_such_setting", json={"value": 1}, headers=csrf).status_code == 404
    assert web.put("/api/v1/admin/settings/Bad-Name", json={"value": 1}, headers=csrf).status_code == 422
    reset = web.delete("/api/v1/admin/settings/candidate_retention_days", headers=csrf)
    assert reset.status_code == 200 and reset.json()["value"] == 180 and reset.json()["overridden"] is False


def test_quotas_over_http(web, sessions):
    csrf = sign_in_admin(web, sessions)
    assert web.get("/api/v1/admin/quotas").json() == {"items": []}
    r = web.put("/api/v1/admin/quotas", json={"scope": "user", "scope_id": LEARNER_ID, "max_instances": 3}, headers=csrf)
    assert r.status_code == 200 and r.json() == {"scope": "user", "scope_id": LEARNER_ID, "max_instances": 3}
    assert web.put("/api/v1/admin/quotas", json={"scope": "global", "scope_id": None, "max_instances": 2}, headers=csrf).status_code == 200
    assert [i["scope"] for i in web.get("/api/v1/admin/quotas").json()["items"]] == ["global", "user"]
    for bad in ({"scope": "user", "scope_id": "nope", "max_instances": 1}, {"scope": "global", "scope_id": "x", "max_instances": 1}, {"scope": "global", "max_instances": -1},
                {"scope": "global", "max_instances": 10001}, {"scope": "team", "max_instances": 1}):
        r = web.put("/api/v1/admin/quotas", json=bad, headers=csrf)
        assert r.status_code == 422 and r.json()["code"] == "REQ-VALIDATION", bad
    assert web.delete(f"/api/v1/admin/quotas?scope=user&scope_id={LEARNER_ID}", headers=csrf).status_code == 204
    gone = web.delete(f"/api/v1/admin/quotas?scope=user&scope_id={LEARNER_ID}", headers=csrf)
    assert (gone.status_code, gone.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")


def test_capacity_and_jobs_over_http(web, sessions):
    sign_in_admin(web, sessions)
    cap = web.get("/api/v1/admin/capacity")
    assert cap.status_code == 200 and cap.headers["cache-control"] == "private, no-store"
    assert cap.json() == {"instances": {"running": 2, "reported": 1, "failed": 0}, "memory": {"capacity_mb": 4096, "used_mb": 1024, "health": "ok"},
                          "queue": {"emails_waiting": 0, "events_unpublished": 0}, "failures": {"emails_failed": 0, "jobs_failed": 0, "instances_failed": 0}}
    jobs = web.get("/api/v1/admin/jobs").json()["items"]
    assert jobs == [{"name": "log_purge", "interval_seconds": 86400, "last_started_at": timestamp(T0), "last_finished_at": timestamp(T0),
                     "last_status": "succeeded", "last_detail": "0 purged", "last_success_at": timestamp(T0), "next_due_at": timestamp(T0 + timedelta(days=1))}]


def test_the_admin_area_is_closed_when_the_operations_are_not_configured(web, sessions):
    sign_in_admin(web, sessions)
    web.app.state.admin_ops = None
    r = web.get("/api/v1/admin/settings")
    assert (r.status_code, r.json()["code"]) == (500, "REQ-INTERNAL")
