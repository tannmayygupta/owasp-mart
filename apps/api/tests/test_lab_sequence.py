"""A learner's run goes one challenge at a time, each with its own countdown (Easy 20, Medium 40, Hard 60 minutes); a finished run can be followed by a new one; the
account keeps the best result per challenge. Times are checked by hand against the tiers of challenges/catalog, not against the code under test:
C01 Easy 20, C02 Medium 40, C03 Medium 40, C04 Medium 40, C05 Easy 20, C06 Hard 60, C07 Easy 20, C08 Medium 40, C09 Medium 40, C10 Hard 60, C11 Medium 40 = 420 minutes."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from vulnmart_attempts import AttemptState, FakeClock

from support import play
from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.lab.sequence import ACTIVE, EXPIRED, FUTURE, READY, SOLVED, TIER_MINUTES
from vulnmart.ports.errors import AttemptStateInvalid, ChallengeNotFound
from vulnmart.ports.fake_instance_host import FakeInstanceHost

T0 = datetime(2026, 10, 20, 9, 0, 0, tzinfo=UTC)
MINUTES = {"C01": 20, "C02": 40, "C03": 40, "C04": 40, "C05": 20, "C06": 60, "C07": 20, "C08": 40, "C09": 40, "C10": 60, "C11": 40}


def make(sequenced: bool = True):
    clock = FakeClock(T0)
    host = FakeInstanceHost()
    env = {"VULNMART_LAB_SEQUENCE": "1"} if sequenced else {}
    return build_lab_runtime(env, host=host, clock=clock), clock, host


def states(rt, attempt_id):
    return [(c.challenge_key, c.state) for c in rt.challenge_clocks(attempt_id)]


def test_the_tiers_give_twenty_forty_and_sixty_minutes():
    assert dict(TIER_MINUTES) == {"Easy": 20, "Medium": 40, "Hard": 60}
    rt, _, _ = make()
    assert {k: rt.sequence.limit_minutes(k) for k in rt.challenge_keys} == MINUTES
    assert rt.sequence.total_minutes() == 420
    assert rt.sequence.run_limit_minutes() == 450


def test_a_sequenced_run_lasts_the_sum_of_the_times_plus_thirty_minutes_and_its_instance_outlives_it():
    rt, _, host = make()
    started = rt.start_attempt("u-1")
    rec = rt.engine.get(started.attempt_id)
    assert rec.rules.time_limit_minutes == 450
    assert rec.deadline_at == T0 + timedelta(minutes=450)
    assert rt._limits_for(rec).max_minutes == 480  # the run limit plus the 30 minute margin, so the instance does not stop before the run ends
    plain, _, _ = make(sequenced=False)
    assert plain._limits_for(plain.engine.get(plain.start_attempt("u-1").attempt_id)).max_minutes == 240  # unchanged where the runtime is not sequenced


def test_only_the_first_challenge_exists_until_it_is_begun_and_solved():
    rt, clock, _ = make()
    a = rt.start_attempt("u-1").attempt_id
    s = states(rt, a)
    assert s[0] == ("C01", READY) and all(state == FUTURE for _, state in s[1:])


def test_nothing_counts_before_the_challenge_is_begun_and_a_later_challenge_does_not_exist():
    rt, _, _ = make()
    started = rt.start_attempt("u-1")
    a, i = started.attempt_id, started.instance_id
    play(rt, i)
    with pytest.raises(AttemptStateInvalid):  # C01 is current but not begun
        rt.submit_flag(a, "C01", rt.keys.flag(i, "C01", 1))
    with pytest.raises(ChallengeNotFound):  # C02 has not been reached
        rt.submit_flag(a, "C02", rt.keys.flag(i, "C02", 1))
    with pytest.raises(AttemptStateInvalid):
        rt.unlock_hint(a, "C01", 1)
    with pytest.raises(ChallengeNotFound):
        rt.unlock_hint(a, "C02", 1)
    assert rt.score(a).score == 0


def test_begin_starts_the_countdown_once_and_a_repeat_changes_nothing():
    rt, clock, _ = make()
    a = rt.start_attempt("u-1").attempt_id
    first = rt.begin_challenge(a, "C01")
    assert first.state == ACTIVE and first.opened_at == T0 and first.expires_at == T0 + timedelta(minutes=20)
    clock.advance(minutes=5)
    again = rt.begin_challenge(a, "C01")
    assert again.opened_at == T0 and again.seconds_left(clock()) == 15 * 60  # the first instant stays
    with pytest.raises(ChallengeNotFound):
        rt.begin_challenge(a, "C02")  # not the current challenge


def test_a_flag_for_the_active_challenge_is_credited_and_the_next_challenge_appears():
    rt, clock, _ = make()
    started = rt.start_attempt("u-1")
    a, i = started.attempt_id, started.instance_id
    play(rt, i)
    rt.begin_challenge(a, "C01")
    right = rt.submit_flag(a, "C01", rt.keys.flag(i, "C01", 1))
    assert (right.result, right.credit) == ("correct", "credited")
    s = dict(states(rt, a))
    assert s["C01"] == SOLVED and s["C02"] == READY and s["C03"] == FUTURE
    assert rt.score(a).score == 63  # C01 weighs 60 of 960: 1000 x 60 / 960 = 62.5, half up


def test_when_the_time_is_over_the_challenge_is_closed_and_the_next_one_comes_up():
    rt, clock, _ = make()
    started = rt.start_attempt("u-1")
    a, i = started.attempt_id, started.instance_id
    play(rt, i)
    rt.begin_challenge(a, "C01")
    clock.advance(minutes=19, seconds=59)
    assert dict(states(rt, a))["C01"] == ACTIVE
    clock.advance(seconds=1)  # 20 minutes: Easy
    assert dict(states(rt, a))["C01"] == EXPIRED and dict(states(rt, a))["C02"] == READY
    with pytest.raises(AttemptStateInvalid):  # no flag and no hint after the time
        rt.submit_flag(a, "C01", rt.keys.flag(i, "C01", 1))
    with pytest.raises(AttemptStateInvalid):
        rt.unlock_hint(a, "C01", 1)
    assert rt.score(a).score == 0


def test_a_milestone_credited_before_the_time_is_over_stays():
    rt, clock, _ = make()
    started = rt.start_attempt("u-1")
    a, i = started.attempt_id, started.instance_id
    rt.begin_challenge(a, "C01")
    clock.advance(minutes=1)
    event = {"schema_version": "0.1", "instance_id": i, "epoch": 1, "seq": 1, "type": "shop.cross_store_order_read", "source": "shop", "session_kind": "player",
             "user_id": "u-1001", "ts": clock().strftime("%Y-%m-%dT%H:%M:%SZ"), "data": {"order_id": "VM-100777", "caller_user_id": "u-1001", "caller_store_id": "s-01", "order_store_id": "s-02"}}
    from test_lab_runtime import post
    assert post(rt, event).status == 202
    assert rt.milestones.best(a, "C01").value == "M1"
    clock.advance(minutes=30)
    assert dict(states(rt, a))["C01"] == EXPIRED
    assert rt.milestones.best(a, "C01").value == "M1"  # what was earned stays


def test_an_event_for_a_challenge_that_is_not_active_credits_nothing():
    rt, clock, _ = make()
    started = rt.start_attempt("u-1")
    a, i = started.attempt_id, started.instance_id
    from test_lab_runtime import flag_event, post
    # C05 is a later challenge: its flag seen in a response by the sidecar must not credit the learner yet
    assert post(rt, flag_event(rt, i, "C05", rt.keys.flag(i, "C05", 1), 1, clock)).status == 202
    assert rt.milestones.best(a, "C05").value == "none"
    # C01 is current but not begun: nothing yet either
    assert post(rt, flag_event(rt, i, "C01", rt.keys.flag(i, "C01", 1), 2, clock)).status == 202
    assert rt.milestones.best(a, "C01").value == "none"
    rt.begin_challenge(a, "C01")
    assert post(rt, flag_event(rt, i, "C01", rt.keys.flag(i, "C01", 1), 3, clock)).status == 202
    assert rt.milestones.best(a, "C01").value == "M3"


def test_a_run_that_is_not_sequenced_is_unchanged_all_challenges_are_open():
    rt, _, _ = make(sequenced=False)
    started = rt.start_attempt("u-1")
    play(rt, started.instance_id)
    assert all(state == ACTIVE for _, state in states(rt, started.attempt_id))
    assert rt.submit_flag(started.attempt_id, "C05", rt.keys.flag(started.instance_id, "C05", 1)).credit == "credited"
    with pytest.raises(ChallengeNotFound):
        rt.begin_challenge(started.attempt_id, "C01")


def test_the_tick_submits_a_run_whose_challenges_are_all_over_and_a_new_run_can_follow():
    rt, clock, host = make()
    first = rt.start_attempt("u-1")
    a = first.attempt_id
    for key in rt.challenge_keys:  # every challenge is begun and left to run out
        rt.begin_challenge(a, key)
        clock.advance(minutes=MINUTES[key])
    assert rt.sequence.finished(a)
    rt.tick()
    assert rt.engine.get(a).state in (AttemptState.SUBMITTED, AttemptState.REPORTED)
    second = rt.start_attempt("u-1")
    assert second.attempt_id != a  # a finished learner run is followed by a new one
    assert rt.engine.get(a).state in (AttemptState.SUBMITTED, AttemptState.REPORTED)  # the old run stays as history
    assert [r.id for r in rt.engine.for_user("u-1")][:2] == [second.attempt_id, a]
    assert dict(states(rt, second.attempt_id))["C01"] == READY  # the new run starts again from the first challenge
    assert host.host_status().instances == 1  # the finished run no longer holds an instance


def test_a_running_run_is_never_replaced_by_a_second_start():
    rt, _, _ = make()
    first = rt.start_attempt("u-1")
    assert rt.start_attempt("u-1").attempt_id == first.attempt_id


def test_the_account_keeps_the_best_result_per_challenge_over_all_runs():
    rt, clock, _ = make()
    f = rt.start_attempt("u-1")
    play(rt, f.instance_id)
    rt.begin_challenge(f.attempt_id, "C01")
    rt.submit_flag(f.attempt_id, "C01", rt.keys.flag(f.instance_id, "C01", 1))  # 63 points
    assert rt.account_progress("u-1")["total_points"] == 63
    rt.submit(f.attempt_id)
    s = rt.start_attempt("u-1")
    play(rt, s.instance_id)
    rt.begin_challenge(s.attempt_id, "C01")
    rt.submit_flag(s.attempt_id, "C01", rt.keys.flag(s.instance_id, "C01", 1))  # the same challenge again: still 63, not 126
    acc = rt.account_progress("u-1")
    assert acc["total_points"] == 63 and acc["runs"] == 2
    assert next(r for r in acc["per_challenge"] if r["challenge_key"] == "C01")["best_points"] == 60  # the raw points of the challenge (weight 60); the total is shown out of 1000
    assert rt.account_progress("u-2") == {"total_points": 0, "runs": 0, "per_challenge": [{"challenge_key": k, "best_points": 0} for k in rt.challenge_keys]}


def test_a_company_assessment_is_not_sequenced():
    rt, _, _ = make()
    rec = rt.start_attempt("u-9", org_id="org-1")
    assert not rt.is_sequenced(rec.attempt_id)
    assert all(state == ACTIVE for _, state in states(rt, rec.attempt_id))
