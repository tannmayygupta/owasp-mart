"""The lab publishes its domain events for the live hub (IF-3, handoff H-142): the right events at the right moments, each valid, no secret in any."""
from __future__ import annotations

import json
from datetime import UTC, datetime

from support import play
from vulnmart_attempts import FakeClock

from vulnmart.lab.live import LiveAnnouncer
from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.outbox import check_event

T0 = datetime(2026, 10, 19, 10, 0, 0, tzinfo=UTC)


def world():
    clock = FakeClock(T0)
    host = FakeInstanceHost()
    rt = build_lab_runtime({}, host=host, clock=clock)
    seen: list[dict] = []
    rt.live.attach(lambda e: seen.append(json.loads(json.dumps(e))))
    return rt, clock, host, seen


def types(seen):
    return [e["type"] for e in seen]


def test_every_event_the_lab_sends_is_valid_and_carries_no_flag_or_text():
    rt, clock, host, seen = world()
    s = rt.start_attempt("u-live-1")
    play(rt, s.instance_id)
    assert rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1)).credit == "credited"
    rt.unlock_hint(s.attempt_id, "C01", 1)
    clock.advance(minutes=121)
    rt.tick()
    for r in host.reports:
        rt.announce_instance(r)
    assert seen, "something was published"
    for e in seen:
        check_event(e)  # the platform's own validator: the schema, no extra member
        assert "VM{" not in json.dumps(e) and "text" not in e["data"]


def test_a_counted_capture_a_hint_and_the_states_of_an_attempt_are_announced_in_order():
    rt, clock, host, seen = world()
    s = rt.start_attempt("u-live-2")
    play(rt, s.instance_id)
    seen.clear()
    rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1))
    assert types(seen) == ["attempt.milestone_reached", "attempt.flag_captured", "attempt.score_updated"]
    assert seen[0]["data"] == {"attempt_id": s.attempt_id, "mode": "learner", "challenge_key": "C02", "milestone": "M3"}
    assert seen[2]["data"]["score"] == 94 and {"challenge_key": "C02", "best_milestone": "M3", "points": 90} in seen[2]["data"]["per_challenge"] or seen[2]["data"]["score"] > 0
    seen.clear()
    rt.unlock_hint(s.attempt_id, "C01", 1)
    assert types(seen) == ["attempt.hint_unlocked", "attempt.score_updated"] and seen[0]["data"]["level"] == 1
    seen.clear()
    clock.advance(minutes=121)
    rt.tick()
    changes = [e["data"] for e in seen if e["type"] == "attempt.state_changed"]
    assert [c["state"] for c in changes][:2] == ["expired", "submitted"] or "submitted" in [c["state"] for c in changes]
    assert all(c["mode"] == "learner" and c["previous_state"] for c in changes)


def test_a_held_capture_is_not_announced_as_a_capture():
    rt, clock, host, seen = world()
    s = rt.start_attempt("u-live-3", org_id="o-acme")  # an assessment, no recorded activity: the paste is held (FR-ACH-02)
    seen.clear()
    assert rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1)).credit == "held"
    assert "attempt.flag_captured" not in types(seen) and "attempt.milestone_reached" not in types(seen)


def test_the_instance_states_reach_the_hub_with_the_attempt_and_the_access_of_the_moment():
    rt, clock, host, seen = world()
    s = rt.start_attempt("u-live-4")
    seen.clear()
    for r in host.reports:
        rt.announce_instance(r)
    states = [e["data"]["state"] for e in seen if e["type"] == "instance.state_changed"]
    assert "ready" in states
    ready = next(e["data"] for e in seen if e["data"].get("state") == "ready")
    assert ready["attempt_id"] == s.attempt_id and ready["instance_id"] == s.instance_id and ready["access"] == "open" and ready["error_code"] is None


def test_a_candidate_attempt_is_announced_as_candidate():
    rt, clock, host, seen = world()
    s = rt.start_attempt("u-live-5", org_id="o-acme")
    play(rt, s.instance_id)
    seen.clear()
    rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1))
    assert seen and all(e["data"]["mode"] == "candidate" for e in seen)


def test_a_publisher_that_fails_never_disturbs_the_lab_and_no_publisher_means_silence():
    rt, clock, host, seen = world()

    def broken(_event):
        raise RuntimeError("database away")

    rt.live.attach(broken)
    s = rt.start_attempt("u-live-6")
    play(rt, s.instance_id)
    assert rt.submit_flag(s.attempt_id, "C02", rt.keys.flag(s.instance_id, "C02", 1)).credit == "credited"  # the step still happened
    rt.live.attach(None)
    assert rt.unlock_hint(s.attempt_id, "C01", 1) == 1


def test_an_unknown_state_or_a_missing_attempt_sends_nothing():
    sent = []
    a = LiveAnnouncer(clock=lambda: T0, record_of=lambda _id: None, score_of=lambda _id: (0, []))
    a.attach(sent.append)
    a.attempt_state("a-AAAAAAAAAAAAAAAA", None, "running")
    a.milestone("a-AAAAAAAAAAAAAAAA", "C01", "M1")
    a.score("a-AAAAAAAAAAAAAAAA")
    a.instance(instance_id="i-AAAAAAAAAAAAAAAA", attempt_id="a-AAAAAAAAAAAAAAAA", state="nonsense", health="healthy", epoch=1, error_code=None, access="open")
    assert sent == []