"""Story 3.6: the cap on parallel builds (FR-INS-07) and the start retry (FR-INS-08), on the fake backend. Every orchestrator row of the
I/O matrix of the story plan has a test here."""
from __future__ import annotations

import threading
import time

import pytest
from support import allowlist, body, template

from vulnmart_orchestrator.backend import BackendError, FakeBackend, ServiceFakeBackend
from vulnmart_orchestrator.engine import Orchestrator
from vulnmart_orchestrator.lifecycle import FakeSettingsPort, Settings
from vulnmart_orchestrator.states import ErrorCode, InstanceState

S = InstanceState


def iid(n: int) -> str:
    return "i-" + "ABCDEFGHIJKLMNOP"[:15] + "ABCDEFGHIJKLMNOPQRST"[n]


class Ticks:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


def make(backend=None, settings=None, seen=None):
    ticks = Ticks()
    be = backend or FakeBackend()
    orch = Orchestrator(
        be, {"shop-v0": template()}, allowlist(), clock=ticks, sleep=ticks.sleep, health_timeout_s=10, poll_s=1,
        settings=FakeSettingsPort(settings) if settings else None, on_transition=(seen.append if seen is not None else None),
    )
    return orch, be


class FailsFirst(FakeBackend):
    """The first start of the volume keeper fails; later ones work."""

    def __init__(self, times: int = 1, **kw) -> None:
        super().__init__(**kw)
        self.left = times

    def start(self, name: str) -> None:
        if self.left > 0 and self.containers[name].role == "volume-keeper":
            self.left -= 1
            raise BackendError("fake start failure")
        super().start(name)


def nothing_left(be: FakeBackend) -> bool:
    return not (be.containers or be.networks or be.volumes)


# ---------------------------------------------------------------- the settings

@pytest.mark.parametrize("over", [{"max_parallel_builds": 0}, {"max_parallel_builds": 65}, {"start_retries": -1}, {"start_retries": 3},
                                   {"start_retries": True}, {"max_parallel_builds": 1.5}])
def test_bad_numbers_are_refused(over):
    with pytest.raises(ValueError):
        Settings(**over)


def test_defaults_are_four_builds_and_one_retry():
    assert (Settings().max_parallel_builds, Settings().start_retries) == (4, 1)


# ---------------------------------------------------------------- the build cap (FR-INS-07)

def test_twenty_creates_run_at_most_four_builds_together_and_all_become_ready():
    seen: list = []
    be = ServiceFakeBackend()
    orch = Orchestrator(be, {"shop-v0": template()}, allowlist(), poll_s=0.01, on_transition=seen.append)
    running, peak, mu = 0, 0, threading.Lock()
    inner = orch._run

    def counted(*a, **kw):
        nonlocal running, peak
        with mu:
            running += 1
            peak = max(peak, running)
        try:
            time.sleep(0.05)  # long enough for the others to pile up
            return inner(*a, **kw)
        finally:
            with mu:
                running -= 1

    orch._run = counted  # type: ignore[method-assign]
    ids = [iid(n) for n in range(20)]
    accepted = [orch.accept_create(body(i)) for i in ids]
    threads = [threading.Thread(target=a.work) for a in accepted]
    for t in threads:
        t.start()
    time.sleep(0.02)
    assert any(orch.get(i).state is S.REQUESTED for i in ids), "the builds beyond the cap wait in `requested`"
    for t in threads:
        t.join(timeout=60)
    assert peak == 4 and orch.max_builds_seen == 4
    assert all(orch.get(i).state is S.READY for i in ids)


def test_the_cap_follows_the_setting_and_never_fails_a_create():
    orch, _ = make(ServiceFakeBackend(), Settings(max_parallel_builds=1))
    orch.poll_s = 0.01
    ids = [iid(n) for n in range(3)]
    accepted = [orch.accept_create(body(i)) for i in ids]
    threads = [threading.Thread(target=a.work) for a in accepted]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert orch.max_builds_seen == 1
    assert [orch.get(i).state for i in ids] == [S.READY] * 3


def test_a_destroy_while_waiting_for_a_slot_cancels_the_build():
    orch, be = make(ServiceFakeBackend(), Settings(max_parallel_builds=1))
    gate = threading.Event()
    inner = orch._run

    def slow(*a, **kw):
        gate.wait(10)
        return inner(*a, **kw)

    orch._run = slow  # type: ignore[method-assign]
    first, second = orch.accept_create(body(iid(0))), orch.accept_create(body(iid(1)))
    t1 = threading.Thread(target=first.work)
    t2 = threading.Thread(target=second.work)
    t1.start()
    time.sleep(0.1)
    t2.start()
    time.sleep(0.1)
    assert orch.get(iid(1)).state is S.REQUESTED
    orch.destroy(iid(1))
    t2.join(timeout=10)
    assert not t2.is_alive(), "the waiting build gave up its place in the queue"
    gate.set()
    t1.join(timeout=30)
    assert orch.get(iid(1)).state is S.DESTROYED and orch.get(iid(0)).state is S.READY


# ---------------------------------------------------------------- the start retry (FR-INS-08)

def test_a_start_that_fails_once_is_tried_again_and_the_platform_sees_failed_then_provisioning():
    seen: list = []
    orch, be = make(FailsFirst(1), seen=seen)
    rec = orch.create(body())
    assert rec.state is S.READY and rec.error_code is None and rec.health == "healthy"
    states = [t.to_state.value for t in seen]
    assert states == ["requested", "provisioning", "starting", "failed", "provisioning", "starting", "ready"]
    failed = next(t for t in seen if t.to_state is S.FAILED)
    assert failed.error_code == ErrorCode.START_FAILED
    assert [t.transition for t in seen] == list(range(1, 8)), "the numbers keep growing across the retry"
    assert len([n for n in be.networks]) == 1, "the objects of the first try were removed before the second"


def test_a_health_failure_is_also_retried():
    be = FakeBackend(healthy_after=None)
    orch, _ = make(be)
    seen: list = []
    orch.on_transition = seen.append
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.HEALTH_TIMEOUT
    assert sum(1 for t in seen if t.to_state is S.PROVISIONING) == 2, "one try and one retry"
    assert nothing_left(be)


def test_a_start_that_fails_every_time_ends_failed_with_the_code_and_nothing_left():
    be = FailsFirst(99)
    orch, _ = make(be, Settings(start_retries=2))
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED
    assert be.left == 99 - 3, "the first try and two retries"
    assert nothing_left(be)


def test_no_retry_when_the_setting_is_zero():
    be = FailsFirst(99)
    orch, _ = make(be, Settings(start_retries=0))
    rec = orch.create(body())
    assert rec.state is S.FAILED and be.left == 98


def test_an_injection_failure_is_never_retried():
    seen: list = []
    be = FakeBackend(injector_exit=1)
    orch, _ = make(be, seen=seen)
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.INJECT_FAILED
    assert sum(1 for c in be.calls if c[0] == "start_with_stdin") == 1, "the document went in once"
    assert nothing_left(be)


def test_the_retry_sends_the_same_secrets_again_and_logs_none(capsys):
    be = FakeBackend(healthy_after=None)  # every try reaches the injector, so its document goes in once per try
    orch, _ = make(be)
    orch.create(body())
    injector_docs = [d for n, v in be.stdin.items() if n.endswith("-injector") or "injector" in n for d in v]
    assert len(injector_docs) == 2 and injector_docs[0] == injector_docs[1], "the same document, from memory, on both tries"
    out = capsys.readouterr()
    assert "VM{" not in out.out + out.err


def test_a_destroy_during_the_retry_cancels_it():
    seen: list = []
    orch, _ = make(FailsFirst(1), seen=seen)
    be = orch.backend
    original, pending = orch._fail, []

    def fail_then_destroy(rec, f):
        clean = original(rec, f)
        pending.append(orch.accept_destroy(rec.instance_id))  # the destroy arrives right after the failed try
        return clean

    orch._fail = fail_then_destroy  # type: ignore[method-assign]
    rec = orch.create(body())
    assert rec.state is S.STOPPING, "the retry did not start"
    assert sum(1 for t in seen if t.to_state is S.PROVISIONING) == 1
    pending[0].work()
    assert rec.state is S.DESTROYED and nothing_left(be)

def test_the_reconciler_leaves_a_failed_record_alone_while_its_retry_is_coming():
    orch, be = make(FakeBackend())
    rec = orch.create(body())
    assert rec.state is S.READY and be.containers
    rec.state, rec.retrying = S.FAILED, True  # the moment between the failed report and the move to provisioning
    result = orch.reconcile()
    assert be.containers and be.networks, "the retry's objects were not swept"
    assert body()["instance_id"] in result.skipped
    rec.retrying = False  # the retry ended: handled as before (a failed record's objects are removed)
    orch.reconcile()
    assert nothing_left(be)


def test_the_retrying_flag_is_clear_after_a_retry_and_after_a_final_failure():
    orch, _ = make(FailsFirst(1))
    assert orch.create(body()).retrying is False
    orch2, _ = make(FailsFirst(99))
    assert orch2.create(body()).retrying is False
