"""Story P-12: createSession, getSession and deleteSession over HTTP: the contract answers, the cookie, the Origin and CSRF checks, the
login throttle (a back-off that ends by itself), the scope of an authenticated request, and what is never logged."""
from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from vulnmart.accounts import security
from vulnmart.accounts.http import SESSION_COOKIE, Authenticated, authenticated
from vulnmart.accounts.models import User, UserRole, UserSession
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.db import Base
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.kernel.settings import Settings
from vulnmart.main import create_app
from vulnmart.ports.fakes import FakeSettingsPort

ORIGIN = "http://127.0.0.1:3000"
PASSWORD = "correct horse battery staple"
EMAIL = "ada@example.com"
T0 = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)
_HASH = security.hash_password(PASSWORD)


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
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def clock():
    return Clock()


def add_user(sessions, uid="u-AAAAAAAAAAAAAAAA", email=EMAIL, *, account_type="participant", verified=True):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type=account_type, email=email, email_ci=email.lower(), password_hash=_HASH, display_name="Ada Learner",
                   status="active", email_verified_at=T0 if verified else None))
        s.flush()
        if account_type == "participant":
            s.add(UserRole(user_id=uid, role="learner", account_type="participant"))


def make_app(sessions, clock, *, overrides=None):
    settings = FakeSettingsPort(overrides or {})
    app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(),
                     accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock),
                     sessions=SessionService(sessions, settings, b"k" * 32, now=clock))
    app.state.ports.settings = settings

    @app.get("/api/v1/_test/scope")
    async def whoami(auth: Authenticated = Depends(authenticated)):  # what a later story's route sees
        scope = ContextScopePort().current()
        return {"user_id": scope.user_id, "roles": sorted(r.value for r in scope.roles)}

    return app


def client(app) -> TestClient:
    return TestClient(app, headers={"origin": ORIGIN}, base_url="https://testserver", raise_server_exceptions=False)


def log_in(c, email=EMAIL, password=PASSWORD):
    return c.post("/api/v1/session", json={"email": email, "password": password})


def cookie_value(response) -> str:
    return re.search(rf"{SESSION_COOKIE}=([^;]+)", response.headers["set-cookie"]).group(1)


# ---- login -----------------------------------------------------------------------------------------------------------

def test_login_answers_with_the_session_and_sets_the_cookie_the_contract_describes(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        r = log_in(c)
    assert r.status_code == 200 and r.headers["cache-control"] == "private, no-store"
    body = r.json()
    assert set(body) == {"status", "user", "csrf_token", "idle_expires_at", "absolute_expires_at"} and body["status"] == "authenticated"
    assert body["user"] == {"user_id": "u-AAAAAAAAAAAAAAAA", "email": EMAIL, "display_name": "Ada Learner", "account_type": "participant",
                            "email_verified": True, "mfa_enabled": False, "created_at": body["user"]["created_at"]}
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", body["csrf_token"])
    assert (body["idle_expires_at"], body["absolute_expires_at"]) == ("2026-10-17T10:30:00Z", "2026-10-17T22:00:00Z")
    header = r.headers["set-cookie"]
    value = cookie_value(r)
    assert header.startswith(f"{SESSION_COOKIE}=") and "Path=/" in header and "Secure" in header and "HttpOnly" in header
    assert "samesite=lax" in header.lower() and "domain" not in header.lower() and "max-age" not in header.lower() and "expires" not in header.lower()
    assert value not in r.text and value != body["csrf_token"], "the cookie value is never in a body"


def test_a_wrong_password_and_an_unknown_address_answer_the_same_401(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        wrong = log_in(c, password="wrong password here")
        unknown = log_in(c, email="nobody@example.com")
    assert wrong.status_code == unknown.status_code == 401
    def without_request_id(response):
        return {k: v for k, v in response.json().items() if k != "request_id"}

    assert without_request_id(wrong) == without_request_id(unknown), "the two answers differ in nothing but the request id"
    assert wrong.json()["code"] == "AUTH-INVALID-CREDENTIALS" and "set-cookie" not in wrong.headers
    assert wrong.headers["cache-control"] == unknown.headers["cache-control"] == "private, no-store"


def test_an_unverified_address_gets_403_only_after_the_right_password(sessions, clock):
    add_user(sessions, verified=False)
    with client(make_app(sessions, clock)) as c:
        wrong = log_in(c, password="wrong password here")
        right = log_in(c)
    assert (wrong.status_code, wrong.json()["code"]) == (401, "AUTH-INVALID-CREDENTIALS")
    assert (right.status_code, right.json()["code"]) == (403, "AUTH-EMAIL-NOT-VERIFIED") and "set-cookie" not in right.headers


def test_an_admin_with_only_a_password_signs_in_to_a_session_that_can_reach_no_admin_function(sessions, clock):
    add_user(sessions, account_type="admin")
    with client(make_app(sessions, clock)) as c:
        r = log_in(c)
        me = c.get("/api/v1/me")
        admin_area = c.get("/api/v1/_test/scope")
    assert r.status_code == 200 and r.json()["user"]["account_type"] == "admin" and r.json()["user"]["mfa_enabled"] is False
    assert me.json()["account_type"] == "admin"
    assert admin_area.json()["roles"] == [], "the scope of an admin session without a second factor holds no admin role (FR-ACC-07)"


@pytest.mark.parametrize("bad,pointer", [({"email": "x"}, "/email"), ({"password": ""}, "/password"), ({"password": "x" * 129}, "/password"),
                                         ({"extra": 1}, "/extra")])
def test_a_bad_login_body_is_422_without_echoing_values(sessions, clock, bad, pointer):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        r = c.post("/api/v1/session", json={"email": EMAIL, "password": PASSWORD, **bad})
    assert r.status_code == 422 and pointer in [e["pointer"] for e in r.json()["errors"]] and PASSWORD not in r.text


def test_a_cookie_sent_with_the_login_is_not_adopted_so_a_planted_session_value_cannot_be_fixed(sessions, clock):
    add_user(sessions)
    planted = "P" * 43
    with client(make_app(sessions, clock)) as c:
        r = c.post("/api/v1/session", json={"email": EMAIL, "password": PASSWORD}, headers={"cookie": f"{SESSION_COOKIE}={planted}"})
        after = c.get("/api/v1/session", headers={"cookie": f"{SESSION_COOKIE}={planted}"})
    assert cookie_value(r) != planted and after.status_code == 401


def test_every_login_sets_a_new_session_value(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        values = {cookie_value(log_in(c)) for _ in range(3)}
    assert len(values) == 3


# ---- the origin and CSRF checks --------------------------------------------------------------------------------------

def test_a_login_from_another_site_is_refused(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        evil = c.post("/api/v1/session", json={"email": EMAIL, "password": PASSWORD}, headers={"origin": "https://evil.example"})
        form = c.post("/api/v1/session", json={"email": EMAIL, "password": PASSWORD}, headers={"sec-fetch-site": "cross-site"})
    assert (evil.status_code, evil.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN") and "set-cookie" not in evil.headers
    assert (form.status_code, form.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN")


def test_logout_needs_the_csrf_token_of_that_session_and_the_right_origin(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        csrf = log_in(c).json()["csrf_token"]
        without = c.delete("/api/v1/session")
        wrong = c.delete("/api/v1/session", headers={"x-csrf-token": "A" * 43})
        truncated = c.delete("/api/v1/session", headers={"x-csrf-token": csrf[:-1]})
        other_site = c.delete("/api/v1/session", headers={"x-csrf-token": csrf, "origin": "https://evil.example"})
        no_origin = c.delete("/api/v1/session", headers={"x-csrf-token": csrf, "origin": ""})
        still = c.get("/api/v1/session")
    assert [r.status_code for r in (without, wrong, truncated)] == [403, 403, 403]
    assert {r.json()["code"] for r in (without, wrong, truncated)} == {"AUTH-CSRF-FAILED"}
    assert [(r.status_code, r.json()["code"]) for r in (other_site, no_origin)] == [(403, "AUTH-ORIGIN-FORBIDDEN")] * 2
    assert still.status_code == 200, "none of the refused calls ended the session"


def test_a_csrf_token_of_another_session_does_not_work(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as first, client(make_app(sessions, clock)) as second:
        log_in(first)
        other = log_in(second).json()["csrf_token"]
        r = first.delete("/api/v1/session", headers={"x-csrf-token": other})
    assert (r.status_code, r.json()["code"]) == (403, "AUTH-CSRF-FAILED")


# ---- logout and a stolen cookie --------------------------------------------------------------------------------------

def test_logout_ends_the_session_on_the_server_and_clears_the_cookie(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        login = log_in(c)
        stolen = cookie_value(login)
        out = c.delete("/api/v1/session", headers={"x-csrf-token": login.json()["csrf_token"]})
        replay = TestClient(c.app, headers={"origin": ORIGIN, "cookie": f"{SESSION_COOKIE}={stolen}"}, base_url="https://testserver").get("/api/v1/session")
    assert out.status_code == 204 and out.content == b"" and out.headers["cache-control"] == "private, no-store"
    assert f"{SESSION_COOKIE}=" in out.headers["set-cookie"] and "max-age=0" in out.headers["set-cookie"].lower()
    assert (replay.status_code, replay.json()["code"]) == (401, "AUTH-SESSION-REQUIRED"), "a stolen old cookie no longer works"


# ---- the session -----------------------------------------------------------------------------------------------------

def test_get_session_returns_the_same_user_and_a_stable_csrf_token(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        login = log_in(c)
        first, second = c.get("/api/v1/session"), c.get("/api/v1/session")
    assert first.status_code == 200 and first.json()["user"] == login.json()["user"]
    assert first.json()["csrf_token"] == second.json()["csrf_token"] == login.json()["csrf_token"]
    assert first.headers["cache-control"] == "private, no-store"


def test_no_cookie_or_a_malformed_one_is_401_session_required(sessions, clock):
    with client(make_app(sessions, clock)) as c:
        none = c.get("/api/v1/session")
        junk = c.get("/api/v1/session", headers={"cookie": f"{SESSION_COOKIE}=short"})
        unknown = c.get("/api/v1/session", headers={"cookie": f"{SESSION_COOKIE}={'U' * 43}"})
    assert [(r.status_code, r.json()["code"]) for r in (none, junk, unknown)] == [(401, "AUTH-SESSION-REQUIRED")] * 3
    assert "set-cookie" not in none.headers and "set-cookie" not in junk.headers
    assert f"{SESSION_COOKIE}=" in unknown.headers["set-cookie"], "a cookie the server does not know is cleared"


def test_the_idle_and_the_absolute_timeouts_end_the_session_over_http(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        log_in(c)
        clock.advance(minutes=29)
        assert c.get("/api/v1/session").status_code == 200
        clock.advance(minutes=31)
        gone = c.get("/api/v1/session")
        assert (gone.status_code, gone.json()["code"]) == (401, "AUTH-SESSION-REQUIRED") and "max-age=0" in gone.headers["set-cookie"].lower()
    with client(make_app(sessions, clock)) as c:
        log_in(c)
        for _ in range(36):
            clock.advance(minutes=20)
            c.get("/api/v1/session")
        assert c.get("/api/v1/session").status_code == 401, "twelve hours of activity still ends it"


def test_an_authenticated_route_runs_with_the_user_and_roles_in_scope(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        log_in(c)
        r = c.get("/api/v1/_test/scope")
        outside = TestClient(c.app, base_url="https://testserver").get("/api/v1/_test/scope")
    assert r.json() == {"user_id": "u-AAAAAAAAAAAAAAAA", "roles": ["learner"]} and outside.status_code == 401
    with pytest.raises(Exception):  # the scope ended with the request
        ContextScopePort().current()


# ---- the throttle ----------------------------------------------------------------------------------------------------

def test_ten_wrong_passwords_make_an_address_wait_and_the_wait_ends_by_itself(sessions, clock):
    add_user(sessions)
    limiter = InMemoryRateLimiter(now=lambda: clock.now.timestamp())
    app = make_app(sessions, clock)
    app.state.rate_limiter = limiter
    with client(app) as c:
        wrong = [log_in(c, password="wrong password here").status_code for _ in range(10)]
        blocked = log_in(c)  # even the right password waits
        other = log_in(c, email="nobody@example.com")
    assert wrong == [401] * 10
    assert (blocked.status_code, blocked.json()["code"]) == (429, "REQ-RATE-LIMITED") and 1 <= int(blocked.headers["retry-after"]) <= 900
    assert "set-cookie" not in blocked.headers
    assert other.status_code == 401, "another address is not affected"
    clock.advance(minutes=15, seconds=1)
    with client(app) as c:
        assert log_in(c).status_code == 200, "after the window the same address can log in: no permanent lockout"


def test_a_good_login_clears_the_failures(sessions, clock):
    add_user(sessions)
    app = make_app(sessions, clock)
    with client(app) as c:
        for _ in range(9):
            log_in(c, password="wrong password here")
        assert log_in(c).status_code == 200
        again = [log_in(c, password="wrong password here").status_code for _ in range(9)]
    assert again == [401] * 9, "the nine failures before the success no longer count"


def test_failures_for_an_unknown_address_are_counted_like_any_other(sessions, clock):
    with client(make_app(sessions, clock)) as c:
        codes = [log_in(c, email="ghost@example.com").status_code for _ in range(11)]
    assert codes == [401] * 10 + [429]


def test_the_per_address_limit_applies_to_every_login_attempt(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock, overrides={"rate_login_per_ip_per_hour": 2})) as c:
        codes = [log_in(c).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


# ---- what is never logged --------------------------------------------------------------------------------------------

def test_neither_the_password_nor_the_session_value_is_logged(sessions, clock, caplog):
    add_user(sessions)
    caplog.set_level(logging.DEBUG)
    with client(make_app(sessions, clock)) as c:
        login = log_in(c)
        value = cookie_value(login)
        c.get("/api/v1/session")
        c.delete("/api/v1/session", headers={"x-csrf-token": login.json()["csrf_token"]})
        log_in(c, password="wrong password here")
    assert PASSWORD not in caplog.text and "wrong password here" not in caplog.text
    assert value not in caplog.text and login.json()["csrf_token"] not in caplog.text


def test_without_the_session_service_the_routes_answer_an_internal_error(sessions, clock):
    app = make_app(sessions, clock)
    app.state.session_service = None
    with client(app) as c:
        assert log_in(c).status_code == 500 and c.get("/api/v1/session").status_code == 500
