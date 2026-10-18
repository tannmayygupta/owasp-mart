"""Story 6.4: activity metadata buckets and the label rule (FR-DET-08, FR-DET-07, D-78)."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from ingest_support import A, B, T0, World

from vulnmart.ingest.activity import (
    ActivityRecorder, InMemoryActivityStore, attribution_label, minute_of, per_challenge_time_allowed,
)
from vulnmart.ports.fakes import FakeSettingsPort


def req(w, status=200, method="GET", route="/api/products", count=1, **kw):
    return w.event("proxy.request", {"method": method, "route_template": route, "status": status, "resp_len": 10, "client_class": "other",
                                     "count": count}, **kw)


def test_thirty_requests_in_a_minute_are_one_bucket_of_counts_only():
    w = World()
    w.add_instance(A)
    rec = ActivityRecorder(InMemoryActivityStore())
    for i in range(30):
        rec.observe(req(w, status=200 if i % 3 else 404, method="GET" if i % 2 else "POST", route=f"/r/{i % 4}"), T0 + timedelta(seconds=i))
    (b,) = rec.store.buckets(A)
    assert b.requests == 30 and b.minute == T0.replace(second=0)
    assert b.by_status_class == {"2xx": 20, "4xx": 10} and b.by_method == {"GET": 15, "POST": 15} and b.distinct_routes == 4
    assert set(vars(b).keys() if hasattr(b, "__dict__") else b.__slots__) == {
        "instance_id", "epoch", "minute", "requests", "by_status_class", "by_method", "crs_by_tag", "distinct_routes"}  # no body, query or text field
    blob = json.dumps({k: getattr(b, k) for k in b.__slots__}, default=str)
    assert "/r/" not in blob and "?" not in blob


def test_an_aggregated_event_counts_its_count_and_crs_matches_count_per_tag():
    w = World()
    w.add_instance(A)
    rec = ActivityRecorder(InMemoryActivityStore())
    rec.observe(req(w, count=12), T0)
    rec.observe(w.event("proxy.crs_match", {"rule_ids": ["942100"], "tags": ["injection", "sqli"], "anomaly_score": 5,
                                            "route_template": "/s"}), T0 + timedelta(seconds=5))
    rec.observe(w.event("proxy.crs_match", {"rule_ids": ["942101"], "tags": ["sqli"], "anomaly_score": 5, "route_template": "/s"}), T0)
    (b,) = rec.store.buckets(A)
    assert b.requests == 12 and b.crs_by_tag == {"injection": 1, "sqli": 2}


def test_buckets_split_by_minute_and_epoch_and_last_activity_is_the_latest_minute():
    w = World()
    w.add_instance(A)
    w.add_instance(B, "a-2")
    rec = ActivityRecorder(InMemoryActivityStore())
    assert rec.last_activity(A) is None
    rec.observe(req(w), T0)
    rec.observe(req(w), T0 + timedelta(minutes=3, seconds=20))
    w.reset(A)
    rec.observe(req(w), T0 + timedelta(minutes=5))
    rec.observe(req(w, iid=B), T0 + timedelta(minutes=9))
    assert [(b.epoch, b.minute.minute) for b in rec.store.buckets(A)] == [(1, 0), (1, 3), (2, 5)]
    assert rec.last_activity(A) == T0 + timedelta(minutes=5) and rec.last_activity(B) == T0 + timedelta(minutes=9)
    assert minute_of(datetime(2026, 10, 17, 10, 7, 59, 5)).tzinfo is UTC


def test_other_events_and_bot_requests_are_not_activity():
    w = World()
    w.add_instance(A)
    rec = ActivityRecorder(InMemoryActivityStore())
    assert rec.observe(w.event("shop.catalog_query_error", {"route": "/x", "error_class": "sql_syntax"}), T0) is False
    assert rec.observe(req(w, session_kind="bot", source="bot"), T0) is False
    assert rec.store.buckets(A) == []


def test_label_is_estimated_and_per_challenge_time_not_allowed_until_verified():
    s = FakeSettingsPort()
    assert attribution_label(s) == "estimated" and per_challenge_time_allowed(s) is False  # the setting is not in SETTINGS yet: false


class _S:
    def __init__(self, v):
        self.v = v

    def get(self, name):
        assert name == "classifier_accuracy_verified"
        return self.v


def test_label_follows_the_setting_and_only_a_true_bool_counts():
    assert attribution_label(_S(False)) == "estimated" and per_challenge_time_allowed(_S(False)) is False
    assert attribution_label(_S("true")) == "estimated" and per_challenge_time_allowed(_S(1)) is False  # not a bool: not verified
    assert attribution_label(_S(True)) == "measured" and per_challenge_time_allowed(_S(True)) is True


def test_label_functions_change_no_score():
    w = World()
    w.add_instance(A)
    w.send_flag("C05")
    before = w.best("C05")
    attribution_label(_S(False))
    per_challenge_time_allowed(_S(False))
    assert w.best("C05") == before == "M3"
