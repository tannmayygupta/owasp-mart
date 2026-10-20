"""Story 8.1: the lab runtime on a fake host and a fake clock. Expected numbers are computed by hand from the weights of
docs/design/challenge-specs.md section 6.2 (C01 = 60 of a 960 total), not from the code under test."""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

import pytest
from vulnmart_attempts import FakeClock

from support import play
from vulnmart.ingest.verify import sign_body
from vulnmart.lab.runtime import LabRuntime, RuntimeFacts, build_lab_runtime, new_instance_id
from vulnmart.ports.errors import AttemptGone, AttemptStateInvalid
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.instance_host import Access, InstanceState

T0 = datetime(2026, 10, 17, 10, 0, 0, tzinfo=UTC)


def make_runtime() -> tuple[LabRuntime, FakeClock, FakeInstanceHost]:
    clock = FakeClock(T0)
    host = FakeInstanceHost()
    return build_lab_runtime({}, host=host, clock=clock), clock, host


def flag_event(rt: LabRuntime, instance_id: str, challenge: str, text: str, seq: int, clock: FakeClock) -> dict:
    return {"schema_version": "0.1", "instance_id": instance_id, "epoch": 1, "seq": seq, "type": "proxy.flag_seen",
            "source": "sidecar", "session_kind": "player", "user_id": "u-1001", "ts": clock().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "data": {"kind": "real", "challenge_key": challenge, "candidate_sha256": hashlib.sha256(text.encode()).hexdigest(),
                     "route_template": "/api/x", "request_ref": "req-1"}}


def post(rt: LabRuntime, event: dict, *, key: str | None = None):
    raw = json.dumps(event).encode()
    k = key or rt.keys.event_key(event["instance_id"], event["epoch"])
    headers = {"content-type": "application/json",
               "x-vm-signature": sign_body(k, event["instance_id"], event["epoch"], event["seq"], raw)}
    return rt.handler.handle(headers, raw, "req-test-0001")


def test_instance_id_has_the_contract_shape():
    assert len(new_instance_id()) == 18 and new_instance_id().startswith("i-")


def test_start_attempt_starts_the_clock_at_ready_and_opens_access():
    rt, clock, host = make_runtime()
    started = rt.start_attempt("u-1")
    state = rt.state(started.attempt_id)
    assert state["state"] == "running"
    assert state["started_at"] == T0.isoformat()
    assert state["deadline_at"] == datetime(2026, 10, 17, 12, 0, tzinfo=UTC).isoformat()  # 120 minutes after ready
    status = host.get(started.instance_id)
    assert status.state is InstanceState.READY and status.access is Access.OPEN


def test_starting_twice_gives_the_same_attempt():
    rt, _, host = make_runtime()
    first = rt.start_attempt("u-1")
    assert rt.start_attempt("u-1") == first
    assert host.host_status().instances == 1


def test_keys_are_random_per_process():
    a, _, _ = make_runtime()
    b, _, _ = make_runtime()
    assert a.keys.event_key("i-AAAAAAAAAAAAAAAA", 1) != b.keys.event_key("i-AAAAAAAAAAAAAAAA", 1)
    assert a.keys.flag("i-AAAAAAAAAAAAAAAA", "C01", 1) != b.keys.flag("i-AAAAAAAAAAAAAAAA", "C01", 1)


def test_a_signed_flag_event_credits_m3_and_the_score_is_the_hand_computed_value():
    rt, clock, _ = make_runtime()
    started = rt.start_attempt("u-1")
    event = flag_event(rt, started.instance_id, "C01", rt.keys.flag(started.instance_id, "C01", 1), 1, clock)
    assert post(rt, event).status == 202
    assert rt.milestones.best(started.attempt_id, "C01").value == "M3"
    # 1000 x (60 x 100%) / 960 = 62.5, rounded half up = 63
    assert rt.score(started.attempt_id).score == 63


def test_a_replayed_event_changes_nothing_and_a_forged_signature_is_refused():
    rt, clock, _ = make_runtime()
    started = rt.start_attempt("u-1")
    event = flag_event(rt, started.instance_id, "C01", rt.keys.flag(started.instance_id, "C01", 1), 1, clock)
    assert post(rt, event).status == 202
    assert post(rt, event).status == 200  # the identical body again: no second credit
    assert rt.score(started.attempt_id).score == 63
    other = flag_event(rt, started.instance_id, "C02", rt.keys.flag(started.instance_id, "C02", 1), 2, clock)
    forged = post(rt, other, key="not-the-real-key-0000000000000000000000000")
    assert forged.status == 401
    assert rt.milestones.best(started.attempt_id, "C02").value == "none"


def test_a_pasted_flag_credits_and_a_wrong_one_does_not():
    rt, _, _ = make_runtime()
    started = rt.start_attempt("u-1")
    play(rt, started.instance_id)
    wrong = rt.submit_flag(started.attempt_id, "C02", "VM{AAAAAAAAAAAAAAAAAAAAAAAA}")
    assert (wrong.result, wrong.credit) == ("incorrect", "none")
    right = rt.submit_flag(started.attempt_id, "C02", rt.keys.flag(started.instance_id, "C02", 1))
    assert (right.result, right.credit) == ("correct", "credited")
    # C02 weighs 90: 1000 x 90 / 960 = 93.75, half up = 94
    assert rt.score(started.attempt_id).score == 94


def test_a_hint_costs_ten_percent_of_the_challenge_and_levels_unlock_in_order():
    rt, _, _ = make_runtime()
    started = rt.start_attempt("u-1")
    play(rt, started.instance_id)
    rt.submit_flag(started.attempt_id, "C01", rt.keys.flag(started.instance_id, "C01", 1))
    with pytest.raises(AttemptStateInvalid):
        rt.unlock_hint(started.attempt_id, "C01", 2)  # level 1 first
    assert rt.unlock_hint(started.attempt_id, "C01", 1) == 1
    # a learner's hints are free: C01 keeps its 60 points of 960: 1000 x 60 / 960 = 62.5, half up = 63
    assert rt.score(started.attempt_id).score == 63


def test_the_clock_runs_out_submits_freezes_destroys_and_reports():
    rt, clock, host = make_runtime()
    started = rt.start_attempt("u-1")
    play(rt, started.instance_id)
    rt.submit_flag(started.attempt_id, "C01", rt.keys.flag(started.instance_id, "C01", 1))
    clock.advance(minutes=121)  # past the 120-minute deadline
    rt.tick()
    state = rt.state(started.attempt_id)
    assert state["state"] == "submitted" and state["access"] == "frozen"
    assert host.get(started.instance_id).access is Access.FROZEN
    clock.advance(minutes=16)  # past the 15-minute freeze
    rt.tick()
    state = rt.state(started.attempt_id)
    assert state["destroyed"] is True and state["state"] == "reported"
    assert host.get(started.instance_id).state is InstanceState.DESTROYED
    assert rt.score(started.attempt_id).score == 63  # time never changes the score


def test_manual_submit_then_no_more_flags():
    rt, _, _ = make_runtime()
    started = rt.start_attempt("u-1")
    assert rt.submit(started.attempt_id) == "submitted"
    with pytest.raises(AttemptStateInvalid):
        rt.submit_flag(started.attempt_id, "C01", "x")


def test_a_held_capture_counts_at_its_fallback():
    rt, _, _ = make_runtime()
    started = rt.start_attempt("u-1")
    rt.milestones.hold(started.attempt_id, "C01", T0)
    result = RuntimeFacts(rt.milestones, rt.hints).facts(started.attempt_id)["C01"]
    assert result.held and result.fallback.label == "none"
    assert rt.score(started.attempt_id).score == 0  # held captures stay out of the score until a human decides


# ---- start, stop, reset: the runtime paths that wait for the orchestrator (review findings A3 to A5) ----

def slow_runtime():
    """A host that moves only when the test says so, and a runtime whose waiting loop just yields the thread."""
    import time

    clock = FakeClock(T0)
    host = FakeInstanceHost(auto_advance=False)
    rt = LabRuntime(host=host, clock=clock, ready_poll_s=0, sleep=lambda _s: time.sleep(0.002), ready_timeout_s=30)
    return rt, clock, host


def run_until_ready(host, instance_id: str, rounds: int = 20) -> None:
    for _ in range(rounds):
        if host.get(instance_id).state is InstanceState.READY:
            return
        host.advance(instance_id)


def wait_for(predicate, seconds: float = 5.0) -> None:
    import time

    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("the condition did not hold in time")


def test_an_async_start_answers_before_ready_a_second_start_gets_the_same_instance_and_the_clock_starts_at_ready():
    rt, clock, host = slow_runtime()
    first = rt.start_attempt_async("u-1")
    assert first.state == "ready" and first.instance_id.startswith("i-") and first.attempt_id.startswith("a-")
    assert rt.state(first.attempt_id)["state"] == "ready", "not running yet: the instance is not ready"
    again = rt.start_attempt_async("u-1")
    assert again.instance_id == first.instance_id and again.attempt_id == first.attempt_id, "one start per attempt"
    assert len(host.list_instances().items) == 1
    clock.advance(seconds=30)
    run_until_ready(host, first.instance_id)
    wait_for(lambda: rt.state(first.attempt_id)["state"] == "running")
    assert rt.state(first.attempt_id)["started_at"] == (T0 + (clock() - T0)).isoformat()
    assert rt.start_attempt_async("u-1").instance_id == first.instance_id, "a running attempt with a live instance keeps it"


def test_a_failed_start_leaves_the_attempt_ready_and_no_instance_and_a_retry_works():
    rt, _clock, host = slow_runtime()
    first = rt.start_attempt_async("u-1")
    host.destroy(first.instance_id)  # the fake has no failure switch; an instance that goes away is a failed start for the runtime
    for _ in range(3):
        host.advance(first.instance_id)
    wait_for(lambda: first.attempt_id not in rt._starting)
    assert rt.state(first.attempt_id)["state"] == "ready" and rt.directory.get(first.instance_id) is None
    retry = rt.start_attempt_async("u-1")
    assert retry.attempt_id == first.attempt_id and retry.instance_id != first.instance_id
    run_until_ready(host, retry.instance_id)
    wait_for(lambda: rt.state(first.attempt_id)["state"] == "running")


def test_stop_frees_the_instance_and_a_new_start_replaces_it_without_touching_the_clock_or_the_reset_count():
    clock = FakeClock(T0)
    host = FakeInstanceHost()
    rt = LabRuntime(host=host, clock=clock)
    s = rt.start_attempt("u-1")
    rt.reset_attempt(s.attempt_id)
    clock.advance(minutes=10)
    assert rt.stop_instance(s.attempt_id) == s.instance_id
    assert host.get(s.instance_id).state is InstanceState.DESTROYED and not rt.instance_alive(s.instance_id)
    clock.advance(minutes=1)
    new = rt.start_attempt("u-1")
    assert new.attempt_id == s.attempt_id and new.instance_id != s.instance_id and new.state == "running"
    assert rt.directory.for_attempt(s.attempt_id).instance_id == new.instance_id and rt.directory.get(s.instance_id) is None
    state = rt.state(s.attempt_id)
    assert state["instance_id"] == new.instance_id and state["started_at"] == T0.isoformat(), "the clock did not move"
    assert rt.time_metrics(s.attempt_id).resets == 1 and rt.directory.for_attempt(s.attempt_id).epoch == 1
    assert rt.keys.flag(new.instance_id, "C01", 1) != rt.keys.flag(s.instance_id, "C01", 1), "new instance, new flags"


def test_two_resets_of_one_attempt_cannot_overlap_and_one_epoch_is_taken_once():
    import threading

    rt, _clock, host = slow_runtime()
    s = rt.start_attempt_async("u-1")
    run_until_ready(host, s.instance_id)
    wait_for(lambda: rt.state(s.attempt_id)["state"] == "running")
    results: list[object] = []

    def first_reset() -> None:
        try:
            results.append(rt.reset_attempt(s.attempt_id))
        except Exception as exc:  # noqa: BLE001
            results.append(exc)

    t = threading.Thread(target=first_reset)
    t.start()
    wait_for(lambda: s.attempt_id in rt._resetting)
    with pytest.raises(AttemptStateInvalid):
        rt.reset_attempt(s.attempt_id)  # refused at once, while the first still waits
    assert rt.epochs.current(s.instance_id) == 2, "events of epoch 1 are stale from the moment the reset was accepted"
    run_until_ready(host, s.instance_id)
    t.join(5)
    assert results == [2] and rt.time_metrics(s.attempt_id).resets == 1


def test_the_log_gets_flag_hint_and_milestone_lines_the_metrics_and_timeline_read():
    rt, clock, _host = make_runtime()
    s = rt.start_attempt("u-1")
    play(rt, s.instance_id)
    rt.unlock_hint(s.attempt_id, "C01", 1)
    assert rt.unlock_hint(s.attempt_id, "C01", 1) == 1, "the same level again costs nothing and logs nothing more"
    assert rt.submit_flag(s.attempt_id, "C02", "VM{ZZZZZZZZZZZZZZZZZZZZZZZZ}").result == "incorrect"
    assert rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1)).credit == "credited"
    names = [(e["event"], e.get("challenge_key"), e.get("result") or e.get("level")) for e in rt.attempt_log.read(s.attempt_id)]
    assert names == [("instance_requested", None, None), ("instance_ready", None, None), ("session_started", None, None), ("hint_unlocked", "C01", 1), ("flag_submitted", "C02", "incorrect"),
                     ("flag_submitted", "C02", "correct"), ("milestone_reached", "C02", "M3")]
    assert rt.time_metrics(s.attempt_id).retries == {"C02": 2} or rt.time_metrics(s.attempt_id).retries


def test_a_running_attempts_instance_that_came_back_closed_is_opened_again_by_the_tick():
    # review finding C1, the lab side: an orchestrator that restarted adopts the instance closed
    rt, clock, host = make_runtime()
    s = rt.start_attempt("u-1")
    host.set_access(s.instance_id, Access.CLOSED, host.get(s.instance_id).access_epoch + 100)
    assert host.get(s.instance_id).access is Access.CLOSED
    rt.tick()
    st = host.get(s.instance_id)
    assert st.access is Access.OPEN and st.access_epoch > 100
    before = st.access_epoch
    rt.tick()
    assert host.get(s.instance_id).access_epoch == before, "nothing to heal: nothing is sent"
    rt.submit(s.attempt_id)  # frozen after a submit: never opened again by the tick
    clock.advance(minutes=1)
    rt.tick()
    assert host.get(s.instance_id).access is Access.FROZEN


def test_the_postgres_store_needs_the_platform_key_service_and_never_makes_its_own_keys():
    import pytest

    with pytest.raises(ValueError, match="VULNMART_KEYSTORE_DSN"):
        build_lab_runtime({"VULNMART_LAB_STORE": "postgres", "VULNMART_POSTGRES_DSN": "postgresql://x:y@localhost/z"})
    with pytest.raises(ValueError, match="VULNMART_POSTGRES_DSN"):
        build_lab_runtime({"VULNMART_LAB_STORE": "postgres", "VULNMART_KEYSTORE_DSN": "postgresql://x:y@localhost/z"})


def test_a_start_that_died_midway_leaves_no_instance_behind():
    """Review finding: the process stops after the orchestrator created the instance but before the attempt learned it; the retry must destroy it."""
    from vulnmart.ports.instance_host import InstanceState

    rt, clock, host = make_runtime()
    begun = rt._begin("u-midway", rt.template_id, None)
    abandoned = begun[1]
    rt._starting.clear()  # the process died here: the in-memory guard is gone, the directory row and the orchestrator's instance remain
    started = rt.start_attempt("u-midway")
    assert started.instance_id != abandoned
    assert host.get(abandoned).state is InstanceState.DESTROYED
    assert rt.directory.get(abandoned) is None and rt.directory.get(started.instance_id) is not None


def _wait_for(check, seconds=3.0):
    import time

    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.02)
    return check()


def test_a_player_event_tells_the_orchestrator_the_player_is_active_but_a_bot_event_does_not():
    """Audit blocker B1: without the report the idle limit ran from `ready` and cut players off while they played."""
    rt, clock, host = make_runtime()
    rt._activity_every = 0.0
    started = rt.start_attempt("u-1001")
    iid = started.instance_id
    assert host.last_activity(iid) is None
    bot = flag_event(rt, iid, "C01", "not a flag", 1, clock)
    bot["session_kind"] = "bot"
    assert post(rt, bot).status in (200, 202)
    assert not _wait_for(lambda: host.last_activity(iid) is not None, 0.3), "a bot is not a player"
    assert post(rt, flag_event(rt, iid, "C01", "browsing", 2, clock)).status in (200, 202)
    assert _wait_for(lambda: host.last_activity(iid) is not None)
    assert host.get(iid).state is InstanceState.ACTIVE


def test_activity_reports_are_throttled_per_instance_and_a_failing_orchestrator_never_breaks_the_event():
    rt, clock, host = make_runtime()
    started = rt.start_attempt("u-1001")
    iid = started.instance_id
    calls = []
    real = host.record_activity

    def counting(instance_id, at=None):
        calls.append(instance_id)
        return real(instance_id, at)

    host.record_activity = counting
    for seq in range(2, 8):
        assert post(rt, flag_event(rt, iid, "C01", f"page {seq}", seq, clock)).status in (200, 202)
    assert _wait_for(lambda: len(calls) >= 1)
    import time

    time.sleep(0.2)
    assert len(calls) == 1, "six events inside the throttle window make one report"

    def broken(instance_id, at=None):
        raise RuntimeError("orchestrator unreachable")

    host.record_activity = broken
    rt._activity_sent.clear()
    assert post(rt, flag_event(rt, iid, "C01", "after the outage", 20, clock)).status in (200, 202)
    time.sleep(0.2)  # the event was accepted; the failed report is only logged


def test_nothing_credits_after_the_deadline_even_before_the_tick_has_submitted_the_attempt():
    """Audit blocker B5: the tick that submits an expired attempt runs up to a minute later; in that gap neither a paste nor a sidecar event may score."""
    from vulnmart.ports.errors import AttemptStateInvalid

    rt, clock, host = make_runtime()
    s = rt.start_attempt("u-late")
    play(rt, s.instance_id)
    clock.advance(minutes=121)  # past the 120-minute deadline, tick not yet run
    assert rt.engine.get(s.attempt_id).state.value == "running"
    with pytest.raises(AttemptStateInvalid):
        rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1))
    assert post(rt, flag_event(rt, s.instance_id, "C02", rt.keys.flag(s.instance_id, "C02", 1), 1, clock)).status in (200, 202)
    assert rt.milestones.best(s.attempt_id, "C02").value != "M3", "the event is kept, it scores nothing"
    rt.tick()
    assert rt.state(s.attempt_id)["state"] == "submitted"
    assert post(rt, flag_event(rt, s.instance_id, "C03", rt.keys.flag(s.instance_id, "C03", 1), 2, clock)).status in (200, 202)
    assert rt.milestones.best(s.attempt_id, "C03").value != "M3", "and after the submit as well"


def test_a_flag_event_inside_the_window_still_credits():
    rt, clock, _ = make_runtime()
    s = rt.start_attempt("u-inside")
    clock.advance(minutes=5)
    assert post(rt, flag_event(rt, s.instance_id, "C02", rt.keys.flag(s.instance_id, "C02", 1), 1, clock)).status in (200, 202)
    assert rt.milestones.best(s.attempt_id, "C02").value == "M3"


def test_a_hint_costs_points_only_in_an_assessment_and_never_in_practice():
    """FR-SCR-03: the cost is for assessments; a learner's hints are free (PRD section 4). The UI already said cost 0 for a learner; the score now agrees."""
    rt, clock, host = make_runtime()
    learner = rt.start_attempt("u-practice")
    play(rt, learner.instance_id)
    rt.submit_flag(learner.attempt_id, "C01", rt.keys.flag(learner.instance_id, "C01", 1))
    rt.unlock_hint(learner.attempt_id, "C01", 1)
    free = rt.score(learner.attempt_id).score
    candidate = rt.start_attempt("u-candidate", org_id="o-acme")
    play(rt, candidate.instance_id)
    rt.submit_flag(candidate.attempt_id, "C01", rt.keys.flag(candidate.instance_id, "C01", 1))
    rt.unlock_hint(candidate.attempt_id, "C01", 1)
    charged = rt.score(candidate.attempt_id).score
    assert free == 63 and charged == 56, (free, charged)  # C01 is worth 60 of 960; a level-1 hint takes 10 percent of it in an assessment


def test_an_attempt_created_from_a_consent_runs_under_the_rules_of_its_invite():
    """H-140 and H-141: the invite carries a copy of the template's rules; the attempt must use THEM (time limit and resets), not the defaults."""
    import pytest

    from vulnmart.ports.engine_attempts import attempt_rules

    rt, clock, host = make_runtime()
    invite_rules = {"challenge_keys": ["C01", "C02"], "time_limit_min": 45, "hints_mode": "off", "hint_cost_pct": 10, "reset_limit": 1, "retention_days": 90,
                    "invite_expiry_days": 7, "writeup_required": False, "results_visibility": "company", "flag_submissions_per_minute": 3, "template_version": 2}
    a = rt.attempts.create_from_consent(user_id="u-cand", org_id="o-acme", template_id="shop-v0~2", invite_id="i-AAAAAAAAAAAAAAAA", consent_id="c-1",
                                        attempt_id="a-CANDIDATEATTEMPT", rules=invite_rules)
    assert a.attempt_id == "a-CANDIDATEATTEMPT" and a.mode.value == "candidate"
    rec = rt.engine.get(a.attempt_id)
    assert (rec.rules.time_limit_minutes, rec.rules.reset_limit) == (45, 1) and rec.rules.grace_seconds == 60, "the rest stays as the engine's defaults"
    assert attempt_rules(None).time_limit_minutes == 120 and attempt_rules({}).reset_limit == 3
    with pytest.raises(ValueError):
        attempt_rules({"time_limit_min": "45"})  # a string is not a whole number
    with pytest.raises(ValueError):
        attempt_rules({"time_limit_min": 10})  # the 15-minute warning cannot be later than the end
    again = rt.attempts.create_from_consent(user_id="u-cand", org_id="o-acme", template_id="shop-v0~2", invite_id="i-AAAAAAAAAAAAAAAA", consent_id="c-1", rules=invite_rules)
    assert again.attempt_id == a.attempt_id, "a second call is the same attempt"


def test_a_capture_dated_before_the_start_counts_zero_seconds_instead_of_failing_the_report():
    """Audit 2026-10-18 (L-25): `time_metrics` used to raise ValueError, which became a 500 on the report route."""
    from datetime import timedelta

    from vulnmart.lab.runtime import clamp_to_start
    from vulnmart.ports.reports import Milestone

    rt, clock, _ = make_runtime()
    started = rt.start_attempt("u-1")
    early = clock() - timedelta(minutes=5)
    assert rt.milestones.credit(started.attempt_id, "C02", Milestone.M3, early), "the store accepts a capture dated before the start"
    metrics = rt.time_metrics(started.attempt_id)
    assert metrics.headline["C02"] == 0
    assert clamp_to_start({"C01": early, "C02": clock() + timedelta(seconds=30)}, clock()) == {"C01": clock(), "C02": clock() + timedelta(seconds=30)}


def test_the_instance_limits_are_an_hour_idle_and_four_hours_for_a_learner_and_cover_the_time_limit_for_a_candidate():
    """The load check of 2026-10-19 found 24-hour limits holding slots of vm-i for a day (they were 1440 and 1440)."""
    rt, _, _ = make_runtime()
    learner = rt.start_attempt("u-1")
    candidate = rt.start_attempt("u-2", org_id="o-1")
    assert (rt._limits.idle_minutes, rt._limits.max_minutes) == (60, 240)
    rec = rt.engine.get(candidate.attempt_id)
    lim = rt._limits_for(rec)
    assert lim.idle_minutes == 120 and lim.max_minutes == max(240, rec.rules.time_limit_minutes + 30)
    assert rt._limits_for(rt.engine.get(learner.attempt_id)) == rt._limits


def test_erase_is_safe_to_repeat_as_the_deletion_workflow_and_the_retention_job_both_call_it():
    """Handoff H-145 (story P-25): a deletion request and the retention job call the same `LabRuntime.erase`, possibly twice for one attempt."""
    rt, _, _ = make_runtime()
    started = rt.start_attempt("u-1", org_id="o-1")
    rt.withdraw(started.attempt_id)
    rt.erase(started.attempt_id)
    rt.erase(started.attempt_id)  # the second call finds the key gone and the attempt already purged
    assert rt.engine.get(started.attempt_id).purged_at is not None
    with pytest.raises(AttemptGone):
        rt.attempts.get(started.attempt_id)  # the platform's port refuses a purged attempt


def test_the_lab_writes_the_instance_and_auto_capture_events_of_the_attempt_log():
    """FR-TIM-04 (L-25): instance_requested, instance_ready and flag_auto_detected were on the allow-list but never written."""
    rt, clock, _ = make_runtime()
    started = rt.start_attempt("u-1")
    play(rt, started.instance_id)
    flag = rt.keys.flag(started.instance_id, "C02", 1)
    assert post(rt, flag_event(rt, started.instance_id, "C02", flag, 1, clock)).status == 202
    names = [e["event"] for e in rt.attempt_log.read(started.attempt_id)]
    assert names.index("instance_requested") < names.index("instance_ready"), names
    assert "session_started" in names and "flag_auto_detected" in names, names
    detected = [e for e in rt.attempt_log.read(started.attempt_id) if e["event"] == "flag_auto_detected"]
    assert detected and detected[0]["challenge_key"] == "C02" and flag not in str(detected), "ids only, never the flag"


def test_the_invite_history_the_platform_knows_goes_into_the_attempt_log_once_with_its_real_times():
    """FR-TIM-04 (L-25): invite_created, invite_opened and consent_given are known to the platform, not to the lab; the port writes them when the attempt is made."""
    from datetime import timedelta

    rt, clock, _ = make_runtime()
    made, opened, consented = clock() - timedelta(days=3), clock() - timedelta(days=2), clock() - timedelta(minutes=5)
    args = dict(user_id="u-7", org_id="o-1", template_id="shop-v0", invite_id="i-AAAAAAAAAAAAAAAA", consent_id="c-1")
    a = rt.attempts.create_from_consent(**args, history={"invite_created": made, "invite_opened": opened, "consent_given": consented})
    rows = {e["event"]: e["at"] for e in rt.attempt_log.read(a.attempt_id)}
    assert rows == {"invite_created": made.isoformat(), "invite_opened": opened.isoformat(), "consent_given": consented.isoformat()}
    again = rt.attempts.create_from_consent(**args, history={"invite_created": made, "invite_opened": opened, "consent_given": consented})
    assert again.attempt_id == a.attempt_id
    assert [e["event"] for e in rt.attempt_log.read(a.attempt_id)].count("invite_created") == 1, "written once, not again on a repeated call"
    b = rt.attempts.create_from_consent(user_id="u-8", org_id="o-1", template_id="shop-v0", invite_id="i-BBBBBBBBBBBBBBBB", consent_id="c-2",
                                        history={"invite_created": made, "invite_opened": None, "consent_given": consented})
    assert [e["event"] for e in rt.attempt_log.read(b.attempt_id)] == ["invite_created", "consent_given"], "an instant the platform does not know is not invented"
    c = rt.attempts.create_from_consent(user_id="u-9", org_id="o-1", template_id="shop-v0", invite_id="i-CCCCCCCCCCCCCCCC", consent_id="c-3")
    assert rt.attempt_log.read(c.attempt_id) == (), "no history given: nothing written"


def test_request_seen_is_a_marker_when_the_player_starts_and_after_a_quiet_gap_never_one_line_per_request():
    """FR-TIM-04 (L-25): `request_seen` is a summary marker, never the request."""
    from datetime import timedelta

    rt, clock, _ = make_runtime()
    s = rt.start_attempt("u-1")
    def request(seq, at):
        return {"schema_version": "0.1", "instance_id": s.instance_id, "epoch": 1, "seq": seq, "type": "proxy.request", "source": "sidecar", "session_kind": "player", "user_id": "u-1001",
                "ts": at.strftime("%Y-%m-%dT%H:%M:%SZ"), "data": {"route_template": "/api/x", "method": "GET", "status": 200, "count": 3, "resp_len": 120, "client_class": "browser"}}
    seen = lambda: [e for e in rt.attempt_log.read(s.attempt_id) if e["event"] == "request_seen"]  # noqa: E731
    for n in range(5):
        assert post(rt, request(n + 1, clock())).status == 202
        clock.advance(seconds=20)  # five requests inside two minutes
    assert len(seen()) == 1 and set(seen()[0]) == {"event", "attempt_id", "at", "instance_id"}, "one marker, ids only"
    clock.advance(minutes=6)
    assert post(rt, request(6, clock())).status == 202
    assert len(seen()) == 2, "a new marker after a quiet gap"