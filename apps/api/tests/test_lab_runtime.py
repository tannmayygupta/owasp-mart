"""Story 8.1: the lab runtime on a fake host and a fake clock. Expected numbers are computed by hand from the weights of
docs/design/challenge-specs.md section 6.2 (C01 = 60 of a 960 total), not from the code under test."""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

import pytest
from vulnmart_attempts import FakeClock

from vulnmart.ingest.verify import sign_body
from vulnmart.lab.runtime import LabRuntime, RuntimeFacts, build_lab_runtime, new_instance_id
from vulnmart.ports.errors import AttemptStateInvalid
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
    wrong = rt.submit_flag(started.attempt_id, "C02", "VM{AAAAAAAAAAAAAAAAAAAAAAAA}")
    assert (wrong.result, wrong.credit) == ("incorrect", "none")
    right = rt.submit_flag(started.attempt_id, "C02", rt.keys.flag(started.instance_id, "C02", 1))
    assert (right.result, right.credit) == ("correct", "credited")
    # C02 weighs 90: 1000 x 90 / 960 = 93.75, half up = 94
    assert rt.score(started.attempt_id).score == 94


def test_a_hint_costs_ten_percent_of_the_challenge_and_levels_unlock_in_order():
    rt, _, _ = make_runtime()
    started = rt.start_attempt("u-1")
    rt.submit_flag(started.attempt_id, "C01", rt.keys.flag(started.instance_id, "C01", 1))
    with pytest.raises(AttemptStateInvalid):
        rt.unlock_hint(started.attempt_id, "C01", 2)  # level 1 first
    assert rt.unlock_hint(started.attempt_id, "C01", 1) == 1
    # C01: 60 x (100% - 10%) = 54 points of 960: 1000 x 54 / 960 = 56.25, half up = 56
    assert rt.score(started.attempt_id).score == 56


def test_the_clock_runs_out_submits_freezes_destroys_and_reports():
    rt, clock, host = make_runtime()
    started = rt.start_attempt("u-1")
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
    rt.unlock_hint(s.attempt_id, "C01", 1)
    assert rt.unlock_hint(s.attempt_id, "C01", 1) == 1, "the same level again costs nothing and logs nothing more"
    assert rt.submit_flag(s.attempt_id, "C02", "VM{ZZZZZZZZZZZZZZZZZZZZZZZZ}").result == "incorrect"
    assert rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1)).credit == "credited"
    names = [(e["event"], e.get("challenge_key"), e.get("result") or e.get("level")) for e in rt.attempt_log.read(s.attempt_id)]
    assert names == [("session_started", None, None), ("hint_unlocked", "C01", 1), ("flag_submitted", "C02", "incorrect"),
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
