"""Story P-12: login, server-side sessions, idle and absolute timeouts, rotation, a user's own sessions and the CSRF token, on SQLite."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from argon2 import PasswordHasher
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
from vulnmart.accounts import security
from vulnmart.accounts.models import User, UserRole, UserSession
from vulnmart.accounts.sessions import EmailNotVerified, InvalidCredentials, SessionService
from vulnmart.kernel.db import Base
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.scope import Role

T0 = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)
PASSWORD = "correct horse battery staple"
KEY = b"k" * 32


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


@pytest.fixture
def service(sessions, clock):
    return SessionService(sessions, FakeSettingsPort(), KEY, now=clock)


_HASH = security.hash_password(PASSWORD)  # one hash for every test user: Argon2id is slow on purpose


def add_user(sessions, uid="u-AAAAAAAAAAAAAAAA", email="ada@example.com", *, account_type="participant", verified=True, status="active",
             password_hash=None, roles=("learner",)):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type=account_type, email=email, email_ci=email.lower(), password_hash=password_hash or _HASH,
                   display_name="Ada", status=status, email_verified_at=T0 if verified else None))
        s.flush()
        if account_type == "participant":
            for role in roles:
                s.add(UserRole(user_id=uid, role=role, account_type="participant"))
    return uid


def login(service, email="ada@example.com", password=PASSWORD):
    return service.login(email=email, password=password, ip_trunc="203.0.113.0/24", ua_class="browser")


def rows(sessions):
    with sessions() as s:
        return s.scalars(select(UserSession)).all()


# ---- login -----------------------------------------------------------------------------------------------------------

def test_a_login_makes_a_session_whose_value_is_not_stored(service, sessions, clock):
    add_user(sessions)
    result = login(service)
    assert len(result.token) >= 43 and result.session.user.email == "ada@example.com" and result.session.user.email_verified
    (row,) = rows(sessions)
    assert row.id_hash == security.token_hash(result.token) != result.token, "only the hash is stored"
    assert (row.ip_trunc, row.ua_class, row.revoked_at) == ("203.0.113.0/24", "browser", None)
    assert result.session.idle_expires_at == T0 + timedelta(minutes=30) and result.session.absolute_expires_at == T0 + timedelta(hours=12)
    with sessions() as s:
        assert s.scalar(select(User.last_login_at)) is not None


def test_every_login_is_a_new_session_value(service, sessions):
    add_user(sessions)
    assert login(service).token != login(service).token
    assert len(rows(sessions)) == 2


@pytest.mark.parametrize("email,password", [("ada@example.com", "wrong password here"), ("nobody@example.com", PASSWORD), ("not an address", PASSWORD)])
def test_a_wrong_password_and_an_unknown_account_are_the_same_error(service, sessions, email, password):
    add_user(sessions)
    with pytest.raises(InvalidCredentials):
        login(service, email, password)
    assert rows(sessions) == []


@pytest.mark.parametrize("status", ["disabled", "deleted"])
def test_a_disabled_or_deleted_account_cannot_log_in_and_looks_like_a_wrong_password(service, sessions, status):
    add_user(sessions, status=status)
    with pytest.raises(InvalidCredentials):
        login(service)


def test_an_unverified_address_is_told_so_only_after_the_password_was_right(service, sessions):
    add_user(sessions, verified=False)
    with pytest.raises(InvalidCredentials):
        login(service, password="wrong password here")
    with pytest.raises(EmailNotVerified):
        login(service)
    assert rows(sessions) == []


def test_an_admin_with_only_the_password_gets_a_session_that_carries_no_admin_role(service, sessions):
    add_user(sessions, account_type="admin")
    result = login(service)
    assert result.session.roles == frozenset() and result.session.mfa_verified is False and result.session.user.mfa_enabled is False
    assert result.session.scope.is_admin is False, "an admin without a second factor reaches no admin function (FR-ACC-07)"
    assert service.resolve(result.token).roles == frozenset(), "and it stays that way on every request"


def test_an_old_password_hash_is_upgraded_at_login(service, sessions):
    weak = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1).hash(PASSWORD)
    add_user(sessions, password_hash=weak)
    login(service)
    with sessions() as s:
        assert s.scalar(select(User.password_hash)).startswith("$argon2id$v=19$m=19456,t=2,p=1$")
    login(service)  # and the new hash works


def test_the_scope_of_a_session_carries_the_roles(service, sessions):
    add_user(sessions, roles=("learner", "candidate"))
    add_user(sessions, "u-BBBBBBBBBBBBBBBB", "rec@example.com", account_type="recruiter")
    assert login(service).session.scope.roles == frozenset({Role.LEARNER, Role.CANDIDATE})
    recruiter = login(service, "rec@example.com").session.scope
    assert recruiter.roles == frozenset({Role.RECRUITER}) and recruiter.user_id == "u-BBBBBBBBBBBBBBBB" and recruiter.org_id is None


# ---- timeouts --------------------------------------------------------------------------------------------------------

def test_a_session_ends_after_30_idle_minutes_and_stays_ended(service, sessions, clock):
    add_user(sessions)
    token = login(service).token
    clock.advance(minutes=29, seconds=59)
    assert service.resolve(token) is not None
    clock.advance(minutes=30)  # nothing happened for 30 minutes since the last request
    assert service.resolve(token) is None
    assert rows(sessions)[0].revoked_at is not None
    clock.now = T0  # even a clock set back does not bring it back
    assert service.resolve(token) is None


def test_activity_keeps_a_session_alive_until_the_absolute_limit(service, sessions, clock):
    add_user(sessions)
    token = login(service).token
    for _ in range(40):  # a request every 20 minutes: never idle for 30 (36 steps reach 12 hours)
        clock.advance(minutes=20)
        if clock.now >= T0 + timedelta(hours=12):
            break
        assert service.resolve(token) is not None, f"alive at {clock.now - T0}"
    assert clock.now >= T0 + timedelta(hours=12)
    assert service.resolve(token) is None, "the absolute limit of 12 hours ends it whatever happened"


def test_the_idle_limit_of_an_admin_is_15_minutes(service, sessions, clock):
    add_user(sessions)
    # an admin cannot log in yet (P-15): make the session by hand to test the clock rule
    add_user(sessions, "u-CCCCCCCCCCCCCCCC", "admin@example.com", account_type="admin")
    token = security.new_token()
    with sessions.begin() as s:
        s.add(UserSession(id_hash=security.token_hash(token), user_id="u-CCCCCCCCCCCCCCCC", last_seen_at=T0,
                          absolute_expires_at=T0 + timedelta(hours=12)))
    clock.advance(minutes=14, seconds=59)
    resolved = service.resolve(token)
    assert resolved is not None and resolved.idle_expires_at == clock.now + timedelta(minutes=15)
    clock.advance(minutes=15)
    assert service.resolve(token) is None


def test_last_seen_is_written_at_most_once_a_minute(service, sessions, clock):
    add_user(sessions)
    token = login(service).token
    clock.advance(seconds=30)
    service.resolve(token)
    assert rows(sessions)[0].last_seen_at.replace(tzinfo=UTC) == T0, "no write inside a minute"
    clock.advance(seconds=31)
    service.resolve(token)
    assert rows(sessions)[0].last_seen_at.replace(tzinfo=UTC) == clock.now


def test_the_timeouts_are_settings(sessions, clock):
    service = SessionService(sessions, FakeSettingsPort({"session_idle_minutes": 5, "session_absolute_hours": 1}), KEY, now=clock)
    add_user(sessions)
    token = login(service).token
    clock.advance(minutes=6)
    assert service.resolve(token) is None


def test_a_session_ends_when_its_account_is_disabled(service, sessions):
    add_user(sessions)
    token = login(service).token
    with sessions.begin() as s:
        s.scalar(select(User)).status = "disabled"
    assert service.resolve(token) is None


# ---- logout, rotation, own sessions ------------------------------------------------------------------------------------

def test_logout_ends_the_session_at_once_and_a_stolen_copy_stops_working(service, sessions):
    add_user(sessions)
    token = login(service).token
    assert service.resolve(token) is not None
    assert service.logout(token) is True
    assert service.resolve(token) is None
    assert service.logout(token) is False and service.logout("never-issued") is False


def test_rotation_gives_a_new_value_keeps_the_deadline_and_kills_the_old_one(service, sessions, clock):
    add_user(sessions)
    first = login(service)
    clock.advance(hours=1)
    new = service.rotate(first.token)
    assert new and new != first.token
    assert service.resolve(first.token) is None
    resolved = service.resolve(new)
    assert resolved is not None and resolved.absolute_expires_at == first.session.absolute_expires_at, "rotation never extends a session"
    assert service.rotate(first.token) is None and service.rotate("never-issued") is None


def test_a_user_lists_and_revokes_only_their_own_sessions(service, sessions):
    add_user(sessions)
    add_user(sessions, "u-BBBBBBBBBBBBBBBB", "bob@example.com")
    mine_a, mine_b, bobs = login(service), login(service), login(service, "bob@example.com")
    listed = service.list_sessions("u-AAAAAAAAAAAAAAAA", current=mine_a.token)
    assert len(listed) == 2 and [s.current for s in listed].count(True) == 1 and all(len(s.ref) == 16 for s in listed)
    bobs_ref = service.list_sessions("u-BBBBBBBBBBBBBBBB")[0].ref
    assert service.revoke("u-AAAAAAAAAAAAAAAA", bobs_ref) is False, "another user's session is simply not found"
    assert service.resolve(bobs.token) is not None
    other = next(s for s in listed if not s.current)
    assert service.revoke("u-AAAAAAAAAAAAAAAA", other.ref) is True and service.revoke("u-AAAAAAAAAAAAAAAA", other.ref) is False
    assert service.resolve(mine_b.token) is None and service.resolve(mine_a.token) is not None
    assert service.revoke("u-AAAAAAAAAAAAAAAA", "short") is False


def test_log_out_everywhere_with_and_without_keeping_the_current_one(service, sessions):
    add_user(sessions)
    one, two, three = login(service), login(service), login(service)
    assert service.revoke_all("u-AAAAAAAAAAAAAAAA", keep=one.token) == 2
    assert service.resolve(one.token) is not None and service.resolve(two.token) is None and service.resolve(three.token) is None
    assert service.revoke_all("u-AAAAAAAAAAAAAAAA") == 1
    assert service.resolve(one.token) is None


def test_an_ended_session_is_not_in_the_list(service, sessions, clock):
    add_user(sessions)
    login(service)
    clock.advance(minutes=31)
    assert service.list_sessions("u-AAAAAAAAAAAAAAAA") == []


# ---- CSRF ------------------------------------------------------------------------------------------------------------

def test_the_csrf_token_belongs_to_one_session_and_one_key(service, sessions, clock):
    add_user(sessions)
    a, b = login(service).token, login(service).token
    token_a = service.csrf_token(a)
    assert len(token_a) == 43 and token_a == service.csrf_token(a) != service.csrf_token(b)
    other_key = SessionService(sessions, FakeSettingsPort(), b"z" * 32, now=clock)
    assert other_key.csrf_token(a) != token_a
    assert service.csrf_ok(a, token_a) and not service.csrf_ok(b, token_a)
    assert not service.csrf_ok(a, None) and not service.csrf_ok(a, "") and not service.csrf_ok(a, token_a[:-1]) and not service.csrf_ok(a, token_a + "x")


def test_a_short_csrf_key_is_refused(sessions):
    with pytest.raises(ValueError):
        SessionService(sessions, FakeSettingsPort(), b"short")
