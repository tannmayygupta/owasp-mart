"""Story 8.2: the whole assessment loop in one process, no Docker, on a fake clock and a fake host.

One candidate: the instance becomes ready (the clock starts), a signed event credits C01, a pasted flag credits C02, a hint
is unlocked, a capture on C03 is held by the activity gate, the instance is reset (old flags stop working, the reset is
counted), the deadline passes (auto-submit, freeze, destroy), and the score is the number computed here by hand from the
weights (C01 60, C02 90, total 960; milestone M3 = 100 %, hint level 1 = 10 %). A replayed and a forged event change nothing.
"""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from vulnmart_attempts import FakeClock

from vulnmart.ingest.verify import sign_body
from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.instance_host import Access, InstanceState

T0 = datetime(2026, 10, 17, 10, 0, 0, tzinfo=UTC)


class DenyC03:
    """Stands in for the activity check of FR-ACH-02: a capture on C03 has no matching activity, so it is held."""

    def allows(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        return challenge_key != "C03"


def event(rt, clock, iid, epoch, seq, challenge, text):
    return {"schema_version": "0.1", "instance_id": iid, "epoch": epoch, "seq": seq, "type": "proxy.flag_seen",
            "source": "sidecar", "session_kind": "player", "user_id": "u-1001",
            "ts": clock().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "data": {"kind": "real", "challenge_key": challenge, "candidate_sha256": hashlib.sha256(text.encode()).hexdigest(),
                     "route_template": "/api/x", "request_ref": f"req-{seq}"}}


def send(rt, ev, *, key=None):
    raw = json.dumps(ev).encode()
    k = key or rt.keys.event_key(ev["instance_id"], ev["epoch"])
    headers = {"content-type": "application/json", "x-vm-signature": sign_body(k, ev["instance_id"], ev["epoch"], ev["seq"], raw)}
    return rt.handler.handle(headers, raw, "req-loop-0001").status


def test_the_whole_loop():
    clock = FakeClock(T0)
    host = FakeInstanceHost()
    rt = build_lab_runtime({}, host=host, clock=clock, gate=DenyC03())

    started = rt.start_attempt("u-1")
    aid, iid = started.attempt_id, started.instance_id
    assert rt.state(aid)["started_at"] == T0.isoformat()  # the clock started when the instance was ready

    # C01: a signed sidecar event 754 s after ready
    clock.advance(seconds=754)
    c01 = event(rt, clock, iid, 1, 1, "C01", rt.keys.flag(iid, "C01", 1))
    assert send(rt, c01) == 202
    assert send(rt, c01) == 200  # replay of the same body: accepted again, nothing changes
    c02_forged = event(rt, clock, iid, 1, 2, "C02", rt.keys.flag(iid, "C02", 1))
    assert send(rt, c02_forged, key="forged-key-forged-key-forged-key-00000") == 401
    assert rt.milestones.best(aid, "C02").value == "none"

    # C02: pasted, with the first hint unlocked
    assert rt.submit_flag(aid, "C02", rt.keys.flag(iid, "C02", 1)).credit == "credited"
    assert rt.unlock_hint(aid, "C02", 1) == 1

    # C03: the gate says no, so the capture is held and stays out of the score
    c03 = event(rt, clock, iid, 1, 3, "C03", rt.keys.flag(iid, "C03", 1))
    assert send(rt, c03) == 202
    assert (aid, "C03") in rt.milestones.held and rt.milestones.best(aid, "C03").value == "none"

    # (60 x 100 % + 90 x (100 % - 10 %)) = 141 points of 960: 1000 x 141 / 960 = 146.875, half up = 147
    assert rt.score(aid).score == 147

    # reset: new epoch, the old flag no longer credits, the reset is counted, the clock is untouched
    assert rt.reset_attempt(aid) == 2
    assert rt.submit_flag(aid, "C04", rt.keys.flag(iid, "C04", 1)).result == "incorrect"
    assert rt.state(aid)["started_at"] == T0.isoformat()
    metrics = rt.time_metrics(aid)
    assert metrics.headline == {"C01": 754, "C02": 754} and metrics.resets == 1

    # the deadline passes: auto-submit, freeze; the held capture keeps the attempt from `reported`
    clock.advance(minutes=121)
    rt.tick()
    state = rt.state(aid)
    assert state["state"] == "submitted" and state["access"] == "frozen"
    assert host.get(iid).access is Access.FROZEN
    clock.advance(minutes=16)
    rt.tick()
    state = rt.state(aid)
    assert state["destroyed"] is True and host.get(iid).state is InstanceState.DESTROYED
    assert state["state"] == "submitted"  # a held capture waits for a human (D-88)
    assert rt.score(aid).score == 147  # time and the held capture never change the number
