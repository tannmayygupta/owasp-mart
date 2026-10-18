"""Story P-17 against a real Postgres 18: the keystore database and its role (`ensure_keystore`), what that role may and may not do, races between
creating and shredding a key, a shred seen at once by another process, and the crypto-shredding restore test (spike S-10): restore the data as it was
before a shred and the shredded attempt is unreadable while the others still read.

Skipped unless VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py).
"""
from __future__ import annotations

import base64
import os
import threading
import uuid

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import sessionmaker

from test_kernel_postgres import with_db
from vulnmart.kernel.keys import DbKeyPort, KekRing
from vulnmart.kernel.keystore import deks, ensure_keystore, shredded, with_database
from vulnmart.kernel.migrate import main as migrate_main
from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.ports.errors import KeyIntegrity, KeyShredded

OWNER = os.environ.get("VULNMART_TEST_POSTGRES_DSN")
APP = os.environ.get("VULNMART_TEST_APP_DSN")
pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
K1, K2 = bytes(range(32)), bytes(range(32, 64))
PASSWORD = "keystore-test-password-1"


def ring(*pairs):
    return KekRing.parse("\n".join(f"{v}:{base64.urlsafe_b64encode(k).decode()}" for v, k in pairs))


def make_port(dsn: str, *pairs, **kw) -> DbKeyPort:
    engine = create_engine(sqlalchemy_url(dsn), pool_size=12)
    return DbKeyPort(sessionmaker(engine, expire_on_commit=False), ring(*(pairs or ((1, K1),))), event_master=b"e" * 32, flag_key=b"f" * 32, owner_key=b"o" * 32, **kw)


@pytest.fixture(scope="module")
def keystore():
    suffix = uuid.uuid4().hex[:8]
    database, role = f"vm_ks_{suffix}", f"vm_keys_{suffix}"
    ensure_keystore(OWNER, database=database, role=role, role_password=PASSWORD)
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    try:
        yield database, role
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))
            c.execute(text(f'DROP ROLE IF EXISTS "{role}"'))
        admin.dispose()


@pytest.fixture
def role_dsn(keystore):
    database, role = keystore
    return with_database(OWNER, database).replace(OWNER.split("//")[1].split("@")[0], f"{role}:{PASSWORD}")


@pytest.fixture
def owner_engine(keystore):
    engine = create_engine(sqlalchemy_url(with_database(OWNER, keystore[0])))
    yield engine
    engine.dispose()


@pytest.fixture(autouse=True)
def clean(owner_engine):
    with owner_engine.begin() as c:
        c.execute(text("DELETE FROM deks"))
        c.execute(text("DELETE FROM shredded"))
    yield


def test_the_keystore_role_can_use_the_key_service(role_dsn):
    port = make_port(role_dsn)
    port.create_attempt_key("att-1")
    assert port.decrypt("att-1", port.encrypt("att-1", b"data", b"a"), b"a") == b"data"
    assert port.shred("att-1") is True
    with pytest.raises(KeyShredded):
        port.encrypt("att-1", b"x")


def test_ensure_keystore_is_idempotent_and_can_change_the_password(keystore):
    database, role = keystore
    ensure_keystore(OWNER, database=database, role=role, role_password=PASSWORD)
    ensure_keystore(OWNER, database=database, role=role, role_password="another-long-password-2")
    ensure_keystore(OWNER, database=database, role=role, role_password=PASSWORD)
    engine = create_engine(sqlalchemy_url(with_database(OWNER, database)))
    with engine.connect() as c:
        assert c.execute(text("SELECT version FROM keystore_schema")).scalar_one() == 1
    engine.dispose()


@pytest.mark.parametrize("database,role,password", [("Bad Name", "vm_keys", PASSWORD), ("vm_ks", "x;drop", PASSWORD), ("vm_ks", "vm_keys", "short"), ("1db", "vm_keys", PASSWORD)])
def test_ensure_keystore_refuses_odd_names_and_short_passwords(database, role, password):
    with pytest.raises(ValueError):
        ensure_keystore(OWNER, database=database, role=role, role_password=password)


@pytest.mark.parametrize("statement", [
    "UPDATE deks SET dek_id = 'dek-x'", "UPDATE deks SET attempt_id = 'other'", "UPDATE deks SET created_at = now()", "TRUNCATE deks",
    "UPDATE shredded SET attempt_id = 'x'", "DELETE FROM shredded", "TRUNCATE shredded",
    "INSERT INTO keystore_schema (version) VALUES (99)", "DROP TABLE deks", "CREATE TABLE evil (x int)",
])
def test_the_keystore_role_can_do_nothing_beyond_its_job(role_dsn, statement):
    port = make_port(role_dsn)
    port.create_attempt_key("att-1")
    engine = create_engine(sqlalchemy_url(role_dsn))
    with pytest.raises(DBAPIError, match="permission denied|must be owner"):
        with engine.begin() as c:
            c.execute(text(statement))
    engine.dispose()


def test_the_keystore_role_may_rewrap_but_not_change_other_columns_of_a_key(role_dsn):
    port = make_port(role_dsn, (1, K1))
    port.create_attempt_key("att-1")
    sealed = port.encrypt("att-1", b"x")
    rotated = make_port(role_dsn, (1, K1), (2, K2))
    assert rotated.rewrap() == 1 and rotated.decrypt("att-1", sealed) == b"x"


def test_the_applications_own_role_cannot_even_connect_to_the_keystore(keystore):
    app = create_engine(sqlalchemy_url(with_database(APP, keystore[0])))
    with pytest.raises(OperationalError, match="permission denied|not allowed|CONNECT"):
        with app.connect():
            pass
    app.dispose()


def test_the_keystore_role_reads_nothing_in_a_data_database(role_dsn):
    """It may connect where PUBLIC may, but owns and is granted nothing there: a table of the data database is closed to it."""
    name = f"vm_dt_{uuid.uuid4().hex[:8]}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as c:
            c.execute(text(f'CREATE DATABASE "{name}"'))
        owner = create_engine(sqlalchemy_url(with_db(OWNER, name)))
        with owner.begin() as c:
            c.execute(text("CREATE TABLE users (id text)"))
        owner.dispose()
        engine = create_engine(sqlalchemy_url(with_database(role_dsn, name)))
        try:
            with engine.connect() as c:
                with pytest.raises(DBAPIError, match="permission denied"):
                    c.execute(text("SELECT * FROM users"))
        except OperationalError:
            pass  # not allowed to connect at all: also fine
        finally:
            engine.dispose()
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()

def test_eight_threads_creating_the_same_attempt_key_get_one_key(role_dsn, owner_engine):
    port = make_port(role_dsn)
    barrier, ids = threading.Barrier(8), []

    def create():
        barrier.wait()
        ids.append(port.create_attempt_key("att-1").dek_id)

    threads = [threading.Thread(target=create) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(set(ids)) == 1
    with owner_engine.connect() as c:
        assert c.execute(select(func.count()).select_from(deks)).scalar_one() == 1


def test_a_shred_racing_creates_never_brings_the_key_back(role_dsn, owner_engine):
    """Creators and one shredder run together: whatever the order, once the shred committed no later create makes a key."""
    port = make_port(role_dsn)
    port.create_attempt_key("att-1")
    barrier, outcomes = threading.Barrier(9), []

    def create():
        barrier.wait()
        try:
            port.create_attempt_key("att-1")
            outcomes.append("created")
        except KeyShredded:
            outcomes.append("shredded")

    def shred():
        barrier.wait()
        outcomes.append("shred" if port.shred("att-1") else "no-shred")

    threads = [threading.Thread(target=create) for _ in range(8)] + [threading.Thread(target=shred)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert outcomes.count("shred") == 1
    with owner_engine.connect() as c:
        assert c.execute(select(func.count()).select_from(deks)).scalar_one() == 0, "no key exists after the shred, whatever raced with it"
        assert c.execute(select(func.count()).select_from(shredded)).scalar_one() == 1
    with pytest.raises(KeyShredded):
        port.create_attempt_key("att-1")


def test_a_shred_in_one_process_is_seen_at_once_by_another(role_dsn):
    one, other = make_port(role_dsn), make_port(role_dsn)
    one.create_attempt_key("att-1")
    sealed = one.encrypt("att-1", b"data")
    assert other.decrypt("att-1", sealed) == b"data"
    one.shred("att-1")
    with pytest.raises(KeyShredded):
        other.decrypt("att-1", sealed)


def test_a_different_kek_cannot_open_the_keys(role_dsn):
    make_port(role_dsn, (1, K1)).create_attempt_key("att-1")
    wrong = make_port(role_dsn, (1, K2))
    with pytest.raises(KeyIntegrity):
        wrong.encrypt("att-1", b"x")


def test_crypto_shredding_survives_a_restore_of_the_data_spike_s10(keystore, role_dsn):
    """The architecture's rule (04 section 5.3): the data database is backed up and restored on its own; the keystore is not restored from that backup.
    A copy of the data taken before the shred (a restore of an old dump) is therefore ciphertext without a key for the shredded attempt."""
    suffix = uuid.uuid4().hex[:8]
    live, restored = f"vm_data_{suffix}", f"vm_restore_{suffix}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as c:
            c.execute(text(f'CREATE DATABASE "{live}"'))
        data = create_engine(sqlalchemy_url(with_db(OWNER, live)))
        port = make_port(role_dsn)
        with data.begin() as c:
            c.execute(text("CREATE TABLE evidence (attempt_id text, aad bytea, dek_id text, nonce text, ciphertext bytea)"))
            for attempt in ("att-keep", "att-shred"):
                port.create_attempt_key(attempt)
                for i in range(3):
                    aad = f"row-{i}".encode()
                    s = port.encrypt(attempt, f"{attempt} evidence {i}".encode(), aad)
                    c.execute(text("INSERT INTO evidence VALUES (:a, :aad, :d, :n, :c)"), {"a": attempt, "aad": aad, "d": s.dek_id, "n": s.nonce, "c": s.ciphertext})
        data.dispose()
        with admin.connect() as c:  # the nightly dump, restored later: a copy of the data as it is now
            c.execute(text(f'CREATE DATABASE "{restored}" TEMPLATE "{live}"'))
        assert port.shred("att-shred") is True  # the deletion request runs after the dump was taken
        from vulnmart.ports.keys import Sealed

        back = create_engine(sqlalchemy_url(with_db(OWNER, restored)))
        with back.connect() as c:
            rows = c.execute(text("SELECT attempt_id, aad, dek_id, nonce, ciphertext FROM evidence ORDER BY attempt_id, aad")).all()
        back.dispose()
        assert len(rows) == 6, "the restored data still holds all the ciphertext"
        readable, unreadable = [], []
        for attempt, aad, dek_id, nonce, ciphertext in rows:
            try:
                readable.append(port.decrypt(attempt, Sealed(dek_id, 1, nonce, bytes(ciphertext)), bytes(aad)))
            except KeyShredded:
                unreadable.append(attempt)
        assert unreadable == ["att-shred"] * 3
        assert readable == [f"att-keep evidence {i}".encode() for i in range(3)]
    finally:
        with admin.connect() as c:
            for name in (live, restored):
                c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def test_the_migrate_job_runs_both_histories_and_the_keystore(monkeypatch, tmp_path):
    suffix = uuid.uuid4().hex[:8]
    data, keys_db, role = f"vm_mg_{suffix}", f"vm_mgk_{suffix}", f"vm_mgr_{suffix}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as c:
            c.execute(text(f'CREATE DATABASE "{data}"'))
            c.execute(text(f'GRANT CONNECT ON DATABASE "{data}" TO vulnmart_app'))
        pw = tmp_path / "pw"
        pw.write_text(PASSWORD + "\n", encoding="utf-8")
        for k, v in {"VULNMART_MIGRATE_DSN": with_db(OWNER, data), "VULNMART_KEYSTORE_DATABASE": keys_db, "VULNMART_KEYSTORE_ROLE": role,
                     "VULNMART_KEYSTORE_PASSWORD_FILE": str(pw)}.items():
            monkeypatch.setenv(k, v)
        from vulnmart.kernel import settings as settings_module

        settings_module.get_settings.cache_clear()
        try:
            assert migrate_main() == 0
            assert migrate_main() == 0, "it can run at every start"
        finally:
            settings_module.get_settings.cache_clear()
        ks = create_engine(sqlalchemy_url(with_database(OWNER, keys_db)))
        with ks.connect() as c:
            assert c.execute(text("SELECT count(*) FROM keystore_schema")).scalar_one() == 1
        ks.dispose()
        main = create_engine(sqlalchemy_url(with_db(OWNER, data)))
        with main.connect() as c:
            assert c.execute(text("SELECT to_regclass('audit_log')")).scalar_one() == "audit_log"
        main.dispose()
    finally:
        with admin.connect() as c:
            for name in (data, keys_db):
                c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
            c.execute(text(f'DROP ROLE IF EXISTS "{role}"'))
        admin.dispose()
