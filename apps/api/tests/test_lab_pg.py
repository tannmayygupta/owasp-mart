"""Stream L, migration 0008, against a real Postgres 18: the lab stores of `vulnmart.lab.pg`, the whole assessment loop on them, and a
restart (a second runtime on the same database) that keeps every attempt, score, held capture and event.

Skipped unless VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py). The stores run as the app
role (no owner, no BYPASSRLS), so the grants of the migration are tested too.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.exc import ProgrammingError
from vulnmart_attempts import AttemptRecord, AttemptState, Conflict, FakeClock, Rules
from vulnmart_attempts.review import ReviewFinal

from support import ROOT
from test_kernel_postgres import with_db
from vulnmart.ingest.bots import BotVisit
from vulnmart.ingest.store import PutResult
from vulnmart.ingest.stores import InstanceInfo
from vulnmart.ingest.verify import sign_body
from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.lab import pg
from vulnmart.lab.runtime import LabRuntime
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.lab.keys import StoredKeyPort, init_keystore
from vulnmart.ports.errors import AttemptNotFound, KeyIntegrity, KeyShredded
from vulnmart.ports.fakes import FakeKeyPort
from vulnmart.ports.keys import Sealed
from vulnmart.ports.instance_host import InstanceState
from vulnmart.ports.reports import IntegrityType, Milestone

OWNER = os.environ.get("VULNMART_TEST_POSTGRES_DSN")
APP = os.environ.get("VULNMART_TEST_APP_DSN")
pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")

T0 = datetime(2026, 10, 17, 10, 0, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def engine():
    name = f"vm_lab_{uuid.uuid4().hex[:10]}"
    admin = create_engine(sqlalchemy_url(OWNER), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
        c.execute(text(f'GRANT CONNECT ON DATABASE "{name}" TO vulnmart_app'))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, name)
    app = None
    try:
        command.upgrade(Config(str(ROOT / "apps" / "api" / "alembic.ini")), "head")
        init_keystore(with_db(OWNER, name))
        app = create_engine(sqlalchemy_url(with_db(APP, name)), pool_size=10)
        yield app
    finally:
        os.environ.pop("VULNMART_MIGRATE_DSN", None)
        if app is not None:
            app.dispose()
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def new_record(user="u-1", template="shop-v0", **kw) -> AttemptRecord:
    return AttemptRecord(id=uuid.uuid4().hex, user_id=user, template_id=template, consent_id="c-1", created_at=T0, ready_at=T0, **kw)


def test_the_attempt_record_survives_json_and_the_compare_and_set_holds(engine):
    store = pg.PgAttemptStore(engine)
    rec = new_record(rules=Rules(time_limit_minutes=90, warning_minutes=(10,)), org_id="o-1", warnings_sent=(15, 5))
    stored = store.add(rec)
    assert stored.version == 0 and store.get(rec.id) == stored and store.find("u-1", "shop-v0") == stored
    assert store.get(rec.id).rules.time_limit_minutes == 90 and store.get(rec.id).warnings_sent == (15, 5)
    with pytest.raises(Conflict):
        store.add(new_record())  # the same user and template
    from dataclasses import replace
    moved = store.put_if_version(replace(stored, state=AttemptState.RUNNING, started_at=T0, deadline_at=T0 + timedelta(hours=1)), 0)
    assert moved.version == 1 and store.get(rec.id).state is AttemptState.RUNNING
    with pytest.raises(Conflict):
        store.put_if_version(replace(stored, state=AttemptState.CANCELLED), 0)  # a stale version loses
    assert rec.id in store.ids()
    assert [r.id for r in store.due(T0 + timedelta(minutes=5)) if r.id == rec.id] == [rec.id]


def test_two_threads_racing_one_version_have_one_winner(engine):
    store = pg.PgAttemptStore(engine)
    stored = store.add(new_record(user=f"u-race-{uuid.uuid4().hex[:6]}"))
    from dataclasses import replace
    results: list[str] = []

    def go(state: AttemptState) -> None:
        try:
            store.put_if_version(replace(stored, state=state), 0)
            results.append("won")
        except Conflict:
            results.append("lost")

    threads = [threading.Thread(target=go, args=(s,)) for s in (AttemptState.RUNNING, AttemptState.CANCELLED)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["lost", "won"]


def test_milestones_keep_the_better_level_and_a_hold_remembers_its_fallback(engine):
    attempts = pg.PgAttemptStore(engine)
    rec = attempts.add(new_record(user="u-m"))
    ms = pg.PgMilestoneStore(engine)
    assert ms.best(rec.id, "C01") is Milestone.NONE
    assert ms.credit(rec.id, "C01", Milestone.M2, T0) is True
    assert ms.credit(rec.id, "C01", Milestone.M1, T0) is False and ms.best(rec.id, "C01") is Milestone.M2
    assert ms.credit(rec.id, "C01", Milestone.M2, T0) is False
    assert ms.credit(rec.id, "C01", Milestone.M3, T0 + timedelta(minutes=1)) is True and ms.captures(rec.id) == {"C01": T0 + timedelta(minutes=1)}
    assert ms.credit(rec.id, "C01", Milestone.NONE, T0) is False
    assert ms.hold(rec.id, "C02", T0) is True and ms.hold(rec.id, "C02", T0) is False
    assert ms.is_held(rec.id, "C02") and ms.held_for(rec.id) == {"C02": T0}
    held = pg.PgHeldStore(engine)
    item = held.get(rec.id, "C02")
    assert item.status == "open" and item.fallback.name == "NONE" and item.milestone.name == "M3"
    assert held.release_held(rec.id, "C02").status == "accepted" and not ms.is_held(rec.id, "C02")
    assert held.mark_reminded(rec.id, "C02") is True and held.mark_reminded(rec.id, "C02") is False


def test_hints_integrity_and_flag_log_are_once_per_key_and_hold_no_flag(engine):
    rec = pg.PgAttemptStore(engine).add(new_record(user="u-h"))
    hints = pg.PgHintLedger(engine)
    assert hints.add(rec.id, "C01", 1, T0) and not hints.add(rec.id, "C01", 1, T0) and hints.add(rec.id, "C01", 2, T0)
    assert hints.levels(rec.id, "C01") == (1, 2) and hints.levels(rec.id, "C02") == ()
    integ = pg.PgIntegritySink(engine)
    assert integ.add(rec.id, IntegrityType.DECOY, "a decoy was pasted", "decoy:C01") is True
    assert integ.add(rec.id, IntegrityType.DECOY, "again", "decoy:C01") is False
    assert [(r.kind, r.explanation) for r in integ.of(rec.id)] == [(IntegrityType.DECOY, "a decoy was pasted")]
    assert integ.of(rec.id, IntegrityType.TIMING) == []
    pg.PgFlagSubmissionLog(engine).record(rec.id, "C01", "incorrect", T0)
    with engine.connect() as c:
        cols = c.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name = 'flag_submissions'")).scalars().all()
    assert set(cols) == {"id", "attempt_id", "challenge_key", "result", "at"}, "no column could hold a pasted value"


def test_events_are_stored_once_a_replay_with_another_body_is_a_mismatch_and_the_engine_sees_each_once(engine):
    store, log = pg.PgEventStore(engine), pg.PgEventLog(engine)
    iid = f"i-{uuid.uuid4().hex[:12]}"
    ev = {"instance_id": iid, "epoch": 1, "seq": 1, "type": "proxy.request", "data": {"x": 1}}
    assert store.put(ev, "d1", T0) is PutResult.ACCEPTED
    assert store.put(ev, "d1", T0) is PutResult.DUPLICATE
    assert store.put(ev, "d2", T0) is PutResult.MISMATCH
    assert log.read(iid) == []  # the engine has not seen it yet
    assert log.append(ev, T0) is True and log.append(ev, T0) is False  # the engine counts it once
    assert [e.event["seq"] for e in log.read(iid)] == [1]
    assert log.append({**ev, "seq": 0}, T0) is True  # an event the engine saw before the receiver stored it
    assert [e.event["seq"] for e in log.read(iid)] == [0, 1] and [e.event["seq"] for e in log.read(iid, epoch=2)] == []


def test_directory_epochs_and_recent(engine):
    attempts = pg.PgAttemptStore(engine)
    a = attempts.add(new_record(user="u-d1"))
    b = attempts.add(new_record(user="u-d2", template="other-v0"))
    d = pg.PgInstanceDirectory(engine)
    iid_a, iid_b = f"i-{uuid.uuid4().hex[:12]}", f"i-{uuid.uuid4().hex[:12]}"
    d.add(InstanceInfo(iid_a, a.id, "shop-v0", 1, ("C01", "C02")))
    d.add(InstanceInfo(iid_b, b.id, "other-v0", 1, ("C01",)))
    assert d.get(iid_a).epoch == 1 and d.for_attempt(a.id).instance_id == iid_a and d.get("nope") is None
    d.add(InstanceInfo(iid_a, a.id, "shop-v0", 2, ("C01", "C02")))
    assert d.get(iid_a).epoch == 2
    assert d.recent("C02", "shop-v0", 3600) == {iid_a: 2}
    assert d.recent("C03", "shop-v0", 3600) == {}
    ep = pg.PgInstanceEpochs(engine)
    assert ep.current(iid_a) is None
    ep.set(iid_a, 1)
    ep.set(iid_a, 2)
    ep.set(iid_a, 1)
    assert ep.current(iid_a) == 2
    with pytest.raises(ValueError):
        ep.set(iid_a, 0)


def test_activity_buckets_count_exactly_under_concurrent_writers(engine):
    store = pg.PgActivityStore(engine)
    iid = f"i-{uuid.uuid4().hex[:12]}"
    ev = {"schema_version": "0.1", "instance_id": iid, "epoch": 1, "seq": 1, "type": "proxy.request", "source": "sidecar",
          "session_kind": "player", "user_id": "u-1", "ts": "2026-10-17T10:00:00Z",
          "data": {"method": "GET", "status": 200, "route_template": "/api/x", "count": 1}}

    def go() -> None:
        for _ in range(10):
            store.record(ev, T0)

    threads = [threading.Thread(target=go) for _ in range(5)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    (bucket,) = store.buckets(iid)
    assert bucket.requests == 50 and bucket.by_method == {"GET": 50} and bucket.by_status_class == {"2xx": 50} and bucket.distinct_routes == 1
    assert store.last_activity(iid) == T0
    assert store.record({**ev, "type": "proxy.flag_seen"}, T0) is False


def test_bot_visits_once_per_phase(engine):
    bots = pg.PgBotVisitStore(engine)
    iid = f"i-{uuid.uuid4().hex[:12]}"
    v = BotVisit(iid, 1, "v-1", "t-1", "start", T0)
    assert bots.add(v) and not bots.add(v) and bots.add(BotVisit(iid, 1, "v-1", "t-1", "end", T0))
    assert bots.count(iid) == 2 and bots.count(iid, "end") == 1 and [x.phase for x in bots.visits(iid)] == ["start", "end"]


def test_the_app_role_cannot_rewrite_or_delete_the_append_only_tables(engine):
    rec = pg.PgAttemptStore(engine).add(new_record(user="u-grant"))
    pg.PgFlagSubmissionLog(engine).record(rec.id, "C01", "incorrect", T0)
    for sql in ("UPDATE flag_submissions SET result = 'correct'", "UPDATE review_audit SET decision = 'accept'",
                "UPDATE integrity_flags SET kind = 'timing'", "DELETE FROM review_audit",
                "DELETE FROM security_events"):
        with pytest.raises(ProgrammingError):
            with engine.begin() as c:
                c.execute(text(sql))


# ---- the whole loop on Postgres, then a restart ----

class DenyC03:
    def allows(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        return challenge_key != "C03"


def make_runtime(engine, clock, host, keys) -> LabRuntime:
    return LabRuntime(host=host, clock=clock, keys=keys, gate=DenyC03(), stores=pg.build_pg_stores(engine))


def signed(rt, ev, key=None):
    raw = json.dumps(ev).encode()
    k = key or rt.keys.event_key(ev["instance_id"], ev["epoch"])
    return rt.handler.handle({"content-type": "application/json", "x-vm-signature": sign_body(k, ev["instance_id"], ev["epoch"], ev["seq"], raw)},
                             raw, "req-pg-0001").status


def flag_event(clock, iid, epoch, seq, challenge, text_):
    return {"schema_version": "0.1", "instance_id": iid, "epoch": epoch, "seq": seq, "type": "proxy.flag_seen", "source": "sidecar",
            "session_kind": "player", "user_id": "u-1001", "ts": clock().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "data": {"kind": "real", "challenge_key": challenge, "candidate_sha256": hashlib.sha256(text_.encode()).hexdigest(),
                     "route_template": "/api/x", "request_ref": f"req-{seq}"}}


def test_the_whole_loop_on_postgres_and_a_restart_loses_nothing(engine):
    clock, host = FakeClock(T0), FakeInstanceHost()
    master = os.urandom(32).hex().encode()
    keys = StoredKeyPort(engine, master)
    user = f"u-loop-{uuid.uuid4().hex[:8]}"
    rt = make_runtime(engine, clock, host, keys)
    started = rt.start_attempt(user, org_id="o-loop")
    aid, iid = started.attempt_id, started.instance_id

    clock.advance(seconds=754)
    c01 = flag_event(clock, iid, 1, 1, "C01", keys.flag(iid, "C01", 1))
    assert signed(rt, c01) == 202 and signed(rt, c01) == 200
    capture = {**c01, "seq": 4, "type": "evidence.capture", "challenge_key": "C01", "data": {"request_ref": "req-1", "body": "GET /_stub/planted-flag?key=C01\n\nuser=u1",
                                                                     "headers_redacted": {"user-agent": "t"}}}
    assert signed(rt, capture) == 202
    assert signed(rt, flag_event(clock, iid, 1, 2, "C02", keys.flag(iid, "C02", 1)), key="forged-key-forged-key-forged-key-00000") == 401
    assert rt.submit_flag(aid, "C02", keys.flag(iid, "C02", 1)).credit == "credited"
    assert rt.unlock_hint(aid, "C02", 1) == 1
    assert signed(rt, flag_event(clock, iid, 1, 3, "C03", keys.flag(iid, "C03", 1))) == 202
    assert rt.milestones.is_held(aid, "C03")
    assert rt.score(aid).score == 147
    assert rt.reset_attempt(aid) == 2
    clock.advance(minutes=121)
    rt.tick()
    assert rt.state(aid)["state"] == "submitted" and rt.state(aid)["access"] == "frozen"

    # restart: a new runtime on the same database, the same keys, a new host handle
    rt2 = make_runtime(engine, clock, host, StoredKeyPort(engine, master))
    (item,) = rt2.reports.evidence(aid)
    assert item.challenge_key == "C01" and rt2.reports.evidence_body(aid, item.evidence_id) == b"GET /_stub/planted-flag?key=C01\n\nuser=u1"
    with engine.connect() as c:
        stored = c.execute(text("SELECT ciphertext FROM evidence WHERE attempt_id = :a"), {"a": aid}).scalar_one()
    assert b"planted" not in bytes(stored), "the evidence table holds sealed bytes only"
    assert rt2.state(aid)["state"] == "submitted" and rt2.state(aid)["started_at"] == T0.isoformat()
    assert rt2.score(aid).score == 147, "the score is recomputed from stored milestones, hints and holds"
    assert rt2.milestones.best(aid, "C01").value == "M3" and rt2.hints.levels(aid, "C02") == (1,)
    assert rt2.directory.get(iid).epoch == 2 and rt2.epochs.current(iid) == 2
    assert signed(rt2, c01) == 200, "a replay after the restart is still a replay"
    assert len(rt2.time_metrics(aid).headline) == 2 and rt2.time_metrics(aid).resets == 1
    assert rt2.attempts.get(aid).org_id == "o-loop"
    assert [e["event"] for e in rt2.attempt_log.read(aid)][0] == "session_started"
    assert [h.challenge_key for h in rt2.held_captures(aid)] == ["C03"]

    # the held capture is reviewed by the second runtime; the first one sees the decision and cannot reverse it
    reviewer = {"id": "r-1", "role": "recruiter", "org_id": "o-loop"}
    assert rt2.decide_held(aid, "C03", reviewer, "accept", "looks real") == "accept"
    assert rt.milestones.best(aid, "C03").value == "M3"
    with pytest.raises(ReviewFinal):
        rt.decide_held(aid, "C03", reviewer, "reject")
    assert rt.decide_held(aid, "C03", reviewer, "accept") == "accept"  # the same decision again: no second audit row
    assert len(rt.audit.rows(aid)) == 1 and rt.audit.rows(aid)[0].reviewer == "r-1"

    # the instance is destroyed on the next tick and the report moves to reported after the decision
    clock.advance(minutes=16)
    rt2.tick()
    assert rt2.state(aid)["destroyed"] is True and host.get(iid).state is InstanceState.DESTROYED
    rt2.tick()
    assert rt2.state(aid)["state"] == "reported"


def test_purge_removes_the_attempt_data_and_keeps_the_attempt_row_and_the_audit(engine):
    clock, host = FakeClock(T0), FakeInstanceHost()
    keys = FakeKeyPort(event_master=os.urandom(32), flag_key=os.urandom(32), owner_key=os.urandom(32))
    rt = make_runtime(engine, clock, host, keys)
    s = rt.start_attempt(f"u-purge-{uuid.uuid4().hex[:8]}", org_id="o-p")
    rt.submit_flag(s.attempt_id, "C01", keys.flag(s.instance_id, "C01", 1))
    rt.unlock_hint(s.attempt_id, "C01", 1)
    rt.withdraw(s.attempt_id)
    removed = pg.purge_attempt_data(engine, s.attempt_id)
    assert removed["milestones"] == 1 and removed["hint_unlocks"] == 1 and removed["instances"] == 1 and removed["attempt_events"] >= 1
    assert rt.milestones.best(s.attempt_id, "C01") is Milestone.NONE and rt.directory.get(s.instance_id) is None
    assert rt.engine.get(s.attempt_id).state is AttemptState.WITHDRAWN
    assert pg.purge_attempt_data(engine, s.attempt_id)["milestones"] == 0  # repeating changes nothing
    assert host.get(s.instance_id).state is InstanceState.DESTROYED


def test_a_withdrawn_attempt_is_purged_by_the_tick_after_the_undo_window(engine):
    clock, host = FakeClock(T0), FakeInstanceHost()
    keys = FakeKeyPort(event_master=os.urandom(32), flag_key=os.urandom(32), owner_key=os.urandom(32))
    rt = make_runtime(engine, clock, host, keys)
    s = rt.start_attempt(f"u-tick-{uuid.uuid4().hex[:8]}")
    rt.submit_flag(s.attempt_id, "C01", keys.flag(s.instance_id, "C01", 1))
    rt.withdraw(s.attempt_id)
    clock.advance(days=6)
    rt.tick()
    assert rt.milestones.best(s.attempt_id, "C01") is Milestone.M3, "inside the undo window nothing is deleted"
    clock.advance(days=2)
    rt.tick()
    assert rt.state(s.attempt_id)["state"] == "deleted"
    assert rt.milestones.best(s.attempt_id, "C01") is Milestone.NONE and rt.directory.get(s.instance_id) is None
    assert rt.attempt_log.read(s.attempt_id) == ()


def test_the_key_port_seals_with_aes_gcm_keeps_its_keys_across_instances_and_shreds(engine):
    master = os.urandom(32).hex().encode()
    k1, k2 = StoredKeyPort(engine, master), StoredKeyPort(engine, master)
    a, b = f"a-{uuid.uuid4().hex[:8]}", f"a-{uuid.uuid4().hex[:8]}"
    key = k1.create_attempt_key(a)
    assert k2.create_attempt_key(a) == key, "creating twice gives the same key, from any instance"
    k1.create_attempt_key(b)
    sealed = k1.encrypt(a, b"secret body", b"aad-1")
    assert b"secret body" not in sealed.ciphertext and len(sealed.nonce) == 24
    assert k2.decrypt(a, sealed, b"aad-1") == b"secret body"
    assert k1.encrypt(a, b"secret body", b"aad-1").ciphertext != sealed.ciphertext, "a fresh nonce each time"
    with pytest.raises(KeyIntegrity):
        k1.decrypt(a, sealed, b"other-aad")
    with pytest.raises(KeyIntegrity):
        k1.decrypt(b, sealed, b"aad-1")  # another attempt's key
    with pytest.raises(KeyIntegrity):
        k1.decrypt(a, Sealed(sealed.dek_id, 1, sealed.nonce, sealed.ciphertext[:-1] + bytes([sealed.ciphertext[-1] ^ 1])), b"aad-1")
    with pytest.raises(AttemptNotFound):
        k1.encrypt("a-unknown", b"x")
    wrong = StoredKeyPort(engine, os.urandom(32).hex().encode())
    with pytest.raises(KeyIntegrity):
        wrong.decrypt(a, sealed, b"aad-1")  # another master key cannot open the stored data key
    assert k1.event_key("i-1", 1) == k2.event_key("i-1", 1) != wrong.event_key("i-1", 1)
    assert k1.flag("i-1", "C01", 1) == k2.flag("i-1", "C01", 1) != k1.flag("i-1", "C01", 2)
    assert k1.owner_hash("u-1") == k2.owner_hash("u-1") and k1.decoy("i-1", "C01", 1, 0) != k1.flag("i-1", "C01", 1)
    assert k1.shred(a) is True and k1.shred(a) is False and k1.shred("a-none") is False
    with pytest.raises(KeyShredded):
        k2.decrypt(a, sealed, b"aad-1")
    with pytest.raises(KeyShredded):
        k2.create_attempt_key(a)
    with engine.connect() as c:
        wrapped = c.execute(text("SELECT wrapped FROM deks WHERE attempt_id = :a"), {"a": a}).scalar_one()
    assert bytes(wrapped) == b"", "the wrapped key is gone, not just flagged"


def test_the_master_key_file_must_be_long_enough_and_private(tmp_path):
    from vulnmart.lab.keys import read_master_key

    short = tmp_path / "short"
    short.write_text("too-short")
    with pytest.raises(ValueError, match="at least"):
        read_master_key(str(short))
    good = tmp_path / "good"
    good.write_text("k" * 40 + "\n")
    if os.name != "nt":
        good.chmod(0o644)
        with pytest.raises(ValueError, match="0600"):
            read_master_key(str(good))
        good.chmod(0o600)
    assert read_master_key(str(good)) == b"k" * 40


def test_the_flag_rate_limit_survives_a_restart_because_it_reads_the_stored_log(engine):
    from vulnmart.ports.errors import FlagRateLimited

    clock, host = FakeClock(T0), FakeInstanceHost()
    master = os.urandom(32).hex().encode()
    keys = StoredKeyPort(engine, master)
    rt = make_runtime(engine, clock, host, keys)
    s = rt.start_attempt(f"u-rate-{uuid.uuid4().hex[:8]}")
    for _ in range(5):
        assert rt.submit_flag(s.attempt_id, "C04", "VM{WRONGWRONGWRONGWRONGWRONG}").result == "incorrect"
    rt2 = make_runtime(engine, clock, host, StoredKeyPort(engine, master))
    with pytest.raises(FlagRateLimited) as hit:
        rt2.submit_flag(s.attempt_id, "C04", keys.flag(s.instance_id, "C04", 1))  # even the right value is refused
    assert hit.value.retry_after > 0
    clock.advance(minutes=11)
    assert rt2.submit_flag(s.attempt_id, "C04", keys.flag(s.instance_id, "C04", 1)).result == "correct"
