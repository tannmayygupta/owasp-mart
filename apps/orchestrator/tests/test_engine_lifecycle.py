"""Story 3.4: reset with new flags (FR-INS-03) and teardown at the total limit or after inactivity (FR-INS-04), on the fake backend and a
fake clock. Every row of the I/O matrix of the story plan has a test here."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone

import pytest
from support import DECOY, EVENT_KEY, FLAG_A, FLAG_B, IID, SEED, allowlist, body, plan_memory_mb, template

from vulnmart_orchestrator.backend import FakeBackend
from vulnmart_orchestrator.builder import parse_reset
from vulnmart_orchestrator.engine import Orchestrator
from vulnmart_orchestrator.lifecycle import FakeSettingsPort, Settings
from vulnmart_orchestrator.states import (
    ErrorCode, InstanceNotFound, InstanceState, InvalidState, RequestMismatch, StaleEpoch,
)

S = InstanceState
NEW_FLAG = "VM{" + "D" * 24 + "}"
NEW_SEED = "RESET-SEED-NOT-REAL-" + "D" * 24
NEW_KEY = "RESET-EVENT-KEY-NOT-REAL-" + "D" * 24


class FakeNow:
    """The clock under test: a timezone-aware time that only moves when the test says so."""

    def __init__(self) -> None:
        self.t = datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.t

    def advance(self, minutes: float) -> None:
        self.t += timedelta(minutes=minutes)


class Ticks:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


def make(backend=None, settings=None):
    now, ticks, seen = FakeNow(), Ticks(), []
    be = backend or FakeBackend()
    orch = Orchestrator(
        be, {"shop-v0": template()}, allowlist(), clock=ticks, sleep=ticks.sleep, health_timeout_s=10, poll_s=1, now=now,
        on_transition=seen.append, settings=settings,
    )
    return orch, be, now, seen


def reset_body(epoch: int = 2, flag: str = NEW_FLAG) -> dict:
    return {
        "epoch": epoch,
        "flags": [{"challenge_key": "C01", "flag": flag}, {"challenge_key": "C02", "flag": FLAG_B}],
        "decoys": [{"challenge_key": "C01", "index": 0, "value": DECOY}],
        "flag_digests": [{"challenge_key": "C01", "sha256": hashlib.sha256(flag.encode()).hexdigest()},
                         {"challenge_key": "C02", "sha256": hashlib.sha256(FLAG_B.encode()).hexdigest()}],
        "event_key": NEW_KEY, "seed": NEW_SEED,
    }


def limits(idle: int = 60, maximum: int = 240) -> dict:
    return {"memory_mb": 256, "cpu_limit": 1.5, "pids_limit": 512, "idle_minutes": idle, "max_minutes": maximum}


def epochs_present(be: FakeBackend) -> set[str]:
    objs = [*be.containers.values(), *be.networks.values(), *be.volumes.values()]
    return {o.labels["vm.epoch"] for o in objs}


# ---------------------------------------------------------------- reset (FR-INS-03)

def test_reset_from_ready_gives_a_new_epoch_old_objects_gone_new_flags_on_stdin_only():
    orch, be, _, seen = make()
    rec = orch.create(body())
    used = orch.host_status()["used_memory_mb"]
    assert used == plan_memory_mb() and epochs_present(be) == {"1"}
    mark = len(be.calls)

    done = orch.reset(IID, reset_body())
    assert done is rec and rec.state is S.READY and rec.epoch == 2 and rec.health == "healthy"
    assert epochs_present(be) == {"2"}  # every object of epoch 1 is gone: containers, the network and the volumes
    assert not [n for n in be.volumes if n.endswith("-e1")] and len(be.volumes) == 4
    # the old epoch is removed before any object of the new epoch exists
    after = be.calls[mark:]
    last_removal = max(i for i, (o, n) in enumerate(after) if o.startswith("remove_") and "-e1" in n)
    first_creation = min(i for i, (o, n) in enumerate(after) if o.startswith("create_") and "-e2" in n)
    assert last_removal < first_creation
    # the new flags reach the new injector on standard input, once, and are in no setting or label of any object
    injector = next(n for n in be.stdin if "-e2-" in n and n.endswith("-injector"))
    doc = json.loads(be.stdin[injector][0])
    assert len(be.stdin[injector]) == 1 and doc["epoch"] == 2 and doc["seed"] == NEW_SEED
    assert [f["flag"] for f in doc["flags"]][0] == NEW_FLAG
    for spec in (*be.containers.values(), *be.networks.values(), *be.volumes.values()):
        text = json.dumps(getattr(spec, "env", {})) + json.dumps(spec.labels)
        assert NEW_FLAG not in text and NEW_SEED not in text and NEW_KEY not in text and FLAG_A not in text
    # the sidecar of the new epoch got the new event key, not the old one
    sidecar = next(n for n in be.stdin if "-e2-" in n and n.endswith("-sidecar"))
    assert json.loads(be.stdin[sidecar][0])["event_key"] == NEW_KEY and EVENT_KEY not in be.stdin[sidecar][0].decode()
    # memory is unchanged (no capacity check, the instance keeps what it holds) and the view shows no secret
    assert orch.host_status()["used_memory_mb"] == used
    assert NEW_FLAG not in json.dumps(orch.view(IID)) and orch.view(IID)["epoch"] == 2
    # numbering restarts at 1 in the new epoch; the first report leaves the old epoch's ready state
    assert [(t.transition, t.to_state) for t in rec.transitions] == [(1, S.RESETTING), (2, S.PROVISIONING), (3, S.STARTING), (4, S.READY)]
    new_reports = [t for t in seen if t.epoch == 2]
    assert [t.transition for t in new_reports] == [1, 2, 3, 4] and new_reports[0].from_state is S.READY


def test_reset_is_accepted_at_once_and_the_answer_shows_resetting_with_the_new_epoch():
    orch, _, _, _ = make()
    orch.create(body())
    accepted = orch.accept_reset(IID, reset_body())
    assert accepted.changed and accepted.view["state"] == "resetting" and accepted.view["epoch"] == 2 and accepted.work is not None
    accepted.work()
    assert orch.get(IID).state is S.READY


@pytest.mark.parametrize("before", [S.READY, S.ACTIVE, S.IDLE])
def test_reset_from_ready_active_and_idle(before):
    orch, _, _, _ = make()
    orch.create(body())
    if before is not S.READY:
        orch.force_activity(IID, "active")
    if before is S.IDLE:
        orch.force_activity(IID, "idle")
    assert orch.get(IID).state is before
    assert orch.reset(IID, reset_body()).state is S.READY


def test_the_same_reset_again_is_a_repeat_with_no_new_work():
    orch, be, _, _ = make()
    orch.create(body())
    orch.reset(IID, reset_body())
    calls = len(be.calls)
    again = orch.accept_reset(IID, reset_body())
    assert again.changed is False and again.work is None and again.view["epoch"] == 2 and len(be.calls) == calls


def test_the_same_new_epoch_with_another_body_is_a_mismatch():
    orch, _, _, _ = make()
    orch.create(body())
    orch.reset(IID, reset_body())
    with pytest.raises(RequestMismatch):
        orch.accept_reset(IID, reset_body(flag="VM{" + "E" * 24 + "}"))


def test_a_skipped_epoch_is_stale_and_nothing_changes():
    orch, be, _, seen = make()
    orch.create(body())
    count, calls = len(seen), len(be.calls)
    with pytest.raises(StaleEpoch):
        orch.accept_reset(IID, reset_body(epoch=3))
    assert orch.get(IID).state is S.READY and orch.get(IID).epoch == 1 and len(seen) == count and len(be.calls) == calls


def test_a_reset_in_another_state_is_refused_and_nothing_changes():
    orch, _, _, _ = make()
    accepted = orch.accept_create(body())  # requested, no work run
    with pytest.raises(InvalidState):
        orch.accept_reset(IID, reset_body())
    accepted.work()
    orch.accept_destroy(IID)  # stopping
    with pytest.raises(InvalidState):
        orch.accept_reset(IID, reset_body())
    orch2, _, _, _ = make(FakeBackend(injector_exit=1))
    assert orch2.create(body()).state is S.FAILED
    with pytest.raises(InvalidState):
        orch2.accept_reset(IID, reset_body())
    assert orch2.get(IID).epoch == 1


def test_a_reset_of_an_unknown_id_is_not_found():
    orch, _, _, _ = make()
    with pytest.raises(InstanceNotFound):
        orch.accept_reset(IID, reset_body())


def test_a_failing_reset_removes_every_object_of_the_id_and_fails_with_a_code():
    be = FakeBackend()
    orch, _, _, _ = make(be)
    orch.create(body())
    be.injector_exit = 1  # the injector of the new epoch crashes
    rec = orch.reset(IID, reset_body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.INJECT_FAILED and rec.epoch == 2
    assert be.find(IID).empty


def test_a_destroy_during_a_reset_cancels_it_like_a_destroy_during_create():
    orch, be, _, _ = make()
    orch.create(body())
    accepted = orch.accept_reset(IID, reset_body())  # resetting, the worker has not started
    destroy = orch.accept_destroy(IID)
    assert destroy.view["state"] == "stopping"
    accepted.work()  # cancelled at its first step: no object of the new epoch
    assert "2" not in epochs_present(be)
    destroy.work()
    assert orch.get(IID).state is S.DESTROYED and be.find(IID).empty


def test_the_record_keeps_no_flag_decoy_key_or_seed_after_its_work_ran():
    orch, _, _, _ = make()
    rec = orch.create(body())
    orch.reset(IID, reset_body())
    base = rec.base
    assert base.flags == () and base.decoys == () and base.flag_digests == () and base.event_key == "" and base.seed == ""
    text = repr(vars(rec)) + json.dumps(orch.view(IID))
    for secret in (FLAG_A, FLAG_B, NEW_FLAG, SEED, EVENT_KEY, NEW_SEED, NEW_KEY):
        assert secret not in text
    assert all(len(v) == 64 for v in rec.reset_prints.values())  # a hash, not the body


def test_a_reset_does_not_change_the_access_and_keeps_the_original_expiry():
    orch, be, now, _ = make()
    orch.create(body())
    first_expiry = {s.labels["vm.expires"] for s in be.containers.values()}
    orch.set_access(IID, "open", 3)
    now.advance(90)
    orch.reset(IID, reset_body())
    assert (orch.view(IID)["access"], orch.view(IID)["access_epoch"]) == ("open", 3)
    assert {s.labels["vm.expires"] for s in be.containers.values()} == first_expiry  # the reset plan keeps the first create's expiry


def test_the_epoch_filter_of_find_separates_the_epochs():
    orch, be, _, _ = make()
    orch.create(body())
    assert be.find(IID, 1).containers and be.find(IID, 2).empty and be.find(IID, None) == be.find(IID, 1)
    assert parse_reset(reset_body()).fingerprint() != parse_reset(reset_body(flag="VM{" + "E" * 24 + "}")).fingerprint()


# ---------------------------------------------------------------- activity (FR-INS-04)

def test_activity_moves_ready_and_idle_to_active_with_one_report_and_nothing_when_already_active():
    orch, _, now, seen = make()
    orch.create(body())
    count = len(seen)
    now.advance(10)
    assert orch.record_activity(IID)["state"] == "active"
    assert len(seen) == count + 1 and seen[-1].to_state is S.ACTIVE and orch.get(IID).last_activity == now.t
    now.advance(1)
    orch.record_activity(IID)  # already active: no state change, no report, the clock moves
    assert len(seen) == count + 1 and orch.get(IID).last_activity == now.t
    orch.get(IID).state = S.IDLE
    assert orch.record_activity(IID)["state"] == "active"
    with pytest.raises(InstanceNotFound):
        orch.record_activity("i-ZZZZZZZZZZZZZZZZ")


def test_activity_in_a_state_that_is_not_ready_active_or_idle_is_refused():
    orch, _, _, _ = make()
    orch.accept_create(body())
    with pytest.raises(InvalidState):
        orch.record_activity(IID)
    with pytest.raises(InvalidState):
        orch.force_activity(IID, "active")


def test_quiet_for_the_active_window_moves_active_to_idle():
    orch, _, now, seen = make()
    orch.create(body())
    orch.record_activity(IID)
    now.advance(4.9)
    orch.reap_due()
    assert orch.get(IID).state is S.ACTIVE
    now.advance(0.2)
    orch.reap_due()
    assert orch.get(IID).state is S.IDLE and seen[-1].from_state is S.ACTIVE and seen[-1].to_state is S.IDLE


def test_the_active_window_comes_from_the_settings_port():
    settings = FakeSettingsPort(Settings(active_window_minutes=1))
    orch, _, now, _ = make(settings=settings)
    orch.create(body())
    orch.record_activity(IID)
    now.advance(1)
    orch.reap_due()
    assert orch.get(IID).state is S.IDLE


# ---------------------------------------------------------------- teardown (FR-INS-04)

def test_no_activity_for_the_idle_limit_destroys_through_the_normal_path_with_reports():
    orch, be, now, seen = make()
    orch.create(body(limits=limits(idle=60, maximum=240)))
    now.advance(59.9)
    assert orch.reap_due() == [] and orch.get(IID).state is S.READY
    now.advance(0.2)  # 60 idle minutes since ready
    assert orch.reap_due() == [IID]
    assert orch.get(IID).state is S.DESTROYED and be.find(IID).empty
    assert [t.to_state for t in seen][-2:] == [S.STOPPING, S.DESTROYED] and "reaper" in seen[-2].reason
    assert orch.host_status()["used_memory_mb"] == 0  # memory is released at destroyed
    assert orch.reap_due() == []  # a destroyed instance is left alone


def test_the_inactivity_clock_runs_from_the_last_activity():
    orch, _, now, _ = make()
    orch.create(body(limits=limits(idle=60, maximum=240)))
    now.advance(50)
    orch.record_activity(IID)
    now.advance(59)
    assert orch.reap_due() == [] and orch.get(IID).state is S.IDLE  # quiet for the window, but not yet for the idle limit
    now.advance(1.1)
    assert orch.reap_due() == [IID] and orch.get(IID).state is S.DESTROYED


def test_the_total_limit_destroys_in_any_live_state_even_with_activity():
    orch, _, now, _ = make()
    orch.create(body(limits=limits(idle=1440, maximum=240)))
    for _ in range(23):
        now.advance(10)
        orch.record_activity(IID)
    assert orch.reap_due() == [] and orch.get(IID).state is S.ACTIVE  # 230 minutes
    now.advance(10)
    assert orch.reap_due() == [IID] and orch.get(IID).state is S.DESTROYED


def test_the_total_limit_also_ends_an_instance_that_is_still_being_built_or_failed():
    orch, _, now, _ = make()
    orch.accept_create(body(limits=limits(maximum=30)))  # requested, never built
    orch3, _, now3, _ = make(FakeBackend(injector_exit=1))
    assert orch3.create(body(limits=limits(maximum=30))).state is S.FAILED
    now.advance(30)
    now3.advance(30)
    assert orch.reap_due() == [IID] and orch.get(IID).state is S.DESTROYED
    assert orch3.reap_due() == [IID] and orch3.get(IID).state is S.DESTROYED


def test_a_reset_does_not_extend_the_total_limit():
    orch, _, now, _ = make()
    orch.create(body(limits=limits(idle=1440, maximum=240)))
    now.advance(200)
    orch.reset(IID, reset_body())
    now.advance(39)
    assert orch.reap_due() == [] and orch.get(IID).state is S.READY
    now.advance(1)  # 240 minutes after the first create, 40 after the reset
    assert orch.reap_due() == [IID] and orch.get(IID).state is S.DESTROYED


def test_the_ceiling_of_the_settings_port_caps_a_longer_max_minutes():
    orch, _, now, _ = make(settings=FakeSettingsPort(Settings(max_minutes_ceiling=100)))
    orch.create(body(limits=limits(idle=1440, maximum=240)))
    now.advance(99)
    assert orch.reap_due() == []
    now.advance(1)
    assert orch.reap_due() == [IID]


def test_a_candidate_with_a_longer_idle_limit_is_not_stopped_before_it():
    orch, _, now, _ = make()
    other = "i-BBBBBBBBBBBBBBBB"
    orch.create(body(IID, limits=limits(idle=60, maximum=240)))  # a learner
    orch.create(body(other, limits=limits(idle=120, maximum=240)))  # a candidate: the platform set a longer idle_minutes
    now.advance(61)
    assert orch.reap_due() == [IID] and orch.get(other).state is S.READY
    now.advance(60)
    assert orch.reap_due() == [other]


def test_the_default_settings_numbers():
    s = Settings()
    assert (s.default_idle_minutes, s.default_max_minutes, s.max_minutes_ceiling, s.active_window_minutes, s.reaper_interval_s) == (60, 240, 1440, 5, 30.0)
    port = FakeSettingsPort()
    assert port.set(default_idle_minutes=45).default_idle_minutes == 45 and port.get().default_idle_minutes == 45


def test_reap_due_hands_the_destroy_work_to_the_executor():
    orch, be, now, _ = make()
    orch.create(body(limits=limits(idle=60, maximum=240)))
    now.advance(61)
    work = []
    assert orch.reap_due(execute=work.append) == [IID]
    assert orch.get(IID).state is S.STOPPING and len(work) == 1 and not be.find(IID).empty  # accepted, not yet run
    work[0]()
    assert orch.get(IID).state is S.DESTROYED


# ---------------------------------------------------------------- findings of the review of story 3.4

def test_the_expiry_label_is_the_real_deadline_when_the_ceiling_cuts_max_minutes():
    orch, be, now, _ = make(settings=FakeSettingsPort(Settings(max_minutes_ceiling=100)))
    orch.create(body(limits=limits(idle=1440, maximum=240)))
    expected = (now.t + timedelta(minutes=100)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert {c.labels["vm.expires"] for c in be.containers.values()} == {expected}
    orch.reset(IID, reset_body())  # a reset keeps the same cut deadline
    assert {c.labels["vm.expires"] for c in be.containers.values()} == {expected}


def test_activity_times_must_carry_a_time_zone_never_go_back_and_never_lie_in_the_future():
    orch, _, now, _ = make()
    rec = orch.create(body())
    with pytest.raises(ValueError):
        orch.record_activity(IID, datetime(2026, 10, 15, 12, 5))  # naive
    orch.record_activity(IID, now.t + timedelta(minutes=30))  # future: cut to now
    assert rec.last_activity == now.t
    now.advance(10)
    first = rec.last_activity
    now.advance(20)
    orch.record_activity(IID, first - timedelta(minutes=5))  # older than the last one: ignored
    assert rec.last_activity == first


def test_settings_that_would_break_the_reaper_are_refused():
    for bad in ({"reaper_interval_s": 0}, {"reaper_interval_s": -1}, {"active_window_minutes": 0}, {"max_minutes_ceiling": 0}):
        with pytest.raises(ValueError):
            Settings(**bad)
    with pytest.raises(ValueError):
        FakeSettingsPort().set(reaper_interval_s=0)


def test_one_instance_that_cannot_be_reaped_does_not_stop_the_pass_and_is_tried_again():
    orch, be, now, _ = make()
    other = body(limits=limits(idle=60, maximum=240))
    other["instance_id"] = "i-BBBBBBBBBBBBBBBB"
    orch.create(body(limits=limits(idle=60, maximum=240)))
    orch.create(other)
    now.advance(61)
    work = []

    def execute(w):
        if not work:
            work.append("failed once")
            raise RuntimeError("no thread")
        w()

    with pytest.raises(RuntimeError):
        orch.reap_due(execute=execute)
    states = {i: orch.get(i).state for i in (IID, "i-BBBBBBBBBBBBBBBB")}
    assert S.DESTROYED in states.values()  # the other instance was still reaped in the same pass
    assert not orch.get(IID).destroying  # the flag of the failed one is cleared
    assert orch.reap_due() == [IID] or orch.get(IID).state is S.DESTROYED  # the next pass tries again and finishes
    assert orch.get(IID).state is S.DESTROYED and orch.get("i-BBBBBBBBBBBBBBBB").state is S.DESTROYED


def test_the_reaper_tries_again_with_a_destroy_that_stopped_halfway():
    orch, be, now, _ = make()
    rec = orch.create(body())
    orch.accept_destroy(IID)  # accepted, then the worker could not start or gave up: `stopping`, nothing working
    orch.release_destroy(rec)
    assert rec.state is S.STOPPING and not rec.destroying and not be.find(IID).empty
    assert orch.reap_due() == [IID]
    assert rec.state is S.DESTROYED and be.find(IID).empty


def test_a_reset_whose_worker_cannot_start_fails_with_a_code_and_leaves_nothing():
    orch, be, _, _ = make()
    rec = orch.create(body())
    accepted = orch.accept_reset(IID, reset_body())
    assert rec.state is S.RESETTING and accepted.work is not None
    orch.abandon_create(rec)  # what the service does when it cannot start the thread
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED and be.find(IID).empty