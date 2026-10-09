"""The shared protocol suite (IF-5): every row of the contract's matrix, run against FakeInstanceHost and against
HttpInstanceHost talking to the fake orchestrator service (see conftest.py: the `kind` fixture)."""
from __future__ import annotations

import dataclasses
import re

import pytest

from support import create_request, material, new_id, reset_request
from vulnmart.ports.instance_host import (
    Access, Busy, Health, HostHealth, InstanceExists, InstanceHost, InstanceNotFound, InstanceState, InvalidState,
    LabelUnknown, RequestMismatch, StaleAccessEpoch, StaleEpoch, TemplateUnknown, ValidationFailed,
)

S = InstanceState


def test_both_implementations_satisfy_the_protocol(harness):
    assert isinstance(harness.host, InstanceHost)


# ---- create ----
def test_create_is_accepted_then_advances_to_ready(harness):
    req = create_request()
    out = harness.host.create(req)
    assert out.changed is True  # 202
    assert out.status.state is S.REQUESTED
    assert out.status.access is Access.CLOSED and out.status.access_epoch == 0
    assert out.status.epoch == 1 and out.status.template_id == "shop-v0" and out.status.hostname == req.hostname
    ready = harness.settle(req.instance_id, S.READY)
    assert ready.health is Health.HEALTHY and ready.error_code is None


def test_create_again_with_an_identical_body_is_a_repeat(harness):
    req = create_request()
    harness.host.create(req)
    again = harness.host.create(req)
    assert again.changed is False  # 200
    assert again.status.instance_id == req.instance_id
    harness.settle(req.instance_id, S.READY)
    assert harness.host.create(req).status.state is S.READY


def test_create_conflict_same_id_and_epoch_other_body(harness):
    req = create_request(tag="A")
    harness.host.create(req)
    with pytest.raises(RequestMismatch) as err:
        harness.host.create(create_request(req.instance_id, tag="E"))
    assert err.value.code == "ORCH-REQUEST-MISMATCH"
    assert harness.host.get(req.instance_id).epoch == 1  # nothing changed


def test_create_for_an_existing_instance_with_another_epoch(harness):
    req = create_request()
    harness.host.create(req)
    with pytest.raises(InstanceExists):
        harness.host.create(create_request(req.instance_id, epoch=2))


def test_unknown_template_creates_nothing(harness):
    req = create_request(template="not-listed")
    with pytest.raises(TemplateUnknown) as err:
        harness.host.create(req)
    assert err.value.code == "ORCH-TEMPLATE-UNKNOWN"
    with pytest.raises(InstanceNotFound):
        harness.host.get(req.instance_id)
    assert harness.host.host_status().instances == 0


def test_busy_host_refuses_and_creates_nothing(make, kind):
    h = make(kind, capacity_mb=512)
    a, b, c = (create_request(memory_mb=256) for _ in range(3))
    h.host.create(a)
    h.host.create(b)
    with pytest.raises(Busy) as err:
        h.host.create(c)
    assert err.value.code == "ORCH-BUSY"
    with pytest.raises(InstanceNotFound):
        h.host.get(c.instance_id)
    # the capacity comes back when an instance is destroyed
    h.host.destroy(a.instance_id)
    h.settle(a.instance_id, S.DESTROYED)
    assert h.host.create(c).changed is True


def test_failing_template_ends_in_failed_with_an_error_code(harness):
    req = create_request(template="shop-fail-v0")
    harness.host.create(req)
    failed = harness.settle(req.instance_id, S.FAILED)
    assert failed.error_code == "INST-HEALTH-TIMEOUT" and failed.health is Health.UNHEALTHY
    with pytest.raises(InvalidState):  # reset is for ready, active and idle only
        harness.host.reset(req.instance_id, reset_request())


@pytest.mark.parametrize("what", ["memory_mb", "cpu_zero", "cpu_high", "hostname"])
def test_malformed_create_values_are_validation_errors(harness, what):
    req = create_request()
    if what == "memory_mb":
        req = dataclasses.replace(req, limits=dataclasses.replace(req.limits, memory_mb=1))
    elif what == "cpu_zero":
        req = dataclasses.replace(req, limits=dataclasses.replace(req.limits, cpu_limit=0))
    elif what == "cpu_high":
        req = dataclasses.replace(req, limits=dataclasses.replace(req.limits, cpu_limit=9))
    else:
        req = dataclasses.replace(req, hostname="Bad_Host")
    with pytest.raises(ValidationFailed) as err:
        harness.host.create(req)
    assert err.value.code == "ORCH-VALIDATION" and err.value.field
    with pytest.raises(InstanceNotFound):
        harness.host.get(req.instance_id)


def test_create_with_an_older_epoch_is_stale(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    harness.host.reset(req.instance_id, reset_request(2))
    with pytest.raises(StaleEpoch):
        harness.host.create(req)  # epoch 1 while the instance is at epoch 2


def test_a_destroyed_id_cannot_be_created_again(harness):
    req = create_request()
    harness.host.create(req)
    harness.host.destroy(req.instance_id)
    harness.settle(req.instance_id, S.DESTROYED)
    with pytest.raises(InstanceExists) as err:
        harness.host.create(req)
    assert err.value.code == "ORCH-INSTANCE-EXISTS"


def test_a_malformed_instance_id_is_a_validation_error_not_a_missing_instance(harness):
    for call in (
        lambda: harness.host.get("nope"),
        lambda: harness.host.reset("nope", reset_request(2)),
        lambda: harness.host.set_access("nope", Access.OPEN, 1),
        lambda: harness.host.destroy("nope"),
    ):
        with pytest.raises(ValidationFailed) as err:
            call()
        assert err.value.field == "/instance_id"


# ---- get ----
def test_get_unknown_instance(harness):
    with pytest.raises(InstanceNotFound) as err:
        harness.host.get(new_id())
    assert err.value.code == "ORCH-INSTANCE-NOT-FOUND"


# ---- reset ----
def test_reset_from_ready_gives_a_new_epoch(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    out = harness.host.reset(req.instance_id, reset_request(2))
    assert out.changed is True and out.status.state is S.RESETTING and out.status.epoch == 2
    after = harness.settle(req.instance_id, S.READY)
    assert after.epoch == 2 and after.health is Health.HEALTHY


@pytest.mark.parametrize("activity", [S.ACTIVE, S.IDLE])
def test_reset_from_active_and_idle(harness, activity):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    harness.set_activity(req.instance_id, S.ACTIVE)
    if activity is S.IDLE:
        harness.set_activity(req.instance_id, S.IDLE)
    assert harness.host.get(req.instance_id).state is activity
    assert harness.host.reset(req.instance_id, reset_request(2)).status.state is S.RESETTING


def test_reset_repeat_wrong_epoch_and_mismatch(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    harness.host.reset(req.instance_id, reset_request(2, tag="D"))
    assert harness.host.reset(req.instance_id, reset_request(2, tag="D")).changed is False  # 200
    with pytest.raises(RequestMismatch):
        harness.host.reset(req.instance_id, reset_request(2, tag="F"))
    harness.settle(req.instance_id, S.READY)
    with pytest.raises(StaleEpoch) as err:
        harness.host.reset(req.instance_id, reset_request(4))  # must be 3
    assert err.value.code == "ORCH-STALE-EPOCH"


def test_reset_in_other_states_is_refused(held):
    req = create_request()
    held.host.create(req)
    assert held.host.get(req.instance_id).state is S.REQUESTED
    with pytest.raises(InvalidState) as err:
        held.host.reset(req.instance_id, reset_request(2))
    assert err.value.code == "ORCH-INVALID-STATE"
    held.host.destroy(req.instance_id)  # now stopping
    with pytest.raises(InvalidState):
        held.host.reset(req.instance_id, reset_request(2))


def test_reset_epoch_one_is_a_validation_error(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    with pytest.raises(ValidationFailed) as err:
        harness.host.reset(req.instance_id, reset_request(1))
    assert err.value.field == "/epoch"


def test_access_given_as_a_plain_string_is_coerced(harness):
    req = create_request()
    harness.host.create(req)
    assert harness.host.set_access(req.instance_id, "open", 1).access is Access.OPEN
    assert harness.host.set_access(req.instance_id, "open", 1).access_epoch == 1  # repeat is fine
    with pytest.raises(StaleAccessEpoch):
        harness.host.set_access(req.instance_id, "closed", 1)
    with pytest.raises(ValidationFailed):
        harness.host.set_access(req.instance_id, "ajar", 2)


def test_reset_unknown_instance(harness):
    with pytest.raises(InstanceNotFound):
        harness.host.reset(new_id(), reset_request())


# ---- access ----
def test_access_is_applied_and_an_older_epoch_is_refused(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    opened = harness.host.set_access(req.instance_id, Access.OPEN, 1)
    assert opened.access is Access.OPEN and opened.access_epoch == 1
    frozen = harness.host.set_access(req.instance_id, Access.FROZEN, 3)
    assert frozen.access is Access.FROZEN and frozen.access_epoch == 3
    with pytest.raises(StaleAccessEpoch) as err:
        harness.host.set_access(req.instance_id, Access.OPEN, 2)
    assert err.value.code == "ORCH-STALE-ACCESS-EPOCH"
    now = harness.host.get(req.instance_id)
    assert now.access is Access.FROZEN and now.access_epoch == 3  # unchanged


def test_access_same_epoch_same_value_is_a_repeat_other_value_is_stale(harness):
    req = create_request()
    harness.host.create(req)
    harness.host.set_access(req.instance_id, Access.OPEN, 1)
    assert harness.host.set_access(req.instance_id, Access.OPEN, 1).access is Access.OPEN
    with pytest.raises(StaleAccessEpoch):
        harness.host.set_access(req.instance_id, Access.CLOSED, 1)
    closed = harness.host.set_access(req.instance_id, Access.CLOSED, 2)
    assert closed.access is Access.CLOSED


def test_access_on_unknown_and_destroyed_instances(harness):
    with pytest.raises(InstanceNotFound):
        harness.host.set_access(new_id(), Access.OPEN, 1)
    req = create_request()
    harness.host.create(req)
    harness.host.destroy(req.instance_id)
    harness.settle(req.instance_id, S.DESTROYED)
    with pytest.raises(InvalidState):
        harness.host.set_access(req.instance_id, Access.OPEN, 1)


# ---- destroy ----
def test_destroy_then_repeat(harness):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    out = harness.host.destroy(req.instance_id)
    assert out.changed is True and out.status.state is S.STOPPING  # 202
    harness.settle(req.instance_id, S.DESTROYED)
    again = harness.host.destroy(req.instance_id)
    assert again.changed is False and again.status.state is S.DESTROYED  # 200


def test_destroy_unknown_instance(harness):
    with pytest.raises(InstanceNotFound):
        harness.host.destroy(new_id())


# ---- list and host ----
def test_list_filters_and_pages(harness):
    reqs = [create_request() for _ in range(3)]
    for r in reqs:
        harness.host.create(r)
    harness.settle(reqs[0].instance_id, S.READY)
    ids = sorted(r.instance_id for r in reqs)
    page1 = harness.host.list_instances(limit=2)
    assert [i.instance_id for i in page1.items] == ids[:2] and page1.next_cursor
    page2 = harness.host.list_instances(cursor=page1.next_cursor, limit=2)
    assert [i.instance_id for i in page2.items] == ids[2:] and page2.next_cursor is None
    only = harness.host.list_instances({"instance": ids[1]})
    assert [i.instance_id for i in only.items] == [ids[1]]
    assert len(harness.host.list_instances({"template": "shop-v0", "kind": "inst", "component": "sidecar"}).items) == 3
    assert harness.host.list_instances({"epoch": "2"}).items == ()
    assert harness.host.list_instances({"template": "shop-fail-v0"}).items == ()
    assert harness.host.list_instances({"kind": "front"}).items == ()
    assert harness.host.list_instances({"component": "no-such-component"}).items == ()


def test_list_with_an_unknown_label_is_refused(harness):
    with pytest.raises(LabelUnknown) as err:
        harness.host.list_instances({"colour": "red"})
    assert err.value.code == "ORCH-LABEL-UNKNOWN"


def test_host_reports_capacity_and_health(harness):
    before = harness.host.host_status()
    assert before.capacity_memory_mb == 8192 and before.used_memory_mb == 0 and before.instances == 0
    assert before.health is HostHealth.OK
    req = create_request(memory_mb=300)
    harness.host.create(req)
    during = harness.host.host_status()
    assert during.used_memory_mb == 300 and during.instances == 1
    harness.host.destroy(req.instance_id)
    harness.settle(req.instance_id, S.DESTROYED)
    after = harness.host.host_status()
    assert after.used_memory_mb == 0 and after.instances == 0


# ---- no secret in any answer ----
def test_no_answer_holds_a_secret(harness):
    req = create_request(tag="Q")
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    harness.host.reset(req.instance_id, reset_request(2, tag="R"))
    answers = [
        harness.host.get(req.instance_id), harness.host.list_instances(), harness.host.host_status(),
        harness.host.set_access(req.instance_id, Access.OPEN, 1), harness.host.destroy(req.instance_id),
    ]
    text = "\n".join(repr(a) + str(dataclasses.asdict(a)) for a in answers)
    for secret in [*(m for t in "QR" for m in _secrets(t))]:
        assert secret not in text
    assert not re.search(r"VM\{", text)


def _secrets(tag: str):
    m = material(tag)
    yield from (f.flag for f in m.flags)
    yield from (d.value for d in m.decoys)
    yield from (d.sha256 for d in m.flag_digests)
    yield m.event_key
    yield m.seed
