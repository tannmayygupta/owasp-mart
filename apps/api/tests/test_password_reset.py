"""Story P-14, password reset (FR-ACC-08): the reset link at service level and over HTTP, including that the weak-password refusal does not use up
the link, that a reset ends every session and clears the login throttle, and that the link of an admin-created admin is a reset link."""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from vulnmart.accounts import security
from vulnmart.accounts.admins import AdminService
from vulnmart.accounts.models import EmailToken, User, UserRole, UserSession
from vulnmart.accounts.passwords import CommonPasswordList, PasswordPolicy, _common_passwords
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.service import AccountService, InvalidInput, TokenInvalid
from vulnmart.accounts.sessions import MfaUnavailable, SessionService
from vulnmart.kernel.db import Base
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.settings import Settings
from vulnmart.main import create_app
from vulnmart.notifications.models import EmailOutbox
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.ports.scope import Role, Scope

ORIGIN = "http://127.0.0.1:3000"
OLD = "correct horse battery staple"
NEW = "purple tractor midnight lantern"
EMAIL = "ada@example.com"
T0 = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)
_HASH = security.hash_password(OLD)
POLICY = PasswordPolicy(CommonPasswordList())
# a password from the bundled list that the form would let through by length (12 or more characters) and variety (4 or more different characters)
COMMON = next(p for p in sorted(_common_passwords()) if len(p) >= 12 and len(set(p)) >= 4)


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


def add_user(sessions, uid="u-AAAAAAAAAAAAAAAA", email=EMAIL, *, verified=True, account_type="participant", name="Ada Learner"):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type=account_type, email=email, email_ci=email.lower(), password_hash=_HASH, display_name=name,
                   status="active", email_verified_at=T0 if verified else None))
        s.flush()
        if account_type == "participant":
            s.add(UserRole(user_id=uid, role="learner", account_type="participant"))
    return uid


def service(sessions, clock):
    return AccountService(sessions, FakeSettingsPort(), public_origin="https://vulnmart.example", now=clock, policy=POLICY)


def mails(sessions, template="account.password_reset"):
    with sessions() as s:
        return [(r.to_user_id, dict(r.params)) for r in s.scalars(select(EmailOutbox).where(EmailOutbox.template == template).order_by(EmailOutbox.id))]


def token_of(params) -> str:
    return re.search(r"token=([A-Za-z0-9_-]{43})", params["link"]).group(1)


def stored_hash(sessions, uid="u-AAAAAAAAAAAAAAAA"):
    with sessions() as s:
        return s.get(User, uid).password_hash


# ---- the reset request ---------------------------------------------------------------------------------------------

def test_a_reset_request_mails_a_single_use_link_stored_only_as_a_hash(sessions, clock):
    uid = add_user(sessions)
    service(sessions, clock).request_reset(email="ADA@example.com")
    ((to, params),) = mails(sessions)
    token = token_of(params)
    assert to == uid and params["link"] == f"https://vulnmart.example/reset-password?token={token}" and params["expires_in_hours"] == 24
    with sessions() as s:
        (row,) = s.scalars(select(EmailToken)).all()
    assert (row.purpose, row.token_hash, row.used_at) == ("reset", security.token_hash(token), None) and row.token_hash != token
    assert row.expires_at.replace(tzinfo=UTC) == T0 + timedelta(hours=24)


def test_a_second_request_kills_the_first_link(sessions, clock):
    add_user(sessions)
    svc = service(sessions, clock)
    svc.request_reset(email=EMAIL)
    first = token_of(mails(sessions)[0][1])
    svc.request_reset(email=EMAIL)
    second = token_of(mails(sessions)[1][1])
    assert first != second
    with pytest.raises(TokenInvalid):
        svc.confirm_reset(token=first, new_password=NEW)
    svc.confirm_reset(token=second, new_password=NEW)


def test_an_unknown_or_disabled_address_gets_no_mail_and_no_error(sessions, clock):
    uid = add_user(sessions)
    with sessions.begin() as s:
        s.get(User, uid).status = "disabled"
    svc = service(sessions, clock)
    svc.request_reset(email=EMAIL)
    svc.request_reset(email="nobody@example.com")
    assert mails(sessions) == []
    with pytest.raises(InvalidInput):
        svc.request_reset(email="not an address")


# ---- the confirmation ------------------------------------------------------------------------------------------------

def test_a_link_sets_the_password_once_and_ends_every_session(sessions, clock):
    add_user(sessions)
    svc = service(sessions, clock)
    login = SessionService(sessions, FakeSettingsPort(), b"k" * 32, now=clock)
    old_sessions = [login.login(email=EMAIL, password=OLD).token for _ in range(2)]
    svc.request_reset(email=EMAIL)
    token = token_of(mails(sessions)[0][1])
    clock.advance(minutes=5)
    assert svc.confirm_reset(token=token, new_password=NEW) == EMAIL
    assert security.verify_password(stored_hash(sessions), NEW) and not security.verify_password(stored_hash(sessions), OLD)
    assert [login.resolve(t) for t in old_sessions] == [None, None], "every session ended"
    assert login.login(email=EMAIL, password=NEW).session.user.email == EMAIL
    with pytest.raises(TokenInvalid):
        svc.confirm_reset(token=token, new_password="another purple tractor lantern")


def test_an_expired_unknown_or_wrong_kind_of_link_is_the_same_error(sessions, clock):
    uid = add_user(sessions)
    svc = service(sessions, clock)
    svc.request_reset(email=EMAIL)
    token = token_of(mails(sessions)[0][1])
    with sessions.begin() as s:  # a verification link is not a reset link
        s.add(EmailToken(token_hash=security.token_hash("v" * 43), user_id=uid, purpose="verify", expires_at=T0 + timedelta(hours=1)))
    for candidate in ("v" * 43, security.new_token()):
        with pytest.raises(TokenInvalid):
            svc.confirm_reset(token=candidate, new_password=NEW)
    clock.advance(hours=24, seconds=1)
    with pytest.raises(TokenInvalid):
        svc.confirm_reset(token=token, new_password=NEW)
    assert security.verify_password(stored_hash(sessions), OLD)


@pytest.mark.parametrize("bad,kind", [
    (COMMON, "password_common"), ("short", "password_length"), ("aaaaaaaaaaaaaaaa", "password_common"),
    ("ada.learner is my name", "password_identity"), ("my ada@example.com mail", "password_identity"),
])
def test_a_weak_password_is_refused_with_its_reason_and_the_link_is_not_used_up(sessions, clock, bad, kind):
    add_user(sessions)
    svc = service(sessions, clock)
    svc.request_reset(email=EMAIL)
    token = token_of(mails(sessions)[0][1])
    with pytest.raises(InvalidInput) as caught:
        svc.confirm_reset(token=token, new_password=bad)
    assert (caught.value.pointer, caught.value.kind) == ("/new_password", kind)
    assert security.verify_password(stored_hash(sessions), OLD), "nothing changed"
    svc.confirm_reset(token=token, new_password=NEW)  # the same link still works with a good password


def test_confirming_a_reset_verifies_an_unverified_address(sessions, clock):
    add_user(sessions, verified=False)
    svc = service(sessions, clock)
    svc.request_reset(email=EMAIL)
    svc.confirm_reset(token=token_of(mails(sessions)[0][1]), new_password=NEW)
    with sessions() as s:
        assert s.get(User, "u-AAAAAAAAAAAAAAAA").email_verified_at is not None, "the link proved the mailbox"


def test_the_link_of_an_admin_made_by_an_admin_is_a_reset_link(sessions, clock):
    add_user(sessions, "u-ADMINADMINADMIN2", "admin@example.com", account_type="admin", name="First Admin")
    admins = AdminService(sessions, FakeSettingsPort(), FakeAuditPort(), public_origin="https://vulnmart.example", now=clock, policy=POLICY)
    new_id = admins.create_admin(Scope(user_id="u-ADMINADMINADMIN2", roles=frozenset({Role.ADMIN})), email="second@example.com", display_name="Second Admin")
    ((to, params),) = mails(sessions, "account.admin_created")
    assert to == new_id and "/reset-password?token=" in params["link"]
    service(sessions, clock).confirm_reset(token=token_of(params), new_password=NEW)
    assert security.verify_password(stored_hash(sessions, new_id), NEW)
    with pytest.raises(MfaUnavailable):  # and the admin still cannot sign in before the second factor exists (story P-15)
        SessionService(sessions, FakeSettingsPort(), b"k" * 32, now=clock).login(email="second@example.com", password=NEW)


# ---- over HTTP -------------------------------------------------------------------------------------------------------

def make_app(sessions, clock, *, overrides=None):
    settings = FakeSettingsPort(overrides or {})
    session_service = SessionService(sessions, settings, b"k" * 32, now=clock)
    app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(now=lambda: clock.now.timestamp()), policy=POLICY,
                     accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock, policy=POLICY), sessions=session_service,
                     self_service=SelfService(sessions, session_service, POLICY))
    app.state.ports.settings = settings
    return app


def client(app) -> TestClient:
    return TestClient(app, headers={"origin": ORIGIN}, base_url="https://testserver", raise_server_exceptions=False)


def log_in(c, password=OLD, email=EMAIL):
    return c.post("/api/v1/session", json={"email": email, "password": password})


def test_the_request_answers_202_whatever_the_address_is_and_needs_the_dashboard_origin(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        known = c.post("/api/v1/password-reset/request", json={"email": EMAIL})
        unknown = c.post("/api/v1/password-reset/request", json={"email": "nobody@example.com"})
        forbidden = c.post("/api/v1/password-reset/request", json={"email": EMAIL}, headers={"origin": "https://evil.example"})
        bad = c.post("/api/v1/password-reset/request", json={"email": "nope"})
    assert (known.status_code, known.json(), known.headers["cache-control"]) == (unknown.status_code, unknown.json(), unknown.headers["cache-control"]) \
        == (202, {"status": "accepted"}, "private, no-store")
    assert len(mails(sessions)) == 1
    assert (forbidden.status_code, forbidden.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN") and bad.status_code == 422


def test_reset_requests_are_limited_per_address_and_per_email(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        per_email = [c.post("/api/v1/password-reset/request", json={"email": EMAIL}).status_code for _ in range(4)]
    assert per_email == [202, 202, 202, 429]
    with client(make_app(sessions, clock, overrides={"rate_reset_request_per_ip_per_hour": 2})) as c:
        per_ip = [c.post("/api/v1/password-reset/request", json={"email": f"user{i}@example.com"}).status_code for i in range(3)]
    assert per_ip == [202, 202, 429]


def test_confirming_over_http_sets_the_password_ends_sessions_and_clears_the_login_throttle(sessions, clock):
    add_user(sessions)
    app = make_app(sessions, clock)
    with client(app) as c, client(app) as other:
        assert log_in(other).status_code == 200
        for _ in range(10):  # ten wrong passwords: the address now waits
            log_in(c, password="not the password at all")
        assert log_in(c).status_code == 429
        c.post("/api/v1/password-reset/request", json={"email": EMAIL})
        token = token_of(mails(sessions)[0][1])
        done = c.post("/api/v1/password-reset/confirm", json={"token": token, "new_password": NEW})
        again = c.post("/api/v1/password-reset/confirm", json={"token": token, "new_password": NEW})
        old_session = other.get("/api/v1/session")
        with_old = log_in(c, password=OLD)
        with_new = log_in(c, password=NEW)
    assert done.status_code == 204 and done.content == b"" and done.headers["cache-control"] == "private, no-store"
    assert (again.status_code, again.json()["code"]) == (400, "AUTH-TOKEN-INVALID")
    assert old_session.status_code == 401, "the other browser's session ended"
    assert with_old.status_code == 401 and with_new.status_code == 200, "the wait was cleared by the reset"


@pytest.mark.parametrize("bad,detail", [
    (COMMON, "This password is too easy to guess. Choose another one."),
    ("ada.learner for ever", "The password must not contain your email address or your name."),
])
def test_a_weak_password_is_422_with_a_fixed_sentence_and_the_link_survives(sessions, clock, bad, detail):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        c.post("/api/v1/password-reset/request", json={"email": EMAIL})
        token = token_of(mails(sessions)[0][1])
        weak = c.post("/api/v1/password-reset/confirm", json={"token": token, "new_password": bad})
        good = c.post("/api/v1/password-reset/confirm", json={"token": token, "new_password": NEW})
    assert weak.status_code == 422 and weak.json()["errors"] == [{"pointer": "/new_password", "detail": detail}]
    assert bad not in weak.text and good.status_code == 204


def test_confirm_refuses_bad_bodies_unknown_links_and_other_origins(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        unknown = c.post("/api/v1/password-reset/confirm", json={"token": "U" * 43, "new_password": NEW})
        short = c.post("/api/v1/password-reset/confirm", json={"token": "U" * 43, "new_password": "short"})
        malformed = c.post("/api/v1/password-reset/confirm", json={"token": "x", "new_password": NEW})
        extra = c.post("/api/v1/password-reset/confirm", json={"token": "U" * 43, "new_password": NEW, "email": EMAIL})
        origin = c.post("/api/v1/password-reset/confirm", json={"token": "U" * 43, "new_password": NEW}, headers={"origin": "https://evil.example"})
    assert (unknown.status_code, unknown.json()["code"]) == (400, "AUTH-TOKEN-INVALID")
    assert short.status_code == malformed.status_code == extra.status_code == 422
    assert (origin.status_code, origin.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN")


def test_guesses_at_link_tokens_are_limited_per_address(sessions, clock):
    with client(make_app(sessions, clock, overrides={"rate_verify_per_ip_per_hour": 2})) as c:
        codes = [c.post("/api/v1/password-reset/confirm", json={"token": "U" * 43, "new_password": NEW}).status_code for _ in range(3)]
    assert codes == [400, 400, 429]


def test_signup_now_refuses_a_common_password_with_the_fixed_sentence(sessions, clock):
    with client(make_app(sessions, clock)) as c:
        r = c.post("/api/v1/accounts", json={"email": "new@example.com", "password": COMMON, "display_name": "New", "age_declaration": True})
        ok = c.post("/api/v1/accounts", json={"email": "new@example.com", "password": NEW, "display_name": "New", "age_declaration": True})
    assert r.status_code == 422 and r.json()["errors"] == [{"pointer": "/password", "detail": "This password is too easy to guess. Choose another one."}]
    assert ok.status_code == 202
    with sessions() as s:
        assert len(s.scalars(select(User)).all()) == 1
