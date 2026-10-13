import json

import pytest
from support import EVENT_KEY, FLAG_A, IID, SEED, allowlist, body, template

from vulnmart_orchestrator.backend import BackendError, FakeBackend
from vulnmart_orchestrator.engine import Orchestrator
from vulnmart_orchestrator.states import (
    ErrorCode, FieldForbidden, InstanceExists, InstanceState, RequestMismatch, StaleEpoch, TemplateUnknown, ValidationFailed,
)

S = InstanceState


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def make(backend=None, **kw):
    clock = Clock()
    be = backend or FakeBackend()
    return Orchestrator(be, {"shop-v0": template()}, allowlist(), clock=clock, sleep=clock.sleep, health_timeout_s=10, poll_s=1, **kw), be


def ops(be, op):
    return [n for o, n in be.calls if o == op]


def test_create_goes_to_ready_with_numbered_transitions():
    orch, be = make()
    rec = orch.create(body())
    assert rec.state is S.READY and rec.error_code is None
    assert [(t.transition, t.to_state) for t in rec.transitions] == [
        (1, S.REQUESTED), (2, S.PROVISIONING), (3, S.STARTING), (4, S.READY)]
    assert rec.transitions[0].from_state is None and rec.transitions[1].from_state is S.REQUESTED
    assert all(t.epoch == 1 and t.instance_id == IID for t in rec.transitions)
    # the injector is gone, the others stay
    assert not any(c.endswith("-injector") for c in be.containers) and len(be.containers) == 6


def test_order_keeper_then_injector_then_the_rest_after_the_exit():
    orch, be = make()
    orch.create(body())
    starts = [n for o, n in be.calls if o in ("start", "start_with_stdin")]
    assert starts[0].endswith("-volume-keeper") and starts[1].endswith("-injector") and len(starts) == 7
    inj = starts[1]
    i_wait = be.calls.index(("wait_exit", inj))
    i_rm = be.calls.index(("remove_container", inj))
    first_rest = min(be.calls.index(c) for c in be.calls if c[0] in ("start", "start_with_stdin") and c[1] not in starts[:2])
    assert be.calls.index(("start_with_stdin", inj)) < i_wait < i_rm < first_rest

def test_the_injector_gets_the_document_once_and_the_sidecar_its_own():
    orch, be = make()
    orch.create(body())
    inj = [n for n in be.stdin if n.endswith("-injector")]
    assert len(inj) == 1 and len(be.stdin[inj[0]]) == 1
    doc = json.loads(be.stdin[inj[0]][0])
    assert doc["seed"] == SEED and doc["flags"][0]["flag"] == FLAG_A
    side = [n for n in be.stdin if n.endswith("-sidecar")]
    assert len(side) == 1 and json.loads(be.stdin[side[0]][0])["event_key"] == EVENT_KEY
    assert set(be.stdin) == {inj[0], side[0]}


def test_early_health_does_not_make_it_ready_before_the_injector_exits():
    be = FakeBackend(healthy_always=True, injector_exit=None)  # healthy from the start, injector never exits
    orch, be = make(be, )
    orch.injector_timeout_s = 5
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.INJECT_FAILED
    started = ops(be, "start") + ops(be, "start_with_stdin")
    assert not any(n.endswith("-shop") for n in started)  # the shop was never started


@pytest.mark.parametrize("exit_code,code", [(10, "INST-INJECT-BAD-DOCUMENT"), (11, "INST-INJECT-SNAPSHOT-PATCH"),
                                            (12, "INST-INJECT-PLACEMENT-WRITE"), (13, "INST-INJECT-MARKER-WRITE"),
                                            (137, "INST-INJECT-FAILED"), (1, "INST-INJECT-FAILED")])
def test_injector_failure_gives_failed_with_the_code_and_removes_everything(exit_code, code):
    orch, be = make(FakeBackend(injector_exit=exit_code))
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == code
    assert not (be.containers or be.networks or be.volumes)
    assert not any(n.endswith(("-shop", "-sidecar")) for n in ops(be, "start") + ops(be, "start_with_stdin"))
    assert rec.transitions[-1].from_state in (S.STARTING, S.PROVISIONING) and rec.transitions[-1].error_code == code
    assert str(exit_code) in rec.transitions[-1].reason


def test_health_timeout_gives_failed_and_removes_everything():
    orch, be = make(FakeBackend(healthy_after=None))
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.HEALTH_TIMEOUT
    assert not (be.containers or be.networks or be.volumes)


def test_a_docker_failure_gives_start_failed_and_cleans_up():
    orch, be = make(FakeBackend(fail_on=("create_container", "-shop")))
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED
    assert not (be.containers or be.networks or be.volumes)


def test_unknown_template_or_image_is_refused_before_any_container_exists():
    orch, be = make()
    with pytest.raises(TemplateUnknown):
        orch.create(body(template_id="nope-v0"))
    assert be.calls == [] and orch.get(IID) is None
    orch2 = Orchestrator(be, {"shop-v0": template()}, allowlist(roles=("shop", "injector", "volume-keeper")))
    from vulnmart_orchestrator.images import ImageNotAllowed

    with pytest.raises(ImageNotAllowed):
        orch2.create(body())
    assert be.calls == [] and orch2.get(IID) is None


@pytest.mark.parametrize("field", ["image", "command", "ports", "env", "volumes", "network_mode", "privileged"])
def test_request_with_container_fields_never_reaches_the_builder(field):
    orch, be = make()
    with pytest.raises(FieldForbidden):
        orch.create({**body(), field: "x"})
    with pytest.raises(ValidationFailed):
        orch.create({**body(), "surprise": 1})
    assert be.calls == [] and orch.records == {}


def test_repeat_create_does_no_new_work_and_other_bodies_are_refused():
    orch, be = make()
    first = orch.create(body())
    calls = list(be.calls)
    assert orch.create(body()) is first and be.calls == calls
    with pytest.raises(RequestMismatch):
        orch.create(body(seed="Z" * 40))
    assert be.calls == calls


def test_stale_and_newer_epochs_are_refused():
    orch, be = make()
    orch.create(body(epoch=2))
    with pytest.raises(StaleEpoch):
        orch.create(body(epoch=1))
    with pytest.raises(InstanceExists):
        orch.create(body(epoch=3))


def test_a_repeat_of_a_failed_create_is_the_same_failure():
    orch, be = make(FakeBackend(injector_exit=10))
    first = orch.create(body())
    n = len(be.calls)
    assert orch.create(body()) is first and len(be.calls) == n


def test_destroy_from_ready_failed_and_twice():
    orch, be = make()
    orch.create(body())
    rec = orch.destroy(IID)
    assert rec.state is S.DESTROYED and not (be.containers or be.networks or be.volumes)
    assert [t.to_state for t in rec.transitions][-2:] == [S.STOPPING, S.DESTROYED]
    assert [t.transition for t in rec.transitions] == list(range(1, len(rec.transitions) + 1))
    assert orch.destroy(IID) is rec  # a second destroy succeeds
    with pytest.raises(InstanceExists):
        orch.create(body())

    orch2, be2 = make(FakeBackend(injector_exit=11))
    orch2.create(body())
    assert orch2.destroy(IID).state is S.DESTROYED


def test_destroy_removes_labelled_objects_even_without_a_record():
    orch, be = make()
    orch.create(body())
    other = Orchestrator(be, {}, allowlist())  # a restarted process: no memory, Docker is the truth
    assert other.destroy(IID) is None
    assert not (be.containers or be.networks or be.volumes)
    assert other.destroy(IID) is None


def test_destroy_that_cannot_finish_stays_stopping_and_a_retry_finishes_it():
    orch, be = make()
    orch.create(body())
    be.fail_on = ("remove_network", "-net")
    with pytest.raises(BackendError):
        orch.destroy(IID)
    assert orch.get(IID).state is S.STOPPING
    be.fail_on = None
    assert orch.destroy(IID).state is S.DESTROYED and not (be.containers or be.networks or be.volumes)


def test_destroy_leaves_other_instances_alone():
    orch, be = make()
    orch.create(body())
    orch.create(body(iid="i-ZZZZZZZZZZZZZZZZ"))
    orch.destroy(IID)
    assert orch.get("i-ZZZZZZZZZZZZZZZZ").state is S.READY
    assert all("zzzzzzzzzzzzzzzz" in n for n in be.containers)


def test_failure_text_and_calls_hold_no_secret():
    orch, be = make(FakeBackend(injector_exit=10))
    rec = orch.create(body())
    text = json.dumps([(t.reason, t.error_code) for t in rec.transitions]) + repr(rec)
    for secret in (FLAG_A, SEED, EVENT_KEY):
        assert secret not in text

def test_an_unexpected_error_fails_the_instance_and_cleans_up_without_leaking_the_message():
    class Boom(FakeBackend):
        def start(self, name):
            raise RuntimeError(SEED + FLAG_A)

    orch, be = make(Boom())
    rec = orch.create(body())
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED
    assert not (be.containers or be.networks or be.volumes)
    reason = rec.transitions[-1].reason
    assert "RuntimeError" in reason and SEED not in reason and FLAG_A not in reason
