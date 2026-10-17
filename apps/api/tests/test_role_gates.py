"""Story P-13 over HTTP: a route only some roles may use (`requires`), the refusal that does not reveal the route, and the rule that no
route or request field can make an admin (FR-ACC-01, FR-ACC-05, FR-ACC-11)."""
from __future__ import annotations

import pytest
from fastapi import Depends
from sqlalchemy import select

from test_session_api import EMAIL, ORIGIN, PASSWORD, Clock, add_user, client, log_in, make_app, sessions  # noqa: F401 - fixtures
from vulnmart.accounts.http import Authenticated, requires
from vulnmart.accounts.models import User, UserRole
from vulnmart.ports.scope import Role

SIGNUP = {"email": "new@example.com", "password": PASSWORD, "display_name": "New", "age_declaration": True}


@pytest.fixture
def clock():
    return Clock()


def gated_app(sessions, clock):
    app = make_app(sessions, clock)

    @app.get("/api/v1/_test/recruiter-only")
    async def recruiter_only(auth: Authenticated = Depends(requires(Role.RECRUITER, Role.ORG_OWNER))):
        return {"ok": True}

    @app.get("/api/v1/_test/admin-only")
    async def admin_only(auth: Authenticated = Depends(requires(Role.ADMIN))):
        return {"ok": True}

    @app.get("/api/v1/_test/candidate-or-learner")
    async def participant_area(auth: Authenticated = Depends(requires(Role.LEARNER, Role.CANDIDATE))):
        return {"roles": sorted(r.value for r in auth.session.roles)}

    @app.post("/api/v1/_test/recruiter-change")
    async def recruiter_change(auth: Authenticated = Depends(requires(Role.RECRUITER, csrf=True))):
        return {"changed": True}

    return app


def test_a_learner_cannot_reach_recruiter_or_admin_routes_and_is_not_told_they_exist(sessions, clock):
    add_user(sessions)
    with client(gated_app(sessions, clock)) as c:
        log_in(c)
        recruiter = c.get("/api/v1/_test/recruiter-only")
        admin = c.get("/api/v1/_test/admin-only")
        missing = c.get("/api/v1/_test/does-not-exist")
        participant = c.get("/api/v1/_test/candidate-or-learner")
    assert (recruiter.status_code, recruiter.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")
    assert (admin.status_code, admin.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")

    def shape(r):
        return {k: v for k, v in r.json().items() if k != "request_id"}

    assert shape(recruiter) == shape(admin) == shape(missing), "a forbidden route answers exactly like one that is not there"
    assert participant.json() == {"roles": ["learner"]}


def test_a_recruiter_reaches_recruiter_routes_but_not_admin_or_participant_ones(sessions, clock):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", account_type="recruiter")
    with client(gated_app(sessions, clock)) as c:
        log_in(c, "rec@example.com")
        assert c.get("/api/v1/_test/recruiter-only").json() == {"ok": True}
        assert c.get("/api/v1/_test/admin-only").status_code == 404
        assert c.get("/api/v1/_test/candidate-or-learner").status_code == 404, "a recruiter cannot use the learner or candidate area"


def test_a_candidate_role_opens_the_participant_area_beside_the_learner_role(sessions, clock):
    add_user(sessions)
    with sessions.begin() as s:
        s.add(UserRole(user_id="u-AAAAAAAAAAAAAAAA", role="candidate", account_type="participant"))
    with client(gated_app(sessions, clock)) as c:
        log_in(c)
        assert c.get("/api/v1/_test/candidate-or-learner").json() == {"roles": ["candidate", "learner"]}


def test_without_a_session_the_answer_is_401_not_404(sessions, clock):
    with client(gated_app(sessions, clock)) as c:
        r = c.get("/api/v1/_test/admin-only")
    assert (r.status_code, r.json()["code"]) == (401, "AUTH-SESSION-REQUIRED")


def test_a_role_gated_change_needs_csrf_and_origin_before_the_role_is_looked_at(sessions, clock):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", account_type="recruiter")
    add_user(sessions, "u-AAAAAAAAAAAAAAAA", EMAIL)
    with client(gated_app(sessions, clock)) as rec, client(gated_app(sessions, clock)) as learner:
        csrf = log_in(rec, "rec@example.com").json()["csrf_token"]
        learner_csrf = log_in(learner).json()["csrf_token"]
        no_token = rec.post("/api/v1/_test/recruiter-change")
        other_origin = rec.post("/api/v1/_test/recruiter-change", headers={"x-csrf-token": csrf, "origin": "https://evil.example"})
        ok = rec.post("/api/v1/_test/recruiter-change", headers={"x-csrf-token": csrf})
        wrong_role = learner.post("/api/v1/_test/recruiter-change", headers={"x-csrf-token": learner_csrf})
    assert (no_token.status_code, no_token.json()["code"]) == (403, "AUTH-CSRF-FAILED")
    assert (other_origin.status_code, other_origin.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN")
    assert ok.json() == {"changed": True}
    assert (wrong_role.status_code, wrong_role.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")


def test_a_role_taken_away_stops_working_on_the_very_next_request(sessions, clock):
    add_user(sessions)
    with sessions.begin() as s:
        s.add(UserRole(user_id="u-AAAAAAAAAAAAAAAA", role="candidate", account_type="participant"))
    app = gated_app(sessions, clock)

    @app.get("/api/v1/_test/candidate-only")
    async def candidate_only(auth: Authenticated = Depends(requires(Role.CANDIDATE))):
        return {"ok": True}

    with client(app) as c:
        log_in(c)
        assert c.get("/api/v1/_test/candidate-only").status_code == 200
        with sessions.begin() as s:
            for row in s.scalars(select(UserRole).where(UserRole.role == "candidate")):
                s.delete(row)
        assert c.get("/api/v1/_test/candidate-only").status_code == 404, "roles are read on every request"


# ---- no way to make an admin over HTTP ---------------------------------------------------------------------------------

@pytest.mark.parametrize("extra", [{"account_type": "admin"}, {"role": "admin"}, {"roles": ["admin"]}, {"is_admin": True}, {"admin": True}])
def test_signup_refuses_any_field_that_could_name_an_account_type_or_role(sessions, clock, extra):
    with client(make_app(sessions, clock)) as c:
        r = c.post("/api/v1/accounts", json={**SIGNUP, **extra})
    assert r.status_code == 422
    with sessions() as s:
        assert s.scalars(select(User)).all() == []


def test_the_signup_route_makes_a_participant_and_no_registered_route_creates_an_admin(sessions, clock):
    with client(make_app(sessions, clock)) as c:
        assert c.post("/api/v1/accounts", json=SIGNUP).status_code == 202
        # the generated schema lists every route, including those of included routers
        schema = c.app.openapi()["paths"]
    with sessions() as s:
        assert [(u.account_type) for u in s.scalars(select(User))] == ["participant"]
    state_changing = {path for path, methods in schema.items() if set(methods) - {"get", "head", "options"} and not path.startswith("/api/v1/_test")}
    assert "/api/v1/session" in schema and "get" in schema["/api/v1/session"], "the schema really lists the included routers"
    assert state_changing == {"/api/v1/accounts", "/api/v1/accounts/verify-email", "/api/v1/accounts/verify-email/resend", "/api/v1/session",
                              "/api/v1/password-reset/request", "/api/v1/password-reset/confirm", "/api/v1/me", "/api/v1/me/password"}
    assert not any("admin" in p for p in state_changing), "no route can create an admin (FR-ACC-11): admins come from a seed command or an admin"
