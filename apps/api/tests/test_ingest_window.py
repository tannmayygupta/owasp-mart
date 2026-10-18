"""Audit blocker B5: events after the attempt ended credit nothing, and the open C09 windows survive a restart."""
from __future__ import annotations

from datetime import timedelta

from ingest_support import A, World
from test_ingest_c09 import ACC, attempt, failures, fresh

from vulnmart.ingest.engine import MilestoneEngine


def restarted(w: World, **kw) -> MilestoneEngine:
    """A new engine over the same stored events and milestones: what a restarted process has."""
    return MilestoneEngine(log=w.log, milestones=w.milestones, integrity=w.integrity, directory=w.directory, checker=w.checker, **kw)


def test_without_recovery_a_restart_inside_the_grace_period_lost_the_c09_credit_and_with_it_the_credit_is_made():
    w = fresh()
    failures(w, 20, step=5)
    w.send(*attempt(result="success"), dt=5)
    success_at = w.now
    lost = restarted(w)  # the old behaviour: nothing pending after a restart
    assert lost.tick(success_at + timedelta(seconds=60)) == [] and w.best("C09") == "M1"
    engine = restarted(w)
    assert engine.recover([w.directory.get(A)]) == 1
    credits = engine.tick(success_at + timedelta(seconds=60))
    assert [c.milestone.value for c in credits] == ["M2"] and w.best("C09") == "M2"
    assert engine.recover([w.directory.get(A)]) >= 0 and engine.tick(success_at + timedelta(seconds=120)) == [], "once"


def test_recovery_still_respects_a_security_event_logged_after_the_success():
    w = fresh()
    failures(w, 20, step=5)
    w.send(*attempt(result="success"), dt=5)
    success_at = w.now
    from test_ingest_c09 import security

    w.send(*security(), dt=12)
    engine = restarted(w)
    engine.recover([w.directory.get(A)])
    assert engine.tick(success_at + timedelta(seconds=90)) == [] and w.best("C09") == "M1"


def test_an_event_after_the_attempt_ended_is_stored_but_credits_nothing():
    w = World()
    w.add_instance()
    over = {"at": None}
    engine = restarted(w, is_open=lambda attempt_id, at: over["at"] is None or at <= over["at"])
    w.engine = engine
    w.send_flag("C02", dt=1)
    assert w.best("C02") == "M3"
    over["at"] = w.now  # the deadline passes here
    r = w.send_flag("C03", dt=30)
    assert r.credits == [] and w.best("C03") != "M3"
    stored = w.log.read(A)
    assert any(e.event["type"] == "proxy.flag_seen" for e in stored), "the event itself is kept"