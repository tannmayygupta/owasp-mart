from conftest_engine import Rig, at

from vulnmart_attempts import AttemptState as S


def test_expiry_sequence_freeze_then_destroy_once():
    r = Rig()
    run = r.started()
    r.clock.set(at(120))
    r.engine.tick()
    rec = r.engine.get(run.id)
    assert rec.state == S.SUBMITTED and rec.submitted_at == at(120) and rec.frozen_until == at(135)
    assert r.instances.access["i1"] == "frozen"
    assert [e["to"] for e in r.names("attempt.state_changed")] == ["running", "expired", "submitted"]
    assert len(r.names("session_expired")) == 1 and len(r.names("session_submitted")) == 1

    r.clock.set(at(134, 59))
    r.engine.tick()
    assert r.instances.destroy_calls == []

    r.clock.set(at(135))
    r.engine.tick()
    assert r.instances.destroy_calls == ["i1"]
    r.clock.set(at(200))
    assert r.engine.tick() == ()
    assert r.instances.destroy_calls == ["i1"] and len(r.names("instance_destroyed")) == 1


def test_no_expiry_before_deadline():
    r = Rig()
    run = r.started()
    r.clock.set(at(119, 59))
    r.engine.tick()
    assert r.engine.get(run.id).state == S.RUNNING


def test_late_scheduler_does_everything_in_one_tick():
    r = Rig()
    run = r.started()
    r.clock.set(at(120 + 180))
    assert r.engine.tick() == (run.id,)
    rec = r.engine.get(run.id)
    assert rec.state == S.SUBMITTED and rec.submitted_at == at(120)
    assert rec.access == "frozen" and rec.destroyed
    assert r.instances.freeze_calls == ["i1"] and r.instances.destroy_calls == ["i1"]
    assert r.instances.access["i1"] == "frozen" and "i1" in r.instances.destroyed


def test_one_late_tick_equals_many_small_ticks():
    a, b = Rig(), Rig()
    ra, rb = a.started(), b.started()
    for sec in range(0, 140 * 60, 15):
        b.clock.set(at(0, sec))
        b.engine.tick()
    a.clock.set(at(140))
    b.clock.set(at(140))
    a.engine.tick()
    b.engine.tick()
    fa, fb = a.engine.get(ra.id), b.engine.get(rb.id)
    for name in ("state", "submitted_at", "frozen_until", "access", "destroyed"):  # warnings are skipped, by design, once the deadline has passed
        assert getattr(fa, name) == getattr(fb, name), name


def test_double_tick_is_idempotent():
    r = Rig()
    run = r.started()
    r.clock.set(at(121))
    r.engine.tick()
    snapshot = r.engine.get(run.id)
    n_events = len(r.events)
    assert r.engine.tick() == ()
    assert r.engine.get(run.id) == snapshot and len(r.events) == n_events


def test_lost_connection_never_stops_the_clock():
    # Nothing but tick() is ever called between start and the end: no heartbeat, no request.
    r = Rig()
    run = r.started()
    for minute in range(0, 120):
        r.clock.set(at(minute))
        r.engine.tick()
        assert r.engine.get(run.id).deadline_at == at(120)
        assert r.engine.get(run.id).state == S.RUNNING
    r.clock.set(at(120))
    r.engine.tick()
    assert r.engine.get(run.id).state == S.SUBMITTED
    assert r.engine.get(run.id).deadline_at == at(120)


def test_freeze_failure_retried_next_tick():
    r = Rig()
    run = r.started()
    r.instances.fail_freeze = 2
    r.clock.set(at(121))
    r.engine.tick()
    rec = r.engine.get(run.id)
    assert rec.state == S.SUBMITTED and rec.access == "open" and "i1" not in r.instances.access
    r.engine.tick()
    assert r.engine.get(run.id).access == "open"
    r.engine.tick()
    rec = r.engine.get(run.id)
    assert rec.access == "frozen" and r.instances.access["i1"] == "frozen"
    assert len(r.instances.freeze_calls) == 3


def test_freeze_failure_blocks_destroy_until_frozen():
    r = Rig()
    run = r.started()
    r.instances.fail_freeze = 1
    r.clock.set(at(300))
    r.engine.tick()
    rec = r.engine.get(run.id)
    assert rec.access == "open" and not rec.destroyed and r.instances.destroy_calls == []
    r.engine.tick()
    assert r.engine.get(run.id).destroyed


def test_destroy_failure_retried_next_tick_and_claim_released():
    r = Rig()
    run = r.started()
    r.instances.fail_destroy = 1
    r.clock.set(at(300))
    r.engine.tick()
    rec = r.engine.get(run.id)
    assert not rec.destroyed and rec.destroy_claim_at is None and not r.names("instance_destroyed")
    r.engine.tick()
    assert r.engine.get(run.id).destroyed
    assert len(r.instances.destroy_calls) == 2 and len(r.names("instance_destroyed")) == 1


def test_cancel_destroy_failure_retried_by_tick():
    r = Rig()
    run = r.started()
    r.instances.fail_destroy = 1
    c = r.engine.cancel(run.id, "r", "x")
    assert c.state == S.CANCELLED and not c.destroyed
    r.engine.tick()
    assert r.engine.get(run.id).destroyed


def test_stale_destroy_claim_is_taken_over():
    from dataclasses import replace
    r = Rig()
    run = r.started()
    r.instances.fail_destroy = 0
    r.clock.set(at(121))
    r.engine.tick()  # submitted and frozen, not yet destroyable
    rec = r.engine.get(run.id)
    r.store.put_if_version(replace(rec, destroy_claim_at=at(121)), rec.version)
    r.clock.set(at(136))
    r.engine.tick()
    assert r.engine.get(run.id).destroyed


def test_fresh_destroy_claim_blocks_second_process():
    from dataclasses import replace
    r = Rig()
    run = r.started()
    r.clock.set(at(121))
    r.engine.tick()
    rec = r.engine.get(run.id)
    r.clock.set(at(136))
    r.store.put_if_version(replace(rec, destroy_claim_at=at(136, -10)), rec.version)
    r.engine.tick()
    assert r.instances.destroy_calls == [] and not r.engine.get(run.id).destroyed
