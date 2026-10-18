"""FR-SES-09 and D-91: resets count only while running, never past the limit; clock, deadline and milestones survive."""
import threading

import pytest
from conftest_engine import Rig, at

from vulnmart_attempts import AttemptState as S
from vulnmart_attempts import InvalidTransition, ResetLimitReached, Rules


def test_three_resets_count_one_two_three_and_clock_is_untouched():
    r = Rig()
    run = r.started()
    for expected in (1, 2, 3):
        r.clock.set(at(expected * 10))
        assert r.engine.can_reset(run.id) is True
        assert r.engine.record_reset(run.id).reset_count == expected
    rec = r.engine.get(run.id)
    assert rec.started_at == at(0) and rec.deadline_at == at(120) and rec.state == S.RUNNING


def test_fourth_reset_is_refused_before_the_instance_is_touched():
    r = Rig()
    run = r.started()
    for _ in range(3):
        r.engine.record_reset(run.id)
    with pytest.raises(ResetLimitReached) as err:
        r.engine.can_reset(run.id)
    assert err.value.limit == 3
    with pytest.raises(ResetLimitReached):
        r.engine.record_reset(run.id)
    rec = r.engine.get(run.id)
    assert rec.reset_count == 3 and rec.deadline_at == at(120)
    assert r.instances.destroy_calls == [] and r.instances.freeze_calls == []


def test_reset_in_ready_is_free_and_not_counted():
    r = Rig()
    ready = r.engine.create("u1", "t1", "c1", instance_id="i1")
    assert r.engine.can_reset(ready.id) is False
    assert r.engine.record_reset(ready.id).reset_count == 0
    assert r.names("instance_reset") == []


def test_reset_after_expiry_is_refused():
    r = Rig()
    run = r.started()
    r.clock.set(at(121))
    r.engine.tick()
    assert r.engine.get(run.id).state == S.SUBMITTED
    with pytest.raises(InvalidTransition):
        r.engine.can_reset(run.id)
    with pytest.raises(InvalidTransition):
        r.engine.record_reset(run.id)


def test_reset_event_holds_ids_and_the_count_only():
    r = Rig()
    run = r.started()
    r.clock.set(at(5))
    r.engine.record_reset(run.id)
    (event,) = r.names("instance_reset")
    assert set(event) == {"event", "attempt_id", "state", "at", "reset_count"}
    assert event["reset_count"] == 1 and event["attempt_id"] == run.id


def test_limit_zero_refuses_every_running_reset():
    r = Rig()
    run = r.engine.create("u1", "t1", "c1", rules=Rules(reset_limit=0), instance_id="i1")
    run = r.engine.instance_ready(run.id, r.clock())
    with pytest.raises(ResetLimitReached):
        r.engine.can_reset(run.id)


def test_two_threads_never_exceed_the_limit():
    r = Rig()
    run = r.started()
    results = []

    def go():
        try:
            r.engine.record_reset(run.id)
            results.append("ok")
        except ResetLimitReached:
            results.append("limit")

    threads = [threading.Thread(target=go) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("ok") == 3 and results.count("limit") == 5
    assert r.engine.get(run.id).reset_count == 3
