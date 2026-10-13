"""FakeInstanceHost: an in-memory InstanceHost that follows the contract rules (IF-5).

For platform tests that need no process and no network. It keeps no secret: a request is reduced to
a SHA-256 fingerprint of its canonical JSON.

Time does not pass by itself. With `auto_advance=True` (the default) every transitional state is
completed at the start of the next call, so a create answers `requested` and the next `get` already
says `ready`. With `auto_advance=False` nothing moves until the test calls `advance()`, which makes a
state such as `starting` or `resetting` easy to hold.

Test hooks that are not part of the contract: `advance`, `set_activity`, and the template name
`shop-fail-v0`, which ends in `failed` with the code `INST-HEALTH-TIMEOUT`.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime

from .instance_host import (
    LIST_LABELS, RESETTABLE, Access, Busy, CreateRequest, CursorInvalid, Health, HostHealth, HostStatus,
    InstanceExists, InstanceNotFound, InstancePage, InstanceState, InstanceStatus, InvalidState, LabelUnknown,
    Outcome, RequestMismatch, ResetRequest, StaleAccessEpoch, StaleEpoch, StateReport, TemplateUnknown,
    ValidationFailed, is_wire_int,
)

ALLOWED_TEMPLATES = frozenset({"shop-v0", "shop-fail-v0"})
COMPONENTS = ("bot-controller", "import-service", "injector", "mock-services", "shop", "sidecar")
INSTANCE_ID = re.compile(r"^i-[A-Z2-7]{16}\Z")
_TEMPLATE = re.compile(r"^[a-z][a-z0-9-]{2,31}\Z")
_CHALLENGE = re.compile(r"^C(0[1-9]|10|11)\Z")
_FLAG = re.compile(r"^VM\{[A-Z2-7]{24}\}\Z")
_HEX64 = re.compile(r"^[0-9a-f]{64}\Z")
_SECRET = re.compile(r"^[A-Za-z0-9_-]{32,128}\Z")
_HOSTNAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\Z")
_CURSOR = re.compile(r"^[A-Za-z0-9_-]{24}\Z")  # base64url (no padding) of an 18-character instance id
_EPOCH_LABEL = re.compile(r"^[1-9][0-9]*\Z")
_TRANSITIONAL = {
    InstanceState.REQUESTED, InstanceState.PROVISIONING, InstanceState.STARTING,
    InstanceState.RESETTING, InstanceState.STOPPING,
}


def _by_value(node):
    """Numbers are compared by value, as the service does: `2` and `2.0` are one request (only `cpu_limit` may be a
    non-integer; every integer field is checked as an integer before a fingerprint is made)."""
    if isinstance(node, dict):
        return {k: _by_value(v) for k, v in node.items()}
    if isinstance(node, (list, tuple)):
        return [_by_value(v) for v in node]
    if isinstance(node, float) and node.is_integer():
        return int(node)
    return node


def fingerprint(body: dict) -> str:
    return hashlib.sha256(json.dumps(_by_value(body), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def encode_cursor(instance_id: str) -> str:
    return base64.urlsafe_b64encode(instance_id.encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> str:
    """The instance id a cursor stands for. Anything this orchestrator would not have handed out is CursorInvalid."""
    bad = CursorInvalid("the cursor is not one this orchestrator handed out", field="/query/cursor")
    if not isinstance(cursor, str) or not _CURSOR.match(cursor):
        raise bad
    try:
        text = base64.urlsafe_b64decode(cursor).decode("ascii")
    except ValueError as exc:  # binascii.Error and UnicodeDecodeError are both ValueErrors
        raise bad from exc
    if not INSTANCE_ID.match(text) or encode_cursor(text) != cursor:
        raise bad
    return text


def _bad(field: str, message: str) -> ValidationFailed:
    return ValidationFailed(message, field=field)


def _check_material(m) -> None:
    # Mirrors the shape rules of the service (and of the OpenAPI schemas).
    if not 1 <= len(m.flags) <= 11:
        raise _bad("/flags", "flags: 1 to 11 entries")
    for i, f in enumerate(m.flags):
        if not _CHALLENGE.match(f.challenge_key):
            raise _bad(f"/flags/{i}/challenge_key", "bad challenge key")
        if not _FLAG.match(f.flag):
            raise _bad(f"/flags/{i}/flag", "bad flag format")
    if len(m.decoys) > 64:
        raise _bad("/decoys", "decoys: at most 64 entries")
    for i, d in enumerate(m.decoys):
        if not _CHALLENGE.match(d.challenge_key):
            raise _bad(f"/decoys/{i}/challenge_key", "bad challenge key")
        if not is_wire_int(d.index, 0):
            raise _bad(f"/decoys/{i}/index", "bad decoy index")
        if not _FLAG.match(d.value):
            raise _bad(f"/decoys/{i}/value", "bad decoy format")
    if not 1 <= len(m.flag_digests) <= 11:
        raise _bad("/flag_digests", "flag_digests: 1 to 11 entries")
    for i, d in enumerate(m.flag_digests):
        if not _CHALLENGE.match(d.challenge_key):
            raise _bad(f"/flag_digests/{i}/challenge_key", "bad challenge key")
        if not _HEX64.match(d.sha256):
            raise _bad(f"/flag_digests/{i}/sha256", "bad digest")
    if not _SECRET.match(m.event_key):
        raise _bad("/event_key", "bad event key shape")
    if not _SECRET.match(m.seed):
        raise _bad("/seed", "bad seed shape")


def _check_create(r: CreateRequest) -> None:
    if not INSTANCE_ID.match(r.instance_id):
        raise _bad("/instance_id", "bad instance id")
    if not _TEMPLATE.match(r.template_id):
        raise _bad("/template_id", "bad template name")
    if not is_wire_int(r.epoch, 1):
        raise _bad("/epoch", "epoch is an integer of at least 1")
    if not isinstance(r.owner_hash, str) or not _HEX64.match(r.owner_hash):
        raise _bad("/owner_hash", "owner_hash is 64 lowercase hex characters")
    _check_material(r.material)
    if len(r.hostname) > 253 or not _HOSTNAME.match(r.hostname):
        raise _bad("/hostname", "bad host name")
    lim = r.limits
    if not is_wire_int(lim.memory_mb, 64, 8192):
        raise _bad("/limits/memory_mb", "memory_mb is 64 to 8192")
    if type(lim.cpu_limit) not in (int, float) or not math.isfinite(lim.cpu_limit) or not 0 < lim.cpu_limit <= 8:
        raise _bad("/limits/cpu_limit", "cpu_limit is over 0 up to 8")
    if not is_wire_int(lim.pids_limit, 16, 4096):
        raise _bad("/limits/pids_limit", "pids_limit is 16 to 4096")
    if not is_wire_int(lim.idle_minutes, 1, 1440):
        raise _bad("/limits/idle_minutes", "idle_minutes is 1 to 1440")
    if not is_wire_int(lim.max_minutes, 1, 1440):
        raise _bad("/limits/max_minutes", "max_minutes is 1 to 1440")


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class _Record:
    status: InstanceStatus
    memory_mb: int
    prints: dict[tuple[int, str], str] = field(default_factory=dict)  # (epoch, "create" or "reset") -> fingerprint
    transition: int = 0  # last transition number of the current epoch; a reset starts the count again


class FakeInstanceHost:
    def __init__(
        self, *, capacity_memory_mb: int = 8192, host_id: str = "fake-host-1", auto_advance: bool = True,
        now: Callable[[], datetime] = _now,
    ) -> None:
        self.capacity_memory_mb = capacity_memory_mb
        self.host_id = host_id
        self.auto_advance = auto_advance
        self._now = now
        self._records: dict[str, _Record] = {}
        # Every state change, in the order it happened: what the orchestrator would send to the platform (section 8).
        self.reports: list[StateReport] = []

    # ---- helpers ----
    def _stamp(self) -> str:
        return self._now().strftime("%Y-%m-%dT%H:%M:%SZ")

    def _set(self, rec: _Record, **changes) -> None:
        rec.status = replace(rec.status, updated_at=self._stamp(), **changes)

    def _move(self, rec: _Record, to: InstanceState, reason: str, **changes) -> None:
        """Change the state and record the report. A new epoch restarts the transition count at 1."""
        frm = rec.status.state
        if "epoch" in changes:
            rec.transition = 0
        self._set(rec, state=to, **changes)
        self._report(rec, frm, reason)

    def _report(self, rec: _Record, frm: InstanceState | None, reason: str) -> None:
        rec.transition += 1
        st = rec.status
        self.reports.append(StateReport(
            st.instance_id, st.epoch, rec.transition, frm, st.state, st.updated_at, reason, st.error_code, st.health))

    def _used(self) -> int:
        return sum(r.memory_mb for r in self._records.values() if r.status.state is not InstanceState.DESTROYED)

    def _get(self, instance_id: str) -> _Record:
        if not INSTANCE_ID.match(instance_id):
            raise _bad("/instance_id", "bad instance id")
        rec = self._records.get(instance_id)
        if rec is None:
            raise InstanceNotFound(f"unknown instance {instance_id}")
        return rec

    def _step(self, rec: _Record) -> bool:
        """Move one transitional state forward. Returns False when the state is a resting one."""
        state = rec.status.state
        if state is InstanceState.REQUESTED or state is InstanceState.RESETTING:
            self._move(rec, InstanceState.PROVISIONING, "orchestrator started work")
        elif state is InstanceState.PROVISIONING:
            self._move(rec, InstanceState.STARTING, "networks and containers created")
        elif state is InstanceState.STARTING:
            if rec.status.template_id == "shop-fail-v0":
                self._move(rec, InstanceState.FAILED, "health check timed out", health=Health.UNHEALTHY, error_code="INST-HEALTH-TIMEOUT")
            else:
                self._move(rec, InstanceState.READY, "health ok and flags injected", health=Health.HEALTHY, error_code=None)
        elif state is InstanceState.STOPPING:
            self._move(rec, InstanceState.DESTROYED, "everything removed")
        else:
            return False
        return True

    def _settle(self) -> None:
        if not self.auto_advance:
            return
        for rec in self._records.values():
            while rec.status.state in _TRANSITIONAL:
                self._step(rec)

    # ---- test hooks (not part of the contract) ----
    def advance(self, instance_id: str) -> InstanceState:
        rec = self._get(instance_id)
        self._step(rec)
        return rec.status.state

    def set_activity(self, instance_id: str, state: InstanceState) -> None:
        rec = self._get(instance_id)
        allowed = {InstanceState.READY, InstanceState.ACTIVE, InstanceState.IDLE}
        if rec.status.state not in allowed or state not in allowed:
            raise InvalidState("activity only moves between ready, active and idle")
        if state is not rec.status.state:  # no change, no report
            self._move(rec, state, "player activity (fake control)")

    # ---- the contract ----
    def create(self, request: CreateRequest) -> Outcome:
        self._settle()
        _check_create(request)
        if request.template_id not in ALLOWED_TEMPLATES:
            raise TemplateUnknown(f"template {request.template_id} is not on the allow-list", field="/template_id")
        print_ = fingerprint(request.to_json())
        rec = self._records.get(request.instance_id)
        if rec is not None:
            if rec.status.state is InstanceState.DESTROYED:
                raise InstanceExists("the instance id was used and destroyed; it cannot be created again")
            if request.epoch < rec.status.epoch:
                raise StaleEpoch("the epoch is older than the current epoch of the instance")
            known = rec.prints.get((request.epoch, "create"))
            if known is None:
                raise InstanceExists("the instance exists with another epoch; use reset")
            if known != print_:
                raise RequestMismatch("same instance and epoch with a different body")
            return Outcome(rec.status, False)
        if self._used() + request.limits.memory_mb > self.capacity_memory_mb:
            raise Busy("the host has no capacity")
        stamp = self._stamp()
        status = InstanceStatus(
            instance_id=request.instance_id, template_id=request.template_id, epoch=request.epoch,
            state=InstanceState.REQUESTED, access=Access.CLOSED, access_epoch=0, health=Health.UNKNOWN,
            error_code=None, host_id=self.host_id, hostname=request.hostname, created_at=stamp, updated_at=stamp,
        )
        rec = _Record(status, request.limits.memory_mb, {(request.epoch, "create"): print_})
        self._records[request.instance_id] = rec
        self._report(rec, None, "create accepted")
        return Outcome(status, True)

    def get(self, instance_id: str) -> InstanceStatus:
        self._settle()
        return self._get(instance_id).status

    def reset(self, instance_id: str, request: ResetRequest) -> Outcome:
        self._settle()
        rec = self._get(instance_id)
        if not is_wire_int(request.epoch, 2):
            raise _bad("/epoch", "epoch is an integer of at least 2")
        _check_material(request.material)
        print_ = fingerprint(request.to_json())
        known = rec.prints.get((request.epoch, "reset"))
        if known is not None and request.epoch <= rec.status.epoch:
            if known != print_:
                raise RequestMismatch("same new epoch with a different body")
            return Outcome(rec.status, False)
        if rec.status.state not in RESETTABLE:
            raise InvalidState(f"reset is not allowed in state {rec.status.state.value}")
        if request.epoch != rec.status.epoch + 1:
            raise StaleEpoch("the new epoch must be the current epoch plus one")
        rec.prints[(request.epoch, "reset")] = print_
        self._move(rec, InstanceState.RESETTING, "reset accepted", epoch=request.epoch, health=Health.UNKNOWN, error_code=None)
        return Outcome(rec.status, True)

    def set_access(self, instance_id: str, access: Access, access_epoch: int) -> InstanceStatus:
        self._settle()
        rec = self._get(instance_id)
        try:
            access = Access(access)
        except ValueError as exc:
            raise _bad("/access", "access is open, frozen or closed") from exc
        if not is_wire_int(access_epoch, 0):
            raise ValidationFailed("access_epoch is an integer of at least 0", field="/access_epoch")
        if rec.status.state is InstanceState.DESTROYED:
            raise InvalidState("the instance is destroyed")
        current = rec.status
        if access_epoch < current.access_epoch or (access_epoch == current.access_epoch and access != current.access):
            raise StaleAccessEpoch("the access epoch is older, or equal with another value")
        if access_epoch > current.access_epoch or access != current.access:
            self._set(rec, access=access, access_epoch=access_epoch)
        return rec.status

    def destroy(self, instance_id: str) -> Outcome:
        self._settle()
        rec = self._get(instance_id)
        if rec.status.state in (InstanceState.DESTROYED, InstanceState.STOPPING):
            return Outcome(rec.status, False)
        self._move(rec, InstanceState.STOPPING, "destroy accepted")
        return Outcome(rec.status, True)

    def list_instances(
        self, labels: dict[str, str] | None = None, *, cursor: str | None = None, limit: int = 100
    ) -> InstancePage:
        self._settle()
        labels = dict(labels or {})
        for name in labels:
            if name not in LIST_LABELS:
                raise LabelUnknown(f"{name} is not a label filter", field="/query/" + name.replace("~", "~0").replace("/", "~1"))
        if not is_wire_int(limit, 1, 500):
            raise ValidationFailed("limit is 1 to 500", field="/query/limit")
        epoch = None
        if "instance" in labels and not INSTANCE_ID.match(str(labels["instance"])):
            raise ValidationFailed("bad instance id", field="/query/instance")
        if "epoch" in labels:
            if not _EPOCH_LABEL.match(str(labels["epoch"])):
                raise ValidationFailed("epoch is a positive integer", field="/query/epoch")
            epoch = int(labels["epoch"])
        after = None
        if cursor is not None:
            after = decode_cursor(cursor)
        items = []
        for iid in sorted(self._records):
            st = self._records[iid].status
            if after is not None and iid <= after:
                continue
            if "instance" in labels and st.instance_id != labels["instance"]:
                continue
            if epoch is not None and st.epoch != epoch:
                continue
            if "template" in labels and st.template_id != labels["template"]:
                continue
            if "component" in labels and labels["component"] not in COMPONENTS:
                continue
            if "kind" in labels and labels["kind"] != "inst":
                continue
            items.append(st)
        page, rest = items[:limit], items[limit:]
        next_cursor = None
        if rest:
            next_cursor = encode_cursor(page[-1].instance_id)
        return InstancePage(tuple(page), next_cursor)

    def host_status(self) -> HostStatus:
        self._settle()
        live = [r for r in self._records.values() if r.status.state is not InstanceState.DESTROYED]
        return HostStatus(self.host_id, "fake", self.capacity_memory_mb, self._used(), len(live), HostHealth.OK)
