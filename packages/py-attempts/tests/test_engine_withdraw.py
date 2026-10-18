"""FR-SES-10 and D-91: withdrawal destroys the instance, schedules deletion after 7 days, undo keeps it withdrawn."""
from datetime import timedelta

import pytest
from conftest_engine import Rig, at

from vulnmart_attempts import AttemptState as S
from vulnmart_attempts import InvalidTransition, WindowClosed

DAY = timedelta(days=1)


def test_withdraw_running_destroys_once_and_schedules_deletion():
    r = Rig()
    run = r.started()
    r.clock.set(at(10))
    rec = r.engine.withdraw(run.id)
    assert rec.state == S.WITHDRAWN and rec.withdrawn_at == at(10) and rec.delete_after == at(10) + 7 * DAY
    assert r.instances.destroy_calls == ["i1"] and rec.destroyed
    (event,) = r.names("attempt_withdrawn")
    assert set(event) == {"event", "attempt_id", "state", "at", "delete_after"}
    assert event["delete_after"] == (at(10) + 7 * DAY).isoformat()


def test_withdraw_twice_returns_same_record_and_one_destroy():
    r = Rig()
    run = r.started()
    first = r.engine.withdraw(run.id)
    assert r.engine.withdraw(run.id) == first
    assert r.instances.destroy_calls == ["i1"] and len(r.names("attempt_withdrawn")) == 1


def test_failed_destroy_leaves_record_unchanged_and_retry_succeeds():
    r = Rig()
    run = r.started()
    r.instances.fail_destroy = 1
    with pytest.raises(RuntimeError):
        r.engine.withdraw(run.id)
    assert r.engine.get(run.id) == run
    assert r.engine.withdraw(run.id).state == S.WITHDRAWN


def test_withdraw_from_ready_has_no_instance_call_when_none_exists():
    r = Rig()
    ready = r.engine.create("u1", "t1", "c1")
    assert r.engine.withdraw(ready.id).state == S.WITHDRAWN
    assert r.instances.destroy_calls == []


def test_withdraw_from_submitted_destroys_the_frozen_instance():
    r = Rig()
    run = r.started()
    r.clock.set(at(30))
    r.engine.submit(run.id)
    assert r.instances.destroy_calls == []
    assert r.engine.withdraw(run.id).state == S.WITHDRAWN
    assert r.instances.destroy_calls == ["i1"]


def test_withdraw_refused_from_reported_and_cancelled():
    r = Rig()
    a = r.started("u1", "t1", "i1")
    r.engine.submit(a.id)
    r.engine.mark_reported(a.id, held_open=0)
    with pytest.raises(InvalidTransition):
        r.engine.withdraw(a.id)
    b = r.started("u2", "t1", "i2")
    r.engine.cancel(b.id, "recruiter", "wrong template")
    with pytest.raises(InvalidTransition):
        r.engine.withdraw(b.id)


def test_undo_on_day_six_cancels_deletion_and_attempt_stays_withdrawn():
    r = Rig()
    run = r.started()
    r.engine.withdraw(run.id)
    r.clock.set(at(0) + 6 * DAY)
    rec = r.engine.undo_withdrawal(run.id)
    assert rec.state == S.WITHDRAWN and rec.delete_after is None and rec.undone_at == at(0) + 6 * DAY
    r.clock.set(at(0) + 30 * DAY)
    assert r.engine.tick() == ()
    assert r.engine.get(run.id).state == S.WITHDRAWN
    assert len(r.names("withdrawal_undone")) == 1
    assert r.engine.undo_withdrawal(run.id) == r.engine.get(run.id)  # repeat is a no-op


def test_undo_on_day_eight_is_refused():
    r = Rig()
    run = r.started()
    r.engine.withdraw(run.id)
    r.clock.set(at(0) + 8 * DAY)
    with pytest.raises(WindowClosed):
        r.engine.undo_withdrawal(run.id)


def test_undo_exactly_at_the_end_of_the_window_is_refused():
    r = Rig()
    run = r.started()
    r.engine.withdraw(run.id)
    r.clock.set(at(0) + 7 * DAY)
    with pytest.raises(WindowClosed):
        r.engine.undo_withdrawal(run.id)


def test_undo_on_an_attempt_that_is_not_withdrawn_is_refused():
    r = Rig()
    run = r.started()
    with pytest.raises(InvalidTransition):
        r.engine.undo_withdrawal(run.id)


def test_tick_moves_to_deleted_at_day_seven_and_not_before():
    r = Rig()
    run = r.started()
    r.engine.withdraw(run.id)
    r.clock.set(at(0) + 7 * DAY - timedelta(seconds=1))
    assert r.engine.tick() == ()
    assert r.engine.get(run.id).state == S.WITHDRAWN
    r.clock.set(at(0) + 7 * DAY)
    assert r.engine.tick() == (run.id,)
    rec = r.engine.get(run.id)
    assert rec.state == S.DELETED and rec.deleted_at == at(0) + 7 * DAY
    assert r.engine.tick() == ()


def test_withdrawn_attempt_is_not_expired_or_resubmitted_by_tick():
    r = Rig()
    run = r.started()
    r.engine.withdraw(run.id)
    r.clock.set(at(200))
    r.engine.tick()
    assert r.engine.get(run.id).state == S.WITHDRAWN and r.names("session_expired") == []
