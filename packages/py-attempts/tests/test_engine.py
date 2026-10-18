import pytest
from conftest_engine import Rig, at

from vulnmart_attempts import AttemptState as S
from vulnmart_attempts import InvalidTransition


def test_create_is_ready_and_one_per_user_per_template():
    r = Rig()
    a = r.engine.create("u1", "t1", "c1", instance_id="i1")
    assert a.state == S.READY and a.started_at is None and a.deadline_at is None
    b = r.engine.create("u1", "t1", "c2", instance_id="i9")
    assert b.id == a.id and b.consent_id == "c1"
    c = r.engine.create("u1", "t2", "c3")
    assert c.id != a.id
    d = r.engine.create("u2", "t1", "c4")
    assert d.id != a.id


def test_start_at_instance_ready_sets_deadline():
    r = Rig()
    a = r.engine.create("u1", "t1", "c1", instance_id="i1")
    r.clock.set(at(10))
    run = r.engine.instance_ready(a.id, at(10))
    assert run.state == S.RUNNING
    assert run.started_at == at(10) and run.deadline_at == at(130)


def test_start_twice_keeps_deadline():
    r = Rig()
    run = r.started()
    again = r.engine.instance_ready(run.id, at(50))
    assert again.deadline_at == run.deadline_at and again.version == run.version


def test_start_from_wrong_state_refused():
    r = Rig()
    run = r.started()
    r.engine.submit(run.id)
    with pytest.raises(InvalidTransition):
        r.engine.instance_ready(run.id, at(1))


def test_naive_start_instant_refused():
    from datetime import datetime
    r = Rig()
    a = r.engine.create("u1", "t1", "c1")
    with pytest.raises(ValueError):
        r.engine.instance_ready(a.id, datetime(2026, 1, 1))


def test_warnings_each_once():
    r = Rig()
    r.started()
    r.clock.set(at(104, 59))
    r.engine.tick()
    assert r.names("time_warning_sent") == []
    r.clock.set(at(105))
    r.engine.tick()
    r.engine.tick()
    assert [e["minutes_left"] for e in r.names("time_warning_sent")] == [15]
    r.clock.set(at(115))
    r.engine.tick()
    r.engine.tick()
    assert [e["minutes_left"] for e in r.names("time_warning_sent")] == [15, 5]


def test_manual_submit_in_time_freezes_and_destroys_later():
    r = Rig()
    run = r.started()
    r.clock.set(at(30))
    sub = r.engine.submit(run.id)
    assert sub.state == S.SUBMITTED and sub.submitted_at == at(30) and sub.frozen_until == at(45)
    assert r.instances.access["i1"] == "frozen" and sub.access == "frozen"
    assert r.instances.destroy_calls == []
    r.clock.set(at(45))
    r.engine.tick()
    assert r.instances.destroy_calls == ["i1"]
    assert r.engine.get(run.id).destroyed


def test_reported_before_freeze_ends_still_destroys_instance():
    # review finding B1: reported while frozen, the instance used to leak because tick never revisited it
    r = Rig()
    run = r.started()
    r.clock.set(at(30))
    r.engine.submit(run.id)
    r.clock.set(at(32))
    assert r.engine.mark_reported(run.id, held_open=0).state == S.REPORTED
    r.engine.tick()
    assert r.instances.destroy_calls == []
    r.clock.set(at(45))
    r.engine.tick()
    assert r.instances.destroy_calls == ["i1"]
    assert r.engine.get(run.id).destroyed


def test_submit_within_grace_allowed_after_grace_refused():
    r = Rig()
    run = r.started()
    r.clock.set(at(120, 59))
    assert r.engine.submit(run.id).state == S.SUBMITTED
    r2 = Rig()
    run2 = r2.started()
    r2.clock.set(at(121, 1))
    with pytest.raises(InvalidTransition):
        r2.engine.submit(run2.id)
    r2.engine.tick()
    done = r2.engine.get(run2.id)
    assert done.state == S.SUBMITTED and done.submitted_at == at(120)


def test_submit_before_start_and_twice_refused():
    r = Rig()
    a = r.engine.create("u1", "t1", "c1", instance_id="i1")
    with pytest.raises(InvalidTransition):
        r.engine.submit(a.id)
    r2 = Rig()
    run = r2.started()
    r2.engine.submit(run.id)
    with pytest.raises(InvalidTransition):
        r2.engine.submit(run.id)


def test_cancel_running_destroys_at_once_and_records_who_and_why():
    r = Rig()
    run = r.started()
    r.clock.set(at(5))
    c = r.engine.cancel(run.id, "recruiter-1", "candidate unwell")
    assert c.state == S.CANCELLED and c.cancelled_by == "recruiter-1" and c.cancelled_reason == "candidate unwell"
    assert r.instances.destroy_calls == ["i1"] and c.destroyed
    assert r.names("instance_destroyed")


def test_cancel_ready_without_instance():
    r = Rig()
    a = r.engine.create("u1", "t1", "c1")
    c = r.engine.cancel(a.id, "r", "x")
    assert c.state == S.CANCELLED and c.destroyed and r.instances.destroy_calls == []


@pytest.mark.parametrize("how", ["submitted", "expired", "cancelled"])
def test_cancel_refused_outside_ready_and_running(how):
    r = Rig()
    run = r.started()
    if how == "submitted":
        r.engine.submit(run.id)
    elif how == "expired":
        r.clock.set(at(121))
        r.engine.tick()
    else:
        r.engine.cancel(run.id, "r", "x")
    with pytest.raises(InvalidTransition):
        r.engine.cancel(run.id, "r", "again")


def test_mark_reported_rules():
    r = Rig()
    run = r.started()
    with pytest.raises(InvalidTransition):
        r.engine.mark_reported(run.id, held_open=0)
    r.engine.submit(run.id)
    assert r.engine.mark_reported(run.id, held_open=1).state == S.SUBMITTED
    assert r.engine.mark_reported(run.id, held_open=0, scoring_exists=False).state == S.SUBMITTED
    assert r.engine.mark_reported(run.id, held_open=0).state == S.REPORTED
    assert r.engine.mark_reported(run.id, held_open=0).state == S.REPORTED  # idempotent


def test_events_hold_only_ids_states_and_times():
    r = Rig()
    run = r.started()
    r.engine.submit(run.id)
    for e in r.events:
        assert set(e) <= {"event", "attempt_id", "state", "at", "from", "to", "minutes_left", "deadline_at",
                          "submitted_at", "reason", "instance_id"}
    assert [e["to"] for e in r.names("attempt.state_changed")] == ["running", "submitted"]


def test_event_sink_failure_does_not_undo_step():
    r = Rig()
    r.engine._events = lambda e: (_ for _ in ()).throw(RuntimeError("sink down"))
    run = r.started()
    assert r.engine.get(run.id).state == S.RUNNING
