"""Story P-22 against a real Postgres 18 as the application role (and a real Valkey when VULNMART_TEST_VALKEY_URL is set): migration 0013 and the privileges on
`domain_events`, the relay over the real tables (one relay at a time, nothing appended twice, order kept) and, with Valkey, the whole path from a published event to the
frames of a hub connection. Skipped unless VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py)."""
from __future__ import annotations

import asyncio
import json
import os
import threading
import uuid

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

import vulnmart.live.models  # noqa: F401
from support import ROOT
from test_companies_postgres import APP, OWNER, app_engine, clean, database, owner, sessions  # noqa: F401
from test_kernel_postgres import with_db
from test_live_hub import collect, events_of, fast
from test_live_relay import A_CAND, A_LEARN, CANDIDATE, LEARNER, ORG, milestone, state_changed
from vulnmart.live.hub import LiveHub
from vulnmart.live.publisher import DbEventPublisher
from vulnmart.live.relay import AudienceResolver, EventRelay
from vulnmart.live.store import MemoryStreamStore, ValkeyStreamStore

pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
VALKEY = os.environ.get("VULNMART_TEST_VALKEY_URL")


@pytest.fixture(autouse=True)
def clean_live(owner):
    with owner.begin() as c:
        c.execute(text("DELETE FROM domain_events"))
        c.execute(text("DELETE FROM attempts"))
    yield


def attempt_rows(owner):
    with owner.begin() as c:
        for aid, uid, org in ((A_LEARN, LEARNER, None), (A_CAND, CANDIDATE, ORG)):
            c.execute(text("INSERT INTO attempts (id, user_id, template_id, org_id, state, version, record) VALUES (:i, :u, :t, :o, 'running', 0, '{}'::jsonb)"),
                      {"i": aid, "u": uid, "t": f"t-{aid}", "o": org})


# ---- the table and who may do what to it --------------------------------------------------------------------------------------------

def test_the_table_has_no_row_policy_and_a_partial_index_over_the_unpublished_rows(owner):
    with owner.connect() as c:
        rls = c.execute(text("SELECT relrowsecurity FROM pg_class WHERE relname = 'domain_events'")).scalar_one()
        index = c.execute(text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_domain_events_unpublished'")).scalar_one()
        cols = {r[0]: r[1] for r in c.execute(text("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'domain_events'"))}
    assert rls is False and "published_at IS NULL" in index
    assert cols == {"id": "bigint", "type": "character varying", "payload": "jsonb", "created_at": "timestamp with time zone",
                    "published_at": "timestamp with time zone", "relay_attempts": "integer", "dropped": "boolean"}


def test_the_application_role_adds_reads_marks_and_deletes_rows_but_cannot_change_what_an_event_says(sessions, app_engine):
    entry = DbEventPublisher(sessions).publish(milestone(A_LEARN, "learner"))
    with app_engine.begin() as c:
        assert c.execute(text("SELECT count(*) FROM domain_events")).scalar_one() == 1
        c.execute(text("UPDATE domain_events SET published_at = now(), relay_attempts = 1, dropped = false WHERE id = :i"), {"i": entry.id})
    for statement in ("UPDATE domain_events SET payload = '{}'::jsonb", "UPDATE domain_events SET type = 'attempt.score_updated'", "UPDATE domain_events SET created_at = now()",
                      "UPDATE domain_events SET id = id + 1", "TRUNCATE domain_events"):
        with pytest.raises(DBAPIError, match="permission denied"):
            with app_engine.begin() as c:
                c.execute(text(statement))
    with app_engine.begin() as c:
        assert c.execute(text("DELETE FROM domain_events WHERE published_at IS NOT NULL")).rowcount == 1


def test_an_event_written_in_a_transaction_that_rolls_back_is_not_there(sessions, app_engine):
    with sessions() as session:
        DbEventPublisher(sessions, lambda: session).publish(milestone(A_LEARN, "learner"))
        session.rollback()
    with app_engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM domain_events")).scalar_one() == 0


# ---- the relay over the real tables --------------------------------------------------------------------------------------------------

def test_the_relay_resolves_audiences_from_the_attempts_table_and_marks_the_rows(sessions, owner):
    attempt_rows(owner)
    store = MemoryStreamStore()
    pub = DbEventPublisher(sessions)
    for e in (state_changed(A_CAND, "candidate"), milestone(A_CAND, "candidate"), milestone(A_LEARN, "learner")):
        pub.publish(e)
    assert EventRelay(sessions, AudienceResolver(sessions), store).run_once() == 3
    got = {n: [json.loads(x.event)["type"] for x in asyncio.run(store.read({n: "0-0"}, 20))]
           for n in (f"live:user:{CANDIDATE}", f"live:org:{ORG}", f"live:user:{LEARNER}")}
    assert got == {f"live:user:{CANDIDATE}": ["attempt.state_changed"], f"live:org:{ORG}": ["attempt.state_changed", "attempt.milestone_reached"],
                   f"live:user:{LEARNER}": ["attempt.milestone_reached"]}
    with owner.connect() as c:
        assert c.execute(text("SELECT count(*) FROM domain_events WHERE published_at IS NULL")).scalar_one() == 0


class Counting:
    """A writer that counts every append call (a refused duplicate counts too) and slows each one down, so that two relays would overlap if nothing stopped them."""

    def __init__(self, inner):
        self.inner, self.calls, self.lock = inner, 0, threading.Lock()

    def append(self, stream, oid, event):
        with self.lock:
            self.calls += 1
        threading.Event().wait(0.01)
        return self.inner.append(stream, oid, event)


def test_four_relays_at_once_append_each_event_once_and_in_order(sessions, owner):
    attempt_rows(owner)
    store = Counting(MemoryStreamStore())
    pub = DbEventPublisher(sessions)
    for n in range(30):
        pub.publish(milestone(A_LEARN, "learner", key=f"C{n % 11 + 1:02d}", level=f"M{n % 3 + 1}"))
    relays = [EventRelay(sessions, AudienceResolver(sessions), store, batch=10) for _ in range(4)]
    barrier = threading.Barrier(4)

    def work(relay):
        barrier.wait()
        for _ in range(6):
            relay.run_once()

    threads = [threading.Thread(target=work, args=(r,)) for r in relays]
    [t.start() for t in threads]
    [t.join() for t in threads]
    for _ in range(3):
        relays[0].run_once()
    assert store.calls == 30, "the advisory lock lets one relay at a time take a row: nothing was even offered to the store twice"
    got = [json.loads(x.event)["data"] for x in asyncio.run(store.inner.read({f"live:user:{LEARNER}": "0-0"}, 20))]
    assert [(d["challenge_key"], d["milestone"]) for d in got] == [(f"C{n % 11 + 1:02d}", f"M{n % 3 + 1}") for n in range(30)]


@pytest.mark.skipif(not VALKEY, reason="needs VULNMART_TEST_VALKEY_URL")
def test_a_published_event_reaches_a_connection_through_postgres_the_relay_and_valkey(sessions, owner):
    import valkey

    valkey.Valkey.from_url(VALKEY).flushdb()
    attempt_rows(owner)
    store = ValkeyStreamStore(VALKEY)
    relay = EventRelay(sessions, AudienceResolver(sessions), store)
    hub = LiveHub(store, fast())
    mine, company = f"live:user:{LEARNER}", f"live:org:{ORG}"

    async def scenario():
        task = asyncio.create_task(collect(hub, [mine, company], until=lambda c: len(events_of(c)) >= 2, max_s=5.0))
        await asyncio.sleep(0.3)
        pub = DbEventPublisher(sessions)
        await asyncio.to_thread(pub.publish, milestone(A_LEARN, "learner"))
        await asyncio.to_thread(pub.publish, milestone(A_CAND, "candidate", level="M2"))
        await asyncio.to_thread(relay.run_once)
        try:
            return await task
        finally:
            await store.close()  # in the loop that opened the connections

    chunks = asyncio.run(scenario())
    assert [t for _, t in events_of(chunks)] == ["attempt.milestone_reached", "attempt.milestone_reached"]
    ids = [i for i, _ in events_of(chunks)]
    assert ids == sorted(ids, key=lambda s: tuple(map(int, s.split("-")))) and len(set(ids)) == 2


def test_migration_0013_goes_down_and_up_again(database, owner):
    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, database[2])
    command.downgrade(cfg, "0012")
    with owner.connect() as c:
        assert c.execute(text("SELECT to_regclass('domain_events')")).scalar_one() is None
    command.upgrade(cfg, "head")
    with owner.connect() as c:
        assert c.execute(text("SELECT to_regclass('domain_events')")).scalar_one() == "domain_events"
        assert c.execute(text("SELECT has_table_privilege('vulnmart_app', 'domain_events', 'INSERT')")).scalar_one() is True
        assert c.execute(text("SELECT has_column_privilege('vulnmart_app', 'domain_events', 'payload', 'UPDATE')")).scalar_one() is False
