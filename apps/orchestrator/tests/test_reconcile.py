"""Story 3.5: the reconciler (FR-INS-05, spike S-13). Every row of the I/O matrix of the story plan has a test here, on the fake backend
and a fake clock. A restart is a second engine on the same backend (the fake keeps Docker's objects) with empty records."""
from __future__ import annotations

import dataclasses
import json
import os
import time
from datetime import timedelta
from types import SimpleNamespace
import pytest
from support import FLAG_A, IID, SEED, allowlist, body, template
from test_engine_lifecycle import FakeNow, Ticks, reset_body

from vulnmart_orchestrator.backend import BackendError, FakeBackend, Seen
from vulnmart_orchestrator.builder import build_plan, parse_create
from vulnmart_orchestrator.engine import ADOPTED_TRANSITION_BASE, Orchestrator
from vulnmart_orchestrator.lifecycle import FakeSettingsPort, Settings
from vulnmart_orchestrator.reconcile import AllWantedDesiredState, FakeDesiredState, TombstoneStore
from vulnmart_orchestrator.service import ReconcileLoop
from vulnmart_orchestrator.states import Busy, ErrorCode, InstanceExists, InstanceState, InvalidState

S = InstanceState
IID2 = "i-BBBBBBBBBBBBBBBB"


def engine(be, *, desired=None, now=None, tombstones=None, gate=True, settings=None):
    seen: list = []
    ticks = Ticks()
    now = now or FakeNow()
    orch = Orchestrator(
        be, {"shop-v0": template()}, allowlist(), clock=ticks, sleep=ticks.sleep, health_timeout_s=10, poll_s=1, now=now,
        on_transition=seen.append, tombstones=tombstones, desired=desired, reconcile_gate=gate, settings=settings,
    )
    return orch, seen, now


def everything_gone(be: FakeBackend) -> bool:
    return not (be.containers or be.networks or be.volumes)


def half_built(be: FakeBackend, iid: str = IID, epoch: int = 1) -> None:
    """What a process killed during a create leaves: the network, volumes and containers exist, nothing started."""
    plan = build_plan(template(), parse_create(body(iid=iid, epoch=epoch)), allowlist())
    be.create_network(plan.network)
    for v in plan.volumes:
        be.create_volume(v)
    for c in plan.containers:
        be.create_container(c)


def ready_instance(be: FakeBackend, iid: str = IID):
    """An instance built by an engine that is then 'killed': its objects stay in the backend, its records are lost."""
    old, _, now = engine(be, gate=False)
    old.create(body(iid=iid))
    assert old.get(iid).state is S.READY
    return now


# ---------------------------------------------------------------- the I/O matrix


def test_killed_mid_provision_every_object_is_removed_and_the_id_is_failed_with_one_report():
    be = FakeBackend()
    half_built(be)
    new, seen, _ = engine(be, desired=FakeDesiredState({IID}))
    result = new.reconcile()
    assert everything_gone(be) and result.failed == [IID]
    rec = new.get(IID)
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED
    first = new.get(IID).transition_offset + 1
    assert first > ADOPTED_TRANSITION_BASE
    assert [(t.instance_id, t.from_state, t.to_state, t.transition) for t in seen] == [(IID, None, S.FAILED, first)]
    new.reconcile()  # a second pass finds nothing and reports nothing more
    assert len(seen) == 1


def test_a_complete_unknown_instance_is_adopted_ready_with_closed_access_and_high_numbers_and_the_reaper_ends_it_at_its_expiry():
    be = FakeBackend()
    ready_instance(be)
    new, seen, now = engine(be, desired=FakeDesiredState({IID}), settings=FakeSettingsPort(Settings(default_idle_minutes=1440)))
    assert new.get(IID) is None
    result = new.reconcile()
    rec = new.get(IID)
    assert result.adopted == [IID] and rec.state is S.READY and rec.health == "healthy"
    assert rec.access == "closed" and rec.access_epoch > ADOPTED_TRANSITION_BASE and rec.epoch == 1 and rec.template_id == "shop-v0"
    assert rec.memory_mb == new.host_status()["used_memory_mb"] > 0
    first = rec.transition_offset + 1
    assert first > ADOPTED_TRANSITION_BASE
    assert [(t.from_state, t.to_state, t.transition) for t in seen] == [(None, S.READY, first)]
    new.record_activity(IID)  # the next transition continues the high numbers
    assert seen[-1].transition == first + 1
    assert be.containers and be.networks and be.volumes  # nothing was removed
    # the deadline is the `vm.expires` label (120 minutes after the create), not the default
    now.advance(119)
    assert new.reap_due() == []
    now.advance(2)
    assert new.reap_due() == [IID] and new.get(IID).state is S.DESTROYED and everything_gone(be)


def test_an_adopted_instance_is_ended_after_the_idle_limit_from_the_settings():
    be = FakeBackend()
    ready_instance(be)
    new, _, now = engine(be, desired=FakeDesiredState({IID}), settings=FakeSettingsPort(Settings(default_idle_minutes=10)))
    new.reconcile()
    now.advance(11)
    assert new.reap_due() == [IID] and new.get(IID).state is S.DESTROYED


def test_an_orphan_the_platform_does_not_list_is_destroyed_through_the_normal_destroy_path():
    be = FakeBackend()
    ready_instance(be)
    new, seen, _ = engine(be, desired=FakeDesiredState(set()))
    result = new.reconcile()
    assert result.destroyed == [IID] and new.get(IID).state is S.DESTROYED and everything_gone(be)
    assert [t.to_state for t in seen] == [S.READY, S.STOPPING, S.DESTROYED]
    assert new.tombstones.has(IID)


def test_a_known_instance_the_platform_stopped_listing_is_destroyed_too():
    be = FakeBackend()
    port = FakeDesiredState({IID})
    orch, _, _ = engine(be, desired=port, gate=False)
    orch.create(body())
    orch.reconcile()
    assert orch.get(IID).state is S.READY
    port.ids = frozenset()
    orch.reconcile()
    assert orch.get(IID).state is S.DESTROYED and everything_gone(be)


@pytest.mark.parametrize("port", [FakeDesiredState(None), FakeDesiredState(error=RuntimeError("secret detail"))])
def test_safe_mode_destroys_nothing_for_being_unwanted_and_refuses_creates_and_resets(port, capsys):
    be = FakeBackend()
    ready_instance(be)
    known, _, _ = engine(be, desired=port, gate=False)
    known.records.clear()
    new, seen, _ = engine(be, desired=port)
    result = new.reconcile()
    assert result.safe_mode and result.adopted == [IID] and result.destroyed == []
    assert new.get(IID).state is S.READY and not everything_gone(be)
    with pytest.raises(Busy):
        new.accept_create(body(iid=IID2))
    with pytest.raises(Busy):
        new.accept_reset(IID, reset_body())
    assert "secret detail" not in capsys.readouterr().err  # logged by class name only
    # the list comes back: the next pass works, the orphan rule applies again and creates are accepted
    if isinstance(port, FakeDesiredState):
        port.ids, port.error = frozenset({IID}), None
    new.reconcile()
    assert new.accept_create(body(iid=IID2)).changed


def test_safe_mode_still_removes_incomplete_leftovers():
    be = FakeBackend()
    half_built(be)
    new, _, _ = engine(be, desired=FakeDesiredState(None))
    assert new.reconcile().failed == [IID] and everything_gone(be)


def test_objects_of_an_old_epoch_of_a_live_record_are_removed():
    be = FakeBackend()
    orch, _, _ = engine(be, desired=FakeDesiredState({IID}), gate=False)
    orch.create(body())
    orch.reset(IID, reset_body(2))
    assert {o.labels["vm.epoch"] for o in (*be.containers.values(), *be.networks.values(), *be.volumes.values())} == {"2"}
    half_built(be, IID, epoch=1)  # a leftover of epoch 1 comes back
    assert any(o.labels["vm.epoch"] == "1" for o in be.containers.values())
    result = orch.reconcile()
    assert result.swept == [f"{IID}@1"] and orch.get(IID).state is S.READY
    assert {o.labels["vm.epoch"] for o in (*be.containers.values(), *be.networks.values(), *be.volumes.values())} == {"2"}


def test_a_live_record_with_no_object_in_docker_ends_destroyed_with_a_report():
    be = FakeBackend()
    orch, seen, _ = engine(be, desired=FakeDesiredState({IID}), gate=False)
    orch.create(body())
    be.containers.clear(), be.networks.clear(), be.volumes.clear()  # for example a VM reboot lost everything
    orch.reconcile()
    assert orch.get(IID).state is S.DESTROYED and seen[-1].to_state is S.DESTROYED and orch.tombstones.has(IID)


def test_an_empty_network_or_volume_with_no_record_is_removed():
    be = FakeBackend()
    plan = build_plan(template(), parse_create(body(iid=IID2)), allowlist())
    be.create_network(plan.network)
    be.create_volume(plan.volumes[0])
    new, seen, _ = engine(be, desired=FakeDesiredState(set()))
    new.reconcile()
    assert everything_gone(be) and new.get(IID2) is None and seen == []


def test_a_destroyed_id_stays_refused_after_a_restart_and_the_file_holds_nothing_secret(tmp_path):
    be = FakeBackend()
    first, _, _ = engine(be, tombstones=TombstoneStore(tmp_path), gate=False)
    first.create(body())
    first.destroy(IID)
    assert everything_gone(be)
    restarted, _, _ = engine(be, tombstones=TombstoneStore(tmp_path))
    restarted.reconcile()
    with pytest.raises(InstanceExists):
        restarted.accept_create(body())
    text = (tmp_path / "tombstones.jsonl").read_text(encoding="utf-8")
    assert json.loads(text) == {"instance_id": IID, "epoch": 1, "at": json.loads(text)["at"]}
    for secret in (FLAG_A, SEED):
        assert secret not in text


def test_the_tombstone_file_survives_a_torn_line(tmp_path):
    store = TombstoneStore(tmp_path)
    store.add(IID, 1, "2026-10-16T10:00:00Z")
    with open(tmp_path / "tombstones.jsonl", "ab") as f:
        f.write(b'{"instance_id":"i-BBB')  # a write cut short
    again = TombstoneStore(tmp_path)
    assert again.has(IID) and not again.has(IID2) and again.ids() == {IID}


def test_an_instance_whose_build_is_running_is_not_touched():
    be = FakeBackend()
    orch, seen, _ = engine(be, desired=FakeDesiredState(set()), gate=False)
    accepted = orch.accept_create(body())  # `requested`: the worker has not started yet
    half_built(be)  # objects exist as if the worker were busy
    objects = (set(be.containers), set(be.networks), set(be.volumes))
    result = orch.reconcile()
    assert result.skipped == [IID] and (set(be.containers), set(be.networks), set(be.volumes)) == objects
    assert orch.get(IID).state is S.REQUESTED
    for state in (S.PROVISIONING, S.STARTING):
        accepted.record.state = state
        orch.reconcile()
        assert set(be.containers) == objects[0]
    accepted.record.state = S.READY
    accepted.record.destroying = True  # a destroy worker is running
    orch.reconcile()
    assert set(be.containers) == objects[0]


def test_one_instance_that_cannot_be_repaired_does_not_stop_the_others():
    be = FakeBackend()
    half_built(be, IID)
    half_built(be, IID2)
    be.fail_on = ("remove_container", IID.lower())
    new, _, _ = engine(be, desired=FakeDesiredState({IID, IID2}))
    result = new.reconcile()
    assert [e.split(":")[0] for e in result.errors] == [IID] and result.failed == [IID2]
    assert all(IID2.lower() not in n for n in be.containers) and any(IID.lower() in n for n in be.containers)
    be.fail_on = None
    new.reconcile()  # the next pass finishes it
    assert everything_gone(be)


# ---------------------------------------------------------------- the gate and the other rules


def test_creates_and_resets_are_busy_until_the_first_pass_has_worked():
    be = FakeBackend()
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    with pytest.raises(Busy):
        new.accept_create(body())
    new.reconcile()
    assert new.accept_create(body()).changed


def test_a_pass_that_cannot_read_docker_raises_and_leaves_the_engine_busy():
    class Broken(FakeBackend):
        def scan(self):
            raise BackendError("docker is down")

    new, _, _ = engine(Broken(), desired=FakeDesiredState({IID}))
    with pytest.raises(BackendError):
        new.reconcile()
    with pytest.raises(Busy):
        new.accept_create(body())


def test_an_incomplete_unknown_instance_is_not_adopted_when_a_component_is_not_running():
    be = FakeBackend()
    ready_instance(be)
    victim = next(n for n in be.containers if n.endswith("-shop"))
    be._started.discard(victim)  # created but not running
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    assert new.reconcile().failed == [IID] and everything_gone(be)


def test_an_unknown_template_label_is_left_alone():
    be = FakeBackend()
    ready_instance(be)
    new, _, _ = engine(be, desired=FakeDesiredState(set()))
    new.templates = {}
    result = new.reconcile()
    assert result.skipped == [IID] and not everything_gone(be) and new.get(IID) is None


def test_the_fake_backend_scan_lists_only_instance_objects():
    be = FakeBackend()
    ready_instance(be)
    seen = be.scan()
    assert {s.kind for s in seen} == {"container", "network", "volume"} and all(isinstance(s, Seen) for s in seen)
    assert {s.status for s in seen if s.kind == "container"} == {"running"}
    assert all(s.labels["vm.kind"] == "inst" for s in seen)


def test_a_pass_over_a_healthy_host_changes_nothing():
    be = FakeBackend()
    orch, seen, _ = engine(be, desired=FakeDesiredState({IID, IID2}), gate=False)
    orch.create(body())
    orch.create(body(iid=IID2))
    before = len(seen)
    result = orch.reconcile()
    assert not (result.adopted or result.failed or result.destroyed or result.swept or result.errors) and len(seen) == before


# ---------------------------------------------------------------- review round: gate, states, races, files


def capture_numbers(be, now_minutes):
    new, seen, now = engine(be, desired=FakeDesiredState({IID}))
    now.advance(now_minutes)
    new.reconcile()
    return seen[0].transition


def test_adopted_numbers_grow_across_restarts():
    be = FakeBackend()
    ready_instance(be)
    first = capture_numbers(be, 0)
    second = capture_numbers(be, 5)  # a second restart, later
    assert second > first >= ADOPTED_TRANSITION_BASE and second - first == 300


def test_the_gate_stays_closed_while_a_pass_has_an_error_and_opens_when_it_is_clean():
    be = FakeBackend()
    half_built(be)
    be.fail_on = ("remove_container", IID.lower())
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    assert new.reconcile().errors
    with pytest.raises(Busy):
        new.accept_create(body(iid=IID2))
    be.fail_on = None
    assert not new.reconcile().errors
    assert new.accept_create(body(iid=IID2)).changed


def test_the_loop_retries_every_few_seconds_while_closed_and_survives_an_exception(capsys):
    class FlakyScan(FakeBackend):
        failures = 2

        def scan(self):
            if self.failures:
                self.failures -= 1
                raise BackendError("docker is down")
            return super().scan()

    be = FlakyScan()
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    loop = ReconcileLoop(new, retry_s=0.01)
    assert loop.first_pass() is False
    with pytest.raises(Busy):
        new.accept_create(body())
    loop.start()
    try:
        end = time.monotonic() + 5
        while True:
            try:
                new.accept_create(body())
                break
            except Busy:
                assert time.monotonic() < end, "the loop never opened the engine"
                time.sleep(0.01)
    finally:
        loop.stop()
    err = capsys.readouterr().err
    assert err.count("reconcile-failed") == 2 and not loop._thread.is_alive()
    assert loop.retry_s == 0.01 and ReconcileLoop.RETRY_S == 5.0


def test_a_first_pass_with_an_instance_error_is_not_a_success():
    be = FakeBackend()
    half_built(be)
    be.fail_on = ("remove_container", IID.lower())
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    assert ReconcileLoop(new).first_pass() is False and new.gate_closed


def test_an_adopted_instance_cannot_be_reset():
    be = FakeBackend()
    ready_instance(be)
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    new.reconcile()
    with pytest.raises(InvalidState, match="adopted instance cannot be reset"):
        new.accept_reset(IID, reset_body())


def test_a_repeat_of_an_accepted_create_and_reset_is_answered_in_safe_mode():
    be = FakeBackend()
    orch, _, _ = engine(be, desired=FakeDesiredState({IID}), gate=False)
    orch.create(body())
    orch.reconciler.port = FakeDesiredState(None)
    assert orch.reconcile().safe_mode
    again = orch.accept_create(body())
    assert not again.changed and again.work is None
    with pytest.raises(Busy):
        orch.accept_create(body(iid=IID2))
    other, _, _ = engine(FakeBackend(), desired=FakeDesiredState({IID}), gate=False)
    other.create(body())
    other.reset(IID, reset_body())
    other.reconciler.port = FakeDesiredState(None)
    assert other.reconcile().safe_mode
    assert not other.accept_reset(IID, reset_body()).changed
    with pytest.raises(Busy):
        other.accept_reset(IID, reset_body(3))


def set_label(be, key, value):
    for o in (*be.containers.values(), *be.networks.values(), *be.volumes.values()):
        if value is None:
            o.labels.pop(key, None)
        else:
            o.labels[key] = value


@pytest.mark.parametrize("value", [None, "not a time", ""])
def test_a_missing_or_unreadable_expiry_ends_the_adopted_instance_at_once_and_is_logged(value, capsys):
    be = FakeBackend()
    ready_instance(be)
    set_label(be, "vm.expires", value)
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    new.reconcile()
    assert new.get(IID).expires_dt == new._now()
    assert "reconcile-expiry-label" in capsys.readouterr().err
    assert new.reap_due() == [IID] and new.get(IID).state is S.DESTROYED


def test_an_expiry_far_in_the_future_is_cut_to_the_ceiling():
    be = FakeBackend()
    ready_instance(be)
    set_label(be, "vm.expires", "2099-01-01T00:00:00Z")
    new, _, now = engine(be, desired=FakeDesiredState({IID}))
    new.reconcile()
    assert new.get(IID).expires_dt == now() + timedelta(minutes=Settings().max_minutes_ceiling)


@pytest.mark.parametrize("status,health", [("restarting", None), ("paused", None), ("removing", None), ("running", "starting")])
def test_a_transient_container_state_leaves_an_unknown_instance_untouched(status, health):
    be = FakeBackend()
    ready_instance(be)
    victim = next(n for n in be.containers if n.endswith("-shop"))
    be.statuses[victim], be.healths[victim] = status, health
    new, seen, _ = engine(be, desired=FakeDesiredState(set()))
    result = new.reconcile()
    assert result.skipped == [IID] and new.get(IID) is None and seen == [] and not everything_gone(be)


@pytest.mark.parametrize("status,health", [("exited", None), ("dead", None), ("created", None), ("running", "unhealthy")])
def test_a_dead_or_unhealthy_component_makes_an_unknown_instance_incomplete(status, health):
    be = FakeBackend()
    ready_instance(be)
    victim = next(n for n in be.containers if n.endswith("-shop"))
    be.statuses[victim], be.healths[victim] = status, health
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    assert new.reconcile().failed == [IID] and everything_gone(be)


def test_a_duplicated_component_makes_an_unknown_instance_incomplete():
    be = FakeBackend()
    ready_instance(be)
    shop = next(c for n, c in be.containers.items() if n.endswith("-shop"))
    be.create_container(dataclasses.replace(shop, name=shop.name + "-twin"))
    be._started.add(shop.name + "-twin")
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    assert new.reconcile().failed == [IID]


def test_healthy_and_no_healthcheck_components_are_adopted():
    be = FakeBackend()
    ready_instance(be)
    for n, c in be.containers.items():
        be.healths[n] = "healthy" if c.healthcheck else None
    new, _, _ = engine(be, desired=FakeDesiredState({IID}))
    assert new.reconcile().adopted == [IID]


def test_a_live_record_with_only_some_of_its_objects_is_failed_and_swept_with_one_report():
    be = FakeBackend()
    orch, seen, _ = engine(be, desired=FakeDesiredState({IID}), gate=False)
    orch.create(body())
    mark = len(seen)
    del be.containers[next(n for n in be.containers if n.endswith("-shop"))]  # a component is gone
    result = orch.reconcile()
    rec = orch.get(IID)
    assert result.failed == [IID] and rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED and everything_gone(be)
    assert [t.to_state for t in seen[mark:]] == [S.FAILED]


def test_a_live_record_with_a_restarting_component_is_left_alone():
    be = FakeBackend()
    orch, seen, _ = engine(be, desired=FakeDesiredState({IID}), gate=False)
    orch.create(body())
    mark = len(seen)
    be.statuses[next(n for n in be.containers if n.endswith("-shop"))] = "restarting"
    orch.reconcile()
    assert orch.get(IID).state is S.READY and len(seen) == mark and not everything_gone(be)


def test_a_create_accepted_after_the_records_were_read_keeps_its_objects():
    be = FakeBackend()
    orch, _, _ = engine(be, desired=FakeDesiredState(set()), gate=False)
    plan = build_plan(template(), parse_create(body(iid=IID2)), allowlist())
    be.create_network(plan.network)  # an unknown network with no container: it would be removed silently
    real_has = orch.tombstones.has

    def has(iid):  # called by the pass after it saw no record and before it removes anything: a create arrives now
        orch.tombstones.has = real_has
        orch.accept_create(body(iid=iid))
        return real_has(iid)

    orch.tombstones.has = has
    result = orch.reconcile()
    assert result.skipped == [IID2] and plan.network.name in be.networks and orch.get(IID2).state is S.REQUESTED


def test_a_live_record_whose_destroy_is_running_keeps_its_leftovers_for_the_next_pass():
    be = FakeBackend()
    orch, _, _ = engine(be, desired=FakeDesiredState({IID}), gate=False)
    orch.create(body())
    half_built(be, IID, epoch=3)  # an old-looking leftover of another epoch
    orch.get(IID).destroying = True
    assert orch.reconcile().skipped == [IID]
    assert any(o.labels["vm.epoch"] == "3" for o in be.containers.values())


def test_a_destroy_that_cannot_be_started_clears_its_flag_and_the_pass_goes_on():
    be = FakeBackend()
    ready_instance(be)
    new, _, _ = engine(be, desired=FakeDesiredState(set()))

    def broken(work):
        raise RuntimeError("no thread")

    result = new.reconcile(execute=broken)
    rec = new.get(IID)
    assert result.errors and rec.destroying is False and rec.state is S.STOPPING
    new.reconcile()  # the reaper or the next pass finishes the removal
    assert new.get(IID).state in (S.STOPPING, S.DESTROYED)


@pytest.mark.parametrize("value", [0, -1, 3601, "60"])
def test_the_reconcile_interval_is_validated(value):
    with pytest.raises(ValueError):
        Settings(reconcile_interval_s=value)
    assert Settings().reconcile_interval_s == 60.0 and Settings(reconcile_interval_s=3600)


def test_the_production_desired_state_port_never_destroys_anything():
    be = FakeBackend()
    ready_instance(be)
    known, _, _ = engine(be, gate=False)  # default port: AllWantedDesiredState
    assert isinstance(known.reconciler.port, AllWantedDesiredState)
    known.create(body(iid=IID2))
    result = known.reconcile()
    assert result.adopted == [IID] and result.destroyed == [] and not result.safe_mode
    assert known.get(IID).state is S.READY and known.get(IID2).state is S.READY


def test_the_tombstone_store_falls_back_to_memory_when_its_directory_is_unusable(tmp_path, capsys):
    blocker = tmp_path / "state"
    blocker.write_text("a file, not a directory", encoding="utf-8")
    store = TombstoneStore(blocker)
    store.add(IID, 1, "2026-10-16T10:00:00Z")
    assert store.has(IID)
    assert "tombstones-unavailable" in capsys.readouterr().err


def test_a_garbage_line_in_the_tombstone_file_is_skipped(tmp_path):
    (tmp_path / "tombstones.jsonl").write_bytes(b'not json\n[1]\n{"instance_id":"x","epoch":1,"at":"t"}\n{"instance_id":"' + IID.encode() + b'","epoch":2,"at":"t"}\n')
    assert TombstoneStore(tmp_path).ids() == {IID}


def test_a_short_write_is_continued(tmp_path, monkeypatch):
    real = os.write
    monkeypatch.setattr(os, "write", lambda fd, data: real(fd, bytes(data)[:3]))
    store = TombstoneStore(tmp_path)
    store.add(IID, 4, "2026-10-16T10:00:00Z")
    assert json.loads((tmp_path / "tombstones.jsonl").read_text(encoding="utf-8"))["epoch"] == 4


def test_a_tombstone_that_cannot_be_written_still_refuses_the_id_in_memory(tmp_path, capsys):
    store = TombstoneStore(tmp_path)
    store._path = tmp_path / "missing-dir" / "tombstones.jsonl"  # every write fails now
    be = FakeBackend()
    orch, _, _ = engine(be, tombstones=store, gate=False)
    orch.create(body())
    orch.destroy(IID)  # does not raise
    assert orch.get(IID).state is S.DESTROYED and store.has(IID)
    fresh, _, _ = engine(be, tombstones=store, gate=False)
    with pytest.raises(InstanceExists):
        fresh.accept_create(body())
    assert "tombstone write failed" in capsys.readouterr().err


class StubList:
    def __init__(self, log, name, items):
        self.log, self.name, self.items = log, name, items

    def list(self, **kw):
        self.log.append((self.name, kw.get("filters")))
        return self.items


def test_sdk_scan_reads_labels_status_and_health_and_lists_containers_last():
    from vulnmart_orchestrator.backend import SdkBackend

    log: list = []
    inst = {"vm.kind": "inst", "vm.instance": IID, "vm.epoch": "1", "vm.component": "shop"}
    summary = SimpleNamespace(name="c-text", labels=inst, id="id1", attrs={"State": "running"})  # the list call only gives a text
    full = SimpleNamespace(name="c-full", labels=inst, id="id2", attrs={"State": {"Status": "running", "Health": {"Status": "unhealthy"}}})
    plain = SimpleNamespace(name="c-plain", labels=inst, id="id3", attrs={"State": {"Status": "exited"}})
    api = SimpleNamespace(inspect_container=lambda cid: {"State": {"Status": "running", "Health": {"Status": "healthy"}}})
    client = SimpleNamespace(
        networks=StubList(log, "networks", [SimpleNamespace(name="n", attrs={"Labels": inst})]),
        volumes=StubList(log, "volumes", [SimpleNamespace(name="v", attrs={"Labels": inst})]),
        containers=StubList(log, "containers", [summary, full, plain]), api=api,
    )
    seen = SdkBackend(client).scan()
    assert [n for n, _ in log] == ["networks", "volumes", "containers"]
    assert all(f == {"label": ["vm.kind=inst"]} for _, f in log)
    by = {s.name: s for s in seen}
    assert by["n"].kind == "network" and by["v"].kind == "volume" and by["n"].labels == inst
    assert (by["c-text"].status, by["c-text"].health) == ("running", "healthy")
    assert (by["c-full"].status, by["c-full"].health) == ("running", "unhealthy")
    assert (by["c-plain"].status, by["c-plain"].health) == ("exited", None)
