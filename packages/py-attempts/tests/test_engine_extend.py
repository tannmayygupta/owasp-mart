"""R-25, C-30: a recruiter gives a running attempt extra time. The deadline moves, a warning that is due again fires again, the total is capped, and nothing reopens an
ended attempt."""
import pytest
from conftest_engine import Rig, at

from vulnmart_attempts import AttemptState as S
from vulnmart_attempts import ExtensionRefused, InvalidTransition
from vulnmart_attempts.engine import MAX_EXTENSION_MINUTES


def test_extra_time_moves_the_deadline_records_who_and_leaves_the_start():
    r = Rig()
    run = r.started()
    r.clock.set(at(30))
    new = r.engine.extend(run.id, 30, "u-recruiter")
    assert new.deadline_at == at(150) and new.started_at == at(0) and new.extended_minutes == 30 and new.state == S.RUNNING
    event = r.names("time_extended")[0]
    assert (event["minutes"], event["viewer_id"], event["deadline_at"]) == (30, "u-recruiter", at(150).isoformat())


def test_a_warning_that_is_due_again_fires_again_and_one_that_is_not_stays_sent():
    r = Rig()
    run = r.started()
    r.clock.set(at(106))  # 14 minutes left: the 15 minute warning is out
    r.engine.tick()
    assert r.engine.get(run.id).warnings_sent == (15,)
    r.engine.extend(run.id, 30, "u-recruiter")  # 44 minutes left now
    assert r.engine.get(run.id).warnings_sent == ()
    r.clock.set(at(136))
    r.engine.tick()
    assert [e["minutes_left"] for e in r.names("time_warning_sent")] == [15, 15], "the warning is sent again at the new deadline"


def test_the_total_extra_time_is_capped_and_a_refusal_changes_nothing():
    r = Rig()
    run = r.started()
    r.engine.extend(run.id, MAX_EXTENSION_MINUTES, "u-r")
    before = r.engine.get(run.id)
    with pytest.raises(ExtensionRefused):
        r.engine.extend(run.id, 1, "u-r")
    assert r.engine.get(run.id) == before


@pytest.mark.parametrize("minutes", [0, -5, True, 2.5, "30"])
def test_minutes_is_a_positive_whole_number(minutes):
    r = Rig()
    run = r.started()
    with pytest.raises(ValueError):
        r.engine.extend(run.id, minutes, "u-r")


def test_only_a_running_attempt_before_its_deadline_can_be_extended():
    r = Rig()
    ready = r.engine.create("u1", "t1", "c1", instance_id="i1")
    with pytest.raises(InvalidTransition):
        r.engine.extend(ready.id, 10, "u-r")
    run = r.started(user="u2", template="t2", instance="i2")
    r.clock.set(at(120, 1))  # the deadline has passed
    with pytest.raises(InvalidTransition):
        r.engine.extend(run.id, 10, "u-r")
    done = r.started(user="u3", template="t3", instance="i3")
    r.engine.submit(done.id)
    with pytest.raises(InvalidTransition):
        r.engine.extend(done.id, 10, "u-r")