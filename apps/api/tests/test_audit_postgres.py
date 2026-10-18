"""Story P-17 against a real Postgres 18: migration 0007, the privileges the database itself enforces (the app role can read and insert audit rows and
cannot change, delete or truncate them), many writers at once (spike S-10, first half: the chain stays gapless and verifies), and the pseudonym race.

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
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import sessionmaker

import vulnmart.kernel.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from support import ROOT
from test_kernel_postgres import with_db
from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.kernel.audit import AuditAnchors, DbAuditPort, ListAnchorSink
from vulnmart.kernel.models import AuditCheckpoint, AuditLog
from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.privacy.models import SubjectMap
from vulnmart.privacy.subjects import PseudonymisingAudit, SubjectService

OWNER = os.environ.get("VULNMART_TEST_POSTGRES_DSN")
APP = os.environ.get("VULNMART_TEST_APP_DSN")
pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
KEYS = FieldKeys.from_secret(b"a field key secret of at least 32 bytes!!")
ALICE = "u-AAAAAAAAAAAAAAAA"


@pytest.fixture(scope="module")
def database():
    name = f"vm_p17_{uuid.uuid4().hex[:10]}"
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
def sessions(database):
    return database[0]


@pytest.fixture
def owner(database):
    engine = create_engine(sqlalchemy_url(with_db(OWNER, database[1])))
    yield engine
    engine.dispose()


@pytest.fixture(autouse=True)
def clean(owner):
    with owner.begin() as c:  # as the owner: the application role cannot delete audit rows, which is the point
        c.execute(text("DELETE FROM audit_log"))
        c.execute(text("DELETE FROM audit_checkpoint"))
        c.execute(text("DELETE FROM audit_anchor"))
        c.execute(text("DELETE FROM subject_map"))
    yield


def test_the_app_role_can_append_and_read(sessions):
    audit = DbAuditPort(sessions)
    record = audit.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted", subject="s-BBBBBBBBBBBBBBBB", details={"attempt": "a-X"})
    assert record.seq == 1 and audit.verify().ok and audit.head() == (1, record.row_hash)


@pytest.mark.parametrize("statement", [
    "UPDATE audit_log SET actor = 's-X'", "DELETE FROM audit_log", "TRUNCATE audit_log",
    "UPDATE audit_checkpoint SET hash = 'x'", "DELETE FROM audit_checkpoint", "TRUNCATE audit_checkpoint",
    "UPDATE audit_anchor SET head_hash = 'x'", "DELETE FROM audit_anchor", "TRUNCATE audit_anchor",
    "UPDATE subject_map SET user_id = 'u-X'", "TRUNCATE subject_map",
])
def test_the_app_role_cannot_change_delete_or_truncate_the_audit_tables(sessions, statement):
    DbAuditPort(sessions).append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted")
    with pytest.raises(DBAPIError, match="permission denied"):
        with sessions.begin() as s:
            s.execute(text(statement))
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(AuditLog)) == 1


def test_the_app_role_can_remove_a_subject_mapping_but_not_change_one(sessions):
    subjects = SubjectService(sessions)
    pseudonym = subjects.pseudonym(ALICE)
    assert subjects.forget(ALICE) is True and subjects.identity(pseudonym) is None


def test_the_hash_columns_are_checked_by_the_database(owner):
    with pytest.raises(DBAPIError):
        with owner.begin() as c:
            c.execute(text("INSERT INTO audit_log (seq, at, actor, action, details, prev_hash, row_hash) VALUES (1, now(), 'a', 'a.b', '{}', 'short', 'short')"))
    with pytest.raises(DBAPIError):
        with owner.begin() as c:
            c.execute(text(f"INSERT INTO audit_log (seq, at, actor, action, details, prev_hash, row_hash) VALUES (0, now(), 'a', 'a.b', '{{}}', '{'a' * 64}', '{'b' * 64}')"))


def test_many_writers_at_once_leave_a_gapless_chain_that_verifies(sessions):
    """Eight threads, each with its own port over a pooled engine, append 25 entries each: 200 entries, numbered 1..200 with no gap and no fork."""
    audit = DbAuditPort(sessions)
    barrier, errors = threading.Barrier(8), []

    def writer(n: int):
        barrier.wait()
        try:
            for i in range(25):
                audit.append(actor=f"s-{n:016d}".replace("0", "A"), action="consent.granted", subject="s-BBBBBBBBBBBBBBBB", details={"writer": n, "i": i})
        except Exception as exc:  # noqa: BLE001 - the test counts what happens
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    with sessions() as s:
        seqs = s.scalars(select(AuditLog.seq).order_by(AuditLog.seq)).all()
        prevs = s.execute(select(AuditLog.prev_hash).order_by(AuditLog.seq)).scalars().all()
    assert seqs == list(range(1, 201)) and len(set(prevs)) == 200, "every entry has its own predecessor: no fork"
    result = audit.verify(batch=64)
    assert result.ok and result.checked == 200 and result.head_seq == 200
    per_writer = {}
    for r in audit.entries(limit=1000):
        per_writer.setdefault(r.details["writer"], []).append(r.details["i"])
    assert all(v == list(range(25)) for v in per_writer.values()), "each writer's own entries are in the order it wrote them"


def test_a_rolled_back_caller_still_leaves_its_entry_and_a_crashing_writer_leaves_no_gap(sessions):
    audit = DbAuditPort(sessions)
    with pytest.raises(RuntimeError):
        with sessions.begin():  # the caller's own transaction, which fails after the audit call
            audit.append(actor="s-AAAAAAAAAAAAAAAA", action="role.granted")
            raise RuntimeError("the caller's work failed")
    assert audit.head()[0] == 1, "the entry is there: an attempt is logged even when the work rolled back"
    with pytest.raises(ValueError):
        audit.append(actor="s-AAAAAAAAAAAAAAAA", action="role.granted", details={"password": "x"})
    assert audit.append(actor="s-AAAAAAAAAAAAAAAA", action="role.granted").seq == 2 and audit.verify().ok


def test_an_entry_inside_an_open_caller_transaction_is_not_blocked_by_it(sessions):
    """The audit port opens its own transaction: a caller that holds rows locked in theirs must not deadlock with it."""
    audit = DbAuditPort(sessions)
    with sessions.begin() as caller:
        caller.execute(text("INSERT INTO subject_map (subject_id, user_id) VALUES ('s-ZZZZZZZZZZZZZZZZ', 'u-ZZZZZZZZZZZZZZZZ')"))
        audit.append(actor="s-ZZZZZZZZZZZZZZZZ", action="role.granted")
    assert audit.verify().ok


def test_the_pseudonym_of_one_user_is_one_row_even_when_eight_threads_ask_at_once(sessions):
    subjects = SubjectService(sessions)
    barrier, got = threading.Barrier(8), []

    def ask():
        barrier.wait()
        got.append(subjects.pseudonym(ALICE))

    threads = [threading.Thread(target=ask) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(set(got)) == 1
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(SubjectMap)) == 1


def test_anchor_check_and_checkpoint_work_on_postgres(sessions, owner):
    audit = DbAuditPort(sessions)
    sink = ListAnchorSink()
    anchors = AuditAnchors(audit, sessions, lambda t: KEYS.context_hash("audit-anchor", t), sink)
    records = [audit.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted", details={"n": i}) for i in range(5)]
    result = anchors.anchor()
    assert result.created and result.head_seq == 5 and anchors.check(sink.published) == []
    assert anchors.anchor().created is False
    with owner.begin() as c:  # the purge path of story P-24, played by the owner: checkpoint first, then delete
        c.execute(text("INSERT INTO audit_checkpoint (seq, hash, reason) VALUES (3, :h, 'retention')"), {"h": records[2].row_hash})
        c.execute(text("DELETE FROM audit_log WHERE seq <= 3"))
    assert audit.verify().ok and audit.verify().checked == 2
    assert audit.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted").seq == 6 and audit.verify().ok
    assert anchors.check(sink.published) == []


def test_through_the_pseudonymising_port_no_user_id_reaches_the_table(sessions, owner):
    port = PseudonymisingAudit(DbAuditPort(sessions), SubjectService(sessions))
    port.append(actor=ALICE, action="consent.granted", subject=ALICE, details={"who": ALICE})
    with owner.connect() as c:
        dump = c.execute(text("SELECT actor || subject || details FROM audit_log")).scalar_one()
    assert ALICE not in dump and "s-" in dump


def test_migration_0007_goes_down_and_up_again(database, owner):
    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, database[1])
    command.downgrade(cfg, "0006")
    with owner.connect() as c:
        assert c.execute(text("SELECT to_regclass('audit_log')")).scalar_one() is None
        assert c.execute(text("SELECT to_regclass('subject_map')")).scalar_one() is None
    command.upgrade(cfg, "head")
    with owner.connect() as c:
        assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() >= "0007"
        grants = {(r[0], r[1]) for r in c.execute(text("SELECT table_name, privilege_type FROM information_schema.role_table_grants "
                                                       "WHERE grantee = 'vulnmart_app' AND table_name IN ('audit_log', 'audit_checkpoint', 'audit_anchor', 'subject_map')"))}
    assert grants == {(t, p) for t in ("audit_log", "audit_checkpoint", "audit_anchor") for p in ("SELECT", "INSERT")} | {("subject_map", p) for p in ("SELECT", "INSERT", "DELETE")}
