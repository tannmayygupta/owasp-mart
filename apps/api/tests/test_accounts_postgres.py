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
from vulnmart.accounts.models import EmailToken, User, UserRole
from vulnmart.accounts.security import hash_password, token_hash
from vulnmart.accounts.service import AccountService, TokenInvalid
from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.notifications.models import EmailOutbox
from vulnmart.ports.fakes import FakeSettingsPort

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
