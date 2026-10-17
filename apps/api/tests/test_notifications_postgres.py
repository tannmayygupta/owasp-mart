"""Story P-09 against a real Postgres 18 and Valkey: migration 0002, claims by several workers, and the worker process path.

Skipped unless the addresses are set (see test_kernel_postgres.py for how to start the throw-away containers):

  VULNMART_TEST_POSTGRES_DSN  the owner role     VULNMART_TEST_APP_DSN  the app role
  VULNMART_TEST_VALKEY_URL    optional: a Valkey, for the end-to-end test through the Dramatiq broker
"""
from __future__ import annotations

import os
import threading
import uuid
from datetime import UTC, datetime

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

import vulnmart.kernel.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from support import ROOT
from test_kernel_postgres import with_db
from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.notifications.fakes import FakeEmailProvider, RegistryRenderer, StaticRecipients
from vulnmart.notifications.models import EmailOutbox
from vulnmart.notifications.service import DbOutboxPort, EmailOutboxService
from vulnmart.ports.fakes import FakeOutboxPort, FakeSettingsPort

OWNER = os.environ.get("VULNMART_TEST_POSTGRES_DSN")
APP = os.environ.get("VULNMART_TEST_APP_DSN")
VALKEY = os.environ.get("VULNMART_TEST_VALKEY_URL")
pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")


@pytest.fixture(scope="module")
def app_sessions():
    name = f"vm_p09_{uuid.uuid4().hex[:10]}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
        c.execute(text(f'GRANT CONNECT ON DATABASE "{name}" TO vulnmart_app'))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, name)
    try:
        config = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
        command.upgrade(config, "head")
        engine = create_engine(sqlalchemy_url(with_db(APP, name)), pool_size=10)
        yield sessionmaker(engine, expire_on_commit=False)
        engine.dispose()
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        os.environ.pop("VULNMART_MIGRATE_DSN", None)


def service_for(sessions, provider=None, users=None, cap=0):
    return EmailOutboxService(sessions, provider or FakeEmailProvider(), StaticRecipients(users or {"u1": "ada@example.invalid"}),
                              RegistryRenderer(), FakeSettingsPort({"email_daily_cap": cap}))


def enqueue(sessions, n, user="u1"):
    with sessions.begin() as session:
        port = DbOutboxPort(lambda: session, FakeOutboxPort())
        return [port.enqueue_email(template="system.test", to_user_id=user).id for _ in range(n)]


def test_the_app_role_can_use_the_outbox_and_the_ids_grow(app_sessions):
    first, second = enqueue(app_sessions, 1)[0], enqueue(app_sessions, 1)[0]
    assert second > first


def test_two_workers_never_claim_the_same_row(app_sessions):
    with app_sessions.begin() as session:
        session.execute(text("DELETE FROM email_outbox"))
    enqueue(app_sessions, 40)
    services = [service_for(app_sessions) for _ in range(4)]
    for s in services:
        s._batch = 10
    claimed: list[list[int]] = [[] for _ in services]
    barrier = threading.Barrier(len(services))

    def work(i):
        barrier.wait()
        claimed[i] = services[i].claim_due()

    threads = [threading.Thread(target=work, args=(i,)) for i in range(len(services))]
    [t.start() for t in threads]
    [t.join() for t in threads]
    everything = [x for part in claimed for x in part]
    assert len(everything) == len(set(everything)) == 40, "no row twice, none left out"


def test_delivery_on_postgres_and_a_restart_loses_nothing(app_sessions):
    with app_sessions.begin() as session:
        session.execute(text("DELETE FROM email_outbox"))
    ids = enqueue(app_sessions, 3)
    crashed = service_for(app_sessions)
    assert crashed.claim_due() == ids  # claimed, then the worker "dies" before sending anything
    provider = FakeEmailProvider()
    after_restart = service_for(app_sessions, provider)
    assert after_restart.claim_due() == []  # the lease is still running
    with app_sessions.begin() as session:
        session.execute(text("UPDATE email_outbox SET claimed_until = :t"), {"t": datetime(2000, 1, 1, tzinfo=UTC)})
    assert after_restart.claim_due() == ids
    assert [after_restart.deliver(i) for i in ids] == ["sent"] * 3
    assert len(provider.sent) == 3
    assert after_restart.stats()["sent"] == 3


def test_a_rolled_back_cause_leaves_no_email_on_postgres(app_sessions):
    with app_sessions.begin() as session:
        session.execute(text("DELETE FROM email_outbox"))
    with pytest.raises(RuntimeError):
        with app_sessions.begin() as session:
            DbOutboxPort(lambda: session, FakeOutboxPort()).enqueue_email(template="system.test", to_user_id="u1")
            raise RuntimeError("cause failed")
    with app_sessions() as session:
        assert session.query(EmailOutbox).count() == 0


@pytest.mark.skipif(not VALKEY, reason="needs VULNMART_TEST_VALKEY_URL")
def test_through_a_real_valkey_broker(app_sessions):
    import dramatiq

    from vulnmart.notifications.worker import RelayLoop, make_broker, make_delivery_actor

    with app_sessions.begin() as session:
        session.execute(text("DELETE FROM email_outbox"))
    provider = FakeEmailProvider()
    service = service_for(app_sessions, provider)
    broker = make_broker(VALKEY)
    dramatiq.set_broker(broker)
    actor = make_delivery_actor(broker, service)
    worker = dramatiq.Worker(broker, worker_threads=2)
    ids = enqueue(app_sessions, 5)
    worker.start()
    try:
        assert RelayLoop(service, actor).relay_once() == 5
        deadline = datetime.now(UTC).timestamp() + 20
        while len(provider.sent) < 5 and datetime.now(UTC).timestamp() < deadline:
            threading.Event().wait(0.2)
    finally:
        worker.stop()
        broker.close()
    assert len(provider.sent) == 5 and service.stats()["sent"] == 5 and len(ids) == 5
