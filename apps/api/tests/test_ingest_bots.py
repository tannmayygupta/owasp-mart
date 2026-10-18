"""Story 6.4: bot visits are recorded and never credit a milestone or become evidence (FR-DET-09)."""
from __future__ import annotations

from datetime import timedelta

from ingest_support import A, T0, World, digest
from test_ingest_evidence import REF, Rig

from vulnmart.ingest.bots import BotRecorder, InMemoryBotVisitStore, is_bot_event
from vulnmart.ports.reports import CHALLENGE_KEYS


def visit(w, phase, visit_id="v-AAAAAAAAAAAAAAAA", **kw):
    return w.event("bot.visit", {"visit_id": visit_id, "ticket_id": "t-AAAAAAAAAAAAAAAA", "phase": phase}, session_kind="bot",
                   source="bot", user_id=None, **kw)


def test_bot_visit_is_recorded_once_per_phase_and_counted():
    w = World()
    w.add_instance(A)
    rec = BotRecorder(InMemoryBotVisitStore())
    assert rec.observe(visit(w, "queued"), T0) and rec.observe(visit(w, "start"), T0 + timedelta(seconds=2))
    assert rec.observe(visit(w, "start"), T0 + timedelta(seconds=3)) is False  # the same visit and phase again
    assert rec.observe(visit(w, "end"), T0 + timedelta(seconds=9))
    assert rec.store.count(A) == 3 and rec.store.count(A, "start") == 1
    v = rec.store.visits(A)[0]
    assert (v.instance_id, v.epoch, v.visit_id, v.ticket_id, v.phase, v.at) == (A, 1, "v-AAAAAAAAAAAAAAAA", "t-AAAAAAAAAAAAAAAA", "queued", T0)


def test_player_session_or_other_type_is_not_a_bot_visit():
    w = World()
    w.add_instance(A)
    rec = BotRecorder(InMemoryBotVisitStore())
    ev = visit(w, "start")
    ev["session_kind"], ev["source"] = "player", "shop"
    assert rec.observe(ev, T0) is False
    assert rec.observe(w.event("proxy.request", {"method": "GET", "route_template": "/", "status": 200, "resp_len": 1,
                                                 "client_class": "other"}), T0) is False
    assert is_bot_event({"session_kind": "bot"}) and is_bot_event({"source": "bot"}) and not is_bot_event({"source": "shop"})


def test_a_mix_of_bot_and_player_events_credits_no_milestone_from_a_bot():
    r = Rig()
    bots = BotRecorder(InMemoryBotVisitStore())
    for phase in ("queued", "start", "end"):
        ev = visit(r.world, phase)
        res = r.world.engine.process(ev, r.world.now)
        r.rec.observe(ev, r.world.now, res)
        bots.observe(ev, r.world.now)
        assert res.credits == [] and res.held == []
    # a shop.* event and a flag sighting with a bot session, and a bot capture: nothing is credited, nothing is evidence
    r.flag("C05", session_kind="bot", source="bot")
    r.capture(session_kind="bot", source="bot")
    r.feed("shop.ticket_markup_stored", {"ticket_id": "t-AAAAAAAAAAAAAAAA", "message_id": "m-AAAAAAAAAAAAAAAA", "user_id": "u-1"},
           session_kind="bot", source="bot")
    r.feed("collector.hit", {"collector_id_ok": True, "bot_tagged": True, "size": 5}, session_kind="bot", source="bot")
    assert all(r.world.best(c) == "none" for c in CHALLENGE_KEYS)
    assert r.store.rows("a-1") == [] and bots.store.count(A) == 3


def test_a_bot_tagged_collector_hit_credits_c03_m2_by_the_story_3_rule_and_a_player_one_does_not():
    w = World()
    w.add_instance(A)
    w.send("collector.hit", {"collector_id_ok": True, "bot_tagged": False, "size": 5})
    assert w.best("C03") == "none"  # a stored-XSS capture by the player's own browser or any untagged hit credits nothing
    w.send("collector.hit", {"collector_id_ok": True, "bot_tagged": True, "size": 5}, source="mock")
    assert w.best("C03") == "M2"
