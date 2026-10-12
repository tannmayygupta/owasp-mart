"""The orchestrator engine: create from a template, access and destroy (stories 3.1 and 3.2, D2 to D4 and D8 of L-13).

Create order (the harness of L-06 does the same with the Docker CLI): network and volumes, containers created, the volume keeper
started (it keeps the memory-backed volumes mounted), the injector started with its document on standard input once, and only
after the injector exited 0 the other components. `ready` needs the injector exit 0 and every healthcheck healthy, so an instance
is never ready before the injection finished. A failure removes every object of the instance, then records `failed` with a code.

Create is split in two (D4 of story 3.2). `accept_create` runs at once and checks everything the contract checks before it answers:
shape, template, existence and epoch, capacity; then it registers the instance as `requested`. The returned `work` runs the slow part
(Docker) and is for a worker thread; `create` is accept plus work in the calling thread (the engine tests use it). Destroy is split the
same way. Each instance has its own lock for the slow work, a short global lock guards the table and every state change, and a destroy
that arrives while the instance is still being built cancels the build at its next step.

State is in memory plus Docker labels. Truth is Docker: destroy works from the `vm.instance` label even for an instance this
process never heard of. There is no database here (the reconciler is story 3.5). Every transition goes to `on_transition` (the state
report queue of the service).
"""
from __future__ import annotations

import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from dataclasses import field as dc_field
from datetime import datetime, timezone

from .backend import Backend, BackendError
from .builder import ContainerSpec, CreateSpec, InstancePlan, build_plan, injection_document, parse_create, sidecar_document
from .capacity import Capacity
from .images import ImageAllowlist
from .states import (
    Busy, ErrorCode, InstanceExists, InstanceNotFound, InstanceState, InvalidState, RequestMismatch, StaleAccessEpoch, StaleEpoch,
    TemplateUnknown, Transition, check_transition, injector_error_code,
)

S = InstanceState
_ENDING = (S.STOPPING, S.DESTROYED)
MAX_REASON = 200  # the length the StateReport schema allows


@dataclass
class InstanceRecord:
    instance_id: str
    epoch: int
    template_id: str
    fingerprint: str
    hostname: str = ""
    memory_mb: int = 0
    components: frozenset[str] = frozenset()
    state: InstanceState | None = None
    error_code: str | None = None
    health: str = "unknown"  # unknown, healthy, unhealthy
    access: str = "closed"
    access_epoch: int = 0
    created_at: str = ""
    updated_at: str = ""
    transitions: list[Transition] = dc_field(default_factory=list)
    destroying: bool = False  # a destroy worker is running
    lock: threading.RLock = dc_field(default_factory=threading.RLock, repr=False, compare=False)  # the slow work of this instance


@dataclass(frozen=True)
class Accepted:
    """What a call decided at once: the record, whether it changed anything (202) or repeated (200), the answer as it was at that
    moment, and the slow work (None when there is nothing to do) for a worker thread."""

    record: InstanceRecord
    changed: bool
    view: dict
    work: Callable[[], None] | None


class _Failure(Exception):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code, self.reason = code, reason


class _Cancelled(Exception):
    """A destroy arrived while the instance was being built."""


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
        capacity_mb: int | None = None,
        host_id: str = "orch-host-1",
        host_kind: str = "vm",
        step_delay_s: float = 0.0,
        on_transition: Callable[[Transition], None] | None = None,
    ) -> None:
        self.backend, self.templates, self.images = backend, templates, images
        self.health_timeout_s, self.injector_timeout_s, self.poll_s = health_timeout_s, injector_timeout_s, poll_s
        self._clock, self._sleep, self._now = clock, sleep, now
        self.capacity = Capacity(capacity_mb)
        self.host_id, self.host_kind, self.step_delay_s = host_id, host_kind, step_delay_s
        self.on_transition = on_transition
        self.records: dict[str, InstanceRecord] = {}
        self._lock = threading.RLock()  # the table and every state change; never held across a Docker call

    # ------------------------------------------------------------ state

    def _stamp(self) -> str:
        return self._now().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def get(self, instance_id: str) -> InstanceRecord | None:
        return self.records.get(instance_id)

    def _move(self, rec: InstanceRecord, to: InstanceState, reason: str, error_code: str | None = None) -> None:
        with self._lock:
            check_transition(rec.state, to)
            number = len(rec.transitions) + 1  # per instance and epoch: a new epoch is a new record and starts at 1
            at = self._stamp()
            if to is S.READY:
                rec.health = "healthy"
            elif to is S.FAILED:
                rec.health = "unhealthy" if error_code == ErrorCode.HEALTH_TIMEOUT else "unknown"
            elif to is S.RESETTING:
                rec.health = "unknown"
            t = Transition(rec.instance_id, rec.epoch, number, rec.state, to, at, (reason or "state change")[:MAX_REASON], error_code, rec.health)
            rec.transitions.append(t)
            rec.state, rec.error_code, rec.updated_at = to, error_code, at
            if self.on_transition is not None:
                try:
                    self.on_transition(t)
                except Exception as e:  # a report that cannot be queued never breaks the state machine
                    print(f"state report hook failed: {type(e).__name__}", file=sys.stderr, flush=True)

    def _advance(self, rec: InstanceRecord, to: InstanceState, reason: str, error_code: str | None = None) -> None:
        """A step of the build: refused (cancelled) when a destroy has already taken the instance."""
        with self._lock:
            if rec.state in _ENDING:
                raise _Cancelled
            self._move(rec, to, reason, error_code)

    def _check_cancel(self, rec: InstanceRecord) -> None:
        if rec.state in _ENDING:
            raise _Cancelled

    def _pause(self, rec: InstanceRecord, *, cancellable: bool = True) -> None:
        """The step delay of the test backend (`--step-delay-ms`): sleeps in short slices so a destroy can still cancel the build."""
        end = time.monotonic() + self.step_delay_s
        while True:
            if cancellable:
                self._check_cancel(rec)
            left = end - time.monotonic()
            if left <= 0:
                return
            time.sleep(min(0.05, left))

    def _view(self, rec: InstanceRecord) -> dict:
        with self._lock:
            return {
                "instance_id": rec.instance_id, "template_id": rec.template_id, "epoch": rec.epoch, "state": rec.state.value,
                "access": rec.access, "access_epoch": rec.access_epoch, "health": rec.health, "error_code": rec.error_code,
                "host_id": self.host_id, "hostname": rec.hostname, "created_at": rec.created_at, "updated_at": rec.updated_at,
            }

    def view(self, instance_id: str) -> dict:
        with self._lock:
            rec = self.records.get(instance_id)
            if rec is None:
                raise InstanceNotFound("unknown instance")
            return self._view(rec)

    # ------------------------------------------------------------ create

    def create(self, request: dict | CreateSpec) -> InstanceRecord:
        accepted = self.accept_create(request)
        if accepted.work is not None:
            accepted.work()
        return accepted.record

    def accept_create(self, request: dict | CreateSpec) -> Accepted:
        spec = request if isinstance(request, CreateSpec) else parse_create(request)
        with self._lock:
            template = self.templates.get(spec.template_id)
            if template is None:
                raise TemplateUnknown("the template is not on the allow-list", field="/template_id")
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
                return Accepted(known, False, self._view(known), None)  # a repeat: no new work, same result
            used = self.capacity.used(r.memory_mb for r in self.records.values() if r.state is not S.DESTROYED)
            if not self.capacity.would_fit(used, spec.memory_mb):
                raise Busy("the host has no capacity")
            plan = build_plan(template, spec, self.images, now=self._now())  # refuses before any object exists
            now = self._stamp()
            rec = InstanceRecord(
                spec.instance_id, spec.epoch, spec.template_id, spec.fingerprint(), hostname=spec.hostname, memory_mb=spec.memory_mb,
                components=frozenset(c["name"] for c in template["components"]), created_at=now, updated_at=now,
            )
            self.records[spec.instance_id] = rec
            self._move(rec, S.REQUESTED, "create accepted")
            return Accepted(rec, True, self._view(rec), lambda: self._run_create(rec, plan, spec))

    def _run_create(self, rec: InstanceRecord, plan: InstancePlan, spec: CreateSpec) -> None:
        with rec.lock:
            try:
                self._run(rec, plan, spec)
            except _Cancelled:
                return  # the destroy that cancelled the build sweeps and finishes
            except _Failure as f:
                self._fail(rec, f)
            except BackendError:
                self._fail(rec, _Failure(ErrorCode.START_FAILED, "the container host refused a step"))
            except Exception as e:  # any other error: never leave the record in `provisioning` with objects behind
                # only the class name: the message may carry a document, flag, seed or key
                self._fail(rec, _Failure(ErrorCode.START_FAILED, f"unexpected error: {type(e).__name__}"))

    def _run(self, rec: InstanceRecord, plan: InstancePlan, spec: CreateSpec) -> None:
        b = self.backend
        self._pause(rec)
        self._advance(rec, S.PROVISIONING, "orchestrator starts work")
        b.create_network(plan.network)
        for v in plan.volumes:
            b.create_volume(v)
        for c in plan.containers:
            b.create_container(c)
        self._pause(rec)
        self._advance(rec, S.STARTING, "networks and containers created")

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

        self._check_cancel(rec)
        for c in plan.others:
            if c.stdin == "sidecar":
                b.start_with_stdin(c.name, sidecar_document(spec))
            else:
                b.start(c.name)
        self._wait_healthy(rec, [c for c in plan.others if c.healthcheck is not None])
        self._pause(rec)
        self._advance(rec, S.READY, "health ok and flags injected")

    def _check_running(self, c: ContainerSpec) -> None:
        st = self.backend.state(c.name)
        if st.status in ("exited", "dead"):
            raise _Failure(ErrorCode.START_FAILED, f"{c.component} stopped right after start")

    def _wait_healthy(self, rec: InstanceRecord, pending: list[ContainerSpec]) -> None:
        deadline = self._clock() + self.health_timeout_s
        waiting = list(pending)
        while waiting:
            self._check_cancel(rec)
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
        try:
            self._advance(rec, S.FAILED, reason, f.code)
        except _Cancelled:
            pass  # a destroy took the instance while it failed: the destroy finishes

    # ------------------------------------------------------------ access

    def set_access(self, instance_id: str, access: str, access_epoch: int) -> dict:
        """IF-5 `access`: any state but destroyed; the access epoch only grows (an equal epoch with another value is stale)."""
        with self._lock:
            rec = self.records.get(instance_id)
            if rec is None:
                raise InstanceNotFound("unknown instance")
            if rec.state is S.DESTROYED:
                raise InvalidState("the instance is destroyed")
            if access_epoch < rec.access_epoch or (access_epoch == rec.access_epoch and access != rec.access):
                raise StaleAccessEpoch("the access epoch is older, or equal with another value")
            if access_epoch > rec.access_epoch or access != rec.access:
                rec.access, rec.access_epoch, rec.updated_at = access, access_epoch, self._stamp()
            return self._view(rec)

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
        accepted = self.accept_destroy(instance_id)
        if accepted.work is not None:
            accepted.work()  # on failure the instance stays `stopping` and a repeat retries
        return rec

    def accept_destroy(self, instance_id: str) -> Accepted:
        with self._lock:
            rec = self.records.get(instance_id)
            if rec is None:
                raise InstanceNotFound("unknown instance")
            if rec.state is S.DESTROYED:
                return Accepted(rec, False, self._view(rec), None)
            changed = False
            if rec.state is not S.STOPPING:
                try:
                    check_transition(rec.state, S.STOPPING)
                except ValueError:
                    raise InvalidState(f"destroy is not allowed in state {rec.state.value}") from None
                self._move(rec, S.STOPPING, "destroy accepted")
                changed = True
            work = None
            if not rec.destroying:  # a repeat while nothing is working retries the removal
                rec.destroying = True
                work = lambda: self._run_destroy(rec)  # noqa: E731
            return Accepted(rec, changed, self._view(rec), work)

    def _run_destroy(self, rec: InstanceRecord) -> None:
        try:
            with rec.lock:  # waits for a build that a destroy cancelled
                self._sweep(rec.instance_id)
                self._pause(rec, cancellable=False)
                with self._lock:
                    if rec.state is not S.DESTROYED:
                        self._move(rec, S.DESTROYED, "everything removed")
        finally:
            with self._lock:
                rec.destroying = False

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

    # ------------------------------------------------------------ list and host

    def list_views(
        self, *, instance: str | None = None, epoch: int | None = None, template: str | None = None, component: str | None = None,
        kind: str | None = None, after: str | None = None, limit: int = 100,
    ) -> tuple[list[dict], str | None]:
        """One page ordered by instance id: the views and the id the next page starts after (None on the last page)."""
        with self._lock:
            ids = [
                i for i in sorted(self.records)
                if (after is None or i > after) and (instance is None or i == instance)
                and (epoch is None or self.records[i].epoch == epoch) and (template is None or self.records[i].template_id == template)
                and (component is None or component in self.records[i].components) and (kind is None or kind == "inst")
            ]
            page = ids[:limit]
            return [self._view(self.records[i]) for i in page], (page[-1] if len(ids) > limit else None)

    def host_status(self) -> dict:
        with self._lock:
            live = [r for r in self.records.values() if r.state is not S.DESTROYED]
            return {
                "host_id": self.host_id, "kind": self.host_kind, "capacity_memory_mb": self.capacity.total_mb or 0,
                "used_memory_mb": self.capacity.used(r.memory_mb for r in live), "instances": len(live), "health": "ok",
            }
