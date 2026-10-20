"""Story P-15 over HTTP: startMfaEnrolment, confirmMfaEnrolment, disableMfa and completeMfaLogin, and the second step of createSession: contract answers,
the admin rule (an admin session without a proved factor reaches no admin function), single-use tickets and codes, throttles, and what is never logged."""
from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from vulnmart.accounts import security, totp
from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.accounts.http import SESSION_COOKIE, Authenticated, requires
from vulnmart.accounts.mfa import MfaService
from vulnmart.accounts.models import User, UserRole
from vulnmart.accounts.passwords import PasswordPolicy
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.db import Base
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.settings import Settings
from vulnmart.main import create_app
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.ports.scope import Role

ORIGIN = "http://127.0.0.1:3000"
PASSWORD = "correct horse battery staple"
T0 = datetime(2026, 10, 18, 10, 0, 7, tzinfo=UTC)
KEYS = FieldKeys.from_secret(b"a field key secret of at least 32 bytes!!")
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


def add_user(sessions, uid, email, account_type="participant"):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type=account_type, email=email, email_ci=email, password_hash=_HASH, display_name="Test", status="active",
                   email_verified_at=T0))
        s.flush()
        if account_type == "participant":
            s.add(UserRole(user_id=uid, role="learner", account_type="participant"))


def make_app(sessions, clock):
    settings = FakeSettingsPort()
    ss = SessionService(sessions, settings, b"k" * 32, now=clock)
    app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(now=lambda: clock.now.timestamp()), policy=PasswordPolicy(),
                     accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock), sessions=ss,
                     self_service=SelfService(sessions, ss), mfa=MfaService(sessions, KEYS, FakeAuditPort(), ss, now=clock))
    app.state.ports.settings = settings

    @app.get("/api/v1/_test/admin-only")
    async def admin_only(auth: Authenticated = Depends(requires(Role.ADMIN))):
        return {"ok": True}

    return app


def client(app) -> TestClient:
    return TestClient(app, headers={"origin": ORIGIN}, base_url="https://testserver", raise_server_exceptions=False)


def log_in(c, email):
    return c.post("/api/v1/session", json={"email": email, "password": PASSWORD})


def headers(csrf):
    return {"x-csrf-token": csrf}


def cookie_value(response) -> str:
    return re.search(rf"{SESSION_COOKIE}=([^;]+)", response.headers["set-cookie"]).group(1)


def code(secret, clock, offset=0):
    return totp.code_for(secret, totp.time_step(clock.now) + offset)


def enrol(c, clock, email):
    """Sign in, enrol and confirm through the routes. Returns the secret and the recovery codes; `c` ends up with the new session cookie."""
    csrf = log_in(c, email).json()["csrf_token"]
    started = c.post("/api/v1/me/mfa", headers=headers(csrf))
    assert started.status_code == 200
    secret = parse_qs(urlsplit(started.json()["otpauth_uri"]).query)["secret"][0]
    confirmed = c.post("/api/v1/me/mfa/confirm", json={"code": code(secret, clock)}, headers=headers(csrf))
    assert confirmed.status_code == 200
    return secret, confirmed.json()["recovery_codes"]


# ---- enrolment -------------------------------------------------------------------------------------------------------

def test_enrolment_through_the_routes_gives_the_address_the_codes_and_a_new_session(sessions, clock):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    with client(make_app(sessions, clock)) as c:
        login = log_in(c, "rec@example.com")
        csrf, old_cookie = login.json()["csrf_token"], cookie_value(login)
        started = c.post("/api/v1/me/mfa", headers=headers(csrf))
        uri = started.json()["otpauth_uri"]
        secret = parse_qs(urlsplit(uri).query)["secret"][0]
        wrong = c.post("/api/v1/me/mfa/confirm", json={"code": "000000"}, headers=headers(csrf))
        confirmed = c.post("/api/v1/me/mfa/confirm", json={"code": code(secret, clock)}, headers=headers(csrf))
        stale = c.post("/api/v1/me/mfa", headers=headers(csrf))  # the old token belonged to the old session value
        new_csrf = c.get("/api/v1/session").json()["csrf_token"]
        again = c.post("/api/v1/me/mfa", headers=headers(new_csrf))
        me = c.get("/api/v1/me")
    assert stale.status_code == 403 and stale.json()["code"] == "AUTH-CSRF-FAILED" and new_csrf != csrf
    assert started.status_code == 200 and uri.startswith("otpauth://totp/VulnMart%3Arec%40example.com?secret=") and started.headers["cache-control"] == "private, no-store"
    assert (wrong.status_code, wrong.json()["code"]) == (401, "AUTH-MFA-INVALID")
    assert confirmed.status_code == 200 and len(confirmed.json()["recovery_codes"]) == 10
    assert all(re.fullmatch(r"[A-Z2-7]{10}", x) for x in confirmed.json()["recovery_codes"]) and set(confirmed.json()) == {"recovery_codes"}
    new_cookie = cookie_value(confirmed)
    assert new_cookie != old_cookie and "samesite=lax" in confirmed.headers["set-cookie"].lower()
    assert (again.status_code, again.json()["code"]) == (409, "AUTH-MFA-STATE")
    assert me.status_code == 200 and me.json()["mfa_enabled"] is True, "the new cookie works and shows the factor on"


def test_one_account_can_start_only_so_many_enrolments_an_hour_and_others_are_not_affected(sessions, clock):
    """Story 1.9 (deferred F6): each start makes a new secret; the per-address limit (60) does not stop one account, the per-account one does."""
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    add_user(sessions, "u-SSSSSSSSSSSSSSSS", "sam@example.com", "recruiter")
    app = make_app(sessions, clock)
    allowed = int(app.state.ports.settings.get("rate_mfa_enrol_per_user_per_hour"))
    with client(app) as c, client(app) as other:
        csrf = log_in(c, "rec@example.com").json()["csrf_token"]
        answers = [c.post("/api/v1/me/mfa", headers=headers(csrf)).status_code for _ in range(allowed + 1)]
        refused = c.post("/api/v1/me/mfa", headers=headers(csrf))
        sams = other.post("/api/v1/me/mfa", headers=headers(log_in(other, "sam@example.com").json()["csrf_token"]))
    assert answers == [200] * allowed + [429]
    assert refused.json()["code"] == "REQ-RATE-LIMITED" and int(refused.headers["retry-after"]) > 0
    assert sams.status_code == 200, "another account from the same address still enrols"


def test_enrolment_needs_a_session_the_csrf_token_and_the_dashboard_origin(sessions, clock):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    app = make_app(sessions, clock)
    with client(app) as c:
        anonymous = client(app).post("/api/v1/me/mfa")
        csrf = log_in(c, "rec@example.com").json()["csrf_token"]
        no_token = c.post("/api/v1/me/mfa")
        other_site = c.post("/api/v1/me/mfa", headers={**headers(csrf), "origin": "https://evil.example"})
        confirm_no_token = c.post("/api/v1/me/mfa/confirm", json={"code": "123456"})
        bad_body = c.post("/api/v1/me/mfa/confirm", json={"code": "12345"}, headers=headers(csrf))
        confirm_nothing_started = c.post("/api/v1/me/mfa/confirm", json={"code": "123456"}, headers=headers(csrf))
    assert anonymous.status_code == 401
    assert (no_token.status_code, no_token.json()["code"]) == (403, "AUTH-CSRF-FAILED") and confirm_no_token.json()["code"] == "AUTH-CSRF-FAILED"
    assert (other_site.status_code, other_site.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN")
    assert bad_body.status_code == 422
    assert (confirm_nothing_started.status_code, confirm_nothing_started.json()["code"]) == (409, "AUTH-MFA-STATE")


# ---- the login -------------------------------------------------------------------------------------------------------

def test_a_login_with_a_second_factor_answers_with_a_ticket_and_no_cookie_then_a_code_opens_the_session(sessions, clock):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    app = make_app(sessions, clock)
    with client(app) as c:
        secret, _ = enrol(c, clock, "rec@example.com")
    clock.advance(seconds=31)
    with client(app) as c:
        first = log_in(c, "rec@example.com")
        body = first.json()
        wrong = c.post("/api/v1/session/mfa", json={"mfa_ticket": body["mfa_ticket"], "code": "000000"})
        unknown = c.post("/api/v1/session/mfa", json={"mfa_ticket": "U" * 43, "code": "000000"})
        done = c.post("/api/v1/session/mfa", json={"mfa_ticket": body["mfa_ticket"], "code": code(secret, clock)})
        reused = c.post("/api/v1/session/mfa", json={"mfa_ticket": body["mfa_ticket"], "code": code(secret, clock)})
        me = c.get("/api/v1/me")
    assert first.status_code == 200 and set(body) == {"status", "mfa_ticket", "mfa_ticket_expires_at"} and body["status"] == "mfa_required"
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", body["mfa_ticket"]) and body["mfa_ticket_expires_at"] == "2026-10-18T10:05:38Z"
    assert "set-cookie" not in first.headers and first.headers["cache-control"] == "private, no-store"
    assert (wrong.status_code, wrong.json()["code"]) == (401, "AUTH-MFA-INVALID") and "set-cookie" not in wrong.headers
    assert {k: v for k, v in wrong.json().items() if k != "request_id"} == {k: v for k, v in unknown.json().items() if k != "request_id"}
    assert done.status_code == 200 and done.json()["status"] == "authenticated" and done.json()["user"]["mfa_enabled"] is True
    assert re.search(rf"{SESSION_COOKIE}=", done.headers["set-cookie"]) and "httponly" in done.headers["set-cookie"].lower()
    assert (reused.status_code, reused.json()["code"]) == (401, "AUTH-MFA-INVALID"), "a ticket works once"
    assert me.status_code == 200


def test_a_totp_code_cannot_be_replayed_and_a_recovery_code_works_once(sessions, clock):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    app = make_app(sessions, clock)
    with client(app) as c:
        secret, codes = enrol(c, clock, "rec@example.com")
    clock.advance(seconds=31)
    good = code(secret, clock)

    def second_step(c):
        return log_in(c, "rec@example.com").json()["mfa_ticket"]

    with client(app) as c:
        assert c.post("/api/v1/session/mfa", json={"mfa_ticket": second_step(c), "code": good}).status_code == 200
        replay = c.post("/api/v1/session/mfa", json={"mfa_ticket": second_step(c), "code": good})
        recovery = c.post("/api/v1/session/mfa", json={"mfa_ticket": second_step(c), "code": codes[0]})
        recovery_again = c.post("/api/v1/session/mfa", json={"mfa_ticket": second_step(c), "code": codes[0]})
        other = c.post("/api/v1/session/mfa", json={"mfa_ticket": second_step(c), "code": codes[1]})
    assert (replay.status_code, replay.json()["code"]) == (401, "AUTH-MFA-INVALID")
    assert recovery.status_code == 200 and other.status_code == 200
    assert (recovery_again.status_code, recovery_again.json()["code"]) == (401, "AUTH-MFA-INVALID")


def test_the_second_step_needs_the_dashboard_origin_and_a_well_formed_body(sessions, clock):
    with client(make_app(sessions, clock)) as c:
        forbidden = c.post("/api/v1/session/mfa", json={"mfa_ticket": "U" * 43, "code": "123456"}, headers={"origin": "https://evil.example"})
        bad_ticket = c.post("/api/v1/session/mfa", json={"mfa_ticket": "x", "code": "123456"})
        bad_code = c.post("/api/v1/session/mfa", json={"mfa_ticket": "U" * 43, "code": "12 345"})
        lower = c.post("/api/v1/session/mfa", json={"mfa_ticket": "U" * 43, "code": "abcdefghij"})
        extra = c.post("/api/v1/session/mfa", json={"mfa_ticket": "U" * 43, "code": "123456", "password": PASSWORD})
    assert (forbidden.status_code, forbidden.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN")
    assert bad_ticket.status_code == bad_code.status_code == lower.status_code == extra.status_code == 422


# ---- admins ----------------------------------------------------------------------------------------------------------

def test_an_admin_reaches_admin_functions_only_after_proving_a_second_factor(sessions, clock):
    add_user(sessions, "u-ADMINADMINADMIN2", "admin@example.com", "admin")
    app = make_app(sessions, clock)
    with client(app) as c:
        first = log_in(c, "admin@example.com")
        before = c.get("/api/v1/_test/admin-only")
        started = c.post("/api/v1/me/mfa", headers=headers(first.json()["csrf_token"]))
        secret = parse_qs(urlsplit(started.json()["otpauth_uri"]).query)["secret"][0]
        still_before = c.get("/api/v1/_test/admin-only")
        confirmed = c.post("/api/v1/me/mfa/confirm", json={"code": code(secret, clock)}, headers=headers(first.json()["csrf_token"]))
        after = c.get("/api/v1/_test/admin-only")
    assert first.status_code == 200 and first.json()["user"]["account_type"] == "admin" and first.json()["user"]["mfa_enabled"] is False
    assert (before.status_code, before.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN"), "a password alone reaches no admin function"
    assert still_before.status_code == 404, "and neither does a started but unconfirmed enrolment"
    assert confirmed.status_code == 200 and after.json() == {"ok": True}
    clock.advance(seconds=31)
    with client(app) as c:  # the next sign-in: password, then the code
        ticket = log_in(c, "admin@example.com").json()["mfa_ticket"]
        assert c.get("/api/v1/_test/admin-only").status_code == 401, "no session between the two steps"
        assert c.post("/api/v1/session/mfa", json={"mfa_ticket": ticket, "code": code(secret, clock)}).status_code == 200
        assert c.get("/api/v1/_test/admin-only").json() == {"ok": True}


def test_an_admin_cannot_turn_the_second_factor_off(sessions, clock):
    add_user(sessions, "u-ADMINADMINADMIN2", "admin@example.com", "admin")
    app = make_app(sessions, clock)
    with client(app) as c:
        enrol(c, clock, "admin@example.com")
        csrf = c.get("/api/v1/session").json()["csrf_token"]
        r = c.request("DELETE", "/api/v1/me/mfa", json={"password": PASSWORD}, headers=headers(csrf))
        still = c.get("/api/v1/me")
    assert (r.status_code, r.json()["code"]) == (409, "AUTH-MFA-STATE") and still.json()["mfa_enabled"] is True


# ---- turning it off --------------------------------------------------------------------------------------------------

def test_a_recruiter_turns_it_off_with_the_password_and_gets_a_new_session(sessions, clock):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    app = make_app(sessions, clock)
    with client(app) as c:
        enrol(c, clock, "rec@example.com")
        csrf = c.get("/api/v1/session").json()["csrf_token"]
        old_cookie = c.cookies.get(SESSION_COOKIE)
        wrong = c.request("DELETE", "/api/v1/me/mfa", json={"password": "not the password at all"}, headers=headers(csrf))
        no_token = c.request("DELETE", "/api/v1/me/mfa", json={"password": PASSWORD})
        off = c.request("DELETE", "/api/v1/me/mfa", json={"password": PASSWORD}, headers=headers(csrf))
        stolen = client(app)
        stolen.cookies.set(SESSION_COOKIE, old_cookie)
        me = c.get("/api/v1/me")
        nothing_to_do = c.request("DELETE", "/api/v1/me/mfa", json={"password": PASSWORD}, headers=headers(c.get("/api/v1/session").json()["csrf_token"]))
        plain_login = log_in(client(app), "rec@example.com")
    assert (wrong.status_code, wrong.json()["code"]) == (401, "AUTH-INVALID-CREDENTIALS") and no_token.json()["code"] == "AUTH-CSRF-FAILED"
    assert off.status_code == 204 and off.content == b"" and cookie_value(off) != old_cookie
    assert stolen.get("/api/v1/session").status_code == 401, "the old session value stopped working"
    assert me.json()["mfa_enabled"] is False
    assert (nothing_to_do.status_code, nothing_to_do.json()["code"]) == (409, "AUTH-MFA-STATE")
    assert plain_login.json()["status"] == "authenticated", "no second step after turning it off"


# ---- throttles and logs ----------------------------------------------------------------------------------------------

def test_ten_wrong_codes_make_the_account_wait_even_before_a_new_ticket_is_issued(sessions, clock):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    app = make_app(sessions, clock)
    with client(app) as c:
        secret, _ = enrol(c, clock, "rec@example.com")
    clock.advance(seconds=31)
    with client(app) as c:
        for _ in range(2):  # two tickets, five wrong codes each: the ticket dies after five
            ticket = log_in(c, "rec@example.com").json()["mfa_ticket"]
            assert [c.post("/api/v1/session/mfa", json={"mfa_ticket": ticket, "code": "000000"}).status_code for _ in range(5)] == [401] * 5
        blocked = log_in(c, "rec@example.com")  # the right password, but the account waits
    assert (blocked.status_code, blocked.json()["code"]) == (429, "REQ-RATE-LIMITED") and 1 <= int(blocked.headers["retry-after"]) <= 900
    assert "mfa_ticket" not in blocked.text
    clock.advance(minutes=16)
    with client(app) as c:
        ticket = log_in(c, "rec@example.com").json()["mfa_ticket"]
        assert c.post("/api/v1/session/mfa", json={"mfa_ticket": ticket, "code": code(secret, clock)}).status_code == 200, "the wait ended by itself"


def test_wrong_codes_at_enrolment_are_throttled_too_and_a_good_one_clears_the_count(sessions, clock):
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    with client(make_app(sessions, clock)) as c:
        csrf = log_in(c, "rec@example.com").json()["csrf_token"]
        secret = parse_qs(urlsplit(c.post("/api/v1/me/mfa", headers=headers(csrf)).json()["otpauth_uri"]).query)["secret"][0]
        wrong = [c.post("/api/v1/me/mfa/confirm", json={"code": "000000"}, headers=headers(csrf)).status_code for _ in range(10)]
        blocked = c.post("/api/v1/me/mfa/confirm", json={"code": code(secret, clock)}, headers=headers(csrf))
    assert wrong == [401] * 10 and (blocked.status_code, blocked.json()["code"]) == (429, "REQ-RATE-LIMITED")


def test_no_code_secret_ticket_or_recovery_code_is_ever_logged(sessions, clock, caplog):
    caplog.set_level(logging.DEBUG)
    add_user(sessions, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
    app = make_app(sessions, clock)
    with client(app) as c:
        secret, codes = enrol(c, clock, "rec@example.com")
    clock.advance(seconds=31)
    with client(app) as c:
        ticket = log_in(c, "rec@example.com").json()["mfa_ticket"]
        good = code(secret, clock)
        c.post("/api/v1/session/mfa", json={"mfa_ticket": ticket, "code": "000000"})
        c.post("/api/v1/session/mfa", json={"mfa_ticket": ticket, "code": good})
    for sensitive in (secret, ticket, good, *codes):
        assert sensitive not in caplog.text
