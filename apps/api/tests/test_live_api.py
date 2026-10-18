"""Story P-22 (FR-LIV-01, 02, 04, 05): the routes openLiveStream and getLiveSnapshot. The Starlette test client waits for a response to finish, so every stream here is a
finite one (a short maximum age); the endless behaviour (arrival while open, heartbeat, a revoked session) is tested on the hub in test_live_hub.py and on the real stack in
the stack test."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from test_consent import KEYS, ORIGIN, PASSWORD, T0, Clock, add_user, sign_in  # noqa: F401
from vulnmart.accounts.passwords import PasswordPolicy
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.db import Base
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.settings import Settings
from vulnmart.live.hub import HubConfig
from vulnmart.live.snapshot import EmptySnapshot, LabSnapshotSource
from vulnmart.live.store import MemoryStreamStore
from vulnmart.main import create_app
from vulnmart.ports.fakes import FakeSettingsPort

ALICE, BOB = "u-AAAAAAAAAAAAAAAA", "u-BBBBBBBBBBBBBBBB"
ORG = "7c1d2e3f-0000-4000-8000-000000000001"


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def store():
    return MemoryStreamStore()


def event(milestone="M1", attempt="a-AAAAAAAAAAAAAAAA"):
    return json.dumps({"schema_version": 1, "type": "attempt.milestone_reached", "occurred_at": "2026-10-18T10:00:00Z",
                       "data": {"attempt_id": attempt, "mode": "learner", "challenge_key": "C01", "milestone": milestone}}, separators=(",", ":"))


def make_app(sessions, store, *, config=None, snapshot=None, live=True):
    clock, settings = Clock(), FakeSettingsPort()
    ss = SessionService(sessions, settings, b"k" * 32, now=clock)
    kw = {"live_store": store} if live else {}
    app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(now=lambda: clock.now.timestamp()), policy=PasswordPolicy(),
                     accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock), sessions=ss, self_service=SelfService(sessions, ss),
                     live_config=config or HubConfig(max_age_s=0.6, heartbeat_s=0.2, recheck_s=0.3, slow_s=0.3), live_snapshot=snapshot, **kw)
    app.state.ports.settings = settings
    return app


def client(app) -> TestClient:
    return TestClient(app, headers={"origin": ORIGIN}, base_url="https://testserver", raise_server_exceptions=False)


@pytest.fixture
def web(sessions, store):
    add_user(sessions, ALICE, "alice@example.com")
    add_user(sessions, BOB, "bob@example.com")
    with client(make_app(sessions, store)) as c:
        yield c


def frames(text: str) -> list[dict]:
    """The SSE messages of a body: `id`, `event` and `data` (parsed) of each, and the comments as `{"comment": ...}`."""
    out = []
    for block in text.split("\n\n"):
        if not block:
            continue
        item: dict = {}
        for line in block.split("\n"):
            if line.startswith(": "):
                item["comment"] = line[2:]
            elif line.startswith("data: "):
                item["data"] = json.loads(line[6:])
            elif ": " in line:
                key, value = line.split(": ", 1)
                item[key] = value
        out.append(item)
    return out


def user_stream(uid: str) -> str:
    return f"live:user:{uid}"


# ---- who may open a stream and what they get -------------------------------------------------------------------------------------------

def test_both_routes_need_a_session(web):
    for path in ("/api/v1/live", "/api/v1/live/snapshot"):
        r = web.get(path)
        assert r.status_code == 401 and r.json()["code"] == "AUTH-SESSION-REQUIRED", path


def test_the_stream_answer_is_never_cached_or_buffered_and_is_an_event_stream(web):
    sign_in(web)
    r = web.get("/api/v1/live")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["cache-control"] == "private, no-store" and r.headers["x-accel-buffering"] == "no"
    assert frames(r.text)[0] == {"comment": "stream open"}


def test_a_connection_without_last_event_id_gets_nothing_that_was_published_before_it(web, store):
    store.append(user_stream(ALICE), 1, event("M1"))
    sign_in(web)
    r = web.get("/api/v1/live")
    assert [f for f in frames(r.text) if "id" in f] == []


def test_a_reconnect_replays_the_callers_own_events_after_the_given_id_and_nobody_elses(web, store):
    first = store.append(user_stream(ALICE), 1, event("M1"))
    second = store.append(user_stream(ALICE), 2, event("M2"))
    store.append(user_stream(BOB), 1, event("M3", attempt="a-BBBBBBBBBBBBBBBB"))
    store.append(f"live:org:{ORG}", 1, event("M3", attempt="a-CCCCCCCCCCCCCCCC"))
    store.append("live:admin", 1, event("M3", attempt="a-DDDDDDDDDDDDDDDD"))
    sign_in(web)
    r = web.get("/api/v1/live", headers={"last-event-id": first})
    got = [f for f in frames(r.text) if "id" in f]
    assert [f["id"] for f in got] == [second] and got[0]["event"] == "attempt.milestone_reached" and got[0]["data"]["data"]["milestone"] == "M2"
    assert "M3" not in r.text, "no other user's, company's or admin's event reaches a learner"


def test_the_client_cannot_choose_a_stream(web, store):
    sign_in(web)
    store.append(user_stream(BOB), 1, event("M3", attempt="a-BBBBBBBBBBBBBBBB"))
    for extra in ({"params": {"user": BOB}}, {"params": {"stream": user_stream(BOB), "audience": "admin"}}, {"headers": {"x-test-audiences": "admin", "x-audience": "admin"}}):
        r = web.get("/api/v1/live", headers={"last-event-id": "0-1", **extra.get("headers", {})}, params=extra.get("params"))
        assert r.status_code in (200, 422) and "M3" not in r.text


@pytest.mark.parametrize("bad", ["", "nope", "5", "1-2-3", "9999999999999-1"])
def test_a_last_event_id_that_is_not_known_gets_one_resync_and_the_stream_ends(web, store, bad):
    store.append(user_stream(ALICE), 1, event())
    sign_in(web)
    r = web.get("/api/v1/live", headers={"last-event-id": bad})
    assert r.status_code == 200
    assert frames(r.text) == [{"event": "stream.resync", "data": {"schema_version": 1, "type": "stream.resync", "occurred_at": frames(r.text)[0]["data"]["occurred_at"],
                                                                   "data": {"reason": "id_unknown"}}}]


def test_a_stream_ends_by_itself_and_the_client_reconnects_with_the_last_id(web, store):
    sign_in(web)
    started = datetime.now(UTC)
    r = web.get("/api/v1/live")
    assert (datetime.now(UTC) - started).total_seconds() < 5 and r.status_code == 200, "a finite maximum age is what ends it here"
    assert any(f.get("comment") == "heartbeat" for f in frames(r.text)), "a heartbeat came while nothing happened"


def test_too_many_streams_of_one_user_are_refused_with_a_retry_hint(sessions, store):
    add_user(sessions, ALICE, "alice@example.com")
    with client(make_app(sessions, store, config=HubConfig(per_user=0))) as c:
        sign_in(c)
        r = c.get("/api/v1/live")
    assert (r.status_code, r.json()["code"], r.headers["retry-after"]) == (429, "REQ-RATE-LIMITED", "5")


def test_without_a_valkey_address_the_live_route_is_a_plain_server_error_not_a_hang(sessions, store):
    add_user(sessions, ALICE, "alice@example.com")
    with client(make_app(sessions, store, live=False)) as c:
        sign_in(c)
        r = c.get("/api/v1/live")
    assert (r.status_code, r.json()["code"]) == (500, "REQ-INTERNAL")


# ---- the snapshot ----------------------------------------------------------------------------------------------------------------------

def test_the_snapshot_is_empty_without_a_lab_and_has_the_contract_shape(web):
    sign_in(web)
    r = web.get("/api/v1/live/snapshot")
    body = r.json()
    assert r.status_code == 200 and r.headers["cache-control"] == "private, no-store"
    assert set(body) == {"server_time", "attempts", "instances"} and body["attempts"] == [] and body["instances"] == []
    assert datetime.strptime(body["server_time"], "%Y-%m-%dT%H:%M:%SZ")


def test_the_snapshot_shows_what_the_source_gives_for_the_caller_only(sessions, store):
    seen = []

    class Source:
        def snapshot(self, user_id):
            seen.append(user_id)
            return [{"attempt_id": "a-AAAAAAAAAAAAAAAA", "mode": "learner", "state": "running", "instance_id": None, "created_at": "2026-10-18T10:00:00Z", "deadline_at": None}], []

    add_user(sessions, ALICE, "alice@example.com")
    with client(make_app(sessions, store, snapshot=Source())) as c:
        sign_in(c)
        body = c.get("/api/v1/live/snapshot").json()
    assert seen == [ALICE] and body["attempts"][0]["attempt_id"] == "a-AAAAAAAAAAAAAAAA"


def test_the_lab_snapshot_lists_the_callers_attempts_and_instance_states_and_hides_purged_ones():
    def rec(n, state="running", purged=None, org=None):
        return SimpleNamespace(id=f"a-{n * 16}", state=SimpleNamespace(value=state), instance_id=f"i-{n * 16}", created_at=datetime(2026, 10, 18, tzinfo=UTC),
                               deadline_at=None, purged_at=purged, org_id=org)

    records = [rec("A"), rec("B", org="o-1"), rec("C", purged=datetime(2026, 10, 18, tzinfo=UTC)), rec("D", state="deleted"), rec("E", state="submitted")]
    states = {f"i-{'A' * 16}": ("ready", "open", "healthy", 1, None), f"i-{'B' * 16}": ("failed", "closed", "unhealthy", 2, "INST-START-TIMEOUT")}

    class Host:
        def get(self, instance_id):
            from vulnmart.ports.instance_host import InstanceNotFound

            if instance_id not in states:
                raise InstanceNotFound(instance_id)
            st, access, health, epoch, err = states[instance_id]
            return SimpleNamespace(state=SimpleNamespace(value=st), access=SimpleNamespace(value=access), health=SimpleNamespace(value=health), epoch=epoch, error_code=err)

    lab = SimpleNamespace(engine=SimpleNamespace(for_user=lambda uid: records if uid == ALICE else []),
                          directory=SimpleNamespace(for_attempt=lambda aid: SimpleNamespace(instance_id=aid.replace("a-", "i-"))), host=Host())
    attempts, instances = LabSnapshotSource(lab).snapshot(ALICE)
    assert [a["attempt_id"] for a in attempts] == [f"a-{'A' * 16}", f"a-{'B' * 16}", f"a-{'E' * 16}"]
    assert [a["mode"] for a in attempts] == ["learner", "candidate", "learner"]
    assert [(i["instance_id"], i["state"], i["error_code"]) for i in instances] == [(f"i-{'A' * 16}", "ready", None), (f"i-{'B' * 16}", "failed", "INST-START-TIMEOUT")]
    assert set(instances[0]) == {"instance_id", "attempt_id", "state", "access", "health", "epoch", "error_code"}
    assert LabSnapshotSource(lab).snapshot(BOB) == ([], [])
    assert EmptySnapshot().snapshot(ALICE) == ([], [])
