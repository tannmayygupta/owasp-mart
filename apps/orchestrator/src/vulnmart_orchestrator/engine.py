"""The orchestrator engine: create from a template and destroy (story L-13, D2 and D3).

Create order (the harness of L-06 does the same with the Docker CLI): network and volumes, containers created, the volume keeper
started (it keeps the memory-backed volumes mounted), the injector started with its document on standard input once, and only
after the injector exited 0 the other components. `ready` needs the injector exit 0 and every healthcheck healthy, so an instance
is never ready before the injection finished. A failure removes every object of the instance, then records `failed` with a code.

State is in memory plus Docker labels. Truth is Docker: destroy works from the `vm.instance` label even for an instance this
process never heard of. There is no database here (the reconciler is story 3.5). One lock serialises the calls; the HTTP service
(story 3.2) decides how to run them in the background.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from dataclasses import field as dc_field
from datetime import datetime, timezone

from .backend import Backend, BackendError
from .builder import ContainerSpec, CreateSpec, InstancePlan, build_plan, injection_document, parse_create, sidecar_document
from .images import ImageAllowlist
from .states import (
    ErrorCode, InstanceExists, InstanceState, RequestMismatch, StaleEpoch, TemplateUnknown, Transition, check_transition,
    injector_error_code,
)

S = InstanceState


@dataclass
class InstanceRecord:
    instance_id: str
    epoch: int
    template_id: str
    fingerprint: str
    state: InstanceState | None = None
    error_code: str | None = None
    transitions: list[Transition] = dc_field(default_factory=list)


class _Failure(Exception):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code, self.reason = code, reason


class Orchestrator:
    def __init__(
        self,
        backend: Backend,
        templates: Mapping[str, dict],
        images: ImageAllowlist,
        *,
        health_timeout_s: float = 60.0,
        injector_timeout_s: float = 30.0,
        poll_s: float = 0.5,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self.backend, self.templates, self.images = backend, templates, images
        self.health_timeout_s, self.injector_timeout_s, self.poll_s = health_timeout_s, injector_timeout_s, poll_s
        self._clock, self._sleep, self._now = clock, sleep, now
        self.records: dict[str, InstanceRecord] = {}
        self._lock = threading.RLock()

    # ------------------------------------------------------------ state

    def get(self, instance_id: str) -> InstanceRecord | None:
        return self.records.get(instance_id)

    def _move(self, rec: InstanceRecord, to: InstanceState, reason: str, error_code: str | None = None) -> None:
        check_transition(rec.state, to)
        number = len(rec.transitions) + 1  # per instance and epoch: a new epoch is a new record and starts at 1
        at = self._now().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        rec.transitions.append(Transition(rec.instance_id, rec.epoch, number, rec.state, to, at, reason, error_code))
        rec.state, rec.error_code = to, error_code

    # ------------------------------------------------------------ create

    def create(self, request: dict | CreateSpec) -> InstanceRecord:
        spec = request if isinstance(request, CreateSpec) else parse_create(request)
        with self._lock:
            known = self.records.get(spec.instance_id)
            if known is not None:
                if known.state is S.DESTROYED:
                    raise InstanceExists("the instance id was used and destroyed")
                if spec.epoch < known.epoch:
                    raise StaleEpoch("the epoch is below the current epoch")
                if spec.epoch > known.epoch:
                    raise InstanceExists("the instance exists; a new epoch is a reset (not in this engine yet)")
                if known.fingerprint != spec.fingerprint():
                    raise RequestMismatch("same instance and epoch with another body")
                return known  # a repeat: no new work, same result
            template = self.templates.get(spec.template_id)
            if template is None:
                raise TemplateUnknown(f"template {spec.template_id!r} is not known")
            plan = build_plan(template, spec, self.images, now=self._now())  # refuses before any object exists
            rec = InstanceRecord(spec.instance_id, spec.epoch, spec.template_id, spec.fingerprint())
            self.records[spec.instance_id] = rec
            self._move(rec, S.REQUESTED, "create accepted")
            try:
                self._run(rec, plan, spec)
            except _Failure as f:
                self._fail(rec, f)
            except BackendError:
                self._fail(rec, _Failure(ErrorCode.START_FAILED, "the container host refused a step"))
            except Exception as e:  # any other error: never leave the record in `provisioning` with objects behind
                # only the class name: the message may carry a document, flag, seed or key
                self._fail(rec, _Failure(ErrorCode.START_FAILED, f"unexpected error: {type(e).__name__}"))
            return rec

    def _run(self, rec: InstanceRecord, plan: InstancePlan, spec: CreateSpec) -> None:
        b = self.backend
        self._move(rec, S.PROVISIONING, "orchestrator starts work")
        b.create_network(plan.network)
        for v in plan.volumes:
            b.create_volume(v)
        for c in plan.containers:
            b.create_container(c)
        self._move(rec, S.STARTING, "networks and containers created")

        b.start(plan.keeper.name)  # keeps the memory-backed volumes mounted after the injector exits
        self._check_running(plan.keeper)
        b.start_with_stdin(plan.injector.name, injection_document(spec, self._now().strftime("%Y-%m-%dT%H:%M:%SZ")))
        code = b.wait_exit(plan.injector.name, self.injector_timeout_s)
        if code is None:
            raise _Failure(ErrorCode.INJECT_FAILED, "the injector did not finish in time")
        if code != 0:
            raise _Failure(injector_error_code(code), f"the injector exited with code {code}")
        # Guard: the code only gets here after the injector exited 0, and the other components are started below, so the order
        # itself guarantees that nothing is ready or even started before the injection finished.
        b.remove_container(plan.injector.name)  # removed at once (IF-6 section 5)

        for c in plan.others:
            if c.stdin == "sidecar":
                b.start_with_stdin(c.name, sidecar_document(spec))
            else:
                b.start(c.name)
        self._wait_healthy([c for c in plan.others if c.healthcheck is not None])
        self._move(rec, S.READY, "health ok and flags injected")

    def _check_running(self, c: ContainerSpec) -> None:
        st = self.backend.state(c.name)
        if st.status in ("exited", "dead"):
            raise _Failure(ErrorCode.START_FAILED, f"{c.component} stopped right after start")

    def _wait_healthy(self, pending: list[ContainerSpec]) -> None:
        deadline = self._clock() + self.health_timeout_s
        waiting = list(pending)
        while waiting:
            for c in list(waiting):
                st = self.backend.state(c.name)
                if st.status in ("exited", "dead"):
                    raise _Failure(ErrorCode.START_FAILED, f"{c.component} stopped before it was healthy")
                if st.health == "healthy":
                    waiting.remove(c)
                elif st.health == "unhealthy":
                    raise _Failure(ErrorCode.HEALTH_TIMEOUT, f"{c.component} did not become healthy")
            if not waiting:
                return
            if self._clock() >= deadline:
                raise _Failure(ErrorCode.HEALTH_TIMEOUT, "a component did not become healthy in time")
            self._sleep(self.poll_s)

    def _fail(self, rec: InstanceRecord, f: _Failure) -> None:
        reason = f.reason
        try:
            self._sweep(rec.instance_id)
        except BackendError:
            reason += "; cleanup incomplete, the reconciler or a destroy must finish it"
        self._move(rec, S.FAILED, reason, f.code)

    # ------------------------------------------------------------ destroy

    def destroy(self, instance_id: str) -> InstanceRecord | None:
        """Remove every object with the instance label. Any state; a second destroy succeeds. Returns the record, or None when
        this process has no record (the sweep still ran, because truth is Docker)."""
        with self._lock:
            rec = self.records.get(instance_id)
            if rec is None:
                self._sweep(instance_id)
                return None
            if rec.state is S.DESTROYED:
                self._sweep(instance_id)  # cheap, and removes anything a late call left
                return rec
            if rec.state is not S.STOPPING:
                self._move(rec, S.STOPPING, "destroy")
            self._sweep(instance_id)  # on failure the instance stays `stopping` and a repeat retries
            self._move(rec, S.DESTROYED, "everything removed")
            return rec

    def _sweep(self, instance_id: str) -> None:
        b = self.backend
        found = b.find(instance_id)
        errors = 0
        for step, names in ((b.remove_container, found.containers), (b.remove_network, found.networks), (b.remove_volume, found.volumes)):
            for n in names:
                try:
                    step(n)
                except BackendError:
                    errors += 1
        if errors:
            raise BackendError(f"{errors} object(s) could not be removed")
        if not b.find(instance_id).empty:
            raise BackendError("objects with the instance label remain")
