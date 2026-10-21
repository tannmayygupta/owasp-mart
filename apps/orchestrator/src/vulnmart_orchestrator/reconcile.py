"""The reconciler (story 3.5, spike S-13, FR-INS-05, D-55, ADR 0036).

Truth is Docker. A pass scans every object with the label `vm.kind=inst`, compares it with the engine's records and repairs the
difference. It runs once before the service answers and then about every minute. There is no database: a live instance that this
process does not know is rebuilt from its labels (adoption), and a destroyed id is kept in a small file of tombstones.

Safety rule: nothing is destroyed because a list is empty or missing. When the desired state cannot be read the pass is in safe mode:
only incomplete leftovers are removed (and expired instances are left to the reaper); complete unknown instances are adopted, and
nothing is destroyed for being unwanted. The engine refuses creates and resets (ORCH-BUSY) until a pass has worked.

Objects of an instance whose build or destroy is running in this process are never touched.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from dataclasses import field as dc_field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from .states import InstanceState as S

if TYPE_CHECKING:
    from .backend import Seen
    from .engine import InstanceRecord, Orchestrator

INSTANCE_ID = re.compile(r"^i-[A-Z2-7]{16}$")
KEEPER_ROLE = "volume-keeper"
TOMBSTONE_FILE = "tombstones.jsonl"
BUSY_STATES = (S.REQUESTED, S.PROVISIONING, S.STARTING, S.RESETTING)  # a build is (or may be) running in this process
LIVE_STATES = (S.READY, S.ACTIVE, S.IDLE)


def _log(**fields: object) -> None:
    print(json.dumps(fields, separators=(",", ":")), file=sys.stderr, flush=True)


# ---------------------------------------------------------------- desired state port


class DesiredStatePort(Protocol):
    def desired(self) -> frozenset[str] | set[str] | None:
        """The ids of the instances the platform wants on this host, or None when they cannot be read (safe mode)."""


class FakeDesiredState:
    """A desired state held in the process. `ids=None` (or `error` set) is the unreadable case. The platform's source replaces it later."""

    def __init__(self, ids: Iterable[str] | None = None, *, error: Exception | None = None) -> None:
        self.ids = None if ids is None else frozenset(ids)
        self.error = error

    def desired(self) -> frozenset[str] | None:
        if self.error is not None:
            raise self.error
        return self.ids


DESIRED_TARGET = "/internal/v1/orch/desired"
MAX_DESIRED_BODY = 256 * 1024


class HttpDesiredState:
    """The platform's list of wanted instances (contract section 8a, handoff H-123): a signed GET to `<report url>/internal/v1/orch/desired`, signed with the
    report key. Any answer but a good 200 (a network error, another status, a body that is not `{"instance_ids": [valid ids]}`, a redirect) raises, which the
    reconciler turns into safe mode: nothing is destroyed for being unwanted. `get` is injectable for tests: (url, headers, timeout) -> (status, body)."""

    def __init__(self, url: str, key: bytes, *, timeout_s: float = 5.0, get=None) -> None:
        import urllib.parse

        from .reports import check_report_url

        check_report_url(url)
        self._url = url.rstrip("/") + DESIRED_TARGET
        self._target = urllib.parse.urlsplit(url).path.rstrip("/") + DESIRED_TARGET  # the request target that is signed
        self._key, self._timeout, self._get = key, timeout_s, get or self._http_get

    @staticmethod
    def _http_get(url: str, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
        import urllib.error
        import urllib.request

        from .reports import _NoRedirect

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            with opener.open(urllib.request.Request(url, method="GET", headers=headers), timeout=timeout) as resp:
                return resp.status, resp.read(MAX_DESIRED_BODY + 1)
        except urllib.error.HTTPError as err:
            try:
                return err.code, b""
            finally:
                err.close()

    def desired(self) -> frozenset[str]:
        import secrets

        from .auth import body_sha256, sign

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        nonce = secrets.token_hex(16)
        headers = {"X-VM-Timestamp": ts, "X-VM-Nonce": nonce, "X-VM-Signature": sign(self._key, "GET", self._target, ts, nonce, body_sha256(b""))}
        status, body = self._get(self._url, headers, self._timeout)
        if status != 200:
            raise RuntimeError(f"desired state: status {status}")
        if len(body) > MAX_DESIRED_BODY:
            raise RuntimeError("desired state: body too large")
        data = json.loads(body)
        ids = data.get("instance_ids") if isinstance(data, dict) and set(data) == {"instance_ids"} else None
        if not isinstance(ids, list) or len(ids) > 1000 or not all(isinstance(i, str) and INSTANCE_ID.fullmatch(i) for i in ids):
            raise RuntimeError("desired state: the body is not a list of instance ids")
        return frozenset(ids)


class _Everything(frozenset):
    """Contains every id: nothing is ever unwanted."""

    def __contains__(self, item: object) -> bool:
        return True


class AllWantedDesiredState:
    """The port of the service until the platform has a source (handoff H-67 follow-up): every instance is wanted, so the reconciler
    adopts what it finds and removes broken leftovers, and never destroys an instance for being unwanted."""

    def desired(self) -> frozenset[str]:
        return _Everything()


# ---------------------------------------------------------------- tombstones


class TombstoneStore:
    """Destroyed instance ids, one JSON line each (instance id, epoch, time; nothing secret), appended atomically. In memory only when
    no state directory is given. A torn or unreadable line is skipped when the file is read."""

    def __init__(self, state_dir: str | os.PathLike[str] | None = None) -> None:
        self._lock = threading.Lock()
        self._ids: dict[str, tuple[int, str]] = {}
        self._path: Path | None = None
        if state_dir:
            try:
                directory = Path(state_dir)
                directory.mkdir(parents=True, exist_ok=True)
                self._path = directory / TOMBSTONE_FILE
                self._load()
            except OSError as ex:  # the service still starts: ids are refused in memory, but not after the next restart
                _log(event="tombstones-unavailable", error=type(ex).__name__)
                self._path = None

    def _load(self) -> None:
        assert self._path is not None
        if not self._path.exists():
            return
        for line in self._path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                row = json.loads(line)
                iid, epoch, at = row["instance_id"], row["epoch"], row["at"]
            except (ValueError, KeyError, TypeError):
                continue
            if isinstance(iid, str) and INSTANCE_ID.fullmatch(iid) and type(epoch) is int and isinstance(at, str):
                self._ids[iid] = (epoch, at)

    def has(self, instance_id: str) -> bool:
        with self._lock:
            return instance_id in self._ids

    def ids(self) -> frozenset[str]:
        with self._lock:
            return frozenset(self._ids)

    def add(self, instance_id: str, epoch: int, at: str) -> None:
        with self._lock:
            if instance_id in self._ids:
                return
            self._ids[instance_id] = (epoch, at)
            if self._path is None:
                return
            line = (json.dumps({"instance_id": instance_id, "epoch": epoch, "at": at}, separators=(",", ":")) + "\n").encode()
            fd = os.open(self._path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                view = memoryview(line)
                while view:  # a short write is continued until the whole line is out
                    view = view[os.write(fd, view):]
                os.fsync(fd)
            finally:
                os.close(fd)


# ---------------------------------------------------------------- the pass


@dataclass
class ReconcileResult:
    safe_mode: bool = False
    adopted: list[str] = dc_field(default_factory=list)
    failed: list[str] = dc_field(default_factory=list)
    destroyed: list[str] = dc_field(default_factory=list)
    swept: list[str] = dc_field(default_factory=list)
    skipped: list[str] = dc_field(default_factory=list)
    errors: list[str] = dc_field(default_factory=list)


def _int(value: str | None) -> int | None:
    return int(value) if value is not None and value.isascii() and value.isdigit() else None


def _parse_time(value: str | None) -> datetime | None:
    try:
        return datetime.strptime(value or "", "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class Reconciler:
    def __init__(self, engine: Orchestrator, port: DesiredStatePort, *, unwanted_passes: int = 1) -> None:
        self.engine, self.port = engine, port
        # An instance is destroyed for being unlisted only after it was unlisted in this many passes in a row (the service uses 2: a create accepted a moment
        # before the platform noted its id is never destroyed by one pass).
        self.unwanted_passes = max(1, unwanted_passes)
        self._unlisted: dict[str, int] = {}
        self._pass_lock = threading.Lock()  # one pass at a time

    def run_once(self, execute: Callable[[Callable[[], None]], None] | None = None) -> ReconcileResult:
        """One pass. `execute` runs a destroy's slow work (a worker thread in the service); by default it runs here. A backend error
        while listing Docker is raised (nothing was changed and the engine stays closed to creates until a pass works)."""
        with self._pass_lock:
            e = self.engine
            seen = e.backend.scan()
            result = ReconcileResult()
            try:
                desired = self.port.desired()
            except Exception as ex:  # the source is down: safe mode, logged by class name only
                _log(event="reconcile-desired-failed", error=type(ex).__name__)
                desired = None
            result.safe_mode = desired is None
            groups: dict[str, list[Seen]] = {}
            for o in seen:
                iid = o.labels.get("vm.instance", "")
                if INSTANCE_ID.fullmatch(iid):
                    groups.setdefault(iid, []).append(o)
            with e._lock:
                ids = set(groups) | {i for i, r in e.records.items() if r.state is not S.DESTROYED}
            for iid in sorted(ids):
                try:
                    self._one(iid, groups.get(iid, []), desired, result, execute)
                except Exception as ex:  # one instance never stops the pass: the others are still repaired
                    result.errors.append(f"{iid}:{type(ex).__name__}")
                    _log(event="reconcile-instance-failed", instance=iid, error=type(ex).__name__)
            e._set_reconciled(safe=result.safe_mode, ok=not result.errors)
            return result

    # ------------------------------------------------------------ one instance

    def _one(self, iid: str, objs: list[Seen], desired, result: ReconcileResult, execute) -> None:
        e = self.engine
        with e._lock:
            rec = e.records.get(iid)
            if rec is not None and (rec.state in BUSY_STATES or rec.destroying or rec.retrying):
                result.skipped.append(iid)  # its build or destroy is running in this process
                return
        if rec is None:
            self._unknown(iid, objs, desired, result, execute)
        elif rec.state is S.DESTROYED:
            if objs:  # a late call or a failed removal left something behind
                self._sweep(iid, None, result, lambda: self._idle(rec))
        else:
            self._known(rec, objs, desired, result, execute)

    def _unwanted(self, iid: str, desired) -> bool:
        """True when the instance is not listed and has been missing from `unwanted_passes` passes in a row. Safe mode (`desired` None) never says yes and forgets the count."""
        if desired is None:
            self._unlisted.clear()
            return False
        if iid in desired:
            self._unlisted.pop(iid, None)
            return False
        n = self._unlisted.get(iid, 0) + 1
        self._unlisted[iid] = n
        if n >= self.unwanted_passes:
            self._unlisted.pop(iid, None)
            return True
        return False

    def _unrecorded(self, iid: str) -> bool:
        with self.engine._lock:
            return iid not in self.engine.records

    def _idle(self, rec: InstanceRecord) -> bool:
        with self.engine._lock:
            return rec.state not in BUSY_STATES and not rec.destroying and not rec.retrying

    def _sweep(self, iid: str, epoch: int | None, result: ReconcileResult, guard: Callable[[], bool]) -> bool:
        """Remove the objects, unless `guard` (checked right before, under the engine lock) says a create or reset has begun since the
        pass looked at the records: then nothing is removed and the instance is skipped."""
        if not guard():
            result.skipped.append(iid)
            return False
        self.engine._sweep(iid, epoch)
        result.swept.append(iid if epoch is None else f"{iid}@{epoch}")
        return True

    def _sweep_stale(self, iid: str, objs: list[Seen], current: int, result: ReconcileResult, guard: Callable[[], bool]) -> bool:
        """Objects of an epoch other than the current one are leftovers of a reset or a failed attempt."""
        for ep in sorted({n for n in (_int(o.labels.get("vm.epoch")) for o in objs) if n is not None and n != current}):
            if not self._sweep(iid, ep, result, guard):
                return False
        return True

    def _destroy(self, rec: InstanceRecord, reason: str, result: ReconcileResult, execute) -> None:
        from .states import InvalidState

        e = self.engine
        try:
            accepted = e.accept_destroy(rec.instance_id, f"destroy by the reconciler: {reason}")
        except InvalidState:
            return
        result.destroyed.append(rec.instance_id)
        if accepted.work is None:
            return
        if execute is None:
            accepted.work()
            return
        try:
            execute(accepted.work)
        except Exception:
            e.release_destroy(rec)  # the next pass tries again
            raise

    def _known(self, rec: InstanceRecord, objs: list[Seen], desired, result: ReconcileResult, execute) -> None:
        e = self.engine
        iid = rec.instance_id
        guard = lambda: self._idle(rec)  # noqa: E731
        if not self._sweep_stale(iid, objs, rec.epoch, result, guard):
            return
        current = [o for o in objs if _int(o.labels.get("vm.epoch")) == rec.epoch]
        if rec.state is S.FAILED:
            if current:
                self._sweep(iid, rec.epoch, result, guard)
            return
        if rec.state not in LIVE_STATES:
            _log(event="reconcile-state-not-handled", instance=iid, state=rec.state.value)  # stopping: the reaper retries the removal
            return
        if not current and e.backend.find(iid, rec.epoch).empty:  # checked again: the scan may be older than the build
            self._destroy(rec, "no object of the instance is left in Docker", result, execute)
            return
        template = e.templates.get(rec.template_id)
        if template is not None:
            verdict = self._assess(template, current)
            if verdict == "transient":
                _log(event="reconcile-transient", instance=iid)  # restarting, paused or still starting: look again next pass
                result.skipped.append(iid)
                return
            if verdict == "incomplete":  # some objects are there, others are not: it will not heal by itself
                if e.mark_incomplete(rec) and self._sweep(iid, None, result, guard):
                    result.failed.append(iid)
                return
        if self._unwanted(iid, desired):
            self._destroy(rec, "the platform does not list the instance", result, execute)

    def _unknown(self, iid: str, objs: list[Seen], desired, result: ReconcileResult, execute) -> None:
        e = self.engine
        guard = lambda: self._unrecorded(iid)  # noqa: E731
        if e.tombstones.has(iid) or not any(o.kind == "container" for o in objs):
            self._sweep(iid, None, result, guard)  # a destroyed id, or an empty network or volume: nothing to repair, remove it
            return
        epochs = [n for n in (_int(o.labels.get("vm.epoch")) for o in objs) if n is not None]
        if not epochs:
            self._sweep(iid, None, result, guard)
            return
        current = max(epochs)
        if not self._sweep_stale(iid, objs, current, result, guard):
            return
        mine = [o for o in objs if _int(o.labels.get("vm.epoch")) == current]
        label = lambda key: next((o.labels[key] for o in mine if o.labels.get(key)), "")  # noqa: E731
        template_id = label("vm.template")
        template = e.templates.get(template_id)
        if template is None:
            _log(event="reconcile-unknown-template", instance=iid)  # cannot judge it: leave it alone
            result.skipped.append(iid)
            return
        verdict = self._assess(template, mine)
        if verdict == "transient":
            _log(event="reconcile-transient", instance=iid)
            result.skipped.append(iid)
            return
        raw = label("vm.expires")
        expires = _parse_time(raw)
        if expires is None:
            _log(event="reconcile-expiry-label", instance=iid, problem="missing" if not raw else "unparseable")
        rec = e.register_found(iid, current, template_id, label("vm.host"), expires=expires, ready=verdict == "complete", owner=label("vm.owner"))
        if rec is None:  # a create was accepted since the records were read: its worker owns the objects
            result.skipped.append(iid)
            return
        if verdict == "incomplete":
            self._sweep(iid, None, result, lambda: True)  # the record is ours now (registered above under the engine lock)
            result.failed.append(iid)
            return
        result.adopted.append(iid)
        if self._unwanted(iid, desired):
            self._destroy(rec, "the platform does not list the instance", result, execute)

    @staticmethod
    def _assess(template: dict, mine: list[Seen]) -> str:
        """`transient`: a container is restarting, paused, being removed or its health is still starting (leave it, look again).
        `incomplete`: a component is missing, appears twice, is not running or is unhealthy, the injector is still there, or the network
        or a volume is missing. `complete`: every expected component runs exactly once and is healthy (or has no healthcheck)."""
        containers = [o for o in mine if o.kind == "container"]
        if any(o.status in ("restarting", "paused", "removing") or o.health == "starting" for o in containers):
            return "transient"
        by_component: dict[str | None, list[Seen]] = {}
        for o in containers:
            by_component.setdefault(o.labels.get("vm.component"), []).append(o)
        if any(c["name"] in by_component for c in template["components"] if c["role"] == "injector"):
            return "incomplete"
        expected = {c["name"] for c in template["components"] if c["role"] != "injector"} | {KEEPER_ROLE}
        for name in expected:
            found = by_component.get(name, [])
            if len(found) != 1 or found[0].status != "running" or found[0].health not in (None, "", "none", "healthy"):
                return "incomplete"
        if not any(o.kind == "network" for o in mine):
            return "incomplete"
        volumes = {o.labels.get("vm.component") for o in mine if o.kind == "volume"}
        return "complete" if {f"volume-{v['name']}" for v in template["volumes"]} <= volumes else "incomplete"