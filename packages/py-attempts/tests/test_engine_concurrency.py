import threading

import pytest
from conftest_engine import Rig, at

from vulnmart_attempts import AttemptRecord, AttemptState, Conflict, InMemoryAttemptStore, Rules


def test_two_engines_one_store_one_destroy():
    r = Rig()
    other = r.second_engine()
    run = r.started()
    r.clock.set(at(500))
    barrier = threading.Barrier(2)

    def work(engine):
        barrier.wait()
        engine.tick()

    threads = [threading.Thread(target=work, args=(e,)) for e in (r.engine, other)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    rec = r.engine.get(run.id)
    assert rec.state == AttemptState.SUBMITTED and rec.destroyed
    assert r.instances.destroy_calls == ["i1"]
    assert len(r.names("instance_destroyed")) == 1
    assert len(r.names("session_submitted")) == 1


def test_many_rounds_two_engines_never_double_destroy():
    for _ in range(20):
        r = Rig()
        other = r.second_engine()
        run = r.started()
        r.clock.set(at(500))
        ts = [threading.Thread(target=e.tick) for e in (r.engine, other)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        assert r.instances.destroy_calls == ["i1"], run.id


def test_sequential_second_engine_sees_no_work():
    r = Rig()
    other = r.second_engine()
    r.started()
    r.clock.set(at(500))
    r.engine.tick()
    assert other.tick() == ()


def test_store_compare_and_set_and_unique_key():
    s = InMemoryAttemptStore()
    rec = AttemptRecord(id="a", user_id="u", template_id="t", consent_id="c", created_at=at(0), rules=Rules())
    stored = s.add(rec)
    assert stored.version == 0
    with pytest.raises(Conflict):
        s.add(AttemptRecord(id="b", user_id="u", template_id="t", consent_id="c", created_at=at(0)))
    new = s.put_if_version(stored, 0)
    assert new.version == 1
    with pytest.raises(Conflict):
        s.put_if_version(stored, 0)
    assert s.find("u", "t").id == "a" and s.find("u", "x") is None
