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
process never heard of. There is no database here: the reconciler (story 3.5, `reconcile.py`) rebuilds the records from the Docker
labels after a restart, and destroyed ids are kept as tombstones. Every transition goes to `on_transition` (the state report queue of
the service).
"""
from __future__ import annotations

import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from dataclasses import field as dc_field
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from .backend import Backend, BackendError
from .builder import (
    ContainerSpec, CreateSpec, InstancePlan, ResetSpec, build_plan, injection_document, parse_create, parse_reset, sidecar_document,
)
from .capacity import Capacity
from .images import ImageAllowlist
from .lifecycle import FakeSettingsPort, SettingsPort
from .reconcile import AllWantedDesiredState, DesiredStatePort, ReconcileResult, Reconciler, TombstoneStore
from .states import (
    Busy, ErrorCode, InstanceExists, InstanceNotFound, InstanceState, InvalidState, RequestMismatch, StaleAccessEpoch, StaleEpoch,
    TemplateUnknown, Transition, check_transition, injector_error_code,
)

S = InstanceState
_ENDING = (S.STOPPING, S.DESTROYED)
MAX_REASON = 200  # the length the StateReport schema allows
ADOPTED_TRANSITION_BASE = 1_000_000  # transitions of an adopted instance count from here plus the seconds since ADOPTION_EPOCH, so the
ADOPTION_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)  # platform never drops them as repeats, also after a second restart
MEMORY_ADOPTION_SLACK_MB = 64  # the volume keeper container (64 MB) that every instance holds besides its template components


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
    base: CreateSpec | None = dc_field(default=None, repr=False)  # the create request without its secrets: a reset builds on it
    created_dt: datetime | None = None  # the first create: the total limit counts from here and a reset does not move it
    ready_at: datetime | None = None  # when the instance last became ready (the inactivity clock starts here)
    last_activity: datetime | None = None
    reset_prints: dict[int, str] = dc_field(default_factory=dict, repr=False)  # new epoch -> fingerprint of its reset body
    destroying: bool = False  # a destroy worker is running
    # set only for an instance the reconciler found after a restart (adoption): there is no create request to read them from
    expires_dt: datetime | None = None  # the `vm.expires` label: the total limit
    idle_minutes: int | None = None  # the idle limit (the settings default)
    transition_offset: int = 0  # added to the count of transitions to number the next one
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
        settings: SettingsPort | None = None,
        tombstones: TombstoneStore | None = None,
        desired: DesiredStatePort | None = None,
        reconcile_gate: bool = False,
    ) -> None:
        self.backend, self.templates, self.images = backend, templates, images
        self.settings: SettingsPort = settings or FakeSettingsPort()
        self.health_timeout_s, self.injector_timeout_s, self.poll_s = health_timeout_s, injector_timeout_s, poll_s
        self._clock, self._sleep, self._now = clock, sleep, now
        self.capacity = Capacity(capacity_mb)
        self.host_id, self.host_kind, self.step_delay_s = host_id, host_kind, step_delay_s
        self.on_transition = on_transition
        self.records: dict[str, InstanceRecord] = {}
        self._lock = threading.RLock()  # the table and every state change; never held across a Docker call
        self.tombstones = tombstones or TombstoneStore()
        self.reconciler = Reconciler(self, desired or AllWantedDesiredState())
        # With the gate, creates and resets are refused (ORCH-BUSY) until a pass has worked: the first pass at start has finished and
        # the desired state could be read (no safe mode). Without it (the engine tests) the engine is open from the start.
        self._reconciled = not reconcile_gate
        self._safe_mode = False

    # ------------------------------------------------------------ state

    def _stamp(self) -> str:
        return self._now().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def get(self, instance_id: str) -> InstanceRecord | None:
        return self.records.get(instance_id)

    def _move(self, rec: InstanceRecord, to: InstanceState, reason: str, error_code: str | None = None, *, force: bool = False) -> None:
        with self._lock:
            if not force:  # `force` is the reconciler recording what it found, which has no earlier state
                check_transition(rec.state, to)
            number = rec.transition_offset + len(rec.transitions) + 1  # per instance and epoch: a new epoch starts at 1 (adopted: high)
            at = self._stamp()
            if to is S.READY:
                rec.health = "healthy"
                rec.ready_at = self._now()
            elif to is S.FAILED:
                rec.health = "unhealthy" if error_code == ErrorCode.HEALTH_TIMEOUT else "unknown"
            elif to is S.RESETTING:
                rec.health = "unknown"
            t = Transition(rec.instance_id, rec.epoch, number, rec.state, to, at, (reason or "state change")[:MAX_REASON], error_code, rec.health)
            rec.transitions.append(t)
            rec.state, rec.error_code, rec.updated_at = to, error_code, at
            if to is S.DESTROYED:
                try:
                    self.tombstones.add(rec.instance_id, rec.epoch, at)
                except Exception as e:  # the id stays refused in memory; the file could not be written
                    print(f"tombstone write failed: {type(e).__name__}", file=sys.stderr, flush=True)
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
            if known is None and self.tombstones.has(spec.instance_id):
                raise InstanceExists("the instance id was used and destroyed")  # a restart does not free it (H-65)
            if known is not None:
                if known.state is S.DESTROYED:
                    raise InstanceExists("the instance id was used and destroyed")
                if spec.epoch < known.epoch:
                    raise StaleEpoch("the epoch is below the current epoch")
                if spec.epoch > known.epoch:
                    raise InstanceExists("the instance exists; a new epoch is a reset")
                if known.fingerprint != spec.fingerprint():
                    raise RequestMismatch("same instance and epoch with another body")
                return Accepted(known, False, self._view(known), None)  # a repeat: no new work, same result
            self._check_open()  # after the repeat lookup: a repeat of an accepted request is answered even in safe mode
            created = self._now()
            plan = build_plan(template, self._capped(spec), self.images, now=created)  # refuses before any object exists
            # Capacity counts what the containers really get (the template memory of every component plus the keeper), not the request
            # limit `limits.memory_mb`, which is validated but is not what Docker is given (M5 of the audit).
            used = self.capacity.used(r.memory_mb for r in self.records.values() if r.state is not S.DESTROYED)
            if not self.capacity.would_fit(used, plan.memory_mb):
                raise Busy("the host has no capacity")
            now = self._stamp()
            rec = InstanceRecord(
                spec.instance_id, spec.epoch, spec.template_id, spec.fingerprint(), hostname=spec.hostname, memory_mb=plan.memory_mb,
                components=frozenset(c["name"] for c in template["components"]), created_at=now, updated_at=now,
                base=spec.without_secrets(), created_dt=created,
            )
            self.records[spec.instance_id] = rec
            self._move(rec, S.REQUESTED, "create accepted")
            return Accepted(rec, True, self._view(rec), lambda: self._run_create(rec, plan, spec))

    def _check_open(self) -> None:
        if not self._reconciled or self._safe_mode:
            raise Busy("the orchestrator is comparing Docker with its records; try again shortly")

    # ------------------------------------------------------------ reconciler (story 3.5, FR-INS-05)

    def reconcile(self, execute: Callable[[Callable[[], None]], None] | None = None) -> ReconcileResult:
        """One pass of the reconciler (see `reconcile.py`). A backend error while listing Docker is raised."""
        return self.reconciler.run_once(execute)

    def _set_reconciled(self, *, safe: bool, ok: bool = True) -> None:
        """The end of a pass. `ok` is False when the pass had an error for an instance: the gate stays (or becomes) closed."""
        with self._lock:
            self._reconciled, self._safe_mode = ok, safe

    @property
    def gate_closed(self) -> bool:
        return not self._reconciled or self._safe_mode

    def register_found(
        self, instance_id: str, epoch: int, template_id: str, hostname: str, *, expires: datetime | None, ready: bool,
    ) -> InstanceRecord | None:
        """Record an instance found in Docker that this process does not know. `ready`: all components were found running, so it is
        adopted as `ready` (access closed, access epoch 0; the platform opens it with its next `access` call). Otherwise it is
        recorded as `failed` (INST-START-FAILED) and the caller removes its objects. Returns None when a record exists already.
        Numbers start at 1,000,000 plus the seconds since 2026-01-01 (they grow across restarts), so the platform never drops a report
        as a repeat."""
        with self._lock:
            if instance_id in self.records:
                return None
            template = self.templates[template_id]  # the reconciler checked it
            now = self._now()
            cfg = self.settings.get()
            stamp = self._stamp()
            rec = InstanceRecord(
                instance_id, epoch, template_id, "", hostname=hostname,
                memory_mb=sum(int(c["memory_mb"]) for c in template["components"]) + MEMORY_ADOPTION_SLACK_MB if ready else 0,
                components=frozenset(c["name"] for c in template["components"]), created_at=stamp, updated_at=stamp,
                # never later than the ceiling from now; a missing or unreadable label ends the instance at the next reaper pass
                expires_dt=min(expires, now + timedelta(minutes=cfg.max_minutes_ceiling)) if expires is not None else now,
                idle_minutes=cfg.default_idle_minutes,
                transition_offset=ADOPTED_TRANSITION_BASE + int((now - ADOPTION_EPOCH).total_seconds()),
            )
            self.records[instance_id] = rec
            if ready:
                self._move(rec, S.READY, "adopted after a restart: every component was found running", force=True)
            else:
                self._move(rec, S.FAILED, "found incomplete after a restart; its objects are removed", ErrorCode.START_FAILED, force=True)
            return rec

    def mark_incomplete(self, rec: InstanceRecord) -> bool:
        """A live instance found with only some of its objects: record `failed` (INST-START-FAILED), one report. The caller sweeps."""
        with self._lock:
            if rec.state not in (S.READY, S.ACTIVE, S.IDLE) or rec.destroying:
                return False
            self._move(rec, S.FAILED, "found incomplete: a component is not running; its objects are removed", ErrorCode.START_FAILED, force=True)
            return True

    def abandon_create(self, rec: InstanceRecord) -> None:
        """The worker thread of an accepted create could not be started (M10): fail the instance with INST-START-FAILED instead of
        leaving it in `requested` for ever, holding capacity. It can be destroyed like any failed instance."""
        with self._lock:
            if rec.state in (S.REQUESTED, S.RESETTING):  # a create, or a reset whose worker could not be started
                self._move(rec, S.PROVISIONING, "the worker could not be started")
        if rec.state is S.PROVISIONING:
            self._fail(rec, _Failure(ErrorCode.START_FAILED, "the orchestrator could not start the worker for this create"))

    def release_destroy(self, rec: InstanceRecord) -> None:
        """The worker thread of an accepted destroy could not be started (M10): clear the flag so that a repeated destroy starts it."""
        with self._lock:
            rec.destroying = False

    def _run_create(self, rec: InstanceRecord, plan: InstancePlan, spec: CreateSpec, clear_epoch: int | None = None) -> None:
        """The slow work of a create, or of a reset (`clear_epoch` is then the old epoch whose objects go first)."""
        with rec.lock:
            try:
                self._run(rec, plan, spec, clear_epoch)
            except _Cancelled:
                return  # the destroy that cancelled the build sweeps and finishes
            except _Failure as f:
                self._fail(rec, f)
            except BackendError:
                self._fail(rec, _Failure(ErrorCode.START_FAILED, "the container host refused a step"))
            except Exception as e:  # any other error: never leave the record in `provisioning` with objects behind
                # only the class name: the message may carry a document, flag, seed or key
                self._fail(rec, _Failure(ErrorCode.START_FAILED, f"unexpected error: {type(e).__name__}"))

    def _run(self, rec: InstanceRecord, plan: InstancePlan, spec: CreateSpec, clear_epoch: int | None = None) -> None:
        b = self.backend
        self._pause(rec)
        self._advance(rec, S.PROVISIONING, "orchestrator starts work")
        if clear_epoch is not None:
            # a reset: the old epoch's containers, networks and volumes (found by the `vm.epoch` label) are gone before any object of
            # the new epoch exists, so no old file survives (H-61). The new epoch has other names, so the two never meet.
            self._sweep(rec.instance_id, clear_epoch)
            self._check_cancel(rec)
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

    # ------------------------------------------------------------ reset (story 3.4, FR-INS-03)

    def reset(self, instance_id: str, request: dict | ResetSpec) -> InstanceRecord:
        """Accept and run a reset in the calling thread (the engine tests use it)."""
        accepted = self.accept_reset(instance_id, request)
        if accepted.work is not None:
            accepted.work()
        return accepted.record

    def accept_reset(self, instance_id: str, request: dict | ResetSpec) -> Accepted:
        """IF-5 `reset`: the new epoch (current plus one) and the new secrets. It runs the create path again for the new epoch after
        the old epoch's objects are removed. Template, owner, host name and limits come from the record. No capacity check: the
        instance keeps the memory it holds (H-57). An identical repeat is a repeat (200), another body for the same epoch a mismatch."""
        spec = request if isinstance(request, ResetSpec) else parse_reset(request)
        with self._lock:
            rec = self.records.get(instance_id)
            if rec is None:
                raise InstanceNotFound("unknown instance")
            fingerprint = spec.fingerprint()
            known = rec.reset_prints.get(spec.epoch)
            if known is not None and spec.epoch <= rec.epoch:
                if known != fingerprint:
                    raise RequestMismatch("same new epoch with another body")
                return Accepted(rec, False, self._view(rec), None)  # a repeat: no new work, same result
            self._check_open()
            if rec.state not in (S.READY, S.ACTIVE, S.IDLE):
                raise InvalidState(f"reset is not allowed in state {rec.state.value}")
            if spec.epoch != rec.epoch + 1:
                raise StaleEpoch("the new epoch must be the current epoch plus one")
            if rec.base is None:  # found after a restart: the create request (without secrets) was never kept
                raise InvalidState("an adopted instance cannot be reset; destroy and create it again")
            template = self.templates.get(rec.template_id)
            if template is None:
                raise TemplateUnknown("the template is not on the allow-list", field="/template_id")
            full = spec.apply_to(rec.base)
            # the expiry label keeps the time of the first create: a reset does not extend the total limit
            plan = build_plan(template, self._capped(full), self.images, now=rec.created_dt)  # refuses before anything changes
            old_epoch = rec.epoch
            rec.epoch = spec.epoch
            rec.transitions = []  # numbering restarts at 1 in the new epoch
            rec.reset_prints[spec.epoch] = fingerprint
            rec.last_activity = rec.ready_at = None
            self._move(rec, S.RESETTING, "reset accepted")
            return Accepted(rec, True, self._view(rec), lambda: self._run_create(rec, plan, full, old_epoch))

    # ------------------------------------------------------------ activity and teardown (story 3.4, FR-INS-04)

    def record_activity(self, instance_id: str, at: datetime | None = None) -> dict:
        """A player did something at `at` (now by default). `ready` or `idle` becomes `active` (one report); an `active` instance only
        gets a later last-activity time. The platform will call this once it forwards the signal (open points P-4 and P-19)."""
        with self._lock:
            rec = self.records.get(instance_id)
            if rec is None:
                raise InstanceNotFound("unknown instance")
            if rec.state not in (S.READY, S.ACTIVE, S.IDLE):
                raise InvalidState(f"activity is not allowed in state {rec.state.value}")
            now = self._now()
            if at is not None and at.tzinfo is None:
                raise ValueError("the activity time must carry a time zone")
            at = min(at or now, now)  # never in the future
            rec.last_activity = max(rec.last_activity, at) if rec.last_activity is not None else at  # never backwards
            if rec.state is not S.ACTIVE:
                self._move(rec, S.ACTIVE, "player activity")
            return self._view(rec)

    def force_activity(self, instance_id: str, state: str) -> dict:
        """Test control of the fake backend (`POST /_fake/v1/instances/{id}/activity`): move between ready, active and idle by hand.
        The same transitions as the real ones; the same state again changes nothing and makes no report."""
        with self._lock:
            rec = self.records.get(instance_id)
            if rec is None:
                raise InstanceNotFound("unknown instance")
            if state not in ("ready", "active", "idle") or rec.state not in (S.READY, S.ACTIVE, S.IDLE):
                raise InvalidState("activity only moves between ready, active and idle")
            target = InstanceState(state)
            if target is not rec.state:
                try:
                    check_transition(rec.state, target)
                except ValueError:
                    raise InvalidState(f"{rec.state.value} cannot become {state}") from None
                if target in (S.ACTIVE, S.IDLE):
                    rec.last_activity = self._now()
                self._move(rec, target, "player activity (fake control)")
            return self._view(rec)

    def reap_due(self, now: datetime | None = None, execute: Callable[[Callable[[], None]], None] | None = None) -> list[str]:
        """One pass of the reaper. `now` is the clock under test (the engine's clock by default). Moves `active` to `idle` after the
        quiet window, and destroys, through the normal destroy path, an instance that is past its total limit
        (`min(max_minutes, ceiling)` from the first create, any live state) or has had no activity for its `idle_minutes` (counted from
        ready or the last activity). `execute` runs the destroy work (a worker thread in the service); by default it runs here.
        Returns the ids it started a destroy for."""
        now = now or self._now()
        cfg = self.settings.get()
        started: list[str] = []
        with self._lock:
            records = list(self.records.values())
        failure: Exception | None = None
        for rec in records:
            with self._lock:
                if rec.state is S.DESTROYED or (rec.expires_dt is None and (rec.base is None or rec.created_dt is None)):
                    continue
                if rec.state is S.STOPPING:
                    if rec.destroying:
                        continue  # a worker is removing it
                    reason = "a destroy did not finish"  # its worker gave up: try the removal again
                else:
                    if rec.state is S.ACTIVE:
                        since = rec.last_activity or rec.ready_at
                        if since is not None and now - since >= timedelta(minutes=cfg.active_window_minutes):
                            self._move(rec, S.IDLE, "no activity for the active window")
                    reason = self._expiry_reason(rec, now, cfg.max_minutes_ceiling)
                    if reason is None:
                        continue
                try:
                    accepted = self.accept_destroy(rec.instance_id, f"destroy by the reaper: {reason}")
                except InvalidState:
                    continue
            started.append(rec.instance_id)
            if accepted.work is not None:
                if execute is None:
                    accepted.work()
                else:
                    try:
                        execute(accepted.work)
                    except Exception as e:  # one instance never stops the pass: its flag is cleared and the next pass tries again
                        self.release_destroy(rec)
                        failure = failure or e
        if failure is not None:
            raise failure
        return started

    def _capped(self, spec: CreateSpec) -> CreateSpec:
        """The spec the plan is built from: `max_minutes` is cut to the settings ceiling, so the `vm.expires` label is the real deadline."""
        ceiling = self.settings.get().max_minutes_ceiling
        return spec if spec.max_minutes <= ceiling else replace(spec, max_minutes=ceiling)

    def _expiry_reason(self, rec: InstanceRecord, now: datetime, ceiling: int) -> str | None:
        if rec.expires_dt is not None:  # an adopted instance: the deadline comes from the `vm.expires` label
            over, idle = now >= rec.expires_dt, rec.idle_minutes if rec.idle_minutes is not None else self.settings.get().default_idle_minutes
        else:
            assert rec.base is not None and rec.created_dt is not None
            over, idle = now >= rec.created_dt + timedelta(minutes=min(rec.base.max_minutes, ceiling)), rec.base.idle_minutes
        if over:
            return "total limit reached"
        if rec.state in (S.READY, S.ACTIVE, S.IDLE):
            since = rec.last_activity or rec.ready_at
            if since is not None and now >= since + timedelta(minutes=idle):
                return "no activity for the idle limit"
        return None

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

    def accept_destroy(self, instance_id: str, reason: str = "destroy accepted") -> Accepted:
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
                self._move(rec, S.STOPPING, reason)
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

    def _sweep(self, instance_id: str, epoch: int | None = None) -> None:
        """Remove every object of the instance; with `epoch` only the objects of that epoch (a reset clears the old one)."""
        b = self.backend
        found = b.find(instance_id, epoch)
        errors = 0
        for step, names in ((b.remove_container, found.containers), (b.remove_network, found.networks), (b.remove_volume, found.volumes)):
            for n in names:
                try:
                    step(n)
                except BackendError:
                    errors += 1
        if errors:
            raise BackendError(f"{errors} object(s) could not be removed")
        if not b.find(instance_id, epoch).empty:
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
