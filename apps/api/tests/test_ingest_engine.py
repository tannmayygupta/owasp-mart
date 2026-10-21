"""Story 6.3: the milestone engine. Every challenge's M1 to M3 from the events of the specs, table-driven from the rules JSON;
bot events, best-once, M3 only from a recomputed flag, resets, sharing, gate, replays. Only tests use the fake KeyPort (D-79)."""
from __future__ import annotations

import copy

import pytest
from ingest_support import A, B, KEYS, World, digest

from vulnmart.ingest import rules as R
from vulnmart.ports.reports import CHALLENGE_KEYS, IntegrityType

RULES = R.load_rules()


def xs(order="o-1", store="s-2"):
    return ("shop.cross_store_order_read", {"order_id": order, "caller_user_id": "u-1001", "caller_store_id": "s-1", "order_store_id": store})


def gc(result, card):
    return ("shop.giftcard_attempt", {"user_id": "u-1001", "result": result, "card_class": card})


def refund(decision, order="o-1", path="quick", rid="r-1"):
    return ("shop.refund_decision", {"order_id": order, "refund_id": rid, "path": path, "amount": 10, "decision": decision, "cumulative_after": 10})


def auth(route, result, account="s.iyer"):
    return ("auth.attempt", {"route": route, "account_id": account, "result": result})


def job(keys, polluted):
    return ("import.job", {"job_id": "j-1", "store_id": "s-1", "flagged_keys": keys, "polluted": polluted, "audit_token_issued": False})


# challenge -> cumulative stages (expected best milestone after the events) and near misses (events from nothing -> expected)
STAGES = {
    "C01": [("M1", [xs("o-1")]), ("M1", [xs("o-1"), xs("o-2")]), ("M2", [xs("o-3")])],
    "C02": [("M1", [gc("unknown_wellformed", "none")]), ("M2", [gc("redeemed", "unsold_test")])],
    "C03": [("M1", [("shop.catalog_query_error", {"route": "/api/products/search", "error_class": "sql"})]),
            ("M2", [("collector.hit", {"collector_id_ok": True, "bot_tagged": True, "size": 64})])],
    "C04": [("M1", [refund("auto_approved", "o-1", rid="r-1")]), ("M1", [refund("auto_approved", "o-2", rid="r-2")]),
            ("M2", [refund("auto_approved", "o-1", rid="r-3")])],
    "C05": [("M1", [("shop.verbose_error", {"route": "/api/x", "handler": "c05_api"})]),
            ("M2", [("ops.page_served", {"path": "/_ops/diagnostics", "client_class": "external"})])],
    "C06": [("M1", [job(["__proto__"], False)]), ("M2", [job([], True)])],
    "C07": [("M1", [("auth.reset_requested", {"account_id": "fin", "account_role": "finance", "account_found": True})]),
            ("M2", [("auth.password_reset_completed", {"account_id": "fin", "account_role": "finance"})])],
    "C08": [("M1", [("webhook.received", {"order_id": "o-1", "source": "non_gateway", "verified": False, "sandbox_header": False, "accepted": True})]),
            ("M2", [("order.paid", {"order_id": "o-1", "verified": False, "via": "webhook"})])],
    "C09": [("M1", [auth("legacy", "failure")])],
    "C10": [("M1", [("importer.fetch_attempt", {"job_id": "j-1", "url_class": "loopback", "blocked": False, "status": 200})]),
            ("M2", [("meta.request_served", {"path": "/healthz", "ua_class": "importer"})])],
    "C11": [("M1", [("kyc.result", {"store_id": "s-9", "outcome": "invalid_verbose"})]),
            ("M2", [("store.approved", {"store_id": "s-9", "approved_by": "system_kyc_fallback"})])],
}
NEAR_MISS = {
    "C01": [([xs("o-1"), xs("o-1"), xs("o-1")], "M1")],  # the same order three times is one distinct order: M1 only
    "C02": [[gc("malformed", "none")]],
    "C03": [[("collector.hit", {"collector_id_ok": True, "bot_tagged": False, "size": 1})],
            [("proxy.crs_match", {"rule_ids": ["942100"], "tags": ["attack_xss"], "anomaly_score": 5, "route_template": "/x"})]],
    "C04": [([refund("auto_approved", "o-1", rid="r-1"), refund("auto_approved", "o-2", rid="r-2")], "M1"),  # two orders, not one
            [refund("auto_approved", "o-1", "item")]],
    "C05": [[("shop.verbose_error", {"route": "/x", "handler": "c10_import"})],
            [("ops.page_served", {"path": "/_ops/x", "client_class": "internal"})]],
    "C06": [[job([], False)]],
    "C07": [[("auth.reset_requested", {"account_id": "c1", "account_role": "customer", "account_found": True})],
            [("auth.password_reset_completed", {"account_id": "c1", "account_role": "customer"})]],
    "C08": [[("webhook.received", {"order_id": "o-1", "source": "gateway", "verified": True, "sandbox_header": False, "accepted": True})],
            [("order.paid", {"order_id": "o-1", "verified": True, "via": "webhook"})]],
    "C09": [[auth("web", "failure")]],
    "C10": [[("importer.fetch_attempt", {"job_id": "j-1", "url_class": "external", "blocked": False, "status": 200})],
            [("meta.request_served", {"path": "/rates", "ua_class": "rates"})]],
    "C11": [[("kyc.result", {"store_id": "s-9", "outcome": "valid"})], [("store.approved", {"store_id": "s-1", "approved_by": "seed"})]],
}


def play(w, events):
    for etype, data in events:
        w.send(etype, data, dt=1)


def others_none(w, c):
    return all(w.best(o) == "none" for o in CHALLENGE_KEYS if o != c)


@pytest.mark.parametrize("c", CHALLENGE_KEYS)
def test_m1_m2_m3_fire_from_the_spec_events(c):
    w = World()
    w.add_instance()
    for expected, events in STAGES[c]:
        play(w, events)
        assert w.best(c) == expected, (c, expected)
        assert others_none(w, c), c
    w.send_flag(c, dt=1)
    assert w.best(c) == "M3" and others_none(w, c)


@pytest.mark.parametrize("c", CHALLENGE_KEYS)
def test_m3_first_does_not_back_fill_and_event_rules_cannot_reach_m3(c):
    w = World()
    w.add_instance()
    w.send_flag(c)
    assert w.best(c) == "M3"
    # a later M1 or M2 event changes nothing; the stored value is the best
    for _, events in STAGES[c]:
        play(w, events)
    assert w.best(c) == "M3"
    # and no event path alone gives M3
    w2 = World()
    w2.add_instance()
    for _, events in STAGES[c]:
        play(w2, events)
    assert w2.best(c) != "M3"


@pytest.mark.parametrize("c", CHALLENGE_KEYS)
def test_near_misses_credit_nothing(c):
    for item in NEAR_MISS[c]:
        events, expected = item if isinstance(item, tuple) else (item, "none")
        w = World()
        w.add_instance()
        play(w, events)
        assert w.best(c) == expected, (c, expected)  # never the next milestone up


@pytest.mark.parametrize("event", [
    ("shop.catalog_query_error", {"route": "/api/products/search", "error_class": "sql"}),
    ("proxy.crs_match", {"rule_ids": ["942100"], "tags": ["attack_sqli", "owasp_crs"], "anomaly_score": 5, "route_template": "/api/products/search"}),
    ("shop.ticket_markup_stored", {"ticket_id": "t-1", "message_id": "m-1", "user_id": "u-1001"}),
])
def test_c03_m1_has_three_ways(event):
    w = World()
    w.add_instance()
    play(w, [event])
    assert w.best("C03") == "M1"


def test_c07_backup_path_needs_more_than_500_failed_confirms_then_a_completed_reset():
    def batch(n):
        return ("auth.reset_confirm_batch", {"account_id": "fin", "fail_count": n, "ok_count": 0, "window_s": 60})
    done = ("auth.password_reset_completed", {"account_id": "c1", "account_role": "customer"})
    w = World()
    w.add_instance()
    play(w, [batch(250), batch(250), done])
    assert w.best("C07") == "none"
    w = World()
    w.add_instance()
    play(w, [batch(250), batch(251)])
    assert w.best("C07") == "none"  # no completed reset yet
    play(w, [done])
    assert w.best("C07") == "M2"


def test_a_rule_edit_changes_behaviour():
    edited = copy.deepcopy(RULES)
    edited["challenges"]["C05"]["m1"]["where"]["handler"] = "c10_import"
    w = World(rules=edited)
    w.add_instance()
    play(w, [("shop.verbose_error", {"route": "/x", "handler": "c05_api"})])
    assert w.best("C05") == "none"
    play(w, [("shop.verbose_error", {"route": "/x", "handler": "c10_import"})])
    assert w.best("C05") == "M1"
    stricter = copy.deepcopy(RULES)
    stricter["challenges"]["C01"]["m2"]["of"][0]["at_least"] = 2
    w = World(rules=stricter)
    w.add_instance()
    play(w, [xs("o-1"), xs("o-2")])
    assert w.best("C01") == "M2"


# ---- bot and internal events ----

def test_bot_and_internal_events_never_count():
    w = World()
    w.add_instance()
    for sk in ("bot", "internal"):
        for c in CHALLENGE_KEYS:
            for _, events in STAGES[c]:
                for etype, data in events:
                    w.send(etype, data, session_kind=sk, source="bot" if sk == "bot" else None)
    assert all(w.best(c) == "none" for c in CHALLENGE_KEYS)
    # the events are still in the log (kept for the bot visit record)
    assert w.log.read(A)
    w.send("bot.visit", {"visit_id": "v-1", "ticket_id": "t-1", "phase": "start"}, session_kind="bot", source="bot")
    assert all(w.best(c) == "none" for c in CHALLENGE_KEYS)


def test_a_flag_seen_in_a_bot_session_does_not_credit():
    w = World()
    w.add_instance()
    res = w.send_flag("C09", session_kind="bot")
    assert w.best("C09") == "none" and res.credits == []


# ---- best once ----

def test_best_milestone_counts_once_and_a_lower_one_changes_nothing():
    w = World()
    w.add_instance()
    r1 = w.send(*xs("o-1"))
    assert [c.milestone.value for c in r1.credits] == ["M1"]
    r2 = w.send(*xs("o-2"))
    r3 = w.send(*xs("o-3"))
    assert [c.milestone.value for c in r3.credits] == ["M2"] and r2.credits == []
    r4 = w.send(*xs("o-4"))
    assert r4.credits == [] and w.best("C01") == "M2"
    r5 = w.send_flag("C01")
    assert [c.milestone.value for c in r5.credits] == ["M3"]
    assert w.send_flag("C01", dt=1, seq=None).credits == []  # a second flag event is no new credit
    w.send(*xs("o-5"))
    assert w.best("C01") == "M3"


# ---- M3 only from a recomputed flag ----

def test_sidecar_kind_is_a_hint_not_proof():
    w = World()
    w.add_instance()
    # kind real, but the hash is a decoy: no credit, a decoy integrity flag
    res = w.send_flag("C05", kind="real", decoy=0)
    assert w.best("C05") == "none" and res.integrity == [IntegrityType.DECOY]
    # kind real, hash of nothing we know: no credit, no integrity flag
    w.send("proxy.flag_seen", {"kind": "real", "challenge_key": "C05", "candidate_sha256": digest("not a flag")})
    assert w.best("C05") == "none" and len(w.integrity.rows) == 1
    # the platform decides: a real hash credits even when the sidecar called it a decoy
    w.send_flag("C05", kind="decoy")
    assert w.best("C05") == "M3"


def test_decoy_credit_is_refused_and_flagged_once_per_challenge():
    w = World()
    w.add_instance()
    for i in (0, 1):
        w.send_flag("C02", kind="decoy", decoy=i)
    assert w.best("C02") == "none"
    rows = w.integrity.of("a-1", IntegrityType.DECOY)
    assert len(rows) == 1
    flag, dec = KEYS.flag(A, "C02", 1), KEYS.decoy(A, "C02", 1, 0)
    for text in (rows[0].explanation, repr(rows[0])):
        assert flag not in text and dec not in text and digest(flag) not in text and digest(dec) not in text
    assert A in rows[0].explanation and "C02" in rows[0].explanation


# ---- reset and epochs ----

def test_reset_keeps_milestones_and_m3_needs_a_flag_of_the_new_epoch():
    w = World()
    w.add_instance()
    play(w, STAGES["C05"][0][1] + STAGES["C05"][1][1])
    assert w.best("C05") == "M2"
    w.reset(A)  # epoch 2
    assert w.best("C05") == "M2"
    # the epoch 1 flag, seen on the epoch 2 instance: stale, no credit
    w.send_flag("C05", epoch=2, of_epoch=1)
    assert w.best("C05") == "M2"
    # a late epoch 1 event with the epoch 1 flag: M3 needs the current epoch, none
    w.send_flag("C05", epoch=1, seq=900)
    assert w.best("C05") == "M2"
    w.send_flag("C05", epoch=2)
    assert w.best("C05") == "M3"


def test_an_event_of_an_old_epoch_still_credits_m1():
    w = World()
    w.add_instance()
    w.reset(A)
    w.send("shop.verbose_error", {"route": "/x", "handler": "c05_api"}, epoch=1)
    assert w.best("C05") == "M1"


# ---- other instance and sharing ----

def test_flag_of_another_instance_is_a_sharing_signal_without_a_credit_and_without_a_flag_in_it():
    w = World()
    w.add_instance(A, "a-1")
    w.add_instance(B, "a-2")
    res = w.send_flag("C01", iid=A, of_instance=B)  # B's flag seen on A
    assert w.best("C01") == "none" and w.best("C01", "a-2") == "none"
    assert res.integrity == [IntegrityType.SHARING]
    rows = w.integrity.of("a-1", IntegrityType.SHARING)
    assert len(rows) == 1 and A in rows[0].explanation and B in rows[0].explanation and "C01" in rows[0].explanation
    for secret in (KEYS.flag(B, "C01", 1), digest(KEYS.flag(B, "C01", 1))):
        assert secret not in rows[0].explanation
    # one flag per (attempt, other instance)
    w.send_flag("C01", iid=A, of_instance=B)
    w.send_flag("C05", iid=A, of_instance=B)
    assert len(w.integrity.of("a-1", IntegrityType.SHARING)) == 1


def test_same_flag_from_two_users_marks_the_second_user_only():
    w = World()
    w.add_instance(A, "a-1")
    w.add_instance(B, "a-2")
    w.send_flag("C09", iid=A)  # user 1 earns M3 on their own instance
    assert w.best("C09", "a-1") == "M3"
    w.send_flag("C09", iid=B, of_instance=A)  # user 2 presents user 1's flag
    assert w.best("C09", "a-2") == "none"
    assert len(w.integrity.of("a-2", IntegrityType.SHARING)) == 1
    assert w.integrity.of("a-1") == []
    # a different template is not a candidate for the check
    w2 = World()
    w2.add_instance(A, "a-1", template="t-1")
    w2.add_instance(B, "a-2", template="t-2")
    w2.send_flag("C09", iid=A, of_instance=B)
    assert w2.integrity.rows == [] and w2.best("C09") == "none"


# ---- gate and replays ----

def test_the_activity_gate_holds_m3():
    class Refuse:
        def allows(self, attempt_id, challenge_key, at):
            return False

    w = World(gate=Refuse())
    w.add_instance()
    res = w.send_flag("C06")
    assert res.credits == [] and res.held == ["C06"] and w.best("C06") == "none"
    assert ("a-1", "C06") in w.milestones.held
    assert w.send_flag("C06", dt=1).held == []  # already held, nothing new


def test_the_same_event_twice_is_credited_once():
    w = World()
    w.add_instance()
    ev = w.event("shop.verbose_error", {"route": "/x", "handler": "c05_api"})
    r1 = w.engine.process(ev, w.now)
    r2 = w.engine.process(dict(ev), w.now)
    assert r1.stored and len(r1.credits) == 1 and not r2.stored and r2.credits == []
    # a replayed refund does not double a count
    a1 = w.event(*refund("auto_approved", "o-9", rid="r-1"))
    w.engine.process(a1, w.now)
    w.engine.process(dict(a1), w.now)
    assert w.best("C04") == "M1"
    w.send(*refund("auto_approved", "o-9", rid="r-2"))
    assert w.best("C04") == "M2"
    # a replayed flag event gives no second credit
    f = w.event("proxy.flag_seen", {"kind": "real", "challenge_key": "C10", "candidate_sha256": digest(KEYS.flag(A, "C10", 1))})
    assert len(w.engine.process(f, w.now).credits) == 1 and w.engine.process(f, w.now).credits == []


def test_unknown_types_and_unknown_instances_have_no_effect():
    w = World()
    w.add_instance()
    r = w.send("shop.some_future_event", {"x": 1})
    assert r.credits == [] and w.best("C01") == "none"
    w.send("instance.flags_injected", {"challenge_ids": ["C01"]}, session_kind="internal", source="orchestrator", seq=1099511627776)
    assert all(w.best(c) == "none" for c in CHALLENGE_KEYS)
    r = w.engine.process(w.event(*xs(), iid=B, epoch=1), w.now)  # B is not in the directory
    assert r.credits == []


def test_only_the_challenges_of_the_instance_count():
    w = World()
    w.add_instance(cks=("C01",))
    w.send("shop.verbose_error", {"route": "/x", "handler": "c05_api"})
    assert w.best("C05") == "none"
    w.send_flag("C01")
    assert w.best("C01") == "M3"
