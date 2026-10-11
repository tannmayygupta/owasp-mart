"""State reports (IF-5 section 8, ADR 0028): the transition number, and what the platform side does with a report.

The first group runs on both hosts (the `kind` fixture): FakeInstanceHost and HttpInstanceHost plus the fake service, whose
reports are delivered to a signed receiver. The second group tests `ReportIngest` and the receiver on their own."""
from __future__ import annotations

import dataclasses
import json
import time
from datetime import UTC, datetime

import pytest

from support import ORCH_KEY, ReportReceiver, create_request, raw_call, reset_request
from vulnmart.ports.http_instance_host import signed_headers
from vulnmart.ports.instance_host import (
    Health, InstanceState, ReportIngest, RequestMismatch, StateReport, ValidationFailed,
)

S = InstanceState
IID = "i-AAAAAAAAAAAAAAAA"


def wait_for_reports(harness, count, timeout=10.0):
    deadline = time.monotonic() + timeout
    while len(harness.reports()) < count:
        if time.monotonic() > deadline:
            raise AssertionError(f"only {len(harness.reports())} of {count} reports arrived")
        time.sleep(0.01)
    return harness.reports()


def report(epoch=1, transition=1, frm=S.REQUESTED, to=S.PROVISIONING, at="2026-10-11T12:00:00Z", reason="r", iid=IID):
    return StateReport(iid, epoch, transition, frm, to, at, reason, None, Health.UNKNOWN)


# ---- both hosts: every state change carries a transition number ----
def test_every_state_change_is_reported_with_a_transition_number_per_epoch(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    harness.host.reset(req.instance_id, reset_request(2))
    harness.settle(req.instance_id, S.READY)
    harness.host.destroy(req.instance_id)
    harness.settle(req.instance_id, S.DESTROYED)
    reports = wait_for_reports(harness, 10)
    assert [(r.epoch, r.transition) for r in reports] == [(1, 1), (1, 2), (1, 3), (1, 4), (2, 1), (2, 2), (2, 3), (2, 4), (2, 5), (2, 6)]
    assert [(r.from_state, r.to_state) for r in reports] == [
        (None, S.REQUESTED), (S.REQUESTED, S.PROVISIONING), (S.PROVISIONING, S.STARTING), (S.STARTING, S.READY),
        (S.READY, S.RESETTING), (S.RESETTING, S.PROVISIONING), (S.PROVISIONING, S.STARTING), (S.STARTING, S.READY),
        (S.READY, S.STOPPING), (S.STOPPING, S.DESTROYED),
    ]
    assert {r.instance_id for r in reports} == {req.instance_id}


def test_a_re_entrant_transition_has_its_own_number_and_is_not_a_duplicate(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    for state in (S.ACTIVE, S.IDLE, S.ACTIVE, S.IDLE):
        harness.set_activity(req.instance_id, state)
    reports = wait_for_reports(harness, 8)
    tail = reports[4:]
    assert [(r.from_state, r.to_state) for r in tail] == [(S.READY, S.ACTIVE), (S.ACTIVE, S.IDLE), (S.IDLE, S.ACTIVE), (S.ACTIVE, S.IDLE)]
    assert [r.transition for r in tail] == [5, 6, 7, 8]
    ingest = ReportIngest()
    assert all(ingest.accept(r) is True for r in reports)  # none of them is taken for a repeat of another
    assert ingest.current(req.instance_id).transition == 8


def test_an_activity_that_changes_nothing_makes_no_report_and_takes_no_number(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    harness.set_activity(req.instance_id, S.READY)  # already ready
    harness.set_activity(req.instance_id, S.ACTIVE)
    reports = wait_for_reports(harness, 5)
    time.sleep(0.1)
    assert [r.transition for r in harness.reports()] == [1, 2, 3, 4, 5]


def test_the_reports_of_a_run_can_be_delivered_twice_and_in_any_order(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    harness.host.reset(req.instance_id, reset_request(2))
    harness.settle(req.instance_id, S.READY)
    reports = wait_for_reports(harness, 8)
    ingest = ReportIngest()
    for r in [*reversed(reports), *reports]:  # newest first, then every one again
        ingest.accept(r)
    assert [(r.epoch, r.transition) for r in ingest.history(req.instance_id)] == [(r.epoch, r.transition) for r in reports]
    assert ingest.current(req.instance_id) == reports[-1]


# ---- the fake host with a clock that does not move: equal `at` is still ordered ----
def test_reports_with_the_same_at_are_ordered_by_their_transition():
    from support import make_harness
    frozen = datetime(2026, 10, 11, 12, 0, 0, tzinfo=UTC)
    h = make_harness("fake", now=lambda: frozen)
    req = create_request()
    h.host.create(req)
    h.settle(req.instance_id, S.READY)
    reports = h.reports()
    assert len({r.at for r in reports}) == 1 and len(reports) == 4  # four changes, one and the same `at`
    assert [r.transition for r in reports] == [1, 2, 3, 4]
    ingest = ReportIngest()
    for r in reversed(reports):
        ingest.accept(r)
    assert ingest.current(req.instance_id).to_state is S.READY  # `at` alone could not say which was last; the number does


# ---- ReportIngest ----
def test_the_same_report_again_is_a_duplicate_and_another_body_is_a_conflict():
    ingest = ReportIngest()
    r = report()
    assert ingest.accept(r) is True
    assert ingest.accept(dataclasses.replace(r)) is False  # equal body: 200
    for other in (dataclasses.replace(r, reason="other"), dataclasses.replace(r, to_state=S.STARTING), dataclasses.replace(r, at="2026-10-11T12:00:01Z")):
        with pytest.raises(RequestMismatch):
            ingest.accept(other)  # 409
    assert len(ingest.history(IID)) == 1


def test_a_lower_transition_is_history_and_does_not_move_the_state_back():
    ingest = ReportIngest()
    ingest.accept(report(transition=3, frm=S.PROVISIONING, to=S.STARTING))
    ingest.accept(report(transition=1, frm=None, to=S.REQUESTED))  # late
    ingest.accept(report(transition=2, frm=S.REQUESTED, to=S.PROVISIONING))  # late
    assert ingest.current(IID).transition == 3 and ingest.current(IID).to_state is S.STARTING
    assert [r.transition for r in ingest.history(IID)] == [1, 2, 3]


def test_equal_at_reports_are_orderable_and_the_same_state_twice_is_not_a_duplicate():
    ingest = ReportIngest()
    a = report(transition=1, frm=S.ACTIVE, to=S.IDLE)
    b = report(transition=2, frm=S.IDLE, to=S.ACTIVE)
    c = report(transition=3, frm=S.ACTIVE, to=S.IDLE)  # same states as `a`, same `at`, another number
    assert [ingest.accept(x) for x in (c, a, b)] == [True, True, True]
    assert ingest.current(IID) == c


def test_a_higher_epoch_wins_over_a_higher_transition_of_an_older_epoch():
    ingest = ReportIngest()
    ingest.accept(report(epoch=1, transition=9, frm=S.READY, to=S.ACTIVE))
    ingest.accept(report(epoch=2, transition=1, frm=S.READY, to=S.RESETTING))
    ingest.accept(report(epoch=1, transition=10, frm=S.ACTIVE, to=S.IDLE))  # late report of the old epoch
    assert ingest.current(IID).epoch == 2 and ingest.current(IID).to_state is S.RESETTING


def test_instances_are_kept_apart():
    ingest = ReportIngest()
    other = "i-BBBBBBBBBBBBBBBB"
    ingest.accept(report())
    ingest.accept(report(iid=other, reason="another body, another instance"))
    assert ingest.current(other).reason.startswith("another") and ingest.current(IID).reason == "r"


@pytest.mark.parametrize("mutate,field", [
    (lambda d: d.pop("transition"), "/transition"), (lambda d: d.update(transition=0), "/transition"),
    (lambda d: d.update(transition=-1), "/transition"), (lambda d: d.update(transition=1.0), "/transition"),
    (lambda d: d.update(transition="1"), "/transition"), (lambda d: d.update(transition=True), "/transition"),
    (lambda d: d.update(transition=2**53), "/transition"), (lambda d: d.update(epoch=1.0), "/epoch"),
    (lambda d: d.update(epoch=0), "/epoch"), (lambda d: d.update(extra=1), "/extra"), (lambda d: d.update(to_state="paused"), "/to_state"),
])
def test_a_malformed_report_is_a_validation_error(mutate, field):
    body = report().to_json()
    mutate(body)
    with pytest.raises(ValidationFailed) as err:
        StateReport.from_json(body)
    assert err.value.field == field


# ---- the receiver (the platform side over HTTP): 204, 200, 409, 422, and a float token is refused ----
@pytest.fixture
def rx():
    r = ReportReceiver()
    yield r
    r.stop()


def post(rx, body: bytes):
    return raw_call(rx.url, "POST", "/internal/v1/orch/state", body, key=ORCH_KEY)[0]


def test_the_receiver_answers_204_then_200_then_409(rx):
    body = json.dumps(report().to_json()).encode()
    assert post(rx, body) == 204
    assert post(rx, body) == 200
    assert post(rx, json.dumps(report(reason="changed").to_json()).encode()) == 409
    assert len(rx.reports) == 1


@pytest.mark.parametrize("token", ["1.0", "1e0", "0", "-1", "true", '"1"', "9007199254740993", "NaN"])
def test_the_receiver_refuses_a_transition_that_is_not_an_integer_token(rx, token):
    text = json.dumps(report().to_json(), separators=(",", ":")).replace('"transition":1', f'"transition":{token}')
    assert post(rx, text.encode()) == 422
    assert rx.reports == []


def test_the_receiver_refuses_a_report_without_a_transition(rx):
    body = report().to_json()
    del body["transition"]
    assert post(rx, json.dumps(body).encode()) == 422


def test_a_report_signed_with_the_platform_key_is_refused(rx):
    from support import PLATFORM_KEY
    body = json.dumps(report().to_json()).encode()
    assert raw_call(rx.url, "POST", "/internal/v1/orch/state", body, key=PLATFORM_KEY)[0] == 401
    assert signed_headers(ORCH_KEY, "POST", "/internal/v1/orch/state", body)  # the helper the sender uses
