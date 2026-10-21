"""The activity-versus-capture check of pasted flags (FR-ACH-02, D-94; audit blocker B6)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from support import play
from vulnmart_attempts import FakeClock
from vulnmart_attempts.rules import Rules

from vulnmart.ingest.activity import InMemoryActivityStore
from vulnmart.ingest.gate import RecordedActivityGate
from vulnmart.ingest.stores import InMemoryIntegritySink, InstanceInfo
from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.reports import IntegrityType, Milestone

T0 = datetime(2026, 10, 18, 10, 0, 0, tzinfo=UTC)


def runtime():
    clock = FakeClock(T0)
    return build_lab_runtime({}, host=FakeInstanceHost(), clock=clock), clock


def test_a_pasted_flag_with_no_recorded_activity_is_held_not_credited_and_not_zeroed():
    rt, clock = runtime()
    s = rt.start_attempt("u-gate-1", org_id="o-gate")  # an assessment: a capture the activity does not explain is held (a learner practice only flags it)
    clock.advance(minutes=10)
    r = rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1))
    assert (r.result, r.credit) == ("correct", "held")
    assert rt.milestones.best(s.attempt_id, "C02") is not Milestone.M3
    assert rt.milestones.is_held(s.attempt_id, "C02")
    assert any(f.kind is IntegrityType.ACTIVITY for f in rt.integrity.of(s.attempt_id))
    assert rt.score(s.attempt_id).score == 0, "a held capture is out of the score until a human decides, and nothing is subtracted"


def test_a_learner_practice_capture_is_credited_and_flagged_never_held_because_nobody_could_release_it():
    rt, clock = runtime()
    s = rt.start_attempt("u-gate-practice")  # a learner: no company, so no reviewer exists (wiring audit section 4)
    assert rt.engine.get(s.attempt_id).rules.activity_check_mode == "flag"
    clock.advance(minutes=10)
    r = rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1))
    assert (r.result, r.credit) == ("correct", "credited")
    assert not rt.milestones.is_held(s.attempt_id, "C02")


def test_the_same_paste_after_real_use_of_the_shop_is_credited():
    rt, clock = runtime()
    s = rt.start_attempt("u-gate-2")
    play(rt, s.instance_id)
    clock.advance(minutes=10)
    r = rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1))
    assert (r.result, r.credit) == ("correct", "credited")
    assert not any(f.kind is IntegrityType.ACTIVITY for f in rt.integrity.of(s.attempt_id))


def test_the_requests_of_an_earlier_epoch_do_not_explain_a_capture_of_the_next_one():
    rt, clock = runtime()
    s = rt.start_attempt("u-gate-3", org_id="o-gate")
    play(rt, s.instance_id, epoch=1)
    clock.advance(minutes=10)
    assert rt.reset_attempt(s.attempt_id) == 2
    clock.advance(minutes=5)
    r = rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 2))
    assert (r.result, r.credit) == ("correct", "held"), "epoch 2 shows no activity yet"
    play(rt, s.instance_id, epoch=2)
    rt.milestones.clear_held(s.attempt_id, "C02")  # a reviewer decided; the next paste is judged on its own
    assert rt.submit_flag(s.attempt_id, "C03", rt.keys.flag(s.instance_id, "C03", 2)).credit == "credited"


def gate_with(mode: str, requests: int, started_s_ago: float):
    activity = InMemoryActivityStore()
    sink = InMemoryIntegritySink()
    info = InstanceInfo("i-GATEGATEGATEGATE", "a-1", "shop-v0", 1, ("C01",))
    directory = SimpleNamespace(for_attempt=lambda aid: info)
    rec = SimpleNamespace(rules=Rules(activity_check_mode=mode), started_at=T0 - timedelta(seconds=started_s_ago))
    if requests:
        activity.record({"type": "proxy.request", "instance_id": info.instance_id, "epoch": 1, "session_kind": "player",
                         "data": {"route_template": "/x", "method": "GET", "status": 200, "count": requests}}, T0 - timedelta(minutes=2))
    return RecordedActivityGate(activity=activity, directory=directory, record_of=lambda aid: rec, integrity=sink), sink


def test_mode_flag_counts_the_capture_and_raises_a_flag_for_the_reviewer():
    gate, sink = gate_with("flag", requests=0, started_s_ago=600)
    assert gate.allows("a-1", "C01", T0) is True
    assert [f.kind for f in sink.of("a-1")] == [IntegrityType.ACTIVITY]


def test_mode_hold_refuses_and_a_consistent_capture_raises_nothing():
    gate, sink = gate_with("hold", requests=0, started_s_ago=600)
    assert gate.allows("a-1", "C01", T0) is False
    ok, sink2 = gate_with("hold", requests=9, started_s_ago=600)
    assert ok.allows("a-1", "C01", T0) is True and sink2.of("a-1") == []


def test_a_capture_sooner_than_the_minimum_raises_a_timing_flag_but_never_holds():
    gate, sink = gate_with("hold", requests=9, started_s_ago=20)
    assert gate.allows("a-1", "C01", T0) is True
    assert [f.kind for f in sink.of("a-1")] == [IntegrityType.TIMING]
    assert gate.allows("a-1", "C01", T0) is True
    assert len(sink.of("a-1")) == 1, "once per attempt and challenge"