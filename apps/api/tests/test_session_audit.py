"""Story P-17 (FR-PRV-10): logins, failed logins and logouts are written to the audit log, without the email address, the password or the session value."""
from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
from vulnmart.accounts import security
from vulnmart.accounts.models import User, UserRole
from vulnmart.accounts.sessions import EmailNotVerified, InvalidCredentials, SessionService
from vulnmart.kernel.db import Base
from vulnmart.ports.audit import verify_chain
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort

PASSWORD = "correct horse battery staple"
T0 = datetime(2026, 10, 18, 10, 0, 7, tzinfo=UTC)
_HASH = security.hash_password(PASSWORD)


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def audit():
    return FakeAuditPort()


@pytest.fixture
def service(sessions, audit):
    return SessionService(sessions, FakeSettingsPort(), b"k" * 32, now=lambda: T0, audit=audit)


def add_user(sessions, uid="u-AAAAAAAAAAAAAAAA", email="ada@example.com", verified=True, status="active"):
    with sessions.begin() as s:
        s.add(User(id=uid, account_type="participant", email=email, email_ci=email, password_hash=_HASH, display_name="Ada", status=status,
                   email_verified_at=T0 if verified else None))
        s.flush()
        s.add(UserRole(user_id=uid, role="learner", account_type="participant"))


def actions(audit):
    return [(r.action, r.actor, r.subject, dict(r.details)) for r in audit.records]


def test_a_login_is_logged_with_the_user_and_whether_a_second_factor_was_proved(service, sessions, audit):
    add_user(sessions)
    service.login(email="ada@example.com", password=PASSWORD)
    assert actions(audit) == [("auth.login", "u-AAAAAAAAAAAAAAAA", "u-AAAAAAAAAAAAAAAA", {"mfa": False})]
    service.open_session("u-AAAAAAAAAAAAAAAA", ip_trunc=None, ua_class=None, mfa=True)
    assert actions(audit)[-1][3] == {"mfa": True}


@pytest.mark.parametrize("email,password,verified,status,reason,has_subject", [
    ("ada@example.com", "a wrong password entirely", True, "active", "bad_password", True),
    ("nobody@example.com", PASSWORD, True, "active", "unknown_or_inactive", False),
    ("ada@example.com", PASSWORD, True, "disabled", "unknown_or_inactive", False),
    ("ada@example.com", PASSWORD, False, "active", "not_verified", True),
])
def test_a_failed_login_is_logged_with_a_reason_and_never_the_address_or_the_password(service, sessions, audit, email, password, verified, status, reason, has_subject):
    add_user(sessions, verified=verified, status=status)
    with pytest.raises((InvalidCredentials, EmailNotVerified)):
        service.login(email=email, password=password)
    [(action, actor, subject, details)] = actions(audit)
    assert action == "auth.login_failed" and actor == "system:login" and details == {"reason": reason}
    assert (subject == "u-AAAAAAAAAAAAAAAA") is has_subject
    dump = json.dumps([r.details for r in audit.records]) + str([(r.actor, r.subject) for r in audit.records])
    assert "example.com" not in dump and "wrong password" not in dump and PASSWORD not in dump


def test_a_logout_is_logged_once_and_only_when_a_session_ended(service, sessions, audit):
    add_user(sessions)
    token = service.login(email="ada@example.com", password=PASSWORD).token
    audit.records.clear()
    assert service.logout(token) is True and service.logout(token) is False and service.logout("x" * 43) is False
    assert actions(audit) == [("auth.logout", "u-AAAAAAAAAAAAAAAA", "u-AAAAAAAAAAAAAAAA", {})]
    assert token not in json.dumps([r.details for r in audit.records])


def test_the_chain_of_the_login_entries_verifies(service, sessions, audit):
    add_user(sessions)
    service.login(email="ada@example.com", password=PASSWORD)
    with pytest.raises(InvalidCredentials):
        service.login(email="ada@example.com", password="nope nope nope nope")
    assert verify_chain(audit.records) and len(audit.records) == 2


def test_without_an_audit_port_nothing_changes(sessions):
    add_user(sessions)
    plain = SessionService(sessions, FakeSettingsPort(), b"k" * 32, now=lambda: T0)
    assert plain.logout(plain.login(email="ada@example.com", password=PASSWORD).token) is True
