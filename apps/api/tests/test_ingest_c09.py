"""Story 6.3: the negative-observation rule of C09 M2 (FR-DET-06): at least 20 legacy failures, one success, no security event
for the same account in the window (600 s) and the grace period (30 s). Time is the platform's arrival time; the tests drive it."""
from __future__ import annotations

from datetime import timedelta

from ingest_support import World

ACC = "s.iyer"


def attempt(route="legacy", result="failure", account=ACC):
    return ("auth.attempt", {"route": route, "account_id": account, "result": result})


def security(account=ACC):
    return ("shop.security_event_written", {"account_id": account, "kind": "login_failed"})


def failures(w, n, *, step=5.0, route="legacy", account=ACC, **kw):
    for _ in range(n):
        w.send(*attempt(route, "failure", account), dt=step, seq=None, **kw)


def fresh():
    w = World()
    w.add_instance()
    return w


def test_happy_path_credits_m2_only_after_the_grace_period():
    w = fresh()
    failures(w, 20, step=5)
    assert w.best("C09") == "M1"
    r = w.send(*attempt(result="success"), dt=5, seq=500)  # a sequence gap is not a block
    assert r.credits == [] and w.best("C09") == "M1"
    success_at = w.now
    assert w.engine.tick(success_at + timedelta(seconds=29)) == []
    assert w.best("C09") == "M1"
    credits = w.engine.tick(success_at + timedelta(seconds=30))
    assert [c.milestone.value for c in credits] == ["M2"] and w.best("C09") == "M2"
    assert w.engine.tick(success_at + timedelta(seconds=60)) == []  # once


def test_exactly_20_failures_are_enough_and_19_are_not():
    w = fresh()
    failures(w, 19)
    w.send(*attempt(result="success"), dt=1)
    w.engine.tick(w.now + timedelta(seconds=31))
    assert w.best("C09") == "M1"
    w = fresh()
    failures(w, 20)
    w.send(*attempt(result="success"), dt=1)
    w.engine.tick(w.now + timedelta(seconds=31))
    assert w.best("C09") == "M2"


def test_a_security_event_inside_the_window_means_no_m2():
    w = fresh()
    failures(w, 10, step=5)
    w.send(*security(), dt=1)  # the shop logged something for the account
    failures(w, 10, step=5)
    w.send(*attempt(result="success"), dt=5)
    w.engine.tick(w.now + timedelta(seconds=120))
    assert w.best("C09") == "M1"


def test_a_late_security_event_in_the_grace_period_cancels_the_credit():
    w = fresh()
    failures(w, 20)
    w.send(*attempt(result="success"), dt=5)
    success_at = w.now
    w.send(*security(), dt=12)  # arrives 12 s later, inside the grace period
    assert w.engine.tick(success_at + timedelta(seconds=30)) == [] and w.best("C09") == "M1"
    assert w.engine.tick(success_at + timedelta(seconds=90)) == []  # the window is closed, not retried


def test_a_security_event_after_the_grace_period_does_not_undo_a_credit():
    w = fresh()
    failures(w, 20)
    w.send(*attempt(result="success"), dt=5)
    success_at = w.now
    assert len(w.engine.tick(success_at + timedelta(seconds=30))) == 1
    w.send(*security(), dt=40)
    assert w.best("C09") == "M2"


def test_a_security_event_of_another_account_does_not_cancel():
    w = fresh()
    failures(w, 20)
    w.send(*security("someone.else"), dt=1)
    w.send(*attempt(result="success"), dt=1)
    w.engine.tick(w.now + timedelta(seconds=31))
    assert w.best("C09") == "M2"


def test_another_route_gives_no_m1_and_no_m2():
    w = fresh()
    failures(w, 25, route="web")
    w.send(*attempt("web", "success"), dt=1)
    w.engine.tick(w.now + timedelta(seconds=60))
    assert w.best("C09") == "none"


def test_a_success_on_another_route_does_not_close_the_pattern():
    w = fresh()
    failures(w, 25)
    w.send(*attempt("web", "success"), dt=1)
    w.engine.tick(w.now + timedelta(seconds=60))
    assert w.best("C09") == "M1"


def test_failures_spread_over_15_minutes_are_not_20_in_10():
    w = fresh()
    failures(w, 20, step=45)  # 45 s apart: 14 or 15 inside any 10 minutes
    w.send(*attempt(result="success"), dt=45)
    w.engine.tick(w.now + timedelta(seconds=60))
    assert w.best("C09") == "M1"


def test_failures_must_be_for_one_account():
    w = fresh()
    failures(w, 10, account="a.one")
    failures(w, 10, account="a.two")
    w.send(*attempt(result="success", account="a.one"), dt=1)
    w.engine.tick(w.now + timedelta(seconds=60))
    assert w.best("C09") == "M1"


def test_failures_after_the_success_do_not_count():
    w = fresh()
    w.send(*attempt(result="success"), dt=1)
    failures(w, 25)
    w.engine.tick(w.now + timedelta(seconds=60))
    assert w.best("C09") == "M1"


def test_bot_session_failures_do_not_count():
    w = fresh()
    failures(w, 25, session_kind="bot", source="bot")
    w.send(*attempt(result="success"), dt=1)
    w.engine.tick(w.now + timedelta(seconds=60))
    assert w.best("C09") == "M1"  # the player's own success is the legacy-route use; the bot failures add nothing


def test_a_replayed_success_event_makes_one_credit():
    w = fresh()
    failures(w, 20)
    ev = w.event(*attempt(result="success"))
    w.now += timedelta(seconds=5)
    w.engine.process(ev, w.now)
    w.engine.process(dict(ev), w.now + timedelta(seconds=2))
    credits = w.engine.tick(w.now + timedelta(seconds=40))
    assert len(credits) == 1 and w.best("C09") == "M2"


def test_m3_still_needs_the_flag():
    w = fresh()
    failures(w, 20)
    w.send(*attempt(result="success"), dt=1)
    w.engine.tick(w.now + timedelta(seconds=31))
    assert w.best("C09") == "M2"
    w.send_flag("C09", dt=40)
    assert w.best("C09") == "M3"
