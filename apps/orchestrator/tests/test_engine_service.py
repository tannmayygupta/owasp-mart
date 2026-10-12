"""The engine as the service uses it (story 3.2): contract alignment of the create body, accept and run split, capacity, access, list,
the record fields and a destroy that arrives while the instance is still being built."""
import threading
import time

import pytest
from support import EVENT_KEY, FLAG_A, IID, SEED, allowlist, body, template

from vulnmart_orchestrator.backend import FakeBackend
from vulnmart_orchestrator.builder import parse_access, parse_create, parse_reset
from vulnmart_orchestrator.engine import Orchestrator
from vulnmart_orchestrator.states import (
    Busy, FieldForbidden, InstanceNotFound, InstanceState, InvalidState, StaleAccessEpoch, ValidationFailed,
)

S = InstanceState
OTHER = "i-ZZZZZZZZZZZZZZZZ"


class Gate(FakeBackend):
    """A backend whose injector does not finish until the test lets it: the slow Docker of a real host."""

    def __init__(self):
        super().__init__()
        self.release = threading.Event()
        self.waiting = threading.Event()

    def wait_exit(self, name, timeout_s):
        self.waiting.set()
        assert self.release.wait(10), "the test never released the injector"
        return super().wait_exit(name, timeout_s)


def make(backend=None, **kw):
    be = backend or FakeBackend()
    orch = Orchestrator(be, {"shop-v0": template()}, allowlist(), health_timeout_s=5, poll_s=0.001, **kw)
    return orch, be


def wait_for(predicate, timeout=5.0):
    end = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < end, "timed out"
        time.sleep(0.005)


# ---- the create body is checked the way the contract says (D3) ----
@pytest.mark.parametrize("mutate,field", [
    (lambda b: b.update(template_id="Shop"), "/template_id"),
    (lambda b: b.update(template_id="ab"), "/template_id"),
    (lambda b: b.update(instance_id="i-ABCDEFGHIJKLMNOP\n"), "/instance_id"),
    (lambda b: b.update(hostname="Bad_Host"), "/hostname"),
    (lambda b: b.update(hostname="a" * 64 + ".example.invalid"), "/hostname"),
    (lambda b: b.update(event_key="x" * 31), "/event_key"),
    (lambda b: b.update(event_key="é" * 40), "/event_key"),
    (lambda b: b.update(owner_hash="A" * 64), "/owner_hash"),
    (lambda b: b["limits"].pop("memory_mb"), "/limits/memory_mb"),
    (lambda b: b["limits"].update(memory_mb=63), "/limits/memory_mb"),
    (lambda b: b["limits"].update(memory_mb=8193), "/limits/memory_mb"),
    (lambda b: b["limits"].update(pids_limit=15), "/limits/pids_limit"),
    (lambda b: b["limits"].update(pids_limit=4097), "/limits/pids_limit"),
    (lambda b: b["limits"].update(idle_minutes=0), "/limits/idle_minutes"),
    (lambda b: b["limits"].update(idle_minutes=1441), "/limits/idle_minutes"),
    (lambda b: b["limits"].update(max_minutes=1441), "/limits/max_minutes"),
    (lambda b: b["limits"].update(cpu_limit=0), "/limits/cpu_limit"),
    (lambda b: b["limits"].update(cpu_limit=8.01), "/limits/cpu_limit"),
    (lambda b: b["limits"].update(cpu_limit=True), "/limits/cpu_limit"),
    (lambda b: b["limits"].update(cpu_limit=float("nan")), "/limits/cpu_limit"),
    (lambda b: b["limits"].update(env="x"), "/limits/env"),
    (lambda b: b["flags"][0].update(flag="VM{x}"), "/flags/0/flag"),
    (lambda b: b["decoys"][0].update(index=-1), "/decoys/0/index"),
    (lambda b: b["flag_digests"][0].update(sha256="g" * 64), "/flag_digests/0/sha256"),
    (lambda b: b.update(surprise=1), "/surprise"),
    (lambda b: b.pop("seed"), "/seed"),
])
def test_a_bad_create_value_is_refused_with_its_json_pointer(mutate, field):
    b = body()
    mutate(b)
    with pytest.raises(ValidationFailed) as err:
        parse_create(b)
    assert err.value.field == field


def test_a_forbidden_name_is_found_in_any_case_and_gives_its_pointer():
    with pytest.raises(FieldForbidden) as err:
        parse_create({**body(), "Image": "x"})
    assert err.value.field == "/Image"


def test_the_limits_are_part_of_the_fingerprint_and_cpu_is_compared_by_value():
    base = parse_create(body())
    for name, value in (("memory_mb", 300), ("pids_limit", 600), ("idle_minutes", 31), ("max_minutes", 121), ("cpu_limit", 2)):
        other = parse_create(body(limits={**body()["limits"], name: value}))
        assert other.fingerprint() != base.fingerprint(), name
    two = parse_create(body(limits={**body()["limits"], "cpu_limit": 2}))
    two_float = parse_create(body(limits={**body()["limits"], "cpu_limit": 2.0}))
    assert two.fingerprint() == two_float.fingerprint()


def test_reset_and_access_bodies_have_their_own_closed_shapes():
    reset = {k: body()[k] for k in ("flags", "decoys", "flag_digests", "event_key", "seed")}
    assert parse_reset({**reset, "epoch": 2}).epoch == 2
    for bad, field in (({**reset, "epoch": 1}, "/epoch"), ({**reset, "epoch": 2, "owner_hash": "0" * 64}, "/owner_hash"), (reset, "/epoch")):
        with pytest.raises(ValidationFailed) as err:
            parse_reset(bad)
        assert err.value.field == field
    assert parse_access({"access": "open", "access_epoch": 0}) == ("open", 0)
    for bad, field in (({"access": "ajar", "access_epoch": 1}, "/access"), ({"access": "open", "access_epoch": -1}, "/access_epoch"),
                       ({"access": "open", "access_epoch": True}, "/access_epoch"), ({"access": "open"}, "/access_epoch")):
        with pytest.raises(ValidationFailed) as err:
            parse_access(bad)
        assert err.value.field == field


# ---- accept and run (D4) ----
def test_accept_answers_at_once_and_the_instance_is_ready_only_after_the_injection():
    gate = Gate()
    orch, _ = make(gate)
    started = time.monotonic()
    accepted = orch.accept_create(body())
    assert time.monotonic() - started < 0.5
    assert accepted.changed is True and accepted.view["state"] == "requested" and accepted.view["access"] == "closed"
    assert accepted.view["access_epoch"] == 0 and accepted.view["health"] == "unknown"
    worker = threading.Thread(target=accepted.work)
    worker.start()
    assert gate.waiting.wait(5)
    # the injector has not exited: nothing is ready, and the other components are not even started
    assert orch.view(IID)["state"] == "starting"
    assert not any(n.endswith(("-shop", "-sidecar")) for o, n in gate.calls if o in ("start", "start_with_stdin"))
    gate.release.set()
    worker.join(5)
    assert orch.view(IID)["state"] == "ready" and orch.view(IID)["health"] == "healthy"


def test_a_repeat_of_an_accepted_create_has_no_work_and_a_mismatch_is_refused():
    orch, _ = make()
    first = orch.accept_create(body())
    again = orch.accept_create(body())
    assert again.changed is False and again.work is None and again.record is first.record
    from vulnmart_orchestrator.states import RequestMismatch

    with pytest.raises(RequestMismatch):
        orch.accept_create(body(limits={**body()["limits"], "memory_mb": 300}))  # the limits are part of the identity


def test_every_transition_goes_to_the_hook_in_order_with_the_health_after_it():
    seen = []
    orch, _ = make(on_transition=seen.append)
    orch.create(body())
    assert [(t.transition, t.to_state, t.health) for t in seen] == [
        (1, S.REQUESTED, "unknown"), (2, S.PROVISIONING, "unknown"), (3, S.STARTING, "unknown"), (4, S.READY, "healthy")]
    orch.destroy(IID)
    assert [t.to_state for t in seen][-2:] == [S.STOPPING, S.DESTROYED]


def test_a_failed_instance_is_unhealthy_only_for_a_health_timeout():
    orch, _ = make(FakeBackend(healthy_after=None))
    orch.create(body())
    assert orch.view(IID)["state"] == "failed" and orch.view(IID)["health"] == "unhealthy"
    orch2, _ = make(FakeBackend(injector_exit=10))
    orch2.create(body())
    assert orch2.view(IID)["error_code"] == "INST-INJECT-BAD-DOCUMENT" and orch2.view(IID)["health"] == "unknown"


def test_the_view_holds_no_secret_and_only_the_contract_members():
    orch, _ = make()
    orch.create(body())
    view = orch.view(IID)
    assert set(view) == {"instance_id", "template_id", "epoch", "state", "access", "access_epoch", "health", "error_code", "host_id",
                         "hostname", "created_at", "updated_at"}
    text = repr(view)
    for secret in (FLAG_A, SEED, EVENT_KEY):
        assert secret not in text


# ---- capacity (D8) ----
def test_capacity_is_the_sum_of_memory_of_instances_that_are_not_destroyed():
    orch, be = make(capacity_mb=512)
    orch.create(body(iid=IID))
    orch.create(body(iid=OTHER))
    third = "i-YYYYYYYYYYYYYYYY"
    with pytest.raises(Busy):
        orch.accept_create(body(iid=third))
    assert orch.get(third) is None and orch.host_status()["used_memory_mb"] == 512 and orch.host_status()["instances"] == 2
    orch.destroy(IID)
    assert orch.host_status()["used_memory_mb"] == 256 and orch.host_status()["instances"] == 1
    orch.create(body(iid=third))  # the memory of a destroyed instance is free again; its tombstone stays
    assert orch.view(IID)["state"] == "destroyed"


def test_a_create_larger_than_the_whole_host_is_busy_and_creates_nothing():
    orch, be = make(capacity_mb=128)
    with pytest.raises(Busy):
        orch.accept_create(body())
    assert be.calls == [] and orch.records == {}


# ---- access ----
def test_access_epoch_only_grows_and_an_equal_epoch_needs_the_same_value():
    orch, _ = make()
    orch.create(body())
    assert orch.set_access(IID, "open", 1)["access"] == "open"
    assert orch.set_access(IID, "open", 1)["access_epoch"] == 1
    with pytest.raises(StaleAccessEpoch):
        orch.set_access(IID, "closed", 1)
    with pytest.raises(StaleAccessEpoch):
        orch.set_access(IID, "closed", 0)
    assert orch.set_access(IID, "frozen", 3)["access_epoch"] == 3
    with pytest.raises(InstanceNotFound):
        orch.set_access(OTHER, "open", 1)
    orch.destroy(IID)
    with pytest.raises(InvalidState):
        orch.set_access(IID, "open", 9)


# ---- list ----
def test_list_is_ordered_by_id_paged_and_filtered():
    orch, _ = make()
    ids = ["i-CCCCCCCCCCCCCCCC", "i-AAAAAAAAAAAAAAAA", "i-BBBBBBBBBBBBBBBB"]
    for i in ids:
        orch.create(body(iid=i))
    page, last = orch.list_views(limit=2)
    assert [v["instance_id"] for v in page] == ["i-AAAAAAAAAAAAAAAA", "i-BBBBBBBBBBBBBBBB"] and last == "i-BBBBBBBBBBBBBBBB"
    rest, last = orch.list_views(after=last, limit=2)
    assert [v["instance_id"] for v in rest] == ["i-CCCCCCCCCCCCCCCC"] and last is None
    assert [v["instance_id"] for v in orch.list_views(instance="i-BBBBBBBBBBBBBBBB")[0]] == ["i-BBBBBBBBBBBBBBBB"]
    assert len(orch.list_views(template="shop-v0", kind="inst", component="sidecar")[0]) == 3
    assert orch.list_views(epoch=2)[0] == [] and orch.list_views(kind="front")[0] == [] and orch.list_views(component="nope")[0] == []


# ---- destroy while the instance is being built ----
def test_a_destroy_during_provisioning_cancels_the_build_and_removes_everything():
    gate = Gate()
    orch, _ = make(gate)
    build = threading.Thread(target=orch.accept_create(body()).work)
    build.start()
    assert gate.waiting.wait(5)
    accepted = orch.accept_destroy(IID)
    assert accepted.changed is True and accepted.view["state"] == "stopping"
    again = orch.accept_destroy(IID)  # a repeat while the removal is working: 200, no second worker
    assert again.changed is False and again.work is None
    remover = threading.Thread(target=accepted.work)
    remover.start()
    time.sleep(0.05)
    assert orch.view(IID)["state"] == "stopping"  # the removal waits for the build to notice
    gate.release.set()
    build.join(5)
    remover.join(5)
    assert orch.view(IID)["state"] == "destroyed"
    assert not (gate.containers or gate.networks or gate.volumes)
    states = [t.to_state for t in orch.get(IID).transitions]
    assert S.READY not in states and S.FAILED not in states and states[-2:] == [S.STOPPING, S.DESTROYED]


def test_destroy_of_an_unknown_instance_is_not_found_for_the_service():
    orch, _ = make()
    with pytest.raises(InstanceNotFound):
        orch.accept_destroy(IID)


def test_the_step_delay_pauses_before_each_step_and_a_destroy_cuts_it_short():
    orch, _ = make(step_delay_s=30)
    accepted = orch.accept_create(body())
    build = threading.Thread(target=accepted.work, daemon=True)
    build.start()
    time.sleep(0.1)
    assert orch.view(IID)["state"] == "requested"  # held by the delay
    orch.accept_destroy(IID)
    build.join(2)
    assert not build.is_alive()
