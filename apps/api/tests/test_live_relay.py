"""Story P-22 (FR-LIV-01, FR-LIV-05, FR-LIV-06): publishing an event into the database outbox, and the relay that resolves the audiences from the attempt and appends the
event to the stream of each. On SQLite with the in-memory store; the same relay against Postgres and Valkey is in test_live_postgres.py."""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.kernel.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
import vulnmart.live.models  # noqa: F401
from support import ROOT
from vulnmart.kernel.db import Base
from vulnmart.lab.models import Attempt
from vulnmart.live.models import DomainEvent
from vulnmart.live.publisher import DbEventPublisher, LiveOutbox
from vulnmart.live.relay import MAX_RELAY_ATTEMPTS, AudienceResolver, EventRelay, Owner, RelayLoop, streams_for
from vulnmart.live.store import MemoryStreamStore
from vulnmart.ports.errors import EventInvalid
from vulnmart.ports.fakes import FakeOutboxPort
from vulnmart.ports.outbox import AUDIENCES, EVENT_TYPES, audiences_for, check_event

T0 = datetime(2026, 10, 18, 10, 0, 0, tzinfo=UTC)
LEARNER, CANDIDATE, ORG = "u-LEARNERLEARNER22", "u-CANDIDATECANDID2", "7c1d2e3f-0000-4000-8000-000000000001"
A_LEARN, A_CAND = "a-LEARNERATTEMPTAA", "a-CANDIDATEATTEMPT"


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def store():
    return MemoryStreamStore()


def add_attempt(sessions, attempt_id, user_id, org_id=None):
    with sessions.begin() as s:
        s.add(Attempt(id=attempt_id, user_id=user_id, template_id=f"t-{attempt_id}", org_id=org_id, state="running", version=0, record={}))


@pytest.fixture
def attempts(sessions):
    add_attempt(sessions, A_LEARN, LEARNER)
    add_attempt(sessions, A_CAND, CANDIDATE, ORG)


def milestone(attempt, mode, key="C01", level="M1"):
    return {"schema_version": 1, "type": "attempt.milestone_reached", "occurred_at": "2026-10-18T10:00:00Z",
            "data": {"attempt_id": attempt, "mode": mode, "challenge_key": key, "milestone": level}}


def state_changed(attempt, mode, state="running"):
    return {"schema_version": 1, "type": "attempt.state_changed", "occurred_at": "2026-10-18T10:00:00Z",
            "data": {"attempt_id": attempt, "mode": mode, "state": state, "previous_state": "ready", "deadline_at": None}}


def instance_event(attempt, state="ready"):
    return {"schema_version": 1, "type": "instance.state_changed", "occurred_at": "2026-10-18T10:00:00Z",
            "data": {"instance_id": "i-LEARNERINSTANCE2", "attempt_id": attempt, "state": state, "access": "open", "health": "healthy", "epoch": 1, "error_code": None}}


def relay_of(sessions, store, **kw):
    return EventRelay(sessions, AudienceResolver(sessions), store, now=lambda: T0, **kw)


def streams(store, *names):
    return {n: [json.loads(e.event) for e in asyncio.run(store.read({n: "0-0"}, 20))] for n in names}


# ---- the contract and the checks -----------------------------------------------------------------------------------------------------

def test_the_audience_table_of_the_code_is_the_audience_table_of_the_contract():
    contract = json.loads(Path(ROOT, "contracts", "domain-events", "audiences.json").read_text(encoding="utf-8"))
    assert set(AUDIENCES) == set(contract["types"]) == set(EVENT_TYPES)
    for kind, by_mode in contract["types"].items():
        assert {m: tuple(a) for m, a in by_mode.items()} == AUDIENCES[kind], kind


@pytest.mark.parametrize("path", sorted(Path(ROOT, "contracts", "domain-events", "examples", "valid").glob("*.json")), ids=lambda p: p.stem)
def test_every_valid_example_of_the_contract_is_accepted_by_the_check_except_the_hubs_own_control_event(path):
    body = json.loads(path.read_text(encoding="utf-8"))
    if body["type"] == "stream.resync":
        with pytest.raises(EventInvalid):
            check_event(body)  # the hub's own event: a publisher never hands it over
    else:
        check_event(body)
        assert audiences_for(body)


@pytest.mark.parametrize("bad", [None, [], "x", {"type": "attempt.state_changed"}, {**milestone(A_LEARN, "learner"), "audience": "user"},
                                 {**milestone(A_LEARN, "learner"), "schema_version": 2}, {**milestone(A_LEARN, "learner"), "type": "nope"},
                                 {**milestone(A_LEARN, "learner"), "type": "stream.resync"}, {**milestone(A_LEARN, "learner"), "data": {}},
                                 {**milestone(A_LEARN, "learner"), "data": {**milestone(A_LEARN, "learner")["data"], "flag": "x"}},
                                 {**milestone(A_LEARN, "learner"), "data": {**milestone(A_LEARN, "learner")["data"], "mode": "admin"}}])
def test_the_check_refuses_what_is_not_an_event_a_publisher_may_hand_over(bad):
    with pytest.raises(EventInvalid):
        check_event(bad)


def test_the_in_memory_outbox_and_the_database_one_accept_the_same_events(sessions):
    fake, real = FakeOutboxPort(), DbEventPublisher(sessions)
    for e in (milestone(A_LEARN, "learner"), state_changed(A_CAND, "candidate"), instance_event(A_LEARN)):
        assert fake.publish(e).audiences == real.publish(e).audiences
    for bad in ({"type": "x"}, {**milestone(A_LEARN, "learner"), "extra": 1}):
        for port in (fake, real):
            with pytest.raises(EventInvalid):
                port.publish(bad)


# ---- publishing ----------------------------------------------------------------------------------------------------------------------

def test_a_published_event_is_a_row_with_the_event_exactly_as_the_browser_reads_it(sessions):
    entry = DbEventPublisher(sessions, now=lambda: T0).publish(milestone(A_CAND, "candidate"))
    with sessions() as s:
        [row] = s.scalars(select(DomainEvent)).all()
    assert row.id == entry.id and row.type == "attempt.milestone_reached" and row.payload == milestone(A_CAND, "candidate")
    assert row.published_at is None and row.relay_attempts == 0 and row.dropped is False
    assert entry.audiences == ("org",) and set(row.payload) == {"schema_version", "type", "occurred_at", "data"}, "the audience is not stored in the event"


def test_an_event_given_with_a_session_is_in_the_transaction_of_its_cause(sessions):
    with sessions() as session:
        DbEventPublisher(sessions, lambda: session).publish(milestone(A_LEARN, "learner"))
        session.rollback()  # the cause failed
    with sessions() as s:
        assert s.scalars(select(DomainEvent)).all() == []
    with sessions() as session:
        DbEventPublisher(sessions, lambda: session).publish(milestone(A_LEARN, "learner"))
        session.commit()
    with sessions() as s:
        assert len(s.scalars(select(DomainEvent)).all()) == 1


def test_the_live_outbox_publishes_durably_and_queues_email_in_the_stand_in(sessions):
    emails = FakeOutboxPort()
    outbox = LiveOutbox(DbEventPublisher(sessions), emails)
    outbox.publish(milestone(A_LEARN, "learner"))
    job = outbox.enqueue_email(template="system.test", to_user_id=LEARNER, params={"k": "v"})
    with sessions() as s:
        assert len(s.scalars(select(DomainEvent)).all()) == 1
    assert emails.emails == [job] and emails.events == []


# ---- the audiences -------------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("event,owner,expected", [
    (milestone(A_LEARN, "learner"), Owner(LEARNER, None), [f"live:user:{LEARNER}"]),
    (milestone(A_CAND, "candidate"), Owner(CANDIDATE, ORG), [f"live:org:{ORG}"]),
    (state_changed(A_CAND, "candidate"), Owner(CANDIDATE, ORG), [f"live:user:{CANDIDATE}", f"live:org:{ORG}"]),
    (state_changed(A_LEARN, "learner"), Owner(LEARNER, None), [f"live:user:{LEARNER}"]),
    (instance_event(A_CAND), Owner(CANDIDATE, ORG), [f"live:user:{CANDIDATE}", "live:admin"]),
    (instance_event(A_LEARN), Owner(LEARNER, None), [f"live:user:{LEARNER}", "live:admin"]),
])
def test_the_streams_of_an_event_follow_the_audience_table_and_the_attempt(event, owner, expected):
    assert streams_for(event, owner) == expected


def test_learner_practice_never_reaches_a_company_even_if_an_org_were_named():
    for kind in EVENT_TYPES:
        sample = {"attempt.state_changed": state_changed, "attempt.milestone_reached": milestone}.get(kind)
        if sample is None:
            continue
        assert not any(s.startswith("live:org:") for s in streams_for(sample(A_LEARN, "learner"), Owner(LEARNER, None)))
    assert not any(s.startswith("live:org:") for s in streams_for(milestone(A_LEARN, "learner"), Owner(LEARNER, ORG))), (
        "the audience table, not the attempt row, decides: practice has no org audience at all")


def test_the_resolver_reads_the_owner_and_company_of_each_attempt(sessions, attempts):
    got = AudienceResolver(sessions).owners({A_LEARN, A_CAND, "a-NOSUCHATTEMPTAAA"})
    assert got == {A_LEARN: Owner(LEARNER, None), A_CAND: Owner(CANDIDATE, ORG)}
    assert AudienceResolver(sessions).owners(set()) == {}


# ---- the relay -----------------------------------------------------------------------------------------------------------------------

def test_the_relay_appends_each_event_to_the_stream_of_each_of_its_audiences_in_outbox_order(sessions, store, attempts):
    pub = DbEventPublisher(sessions, now=lambda: T0)
    for e in (state_changed(A_CAND, "candidate"), milestone(A_CAND, "candidate"), milestone(A_LEARN, "learner", level="M2"), instance_event(A_LEARN)):
        pub.publish(e)
    assert relay_of(sessions, store).run_once() == 4
    got = streams(store, f"live:user:{CANDIDATE}", f"live:org:{ORG}", f"live:user:{LEARNER}", "live:admin")
    assert [e["type"] for e in got[f"live:user:{CANDIDATE}"]] == ["attempt.state_changed"]
    assert [e["type"] for e in got[f"live:org:{ORG}"]] == ["attempt.state_changed", "attempt.milestone_reached"]
    assert [e["type"] for e in got[f"live:user:{LEARNER}"]] == ["attempt.milestone_reached", "instance.state_changed"]
    assert [e["type"] for e in got["live:admin"]] == ["instance.state_changed"]
    assert got[f"live:user:{LEARNER}"][0] == milestone(A_LEARN, "learner", level="M2"), "the event is the one published, byte for byte in meaning"
    with sessions() as s:
        assert all(r.published_at == T0.replace(tzinfo=None) or r.published_at == T0 for r in s.scalars(select(DomainEvent)))


def test_a_pass_with_nothing_to_do_does_nothing_and_published_rows_are_not_taken_again(sessions, store, attempts):
    relay = relay_of(sessions, store)
    assert relay.run_once() == 0
    DbEventPublisher(sessions).publish(milestone(A_LEARN, "learner"))
    assert relay.run_once() == 1 and relay.run_once() == 0
    assert len(streams(store, f"live:user:{LEARNER}")[f"live:user:{LEARNER}"]) == 1


def test_nothing_reaches_a_stream_of_someone_who_does_not_own_the_attempt(sessions, store, attempts):
    DbEventPublisher(sessions).publish(milestone(A_CAND, "candidate"))
    relay_of(sessions, store).run_once()
    assert streams(store, f"live:user:{LEARNER}", f"live:user:{CANDIDATE}", "live:admin") == {f"live:user:{LEARNER}": [], f"live:user:{CANDIDATE}": [], "live:admin": []}


def test_a_relay_that_died_after_appending_and_started_again_makes_no_duplicate(sessions, store, attempts):
    pub = DbEventPublisher(sessions)
    pub.publish(milestone(A_LEARN, "learner"))
    pub.publish(milestone(A_LEARN, "learner", level="M2"))

    class DiesOnce:
        calls = 0

        def append(self, stream, oid, event):
            got = store.append(stream, oid, event)
            self.calls += 1
            if self.calls == 2:
                raise ConnectionError("the relay was killed after the second append")
            return got

    with pytest.raises(ConnectionError):
        relay_of(sessions, DiesOnce()).run_once()
    with sessions() as s:
        assert all(r.published_at is None for r in s.scalars(select(DomainEvent))), "nothing was marked: the whole pass is redone"
    assert relay_of(sessions, store).run_once() == 2
    got = streams(store, f"live:user:{LEARNER}")[f"live:user:{LEARNER}"]
    assert [e["data"]["milestone"] for e in got] == ["M1", "M2"], "each event once, in order"


def test_an_event_whose_attempt_is_not_there_yet_waits_and_the_later_ones_wait_behind_it(sessions, store):
    pub = DbEventPublisher(sessions)
    pub.publish(milestone(A_LEARN, "learner"))
    pub.publish(instance_event("a-LATERATTEMPTAAAA"))
    relay = relay_of(sessions, store)
    assert relay.run_once() == 0, "the first one has no attempt: it waits, and so does everything behind it (order is kept)"
    add_attempt(sessions, A_LEARN, LEARNER)
    assert relay.run_once() == 1
    with sessions() as s:
        rows = s.scalars(select(DomainEvent).order_by(DomainEvent.id)).all()
    assert [r.published_at is not None for r in rows] == [True, False] and rows[1].relay_attempts == 1


def test_an_event_whose_attempt_never_appears_is_dropped_after_a_number_of_passes_and_logged_without_content(sessions, store, caplog):
    pub = DbEventPublisher(sessions)
    pub.publish(milestone("a-GHOSTATTEMPTAAAA", "learner"))
    add_attempt(sessions, A_LEARN, LEARNER)
    pub.publish(milestone(A_LEARN, "learner"))
    relay = relay_of(sessions, store)
    caplog.set_level("WARNING", logger="vulnmart.live")
    published = sum(relay.run_once() for _ in range(MAX_RELAY_ATTEMPTS + 1))
    assert published == 1, "the one with an attempt got through once the ghost was dropped"
    with sessions() as s:
        ghost, real = s.scalars(select(DomainEvent).order_by(DomainEvent.id)).all()
    assert (ghost.dropped, ghost.published_at is not None, real.dropped) == (True, True, False)
    [line] = [r.getMessage() for r in caplog.records if "dropped" in r.getMessage()]
    assert "attempt.milestone_reached" in line and "GHOST" not in line and "learner" not in line, "id and type only, nothing of the content"
    assert streams(store, f"live:user:{LEARNER}")[f"live:user:{LEARNER}"][0]["data"]["challenge_key"] == "C01"


def test_a_big_backlog_is_taken_in_batches_in_order(sessions, store, attempts):
    pub = DbEventPublisher(sessions)
    for n in range(25):
        pub.publish(milestone(A_LEARN, "learner", key=f"C{n % 11 + 1:02d}", level=f"M{n % 3 + 1}"))
    relay = relay_of(sessions, store, batch=10)
    assert [relay.run_once() for _ in range(4)] == [10, 10, 5, 0]
    got = streams(store, f"live:user:{LEARNER}")[f"live:user:{LEARNER}"]
    assert [(e["data"]["challenge_key"], e["data"]["milestone"]) for e in got] == [(f"C{n % 11 + 1:02d}", f"M{n % 3 + 1}") for n in range(25)]


def test_the_relay_loop_moves_events_by_itself_and_survives_a_failing_pass(sessions, store, attempts):
    class Flaky:
        passes = 0

        def __init__(self, inner):
            self.inner = inner

        def run_once(self):
            self.passes += 1
            if self.passes == 1:
                raise ConnectionError("database down")
            return self.inner.run_once()

    relay = Flaky(relay_of(sessions, store))
    loop = RelayLoop(relay, 0.05)  # type: ignore[arg-type]
    DbEventPublisher(sessions).publish(milestone(A_LEARN, "learner"))
    loop.start()
    try:
        deadline = datetime.now(UTC) + timedelta(seconds=5)
        while datetime.now(UTC) < deadline and not streams(store, f"live:user:{LEARNER}")[f"live:user:{LEARNER}"]:
            asyncio.run(asyncio.sleep(0.05))
    finally:
        loop.stop()
    assert len(streams(store, f"live:user:{LEARNER}")[f"live:user:{LEARNER}"]) == 1 and relay.passes >= 2
