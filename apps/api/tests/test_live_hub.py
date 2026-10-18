"""Story P-22 (FR-LIV-01, 02, 04, 05, 06): the replay buffer (`live/store.py`) and the SSE hub (`live/hub.py`), against the in-memory store and, when
VULNMART_TEST_VALKEY_URL is set, the real Valkey with the same tests. The relay is in test_live_relay.py, the routes in test_live_api.py and the database in
test_live_postgres.py."""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid

import pytest

from vulnmart.live.hub import HEARTBEAT, LiveHub, HubConfig, frame, resync_frame
from vulnmart.live.store import Entry, MemoryStreamStore, ValkeyStreamStore, format_id, parse_id

VALKEY = os.environ.get("VULNMART_TEST_VALKEY_URL")
LOOP = asyncio.new_event_loop()  # one loop for the whole module: the asynchronous Valkey client keeps connections that belong to the loop that opened them


def run(coro):
    return LOOP.run_until_complete(coro)


class Clock:
    def __init__(self, now: float = 1_800_000_000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture(params=["memory", pytest.param("valkey", marks=pytest.mark.skipif(not VALKEY, reason="needs VULNMART_TEST_VALKEY_URL"))])
def make_store(request):
    """A factory of stores of the kind under test, each starting empty (a Valkey is flushed: the test container is only ever used by one test at a time)."""
    made = []

    def make(**kw):
        if request.param == "memory":
            store = MemoryStreamStore(**kw)
        else:
            import valkey

            valkey.Valkey.from_url(VALKEY).flushdb()
            store = ValkeyStreamStore(VALKEY, **kw)
        made.append(store)
        return store

    yield make
    for store in made:
        run(store.close())


def event(kind="attempt.milestone_reached", attempt="a-AAAAAAAAAAAAAAAA", **data) -> str:
    base = {"attempt_id": attempt, "mode": "learner", "challenge_key": "C01", "milestone": "M1"}
    return json.dumps({"schema_version": 1, "type": kind, "occurred_at": "2026-10-18T10:00:00Z", "data": {**base, **data}}, separators=(",", ":"))


def stream_name() -> str:
    return f"live:user:u-{uuid.uuid4().hex[:16]}"


# ---- ids -----------------------------------------------------------------------------------------------------------------------------

def test_ids_are_milliseconds_dash_sequence_and_nothing_else():
    assert parse_id("1791709660000-0") == (1791709660000, 0) and format_id((5, 7)) == "5-7"
    for bad in (None, "", "5", "5-", "-5", "a-b", "1-2-3", " 1-2", "1-2 ", "1234567890123456-1", "1-1234567890", "١-٢", 5):
        assert parse_id(bad) is None, bad


# ---- the store -----------------------------------------------------------------------------------------------------------------------

def test_an_append_gives_a_unique_growing_id_over_every_stream(make_store):
    store = make_store(clock=Clock())
    a, b = stream_name(), stream_name()
    ids = [store.append(a, 1, event()), store.append(b, 1, event()), store.append(a, 2, event()), store.append(b, 2, event())]
    parsed = [parse_id(i) for i in ids]
    assert all(parsed) and parsed == sorted(parsed) and len(set(parsed)) == 4, ids


def test_ids_never_go_back_when_the_clock_does(make_store):
    clock = Clock()
    store = make_store(clock=clock)
    s = stream_name()
    first = store.append(s, 1, event())
    clock.now -= 3600
    second = store.append(s, 2, event())
    assert parse_id(second) > parse_id(first) and parse_id(second)[0] == parse_id(first)[0]


def test_an_outbox_row_is_appended_once_per_stream(make_store):
    store = make_store()
    a, b = stream_name(), stream_name()
    assert store.append(a, 5, event()) is not None
    assert store.append(a, 5, event()) is None, "the same row again (a relay that started over)"
    assert store.append(a, 4, event()) is None, "an older row"
    assert store.append(b, 5, event()) is not None, "another stream has its own"
    assert store.append(a, 6, event()) is not None
    got = run(store.read({a: "0-0"}, 50))
    assert len(got) == 2


def test_a_read_returns_what_came_after_the_given_id_oldest_first_across_streams(make_store):
    store = make_store()
    a, b = stream_name(), stream_name()
    ids = [store.append(s, n, event(milestone=f"M{n % 3 + 1}")) for n, s in enumerate([a, b, a, b, a], start=1)]
    got = run(store.read({a: "0-0", b: "0-0"}, 50))
    assert [e.id for e in got] == ids and [e.stream for e in got] == [a, b, a, b, a]
    after = run(store.read({a: ids[1], b: ids[1]}, 50))
    assert [e.id for e in after] == ids[2:]
    assert isinstance(got[0], Entry) and json.loads(got[0].event)["type"] == "attempt.milestone_reached"


def test_a_read_waits_for_an_event_and_returns_empty_when_none_comes(make_store):
    store = make_store()
    s = stream_name()
    start = time.monotonic()
    assert run(store.read({s: "0-0"}, 120)) == [] and 0.1 <= time.monotonic() - start < 1.5
    timer = threading.Timer(0.15, lambda: store.append(s, 1, event()))
    timer.start()
    start = time.monotonic()
    got = run(store.read({s: "0-0"}, 3000))
    timer.join()
    assert len(got) == 1 and time.monotonic() - start < 1.5, "it woke up as soon as the event arrived, not at the end of the block"


def test_newest_is_zero_for_an_empty_stream_and_the_last_id_otherwise(make_store):
    store = make_store()
    a, b = stream_name(), stream_name()
    last = store.append(a, 1, event())
    assert run(store.newest([a, b])) == {a: last, b: "0-0"}


def test_the_store_keeps_only_max_len_entries_and_remembers_the_newest_one_it_removed(make_store):
    store = make_store(max_len=5)
    s = stream_name()
    ids = [store.append(s, n, event()) for n in range(1, 13)]
    kept = [e.id for e in run(store.read({s: "0-0"}, 50))]
    assert kept == ids[-5:]
    facts = run(store.facts([s]))
    assert facts.trimmed[s] == ids[-6], "the newest removed entry"
    assert facts.latest == ids[-1] and facts.barrier == ids[0]


def test_the_store_drops_what_is_older_than_max_age(make_store):
    clock = Clock()
    store = make_store(max_age_ms=60_000, clock=clock)
    s = stream_name()
    old = store.append(s, 1, event())
    clock.now += 30
    mid = store.append(s, 2, event())
    clock.now += 45  # the first is now 75 s old, the second 45 s
    new = store.append(s, 3, event())
    assert [e.id for e in run(store.read({s: "0-0"}, 50))] == [mid, new]
    assert run(store.facts([s])).trimmed[s] == old


def test_facts_of_a_store_with_nothing_in_it_are_empty(make_store):
    store = make_store()
    s = stream_name()
    facts = run(store.facts([s]))
    assert (facts.latest, facts.barrier, facts.trimmed) == (None, None, {s: None})


def test_a_reset_loses_the_entries_and_the_facts_together(make_store):
    store = make_store()
    s = stream_name()
    store.append(s, 1, event())
    if isinstance(store, MemoryStreamStore):
        store.reset()
    else:
        import valkey

        valkey.Valkey.from_url(VALKEY).flushdb()
    assert run(store.facts([s])).latest is None and run(store.read({s: "0-0"}, 20)) == []
    assert store.append(s, 1, event()) is not None, "after a reset the same outbox row can be appended again"


def test_eight_threads_appending_never_make_a_duplicate_id(make_store):
    store = make_store()
    s = stream_name()
    ids, lock = [], threading.Lock()

    def work(base):
        for n in range(25):
            got = store.append(s, base * 100 + n + 1, event())
            with lock:
                ids.append(got)

    threads = [threading.Thread(target=work, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    got = [i for i in ids if i is not None]
    assert len(got) == len(set(got)), "no id twice"
    assert all(parse_id(i) for i in got)
    assert len(run(store.read({s: "0-0"}, 50))) <= 200


# ---- frames ----------------------------------------------------------------------------------------------------------------------------

def test_a_frame_has_the_id_the_event_type_and_the_event_on_one_data_line():
    e = Entry("live:user:u-x", "1791709660000-3", event())
    text = frame(e).decode()
    assert text == f"id: 1791709660000-3\nevent: attempt.milestone_reached\ndata: {e.event}\n\n"
    assert text.count("\ndata:") == 1 and "\r" not in text


def test_a_resync_frame_has_no_id_and_names_the_reason():
    text = resync_frame("id_too_old").decode()
    head, data, blank = text.split("\n")[0], text.split("\n")[1], text.split("\n")[2:]
    assert head == "event: stream.resync" and "id:" not in text and blank == ["", ""]
    body = json.loads(data.removeprefix("data: "))
    assert body["type"] == "stream.resync" and body["data"] == {"reason": "id_too_old"} and body["schema_version"] == 1 and body["occurred_at"].endswith("Z")


# ---- the hub ---------------------------------------------------------------------------------------------------------------------------

async def allowed() -> bool:
    return True


async def collect(hub: LiveHub, streams, last=None, *, user="u-1", until=None, max_s=3.0, still=allowed) -> list[bytes]:
    """Read frames from one connection until `until(frames)` is true, the connection ends or `max_s` passes."""
    out: list[bytes] = []
    gen = hub.stream(user, streams, last, still)
    try:
        async with asyncio.timeout(max_s):
            async for chunk in gen:
                out.append(chunk)
                if until is not None and until(out):
                    break
    except TimeoutError:
        pass
    finally:
        await gen.aclose()
    return out


def events_of(chunks: list[bytes]) -> list[tuple[str, str]]:
    """(id, type) of every event frame, in order; comments and the resync control event are skipped."""
    found = []
    for chunk in chunks:
        text = chunk.decode()
        if text.startswith("id: "):
            lines = text.split("\n")
            found.append((lines[0].removeprefix("id: "), lines[1].removeprefix("event: ")))
    return found


def fast(**kw) -> HubConfig:
    return HubConfig(**{"heartbeat_s": 0.2, "recheck_s": 0.3, "max_age_s": 5.0, "slow_s": 0.3, **kw})


def test_a_fresh_connection_gets_only_events_published_after_it_connects(make_store):
    store = make_store()
    s = stream_name()
    store.append(s, 1, event(milestone="M1"))
    hub = LiveHub(store, fast())

    async def scenario():
        task = asyncio.create_task(collect(hub, [s], until=lambda c: len(events_of(c)) >= 1))
        await asyncio.sleep(0.15)
        later = await asyncio.to_thread(store.append, s, 2, event(milestone="M2"))
        return later, await task

    later, chunks = run(scenario())
    assert [i for i, _ in events_of(chunks)] == [later], "the event that was there before is not replayed"
    assert chunks[0] == b": stream open\n\n"
    assert hub.connections == 0


def test_a_reconnect_replays_what_came_after_the_last_id_in_order_and_then_follows(make_store):
    store = make_store()
    s = stream_name()
    ids = [store.append(s, n, event(milestone="M1")) for n in range(1, 5)]
    hub = LiveHub(store, fast())

    async def scenario():
        task = asyncio.create_task(collect(hub, [s], ids[0], until=lambda c: len(events_of(c)) >= 4))
        await asyncio.sleep(0.2)
        last = await asyncio.to_thread(store.append, s, 5, event(milestone="M3"))
        return last, await task

    last, chunks = run(scenario())
    assert [i for i, _ in events_of(chunks)] == ids[1:] + [last]


def test_the_client_that_holds_the_newest_id_is_up_to_date_and_gets_nothing_until_something_new_arrives(make_store):
    store = make_store()
    s = stream_name()
    newest = store.append(s, 1, event())
    got = run(collect(LiveHub(store, fast()), [s], newest, max_s=0.5))
    assert events_of(got) == [] and not any(b"resync" in c for c in got)


@pytest.mark.parametrize("bad", ["", "abc", "5", "1-", "-1", "1-2-3", "x" * 40, "99999999999999-1"])
def test_an_id_that_is_not_one_or_is_newer_than_any_given_gets_one_resync_and_the_connection_ends(make_store, bad):
    store = make_store()
    s = stream_name()
    store.append(s, 1, event())
    got = run(collect(LiveHub(store, fast()), [s], bad, max_s=2.0))
    assert len(got) == 1 and b"event: stream.resync" in got[0] and b'"reason":"id_unknown"' in got[0] and b"id:" not in got[0]


def test_an_id_older_than_what_a_trim_removed_gets_id_too_old_and_one_inside_the_buffer_is_replayed(make_store):
    store = make_store(max_len=5)
    s = stream_name()
    ids = [store.append(s, n, event()) for n in range(1, 13)]
    hub = LiveHub(store, fast())
    too_old = run(collect(hub, [s], ids[2], max_s=2.0))
    assert len(too_old) == 1 and b'"reason":"id_too_old"' in too_old[0]
    inside = run(collect(hub, [s], ids[-4], until=lambda c: len(events_of(c)) >= 3))
    assert [i for i, _ in events_of(inside)] == ids[-3:]
    exact = run(collect(hub, [s], ids[-6], until=lambda c: len(events_of(c)) >= 5))
    assert [i for i, _ in events_of(exact)] == ids[-5:], "an id equal to the newest removed one has lost nothing"


def test_an_id_from_before_a_reset_gets_buffer_reset_even_after_new_events_flow(make_store):
    clock = Clock()
    store = make_store(clock=clock)
    s = stream_name()
    old = store.append(s, 1, event())
    if isinstance(store, MemoryStreamStore):
        store.reset()
    else:
        import valkey

        valkey.Valkey.from_url(VALKEY).flushdb()
    hub = LiveHub(store, fast())
    nothing_yet = run(collect(hub, [s], old, max_s=2.0))
    assert b'"reason":"buffer_reset"' in nothing_yet[0]
    clock.now += 2  # a reset restarts the counter, so the new ids are told apart by their time
    fresh = store.append(s, 1, event())
    after = run(collect(hub, [s], old, max_s=2.0))
    assert len(after) == 1 and b"buffer_reset" in after[0], "the old id is still from before the reset"
    ok = run(collect(hub, [s], fresh, max_s=0.4))
    assert not any(b"resync" in c for c in ok)


def test_a_heartbeat_comment_comes_while_nothing_arrives(make_store):
    hub = LiveHub(make_store(), fast(heartbeat_s=0.15))
    got = run(collect(hub, [stream_name()], until=lambda c: c.count(HEARTBEAT) >= 2, max_s=3.0))
    assert got[0] == b": stream open\n\n" and got.count(HEARTBEAT) >= 2


def test_an_event_resets_the_heartbeat_clock_and_comments_are_not_events(make_store):
    store = make_store()
    s = stream_name()
    hub = LiveHub(store, fast(heartbeat_s=0.3))

    async def scenario():
        task = asyncio.create_task(collect(hub, [s], until=lambda c: c.count(HEARTBEAT) >= 1, max_s=3.0))
        for n in range(1, 4):
            await asyncio.sleep(0.15)
            await asyncio.to_thread(store.append, s, n, event())
        return await task

    got = run(scenario())
    first_heartbeat = got.index(HEARTBEAT)
    assert len(events_of(got[:first_heartbeat])) == 3, "no heartbeat while events kept coming"


def test_a_connection_only_reads_the_streams_it_was_given(make_store):
    store = make_store()
    mine, theirs, company = stream_name(), stream_name(), f"live:org:{uuid.uuid4()}"
    hub = LiveHub(store, fast())

    async def scenario():
        task = asyncio.create_task(collect(hub, [mine, company], until=lambda c: len(events_of(c)) >= 2, max_s=3.0))
        await asyncio.sleep(0.15)
        await asyncio.to_thread(store.append, theirs, 1, event(milestone="M3"))
        a = await asyncio.to_thread(store.append, mine, 1, event(milestone="M1"))
        b = await asyncio.to_thread(store.append, company, 1, event(milestone="M2"))
        return a, b, await task

    a, b, got = run(scenario())
    assert [i for i, _ in events_of(got)] == [a, b], "the other user's stream never reaches this connection, and the two own streams merge in id order"
    assert not any(b'"M3"' in c for c in got)


def test_the_connection_ends_when_the_session_is_no_longer_allowed(make_store):
    state = {"ok": True}

    async def still() -> bool:
        return state["ok"]

    hub = LiveHub(make_store(), fast(recheck_s=0.2))

    async def scenario():
        task = asyncio.create_task(collect(hub, [stream_name()], still=still, max_s=3.0))
        await asyncio.sleep(0.3)
        state["ok"] = False
        start = time.monotonic()
        got = await task
        return got, time.monotonic() - start

    got, took = run(scenario())
    assert took < 1.5 and hub.connections == 0, "it ended soon after the check failed, not at max_s"
    assert b"resync" not in b"".join(got), "a closed session is not a resync: the client reconnects with a fresh one"


def test_a_connection_ends_at_its_maximum_age_and_the_count_goes_back_to_zero(make_store):
    hub = LiveHub(make_store(), fast(max_age_s=0.5))
    start = time.monotonic()
    run(collect(hub, [stream_name()], max_s=5.0))
    assert 0.4 <= time.monotonic() - start < 2.5 and hub.connections == 0


def test_a_client_that_does_not_read_is_dropped_and_its_memory_given_back(make_store):
    store = make_store()
    s = stream_name()
    hub = LiveHub(store, fast(queue_max=2, slow_s=0.2))

    async def scenario():
        gen = hub.stream("u-slow", [s], None, allowed)
        first = await anext(gen)  # the connection is open and the producer runs ...
        for n in range(1, 9):  # ... but the client reads nothing while events keep coming
            await asyncio.to_thread(store.append, s, n, event())
        await asyncio.sleep(0.8)
        rest = [chunk async for chunk in gen]
        return first, rest

    first, rest = run(scenario())
    assert first == b": stream open\n\n" and len(events_of(rest)) < 8, "it stopped instead of queueing everything"
    assert hub.connections == 0


def test_the_caps_per_user_and_per_process(make_store):
    hub = LiveHub(make_store(), fast(per_user=2, total=3))

    async def scenario():
        gens = [hub.stream("u-a", [stream_name()], None, allowed) for _ in range(2)]
        for g in gens:
            await anext(g)
        assert hub.full("u-a") and not hub.full("u-b")
        other = hub.stream("u-b", [stream_name()], None, allowed)
        await anext(other)
        assert hub.full("u-b"), "the process cap of 3 is reached"
        for g in [*gens, other]:
            await g.aclose()
        assert hub.connections == 0 and not hub.full("u-a")

    run(scenario())


def test_a_store_failure_ends_one_connection_and_not_the_hub():
    class Broken(MemoryStreamStore):
        async def read(self, after, block_ms):
            raise ConnectionError("valkey is down")

    hub = LiveHub(Broken(), fast())
    got = run(collect(hub, [stream_name()], max_s=2.0))
    assert got == [b": stream open\n\n"] and hub.connections == 0
