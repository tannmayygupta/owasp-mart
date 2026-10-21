"""The milestone rules read the events the real shop posts (challenges tests, 2026-10-21, WP-D): tightened C01 M2, C05 M2, C07 M1, C08 M1 and M2,
C10 M1, and the C09 M2 negative observation fed with the exact event shapes of the vulnerable and the fixed shop build."""
from __future__ import annotations

from datetime import timedelta

import pytest
from ingest_support import World

from vulnmart.ingest import rules as R

RULES = R.load_rules()


def fresh():
    w = World()
    w.add_instance()
    return w


def xs(order, store):
    return ("shop.cross_store_order_read", {"order_id": order, "caller_user_id": "u-1001", "caller_store_id": "1", "order_store_id": store})


def play(w, events, dt=1):
    for etype, data in events:
        w.send(etype, data, dt=dt)


def test_c01_m2_one_read_of_the_target_store_or_three_distinct_orders():
    w = fresh()
    play(w, [xs("VM-100245", "3")])  # another store, not the target
    assert w.best("C01") == "M1"
    play(w, [xs("VM-100777", "2")])  # Northwind (store 2) is the target store of the spec
    assert w.best("C01") == "M2"
    w = fresh()
    play(w, [xs("VM-1", "3"), xs("VM-2", "3"), xs("VM-2", "3")])
    assert w.best("C01") == "M1"  # two distinct, one repeated
    play(w, [xs("VM-3", "3")])
    assert w.best("C01") == "M2"


@pytest.mark.parametrize("etype,data,expect", [
    ("ops.page_served", {"path": "/_ops/", "client_class": "anonymous"}, "none"),  # the index alone is not the working exploit
    ("ops.page_served", {"path": "/_ops/diagnostics", "client_class": "internal"}, "none"),
    ("ops.page_served", {"path": "/_ops/diagnostics", "client_class": "anonymous"}, "M2"),
    ("ops.page_served", {"path": "/_ops/diagnostics", "client_class": "authenticated"}, "M2"),
    ("auth.reset_requested", {"account_id": "unknown", "account_role": "finance", "account_found": False}, "none"),
    ("auth.reset_requested", {"account_id": "7", "account_role": "finance", "account_found": True}, "M1"),
    ("webhook.received", {"order_id": "unknown", "source": "non_gateway", "verified": False, "sandbox_header": True, "accepted": False}, "none"),
    ("webhook.received", {"order_id": "VM-100001", "source": "non_gateway", "verified": False, "sandbox_header": True, "accepted": False}, "M1"),
    ("order.paid", {"order_id": "5", "verified": True, "via": "card"}, "none"),
    ("order.paid", {"order_id": "5", "verified": False, "via": "card"}, "none"),  # an unverified payment that did not come through the webhook is not C08
    ("order.paid", {"order_id": "5", "verified": False, "via": "webhook"}, "M2"),
    ("importer.fetch_attempt", {"job_id": "j-1", "url_class": "loopback", "blocked": True, "status": 0}, "none"),  # the filter held
    ("importer.fetch_attempt", {"job_id": "j-1", "url_class": "loopback", "blocked": False, "status": 200}, "M1"),
])
def test_tightened_rules_one_event_at_a_time(etype, data, expect):
    w = fresh()
    ck = {"ops.page_served": "C05", "auth.reset_requested": "C07", "webhook.received": "C08", "order.paid": "C08", "importer.fetch_attempt": "C10"}[etype]
    w.send(etype, data, dt=1)
    assert w.best(ck) == expect, (etype, data)


def shop_attempts(w, n, account="9", route="legacy"):
    for _ in range(n):
        w.send("auth.attempt", {"route": route, "account_id": account, "result": "failure"}, dt=4)


def credited(w):
    w.send("auth.attempt", {"route": "legacy", "account_id": "9", "result": "success"}, dt=4)
    credits = w.engine.tick(w.now + timedelta(seconds=31))
    return [c.milestone.value for c in credits]


def test_c09_vulnerable_build_events_credit_m2():
    """The vulnerable legacy route: auth.attempt per guess naming the attacked account, and no shop.security_event_written."""
    w = fresh()
    shop_attempts(w, 25)
    assert credited(w) == ["M2"] and w.best("C09") == "M2"


def test_c09_fixed_build_events_never_credit_m2():
    """The fixed legacy route: every guess is also a security event for the account (kind login_failed), then the account locks."""
    w = fresh()
    for _ in range(5):
        w.send("auth.attempt", {"route": "legacy", "account_id": "9", "result": "failure"}, dt=4)
        w.send("shop.security_event_written", {"account_id": "9", "kind": "login_failed"}, dt=0)
    for _ in range(20):  # the lock answers 429: locked attempts are not failures
        w.send("auth.attempt", {"route": "legacy", "account_id": "9", "result": "locked"}, dt=4)
    assert credited(w) == [] and w.best("C09") == "M1"


def test_c09_failures_against_unknown_accounts_do_not_pool_into_the_target():
    w = fresh()
    shop_attempts(w, 25, account="unknown")  # guesses for an email that does not exist: grouped under "unknown", not under the account
    assert credited(w) == [] and w.best("C09") == "M1"


def test_c09_web_login_attempts_of_the_same_account_do_not_count_as_legacy_failures():
    w = fresh()
    shop_attempts(w, 25, route="web")
    assert credited(w) == [] and w.best("C09") == "M1"  # only the final legacy success is a legacy attempt: M1, never M2


def test_the_rules_the_shop_events_need_still_validate_against_the_schema():
    from ingest_support import load_schema
    assert R.validate_structure(RULES) == [] and R.validate_against_schema(RULES, load_schema()) == []