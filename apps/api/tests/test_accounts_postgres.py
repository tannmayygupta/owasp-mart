"""Story P-11 against a real Postgres 18: migration 0003, the rules the database itself enforces (one account per address, only a
participant holds a role), and the races that SQLite cannot show (the same address signing up at once, one link used at once).

Skipped unless VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py).
"""
from __future__ import annotations

import os
import threading
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from support import ROOT
from test_kernel_postgres import with_db
from vulnmart.accounts.models import EmailToken, User, UserRole, UserSession
from vulnmart.accounts.security import hash_password, token_hash
from vulnmart.accounts.admins import AdminService
from vulnmart.accounts.roles import NotAnAdmin, RoleNotAllowed, RoleService
from vulnmart.accounts.service import AccountService, TokenInvalid
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.notifications.models import EmailOutbox
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.ports.scope import Role, Scope

OWNER = os.environ.get("VULNMART_TEST_POSTGRES_DSN")
APP = os.environ.get("VULNMART_TEST_APP_DSN")
pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
GOOD = "correct horse battery staple"


@pytest.fixture(scope="module")
def sessions():
    name = f"vm_p11_{uuid.uuid4().hex[:10]}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
        c.execute(text(f'GRANT CONNECT ON DATABASE "{name}" TO vulnmart_app'))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, name)
    try:
        command.upgrade(Config(str(ROOT / "apps" / "api" / "alembic.ini")), "head")
        engine = create_engine(sqlalchemy_url(with_db(APP, name)), pool_size=12)
        yield sessionmaker(engine, expire_on_commit=False)
        engine.dispose()
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        os.environ.pop("VULNMART_MIGRATE_DSN", None)


@pytest.fixture(autouse=True)
def clean(sessions):
    with sessions.begin() as s:
        s.execute(text("DELETE FROM email_outbox"))
        s.execute(text("DELETE FROM users"))  # roles and tokens go with their user (ON DELETE CASCADE)
    yield


def add_user(session, user_id, email, account_type="participant"):
    session.add(User(id=user_id, account_type=account_type, email=email, email_ci=email.lower(), password_hash=hash_password(GOOD),
                     display_name="T", status="active"))
    session.flush()


def test_the_app_role_can_use_the_tables(sessions):
    with sessions.begin() as s:
        add_user(s, "u-AAAAAAAAAAAAAAAA", "a@example.com")
        s.add(UserRole(user_id="u-AAAAAAAAAAAAAAAA", role="learner", account_type="participant"))
        s.add(EmailToken(token_hash="h" * 64, user_id="u-AAAAAAAAAAAAAAAA", purpose="verify", expires_at=datetime.now(UTC) + timedelta(hours=1)))
    with sessions() as s:
        assert s.scalar(select(User.email_ci)) == "a@example.com"


def test_one_account_per_address_whatever_the_case(sessions):
    with sessions.begin() as s:
        add_user(s, "u-AAAAAAAAAAAAAAAA", "a@example.com")
    with pytest.raises(IntegrityError):
        with sessions.begin() as s:
            add_user(s, "u-BBBBBBBBBBBBBBBB", "A@example.com")


@pytest.mark.parametrize("account_type", ["recruiter", "admin"])
def test_a_recruiter_or_admin_cannot_hold_a_participant_role(sessions, account_type):
    with sessions.begin() as s:
        add_user(s, "u-AAAAAAAAAAAAAAAA", "a@example.com", account_type)
    for declared in ("participant", account_type):  # naming the real type fails the check, naming participant fails the foreign key
        with pytest.raises(IntegrityError):
            with sessions.begin() as s:
                s.execute(text("INSERT INTO user_roles (user_id, role, account_type) VALUES ('u-AAAAAAAAAAAAAAAA', 'learner', :t)"), {"t": declared})


def test_an_account_type_cannot_change_while_it_holds_a_role(sessions):
    with sessions.begin() as s:
        add_user(s, "u-AAAAAAAAAAAAAAAA", "a@example.com")
        s.add(UserRole(user_id="u-AAAAAAAAAAAAAAAA", role="learner", account_type="participant"))
    with pytest.raises(IntegrityError):
        with sessions.begin() as s:
            s.execute(text("UPDATE users SET account_type = 'admin' WHERE id = 'u-AAAAAAAAAAAAAAAA'"))


def test_the_same_address_signing_up_at_once_makes_one_account_and_one_verification_mail(sessions):
    service = AccountService(sessions, FakeSettingsPort(), public_origin="https://vulnmart.example")
    barrier, errors = threading.Barrier(8), []

    def work():
        barrier.wait()
        try:
            service.signup(email="race@example.com", password=GOOD, display_name="Race")
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    with sessions() as s:
        assert len(s.scalars(select(User)).all()) == 1
        templates = sorted(r.template for r in s.scalars(select(EmailOutbox)))
    assert templates.count("account.verify") == 1 and set(templates) <= {"account.verify", "account.already_registered"}
    assert len(templates) == 8, "every request produced exactly one mail"


def test_one_link_used_at_once_works_for_exactly_one_request(sessions):
    service = AccountService(sessions, FakeSettingsPort(), public_origin="https://vulnmart.example")
    with sessions.begin() as s:
        add_user(s, "u-AAAAAAAAAAAAAAAA", "a@example.com")
        token = "T" * 43
        s.add(EmailToken(token_hash=token_hash(token), user_id="u-AAAAAAAAAAAAAAAA", purpose="verify", expires_at=datetime.now(UTC) + timedelta(hours=1)))
    barrier, results = threading.Barrier(8), []

    def work():
        barrier.wait()
        try:
            service.verify_email(token)
            results.append("ok")
        except TokenInvalid:
            results.append("invalid")

    threads = [threading.Thread(target=work) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["invalid"] * 7 + ["ok"]
    with sessions() as s:
        assert s.scalar(select(User.email_verified_at)) is not None


# ---- story P-12: sessions ---------------------------------------------------------------------------------------------

def session_service(sessions):
    return SessionService(sessions, FakeSettingsPort(), b"k" * 32)


def verified_user(sessions, uid="u-AAAAAAAAAAAAAAAA", email="a@example.com"):
    with sessions.begin() as s:
        add_user(s, uid, email)
        s.get(User, uid).email_verified_at = datetime.now(UTC)
        s.add(UserRole(user_id=uid, role="learner", account_type="participant"))


def test_a_session_lives_on_postgres_and_goes_with_its_user(sessions):
    verified_user(sessions)
    service = session_service(sessions)
    result = service.login(email="a@example.com", password=GOOD, ip_trunc="203.0.113.0/24", ua_class="browser")
    assert service.resolve(result.token) is not None
    with sessions() as s:
        stored = s.scalar(select(UserSession))
        assert stored.id_hash == token_hash(result.token) and result.token not in (stored.id_hash, stored.ip_trunc)
    service.logout(result.token)
    assert service.resolve(result.token) is None
    with sessions.begin() as s:
        s.execute(text("DELETE FROM users"))
    with sessions() as s:
        assert s.scalars(select(UserSession)).all() == [], "sessions are removed with their user"


def test_many_logins_at_once_make_that_many_distinct_sessions(sessions):
    verified_user(sessions)
    service = session_service(sessions)
    barrier, tokens, errors = threading.Barrier(8), [], []

    def work():
        barrier.wait()
        try:
            tokens.append(service.login(email="a@example.com", password=GOOD).token)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == [] and len(set(tokens)) == 8
    with sessions() as s:
        assert len(s.scalars(select(UserSession)).all()) == 8


def test_one_session_ended_at_once_ends_once_and_resolving_never_fails(sessions):
    verified_user(sessions)
    service = session_service(sessions)
    token = service.login(email="a@example.com", password=GOOD).token
    barrier, results = threading.Barrier(8), []

    def work():
        barrier.wait()
        results.append(service.logout(token))

    threads = [threading.Thread(target=work) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == [False] * 7 + [True], "exactly one of eight simultaneous logouts ended it"
    assert service.resolve(token) is None
    other = service.login(email="a@example.com", password=GOOD).token
    resolved, barrier = [], threading.Barrier(8)

    def read():
        barrier.wait()
        resolved.append(service.resolve(other) is not None)

    threads = [threading.Thread(target=read) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert resolved == [True] * 8

# ---- story P-13: roles and admins -------------------------------------------------------------------------------------

def run_at_once(count, work):
    barrier, results, errors = threading.Barrier(count), [], []

    def go():
        barrier.wait()
        try:
            results.append(work())
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=go) for _ in range(count)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    return results, errors


def test_the_candidate_role_granted_at_once_is_added_exactly_once(sessions):
    verified_user(sessions)
    audit = FakeAuditPort()
    roles = RoleService(sessions, audit)
    results, errors = run_at_once(8, lambda: roles.grant_candidate_role("u-AAAAAAAAAAAAAAAA"))
    assert errors == [] and results.count(True) == 1 and results.count(False) == 7
    assert roles.roles_of("u-AAAAAAAAAAAAAAAA") == {"candidate", "learner"}
    assert len([r for r in audit.records if r.action == "role.granted"]) >= 1


def test_the_database_and_the_service_both_refuse_a_participant_role_for_a_recruiter_or_admin(sessions):
    with sessions.begin() as s:
        add_user(s, "u-RRRRRRRRRRRRRRRR", "rec@example.com", "recruiter")
        add_user(s, "u-ADMINADMINADMIN2", "admin@example.com", "admin")
    roles = RoleService(sessions, FakeAuditPort())
    for uid in ("u-RRRRRRRRRRRRRRRR", "u-ADMINADMINADMIN2"):
        with pytest.raises(RoleNotAllowed):
            roles.grant_candidate_role(uid)
        with pytest.raises(IntegrityError):  # the same refusal from the database, whatever the code does
            with sessions.begin() as s:
                s.execute(text("INSERT INTO user_roles (user_id, role, account_type) VALUES (:u, 'candidate', 'participant')"), {"u": uid})


def test_an_admin_is_created_once_whatever_the_number_of_seeds_at_once(sessions):
    audit = FakeAuditPort()
    service = AdminService(sessions, FakeSettingsPort(), audit, public_origin="https://vulnmart.example")
    results, errors = run_at_once(6, lambda: service.seed_admin(email="root@example.com", display_name="Root", password="a long admin password 123"))
    assert errors == [] and results.count(True) == 1
    with sessions() as s:
        users = s.scalars(select(User)).all()
        assert [(u.account_type, u.email_ci) for u in users] == [("admin", "root@example.com")]
        assert s.scalars(select(UserRole)).all() == []
    assert [r.action for r in audit.records].count("admin.created") >= 1


def test_an_admin_creates_another_on_postgres_and_a_failed_audit_leaves_nothing(sessions):
    with sessions.begin() as s:
        add_user(s, "u-ADMINADMINADMIN2", "admin@example.com", "admin")
    scope = Scope(user_id="u-ADMINADMINADMIN2", roles=frozenset({Role.ADMIN}))
    service = AdminService(sessions, FakeSettingsPort(), FakeAuditPort(), public_origin="https://vulnmart.example")
    new_id = service.create_admin(scope, email="second@example.com", display_name="Second")
    with sessions() as s:
        assert s.get(User, new_id).account_type == "admin"
        assert s.scalar(select(EmailToken.purpose).where(EmailToken.user_id == new_id)) == "reset"
        assert s.scalar(select(EmailOutbox.template).where(EmailOutbox.to_user_id == new_id)) == "account.admin_created"

    class Broken:
        def append(self, **kw):
            raise RuntimeError("audit down")

    failing = AdminService(sessions, FakeSettingsPort(), Broken(), public_origin="https://vulnmart.example")
    with pytest.raises(RuntimeError):
        failing.create_admin(scope, email="third@example.com", display_name="Third")
    with sessions() as s:
        assert s.scalar(select(User).where(User.email_ci == "third@example.com")) is None, "no account, token or mail without its audit entry"
        assert s.scalar(select(EmailOutbox).where(EmailOutbox.template == "account.admin_created", EmailOutbox.to_user_id != new_id)) is None
    with pytest.raises(NotAnAdmin):
        service.create_admin(Scope(user_id=new_id, roles=frozenset({Role.LEARNER})), email="x@example.com", display_name="X")
