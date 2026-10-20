"""Stories 8.1 and L-26/L-27 through the runtime: held-capture review, the reset limit and withdrawal, on a fake clock and host."""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

import pytest
from vulnmart_attempts import FakeClock
from vulnmart_attempts.review import ReviewFinal, ReviewForbidden

from vulnmart.ingest.verify import sign_body
from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.ports.errors import AttemptStateInvalid
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.instance_host import InstanceState

T0 = datetime(2026, 10, 17, 10, 0, 0, tzinfo=UTC)
RECRUITER = {"id": "r-1", "role": "recruiter", "org_id": "org-1"}


class DenyC03:
    def allows(self, attempt_id, challenge_key, at):
        return challenge_key != "C03"


def held_world(gate=DenyC03):
    clock, host = FakeClock(T0), FakeInstanceHost()
    rt = build_lab_runtime({}, host=host, clock=clock, gate=gate())
    started = rt.start_attempt("u-1", org_id="org-1")
    iid = started.instance_id
    ev = {"schema_version": "0.1", "instance_id": iid, "epoch": 1, "seq": 1, "type": "proxy.flag_seen", "source": "sidecar",
          "session_kind": "player", "user_id": "u-1001", "ts": T0.strftime("%Y-%m-%dT%H:%M:%SZ"),
          "data": {"kind": "real", "challenge_key": "C03", "route_template": "/x", "request_ref": "r-1",
                   "candidate_sha256": hashlib.sha256(rt.keys.flag(iid, "C03", 1).encode()).hexdigest()}}
    raw = json.dumps(ev).encode()
    sig = sign_body(rt.keys.event_key(iid, 1), iid, 1, 1, raw)
    assert rt.handler.handle({"content-type": "application/json", "x-vm-signature": sig}, raw, "req-r-0001").status == 202
    return rt, clock, host, started


def test_a_held_capture_is_listed_and_stays_out_of_the_score():
    rt, _, _, s = held_world()
    assert [h.challenge_key for h in rt.held_captures(s.attempt_id)] == ["C03"]
    assert rt.score(s.attempt_id).score == 0


def test_accepting_credits_in_full_audits_and_is_idempotent():
    rt, _, _, s = held_world()
    rt.held_captures(s.attempt_id)
    rt.decide_held(s.attempt_id, "C03", RECRUITER, "accept", "looks real")
    assert rt.score(s.attempt_id).score == 94  # C03 weighs 90: 1000 x 90 / 960 = 93.75, half up
    rt.decide_held(s.attempt_id, "C03", RECRUITER, "accept")  # same decision again
    assert len(rt.audit.rows) == 1 and rt.audit.rows[0].reviewer == "r-1" and rt.audit.rows[0].decision == "accept"
    with pytest.raises(ReviewFinal):
        rt.decide_held(s.attempt_id, "C03", RECRUITER, "reject")


def test_rejecting_keeps_it_out_and_zeroes_nothing_and_lets_the_attempt_be_reported():
    rt, clock, host, s = held_world()
    rt.submit_flag(s.attempt_id, "C01", rt.keys.flag(s.instance_id, "C01", 1))
    rt.decide_held(s.attempt_id, "C03", RECRUITER, "reject")
    assert rt.score(s.attempt_id).score == 63  # C01 alone; the rejected capture adds nothing and removes nothing
    rt.submit(s.attempt_id)
    clock.advance(minutes=16)
    rt.tick()
    assert rt.state(s.attempt_id)["state"] == "reported"


@pytest.mark.parametrize("reviewer", [{"id": "c-1", "role": "candidate", "org_id": "org-1"},
                                      {"id": "r-2", "role": "recruiter", "org_id": "org-OTHER"}])
def test_a_wrong_reviewer_is_refused_and_nothing_is_written(reviewer):
    rt, _, _, s = held_world()
    with pytest.raises(ReviewForbidden):
        rt.decide_held(s.attempt_id, "C03", reviewer, "accept")
    assert rt.score(s.attempt_id).score == 0
    assert rt.audit.rows == []


def test_three_resets_are_allowed_and_the_fourth_is_refused_before_the_instance_is_touched():
    clock, host = FakeClock(T0), FakeInstanceHost()
    rt = build_lab_runtime({}, host=host, clock=clock)
    s = rt.start_attempt("u-1")
    assert [rt.reset_attempt(s.attempt_id) for _ in range(3)] == [2, 3, 4]
    with pytest.raises(AttemptStateInvalid):
        rt.reset_attempt(s.attempt_id)
    assert host.get(s.instance_id).epoch == 4
    assert rt.time_metrics(s.attempt_id).resets == 3
    assert rt.state(s.attempt_id)["started_at"] == T0.isoformat()  # a reset never moves the clock


def test_withdrawal_destroys_the_instance_and_deletes_after_seven_days():
    clock, host = FakeClock(T0), FakeInstanceHost()
    rt = build_lab_runtime({}, host=host, clock=clock)
    s = rt.start_attempt("u-1")
    assert rt.withdraw(s.attempt_id) == "withdrawn"
    assert host.get(s.instance_id).state is InstanceState.DESTROYED
    clock.advance(days=6)
    rt.tick()
    assert rt.state(s.attempt_id)["state"] == "withdrawn"
    clock.advance(days=2)
    rt.tick()
    assert rt.state(s.attempt_id)["state"] == "deleted"


def test_start_after_withdrawal_is_refused_and_creates_no_instance():
    # review finding A1: a second start used to build and open an instance, then fail at instance_ready
    clock, host = FakeClock(T0), FakeInstanceHost()
    rt = build_lab_runtime({}, host=host, clock=clock)
    # a learner may start a new run after a withdrawn one (ADR 0063); the attempt of a company assessment may not
    s = rt.start_attempt("u-1", org_id="o-1")
    rt.withdraw(s.attempt_id)
    before = len(host.list()) if hasattr(host, "list") else None
    with pytest.raises(AttemptStateInvalid):
        rt.start_attempt("u-1", org_id="o-1")
    if before is not None:
        assert len(host.list()) == before
