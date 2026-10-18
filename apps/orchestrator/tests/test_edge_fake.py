"""Story edge-3: the engine attaches the edge to instance networks and pushes the access state to the gate (D-61, D-63, D-66), on the fake
backend and a recording gate. Every row of the I/O matrix of the story plan has a test here; the same rows run against real Docker and a
real gate in `test_edge_attach.py`. With no edge setting nothing changes (the whole existing suite is the proof, plus the first test)."""
from __future__ import annotations

import pytest
from support import IID, OWNER, allowlist, body, template
from test_engine_lifecycle import FakeNow, Ticks, reset_body

from vulnmart_orchestrator.backend import BackendError, FakeBackend
from vulnmart_orchestrator.engine import ADOPTED_TRANSITION_BASE, Orchestrator
from vulnmart_orchestrator.gate import GateError
from vulnmart_orchestrator.reconcile import FakeDesiredState
from vulnmart_orchestrator.states import ErrorCode, InstanceState, StaleAccessEpoch

S = InstanceState
EDGE = "vulnmart-edge-gate"


class RecordingGate:
    """A gate that writes down every push in order and can be made to fail. `seen_state` is the engine's own state at the moment of a put,
    so a test can tell what was recorded before and after the push."""

    enabled = True

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.fail = False
        self.engine: Orchestrator | None = None
        self.state_at_put: list = []

    def _check(self) -> None:
        if self.fail:
            raise GateError("the gate is not reachable: fake")

    def put(self, record: dict) -> None:
        self._check()
        rec = self.engine.records[record["instance_id"]] if self.engine else None
        self.state_at_put.append((rec.state, rec.access, rec.access_epoch) if rec else None)
        self.calls.append(("put", record["instance_id"], record["epoch"], record["access"], record["access_epoch"], record["owner"], record["hostname"]))

    def delete(self, instance_id: str) -> None:
        self._check()
        self.calls.append(("delete", instance_id))

    def sync(self, records: list[dict]) -> None:
        self._check()
        self.calls.append(("sync", tuple((r["instance_id"], r["epoch"], r["access"], r["access_epoch"], r["owner"]) for r in records)))


def make(*, edge=EDGE, gate=None, backend=None, retries=1, **kw):
    from vulnmart_orchestrator.lifecycle import FakeSettingsPort, Settings

    now, ticks, seen = FakeNow(), Ticks(), []
    be = backend or FakeBackend()
    orch = Orchestrator(
        be, {"shop-v0": template()}, allowlist(), clock=ticks, sleep=ticks.sleep, health_timeout_s=10, poll_s=1, now=now,
        on_transition=seen.append, edge_container=edge, gate=gate, settings=FakeSettingsPort(Settings(start_retries=retries)), **kw,
    )
    if isinstance(gate, RecordingGate):
        gate.engine = orch
    return orch, be, seen


def ops(be: FakeBackend) -> list[str]:
    return [o for o, _ in be.calls]


# ---------------------------------------------------------------- off by default


def test_no_edge_setting_means_no_connect_no_disconnect_and_no_push():
    gate = RecordingGate()  # given to the engine only to prove it is not used without `enabled`
    gate.enabled = False
    orch, be, _ = make(edge=None, gate=gate)
    assert orch.create(body()).state is S.READY
    orch.set_access(IID, "open", 1)
    orch.reset(IID, reset_body())
    orch.destroy(IID)
    assert "connect_edge" not in ops(be) and "disconnect_edge" not in ops(be) and gate.calls == []
    assert orch.get(IID).state is S.DESTROYED and not be.networks


# ---------------------------------------------------------------- create


def test_create_connects_the_edge_after_the_sidecar_is_healthy_and_before_ready_and_the_gate_has_the_record_closed():
    gate = RecordingGate()
    orch, be, seen = make(gate=gate)
    rec = orch.create(body())
    assert rec.state is S.READY
    assert be.edge_container == EDGE  # the engine gave the backend the one name it may connect
    net = f"vm-{IID.lower()}-e1-net"
    assert be.edge_attached == {net}
    # after the last container start, before ready
    last_start = max(i for i, (o, _) in enumerate(be.calls) if o in ("start", "start_with_stdin"))
    connect = next(i for i, (o, n) in enumerate(be.calls) if o == "connect_edge" and n == net)
    assert connect > last_start
    assert gate.calls == [("put", IID, 1, "closed", 0, OWNER, f"{IID.lower()}.instances.example.invalid")]
    assert gate.state_at_put == [(S.STARTING, "closed", 0)]  # the gate knew the instance before the platform heard `ready`
    assert [t.to_state for t in seen][-1] is S.READY


def test_a_failed_connect_is_a_start_failure_that_is_retried_once_and_leaves_nothing():
    gate = RecordingGate()
    be = FakeBackend(fail_on=("connect_edge", "-net"))
    orch, _, _ = make(gate=gate, backend=be)
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED
    assert ops(be).count("connect_edge") == 2  # the first try and the one retry
    assert not (be.containers or be.networks or be.volumes) and not be.edge_attached
    assert gate.calls == []  # the gate never heard of an instance that did not start


def test_a_failed_gate_push_at_ready_is_a_start_failure_and_the_edge_is_disconnected_again():
    gate = RecordingGate()
    gate.fail = True
    orch, be, _ = make(gate=gate)
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED
    assert not (be.containers or be.networks or be.volumes) and not be.edge_attached
    assert ops(be).count("disconnect_edge") >= 1


# ---------------------------------------------------------------- access


def test_open_freeze_and_close_reach_the_gate_before_the_record_changes():
    gate = RecordingGate()
    orch, _, _ = make(gate=gate)
    orch.create(body())
    gate.calls.clear()
    gate.state_at_put.clear()
    for access, epoch in (("open", 1), ("frozen", 2), ("closed", 3)):
        orch.set_access(IID, access, epoch)
    assert [c[3:5] for c in gate.calls] == [("open", 1), ("frozen", 2), ("closed", 3)]
    # at every push the record still held the previous value: the gate went first
    assert [s[1:] for s in gate.state_at_put] == [("closed", 0), ("open", 1), ("frozen", 2)]
    assert (orch.get(IID).access, orch.get(IID).access_epoch) == ("closed", 3)


def test_a_gate_that_is_down_fails_the_access_call_and_changes_nothing():
    gate = RecordingGate()
    orch, _, seen = make(gate=gate)
    orch.create(body())
    gate.fail = True
    stamp = orch.get(IID).updated_at
    with pytest.raises(BackendError):
        orch.set_access(IID, "open", 1)
    rec = orch.get(IID)
    assert (rec.access, rec.access_epoch, rec.updated_at) == ("closed", 0, stamp)
    gate.fail = False
    orch.set_access(IID, "open", 1)  # the platform repeats the call and it works
    assert orch.get(IID).access == "open"


def test_a_stale_or_repeated_access_call_is_judged_by_the_record_and_a_repeat_pushes_nothing():
    gate = RecordingGate()
    orch, _, _ = make(gate=gate)
    orch.create(body())
    orch.set_access(IID, "open", 2)
    pushes = len(gate.calls)
    orch.set_access(IID, "open", 2)  # an identical repeat: no change, no push
    assert len(gate.calls) == pushes
    with pytest.raises(StaleAccessEpoch):
        orch.set_access(IID, "frozen", 2)
    with pytest.raises(StaleAccessEpoch):
        orch.set_access(IID, "frozen", 1)
    assert len(gate.calls) == pushes


# ---------------------------------------------------------------- reset


def test_reset_disconnects_the_old_network_first_and_the_gate_gets_the_new_epoch():
    gate = RecordingGate()
    orch, be, _ = make(gate=gate)
    orch.create(body())
    orch.set_access(IID, "open", 1)
    gate.calls.clear()
    rec = orch.reset(IID, reset_body())
    assert rec.state is S.READY and rec.epoch == 2
    old, new = f"vm-{IID.lower()}-e1-net", f"vm-{IID.lower()}-e2-net"
    calls = [c for c in be.calls if c[1] in (old, new) and c[0] in ("disconnect_edge", "remove_network", "connect_edge")]
    assert calls.index(("disconnect_edge", old)) < calls.index(("remove_network", old)) < calls.index(("connect_edge", new))
    assert be.edge_attached == {new}
    assert gate.calls == [("put", IID, 2, "open", 1, OWNER, f"{IID.lower()}.instances.example.invalid")]


# ---------------------------------------------------------------- destroy


def test_destroy_closes_the_gate_disconnects_before_removing_the_network_then_deletes_the_record():
    gate = RecordingGate()
    orch, be, _ = make(gate=gate)
    orch.create(body())
    orch.set_access(IID, "open", 4)
    gate.calls.clear()
    be.calls.clear()
    assert orch.destroy(IID).state is S.DESTROYED
    net = f"vm-{IID.lower()}-e1-net"
    # closed first (written one access epoch above the record so the gate accepts it), the delete after the sweep
    assert gate.calls == [("put", IID, 1, "closed", 5, OWNER, f"{IID.lower()}.instances.example.invalid"), ("delete", IID)]
    assert be.calls.index(("disconnect_edge", net)) < be.calls.index(("remove_network", net))
    assert not (be.containers or be.networks or be.volumes) and not be.edge_attached and be.find(IID).empty
    assert (orch.get(IID).access, orch.get(IID).access_epoch) == ("open", 4)  # the record itself was not touched by the wire-only close


def test_destroy_of_an_instance_whose_access_is_already_closed_only_deletes():
    gate = RecordingGate()
    orch, be, _ = make(gate=gate)
    orch.create(body())
    gate.calls.clear()
    orch.destroy(IID)
    assert gate.calls == [("delete", IID)]


def test_a_disconnect_error_is_a_sweep_error_and_a_repeat_finishes_the_job():
    gate = RecordingGate()
    be = FakeBackend()
    orch, _, _ = make(gate=gate, backend=be)
    orch.create(body())
    be.fail_on = ("disconnect_edge", "-net")
    with pytest.raises(BackendError):
        orch.destroy(IID)
    assert orch.get(IID).state is S.STOPPING and be.networks  # nothing was claimed done
    be.fail_on = None
    assert orch.destroy(IID).state is S.DESTROYED
    assert not (be.containers or be.networks or be.volumes) and not be.edge_attached


def test_a_gate_that_cannot_delete_keeps_the_instance_stopping_and_a_repeat_deletes():
    gate = RecordingGate()
    orch, be, _ = make(gate=gate)
    orch.create(body())
    gate.fail = True
    with pytest.raises(BackendError):
        orch.destroy(IID)
    assert orch.get(IID).state is S.STOPPING
    gate.fail = False
    assert orch.destroy(IID).state is S.DESTROYED
    assert gate.calls[-1] == ("delete", IID)


def test_a_failed_build_with_the_edge_attached_removes_the_edge_attachment_and_the_gate_record():
    gate = RecordingGate()
    be = FakeBackend()
    orch, _, _ = make(gate=gate, backend=be, retries=0)

    real_advance = orch._advance

    def advance(rec, to, reason, error_code=None):
        if to is S.READY:
            raise RuntimeError("boom")  # after connect and push: the catch-all failure path must clean both
        return real_advance(rec, to, reason, error_code)

    orch._advance = advance
    rec = orch.create(body())
    assert rec.state is S.FAILED
    assert not (be.containers or be.networks or be.volumes) and not be.edge_attached
    assert gate.calls[-1] == ("delete", IID) and not rec.in_gate


# ---------------------------------------------------------------- reconciler


def test_the_reconciler_cleans_an_edge_attachment_of_an_instance_that_vanished():
    be = FakeBackend()
    old, _, _ = make(backend=be, gate=RecordingGate())
    old.create(body())
    net = f"vm-{IID.lower()}-e1-net"
    be.containers.clear()  # every container is gone (a crash, a manual removal), the network and the edge attachment remain
    be.volumes.clear()
    assert be.edge_attached == {net}
    new, _, _ = make(backend=be, gate=RecordingGate(), desired=FakeDesiredState({IID}))
    result = new.reconcile()
    assert not result.errors and not be.networks and not be.edge_attached
    assert ("disconnect_edge", net) in be.calls


def test_a_restart_pushes_a_full_sync_closed_with_the_owner_from_the_label_and_only_again_when_something_was_repaired():
    be = FakeBackend()
    old, _, _ = make(backend=be, gate=RecordingGate())
    old.create(body())
    gate = RecordingGate()
    new, _, _ = make(backend=be, gate=gate, desired=FakeDesiredState({IID}), reconcile_gate=True)
    new.reconcile()
    epoch = new.get(IID).access_epoch
    assert epoch > ADOPTED_TRANSITION_BASE  # above anything the gate holds: the gate does not refuse the sync as a lower epoch (review finding C1)
    assert gate.calls == [("sync", ((IID, 1, "closed", epoch, OWNER),))]  # a record adopted as ready is pushed closed, never open
    new.reconcile()
    assert len(gate.calls) == 1  # nothing was repaired: no second push
    # an orphan appears and is repaired: the pass pushes again
    other = "i-BBBBBBBBBBBBBBBB"
    from test_reconcile import half_built

    half_built(be, iid=other)
    new.reconcile()
    assert len(gate.calls) == 2 and gate.calls[1][1] == ((IID, 1, "closed", epoch, OWNER),)


def test_a_sync_that_fails_is_logged_and_retried_on_the_next_pass(capsys):
    be = FakeBackend()
    old, _, _ = make(backend=be, gate=RecordingGate())
    old.create(body())
    gate = RecordingGate()
    gate.fail = True
    new, _, _ = make(backend=be, gate=gate, desired=FakeDesiredState({IID}))
    new.reconcile()  # does not raise
    assert gate.calls == [] and "gate sync failed: GateError" in capsys.readouterr().err
    gate.fail = False
    new.reconcile()
    assert [c[0] for c in gate.calls] == ["sync"]


def test_an_adopted_instance_without_a_valid_owner_label_is_left_out_of_the_sync_not_sent_wrong(capsys):
    be = FakeBackend()
    old, _, _ = make(backend=be, gate=RecordingGate())
    old.create(body())
    for spec in list(be.containers.values()) + list(be.networks.values()) + list(be.volumes.values()):
        spec.labels["vm.owner"] = "not-hex"
    gate = RecordingGate()
    new, _, _ = make(backend=be, gate=gate, desired=FakeDesiredState({IID}))
    new.reconcile()
    assert gate.calls == [("sync", ())] and "without a valid owner" in capsys.readouterr().err
