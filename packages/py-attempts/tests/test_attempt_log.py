"""FR-TIM-04: the log is ids-only, by allow-list."""
from datetime import timedelta

import pytest
from conftest_engine import T0, Rig, at

from vulnmart_attempts import AttemptEngine, FakeClock, InMemoryAttemptStore, InMemoryInstanceControl
from vulnmart_attempts.attempt_log import COMMON_FIELDS, EVENT_FIELDS, InMemoryAttemptLog, validate_event

FR_TIM_04 = {
    "invite_created", "invite_opened", "consent_given", "session_started", "instance_requested", "instance_ready",
    "request_seen", "milestone_reached", "flag_auto_detected", "flag_submitted", "hint_unlocked", "instance_reset",
    "time_warning_sent", "session_expired", "session_submitted", "instance_destroyed", "recruiter_viewed_report",
}


def ev(**kw):
    base = {"event": "flag_submitted", "attempt_id": "a1", "at": T0.isoformat(), "challenge_key": "C01", "result": "wrong"}
    base.update(kw)
    return base


def test_every_prd_event_name_is_on_the_list():
    assert FR_TIM_04 <= set(EVENT_FIELDS)


def test_append_and_read_in_order_and_other_attempt_is_empty():
    log = InMemoryAttemptLog()
    log.append(ev(result="wrong"))
    log.append(ev(result="correct"))
    assert [e["result"] for e in log.read("a1")] == ["wrong", "correct"]
    assert log.read("other") == ()


def test_unknown_event_name_is_refused():
    with pytest.raises(ValueError):
        InMemoryAttemptLog().append(ev(event="page_viewed"))


@pytest.mark.parametrize("field", ["email", "name", "body", "flag", "digest", "text", "ip"])
def test_unknown_field_is_refused(field):
    log = InMemoryAttemptLog()
    with pytest.raises(ValueError):
        log.append(ev(**{field: "x"}))
    assert log.read("a1") == ()


def test_field_of_another_event_is_refused():
    with pytest.raises(ValueError):
        InMemoryAttemptLog().append(ev(event="instance_reset", challenge_key="C01"))


def test_missing_ids_and_non_scalar_and_long_values_are_refused():
    log = InMemoryAttemptLog()
    for bad in (ev(attempt_id=""), ev(at=None), ev(result=["x"]), ev(result="x" * 101)):
        with pytest.raises(ValueError):
            log.append(bad)


def test_full_attempt_on_a_fake_clock_logs_in_order_with_no_other_field():
    log = InMemoryAttemptLog()
    clock = FakeClock(T0)
    inst = InMemoryInstanceControl()
    engine = AttemptEngine(InMemoryAttemptStore(), inst, clock, log.from_engine)
    a = engine.create("u1", "t1", "c1", instance_id="i1")
    engine.instance_ready(a.id, clock())
    for minute in (105, 115, 120, 135):
        clock.set(at(minute))
        engine.tick()
    events = log.read(a.id)
    assert [e["event"] for e in events] == [
        "session_started", "time_warning_sent", "time_warning_sent", "session_expired", "session_submitted",
        "instance_destroyed"]
    assert [e.get("minutes_left") for e in events if e["event"] == "time_warning_sent"] == [15, 5]
    for e in events:
        assert set(e) <= COMMON_FIELDS | EVENT_FIELDS[e["event"]]


def test_every_event_the_engine_emits_passes_the_allow_list():
    r = Rig()
    log = InMemoryAttemptLog()
    r.engine = AttemptEngine(r.store, r.instances, r.clock, lambda p: (r.events.append(p), log.from_engine(p)))
    a = r.started("u1", "t1", "i1")
    r.engine.record_reset(a.id)
    r.clock.set(at(10))
    r.engine.withdraw(a.id)
    r.clock.set(at(0) + timedelta(days=8))
    r.engine.tick()
    b = r.started("u2", "t1", "i2")
    r.engine.submit(b.id)
    c = r.started("u3", "t1", "i3")
    r.engine.cancel(c.id, "recruiter", "x")
    emitted = [e for e in r.events if e["event"] != "attempt.state_changed"]
    assert emitted
    for e in emitted:  # the engine swallows sink errors, so validate every emitted payload directly
        validate_event(e)
    assert len(log.read(a.id)) >= 3  # started, reset, instance_destroyed, withdrawn
    for attempt in (a, b, c):
        for e in log.read(attempt.id):
            assert set(e) <= COMMON_FIELDS | EVENT_FIELDS[e["event"]]
