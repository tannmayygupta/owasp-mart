"""Story P-16 against a real Postgres 18: migration 0006, the append-only rule the database itself enforces (the app role cannot change, delete
or truncate a consent record), the one-decision-per-attempt index, and the race of two simultaneous clicks.

Skipped unless VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py).
"""
from __future__ import annotations

import os
import threading
import uuid
from datetime import UTC, datetime

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import sessionmaker

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from support import ROOT
from test_kernel_postgres import with_db
from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.privacy.consent import ConsentService, ConsentState
from vulnmart.privacy.models import ConsentRecord
from vulnmart.privacy.targets import FakeConsentTargets

OWNER = os.environ.get("VULNMART_TEST_POSTGRES_DSN")
APP = os.environ.get("VULNMART_TEST_APP_DSN")
pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
KEYS = FieldKeys.from_secret(b"a field key secret of at least 32 bytes!!")
ALICE = "u-AAAAAAAAAAAAAAAA"


@pytest.fixture(scope="module")
def sessions():
    name = f"vm_p16_{uuid.uuid4().hex[:10]}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
        c.execute(text(f'GRANT CONNECT ON DATABASE "{name}" TO vulnmart_app'))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, name)
    try:
        command.upgrade(Config(str(ROOT / "apps" / "api" / "alembic.ini")), "head")
        engine = create_engine(sqlalchemy_url(with_db(APP, name)), pool_size=12)
        yield sessionmaker(engine, expire_on_commit=False), name
        engine.dispose()
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        os.environ.pop("VULNMART_MIGRATE_DSN", None)


@pytest.fixture
def db(sessions):
    return sessions[0]


def record(attempt, action="granted", n=0):
    return ConsentRecord(id=f"k-{n:016d}", user_id=ALICE, attempt_id=attempt, org_id="o-X", template_id="t-X",
                         notice_version="2026-10-18.1", notice_text_sha256="a" * 64, notice_text_snapshot="text", retention_days_shown=180,
                         controller_name_shown="Acme", action=action, at=datetime.now(UTC), ip_hash=None, ua_hash=None, method="web", audit_seq=1)


def uid() -> str:
    return "a-" + uuid.uuid4().hex[:16].upper().translate(str.maketrans("0189", "ABCD"))


def test_the_app_role_can_add_and_read_records(db):
    attempt = uid()
    with db.begin() as s:
        s.add(record(attempt, n=1))
    with db() as s:
        assert s.scalar(select(ConsentRecord.action).where(ConsentRecord.attempt_id == attempt)) == "granted"


def test_the_app_role_cannot_change_delete_or_truncate_a_record(db):
    attempt = uid()
    with db.begin() as s:
        s.add(record(attempt, n=2))
    for statement in ("UPDATE consent_records SET action = 'declined' WHERE attempt_id = :a", "UPDATE consent_records SET notice_text_snapshot = 'x'",
                      "DELETE FROM consent_records WHERE attempt_id = :a", "DELETE FROM consent_records", "TRUNCATE consent_records"):
        with pytest.raises(DBAPIError, match="permission denied"):
            with db.begin() as s:
                s.execute(text(statement), {"a": attempt})
    with db() as s:
        assert s.scalar(select(ConsentRecord.action).where(ConsentRecord.attempt_id == attempt)) == "granted"


def test_one_granted_or_declined_decision_per_attempt_but_a_withdrawal_may_follow(db):
    attempt = uid()
    with db.begin() as s:
        s.add(record(attempt, "granted", n=3))
    for action, n in (("granted", 4), ("declined", 5)):
        with pytest.raises(IntegrityError):
            with db.begin() as s:
                s.add(record(attempt, action, n=n))
    with db.begin() as s:  # a withdrawal (story P-25) is a new row, not a second decision
        s.add(record(attempt, "withdrawn", n=6))
        s.add(record(attempt, "withdrawn", n=7))
    with db() as s:
        assert sorted(s.scalars(select(ConsentRecord.action).where(ConsentRecord.attempt_id == attempt)).all()) == ["granted", "withdrawn", "withdrawn"]


@pytest.mark.parametrize("change", [{"action": "agreed"}, {"method": "email"}, {"retention_days_shown": 0}])
def test_the_database_refuses_an_unknown_action_a_method_or_zero_retention(db, change):
    row = record(uid(), n=8)
    for key, value in change.items():
        setattr(row, key, value)
    with pytest.raises(IntegrityError):
        with db.begin() as s:
            s.add(row)


def test_a_record_outlives_its_account(sessions, db):
    """No foreign key: deleting the user leaves the proof that they were asked (the deletion workflow of story P-25 pseudonymises user_id)."""
    attempt, owner = uid(), sessions[1]
    with db.begin() as s:
        s.add(record(attempt, n=9))
    with create_engine(sqlalchemy_url(with_db(OWNER, owner))).begin() as c:
        c.execute(text("INSERT INTO users (id, account_type, email, email_ci, password_hash, display_name, status) "
                       "VALUES (:u, 'participant', 'a@example.com', 'a@example.com', 'x', 'A', 'active')"), {"u": ALICE})
    with create_engine(sqlalchemy_url(with_db(OWNER, owner))).begin() as c:
        assert c.execute(text("DELETE FROM users WHERE id = :u"), {"u": ALICE}).rowcount == 1
    with db() as s:
        assert s.scalar(select(func.count()).select_from(ConsentRecord).where(ConsentRecord.attempt_id == attempt)) == 1


def test_eight_simultaneous_grants_write_one_record_one_audit_entry_and_move_the_attempt_once(db):
    attempt = uid()
    targets, audit = FakeConsentTargets(), FakeAuditPort()
    targets.add(attempt_id=attempt, user_id=ALICE)
    service = ConsentService(db, targets, audit, FakeSettingsPort(), KEYS)
    n = service.notice(ALICE, attempt)[1]
    barrier, results, errors = threading.Barrier(8), [], []

    def click():
        barrier.wait()
        try:
            results.append(service.record(user_id=ALICE, attempt_id=attempt, notice_version=n.version, notice_sha256=n.sha256, decision="granted",
                                          ip="203.0.113.7", user_agent="Test"))
        except Exception as exc:  # noqa: BLE001 - the test counts what happens
            errors.append(exc)

    threads = [threading.Thread(target=click) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == [] and len({r.consent_id for r in results}) == 1 and len(results) == 8
    with db() as s:
        assert s.scalar(select(func.count()).select_from(ConsentRecord).where(ConsentRecord.attempt_id == attempt)) == 1
    assert len(audit.records) == 1 and len(targets.applied) == 1 and targets.find(attempt).state == "ready"


def test_a_simultaneous_grant_and_decline_write_one_record_and_one_side_loses(db):
    attempt = uid()
    targets, audit = FakeConsentTargets(), FakeAuditPort()
    targets.add(attempt_id=attempt, user_id=ALICE)
    service = ConsentService(db, targets, audit, FakeSettingsPort(), KEYS)
    n = service.notice(ALICE, attempt)[1]
    barrier, outcomes = threading.Barrier(8), []

    def click(decision):
        barrier.wait()
        try:
            outcomes.append((decision, service.record(user_id=ALICE, attempt_id=attempt, notice_version=n.version, notice_sha256=n.sha256,
                                                      decision=decision, ip=None, user_agent=None).decision))
        except ConsentState:
            outcomes.append((decision, "conflict"))

    threads = [threading.Thread(target=click, args=("granted" if i % 2 else "declined",)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    with db() as s:
        winner = s.scalars(select(ConsentRecord.action).where(ConsentRecord.attempt_id == attempt)).all()
    assert len(winner) == 1 and len(audit.records) == 1 and len(targets.applied) == 1
    assert all(result in (decision, "conflict") for decision, result in outcomes) and {d for d, r in outcomes if r == winner[0]} == {winner[0]}
    assert all(r == "conflict" for d, r in outcomes if d != winner[0])


def test_migration_0006_goes_down_and_up_again(sessions):
    name = sessions[1]
    owner_dsn = with_db(OWNER, name)
    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    os.environ["VULNMART_MIGRATE_DSN"] = owner_dsn
    engine = create_engine(sqlalchemy_url(owner_dsn))
    command.downgrade(cfg, "0005")
    with engine.connect() as c:
        assert c.execute(text("SELECT to_regclass('consent_records')")).scalar_one() is None
    command.upgrade(cfg, "head")
    with engine.connect() as c:
        assert c.execute(text("SELECT to_regclass('consent_records')")).scalar_one() == "consent_records"
        assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() >= "0006"
        privileges = {r[0] for r in c.execute(text("SELECT privilege_type FROM information_schema.role_table_grants "
                                                   "WHERE table_name = 'consent_records' AND grantee = 'vulnmart_app'"))}
    assert privileges == {"SELECT", "INSERT"}
    engine.dispose()
