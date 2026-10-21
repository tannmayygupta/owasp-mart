"""Receiver of the orchestrator's state reports: `POST /internal/v1/orch/state` (IF-5 section 8, handoff H-16, decision F-3).

Mounted by the ingest entrypoint only when the lab runtime is on AND `VULNMART_ORCH_REPORT_KEY_FILE` is set (a file with the orchestrator
signing key, 32 or more characters, mode 0600 or stricter on POSIX). Memory only (D-96): a restart forgets the history, and the orchestrator
sends its reports again (at least once).

Order of checks (IF-5 section 6): body over 64 KiB is 413 and not read further; the signature (headers `X-VM-Timestamp`, `X-VM-Nonce`,
`X-VM-Signature`, 60 s window, nonces remembered 5 min, constant-time compare) is 401 ORCH-BAD-SIGNATURE without a hint which check failed;
a body that is not application/json is 415; a body that `parse_state_report` refuses is 422 ORCH-VALIDATION. Then, per identity
`(instance_id, epoch, transition)`: new 204, identical repeat 200, another body 409 ORCH-REQUEST-MISMATCH.

A report is a claim and is checked against the 10-state machine. An impossible `(from_state, to_state)` pair is answered 204 like any valid
report (it is valid IF-5), stored as history, does NOT move the recorded state of the instance, and logs one warning (decision F-3). A
report with a lower `(epoch, transition)` than the highest seen is history too: the state never moves backwards.

Nothing secret is logged or answered: log lines hold instance ids, numbers, state words and HTTP statuses, never the key, a signature or the
free-text `reason`.
"""
from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from vulnmart_models.error_codes import ErrorCode

from vulnmart.problem import ProblemError
from vulnmart.ports.http_instance_host import MIN_KEY_LENGTH, NonceCache, parse_state_report, verify_request
from vulnmart.ports.instance_host import BadSignature, InstanceState, ReportIngest, RequestMismatch, StateReport, ValidationFailed

if TYPE_CHECKING:
    from vulnmart.lab.runtime import LabRuntime

log = logging.getLogger("vulnmart.lab.state_reports")

ROUTE = "/internal/v1/orch/state"
DESIRED_ROUTE = "/internal/v1/orch/desired"
MAX_BODY_BYTES = 64 * 1024
KEY_FILE_VAR = "VULNMART_ORCH_REPORT_KEY_FILE"

S = InstanceState
# (from, to) pairs of the 10-state machine of IF-5 section 3; `None` is the first report of an epoch. A test compares this table with the
# orchestrator's own (apps/orchestrator/src/vulnmart_orchestrator/states.py), so a change on one side breaks the build on the other.
TRANSITIONS: frozenset[tuple[InstanceState | None, InstanceState]] = frozenset({
    (None, S.REQUESTED),
    (S.REQUESTED, S.PROVISIONING),
    (S.PROVISIONING, S.STARTING),
    (S.STARTING, S.READY),
    (S.READY, S.ACTIVE),
    (S.ACTIVE, S.IDLE),
    (S.IDLE, S.ACTIVE),
    (S.READY, S.RESETTING),
    (S.ACTIVE, S.RESETTING),
    (S.IDLE, S.RESETTING),
    (S.RESETTING, S.PROVISIONING),
    (S.PROVISIONING, S.FAILED),
    (S.STARTING, S.FAILED),
    (S.FAILED, S.PROVISIONING),
    (S.FAILED, S.DESTROYED),
    *((frm, S.STOPPING) for frm in (S.READY, S.ACTIVE, S.IDLE, S.RESETTING, S.PROVISIONING, S.STARTING, S.REQUESTED, S.FAILED)),
    (S.STOPPING, S.DESTROYED),
})


@dataclass(frozen=True, slots=True)
class Recorded:
    """What `StateReportStore.record` did with a new report."""

    new: bool            # False: an identical repeat (answer 200)
    possible: bool       # False: the pair is not in the state machine
    moved: bool          # True: the recorded state of the instance now is this report's `to_state`


class StateReportStore:
    """History of every report per `(instance_id, epoch, transition)` and the recorded state per instance. Thread-safe, memory only."""

    def __init__(self) -> None:
        self._ingest = ReportIngest()
        self._state: dict[str, tuple[int, int, InstanceState]] = {}
        self._lock = threading.Lock()

    def record(self, report: StateReport) -> Recorded:
        """Raises RequestMismatch for the same identity with another body."""
        with self._lock:
            if not self._ingest.accept(report):
                return Recorded(new=False, possible=(report.from_state, report.to_state) in TRANSITIONS, moved=False)
            possible = (report.from_state, report.to_state) in TRANSITIONS
            top = self._state.get(report.instance_id)
            # `destroyed` is the end: no later report resurrects an instance (review finding A7)
            moved = possible and (top is None or (top[2] is not InstanceState.DESTROYED and (report.epoch, report.transition) > (top[0], top[1])))
            if moved:
                self._state[report.instance_id] = (report.epoch, report.transition, report.to_state)
            return Recorded(new=True, possible=possible, moved=moved)

    def state_of(self, instance_id: str) -> InstanceState | None:
        with self._lock:
            entry = self._state.get(instance_id)
        return entry[2] if entry else None

    def states(self) -> dict[str, str]:
        """instance id -> recorded state word, a copy."""
        with self._lock:
            return {i: e[2].value for i, e in self._state.items()}

    def history(self, instance_id: str) -> list[StateReport]:
        return self._ingest.history(instance_id)


def read_report_key(path: str) -> bytes:
    """The orchestrator key from a file. On POSIX a file readable or writable by group or others is refused (the orchestrator's own rule);
    Windows has no such mode bits. Raises ValueError or OSError; the message never holds the key."""
    st = os.stat(path)
    if os.name != "nt" and st.st_mode & 0o077:
        raise ValueError(f"{KEY_FILE_VAR} file {path} has mode {st.st_mode & 0o777:03o}: it must be 0600 or stricter (chmod 600)")
    key = Path(path).read_text(encoding="utf-8").strip().encode()
    if len(key) < MIN_KEY_LENGTH:
        raise ValueError(f"the report key must be at least {MIN_KEY_LENGTH} characters")
    return key


def install_state_report_route(app: FastAPI, store: StateReportStore, key: bytes, *, nonces: NonceCache | None = None,
                               on_moved: Callable[[StateReport], None] | None = None) -> None:
    cache = nonces or NonceCache()

    @app.post(ROUTE, include_in_schema=False)
    async def post_state(request: Request) -> Response:
        declared = request.headers.get("content-length", "")
        if declared.isascii() and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            raise ProblemError(ErrorCode.ORCH_BODY_TOO_LARGE, headers={"Connection": "close"})
        chunks: list[bytes] = []
        size = 0
        async for part in request.stream():
            size += len(part)
            if size > MAX_BODY_BYTES:
                raise ProblemError(ErrorCode.ORCH_BODY_TOO_LARGE, headers={"Connection": "close"})
            chunks.append(part)
        body = b"".join(chunks)

        raw_path = request.scope.get("raw_path") or request.scope["path"].encode()
        target = raw_path.decode("latin-1")
        query = request.scope.get("query_string", b"")
        if query:
            target += "?" + query.decode("latin-1")
        try:
            verify_request(key, request.method, target, request.headers, body, nonces=cache)
        except BadSignature:
            log.warning("state report refused: bad signature")
            raise ProblemError(ErrorCode.ORCH_BAD_SIGNATURE) from None

        if not request.headers.get("content-type", "").lower().startswith("application/json"):
            raise ProblemError(ErrorCode.ORCH_UNSUPPORTED_MEDIA_TYPE)
        try:
            report = parse_state_report(body)
        except ValidationFailed:
            raise ProblemError(ErrorCode.ORCH_VALIDATION) from None
        try:
            result = store.record(report)
        except RequestMismatch:
            log.warning("state report refused: the identity %s epoch %d transition %d came with another body",
                        report.instance_id[:32], report.epoch, report.transition)
            raise ProblemError(ErrorCode.ORCH_REQUEST_MISMATCH) from None
        if result.new and not result.possible:
            log.warning("impossible state transition reported (stored as history, state not moved): instance %s epoch %d transition %d %s -> %s",
                        report.instance_id[:32], report.epoch, report.transition,
                        report.from_state.value if report.from_state else "none", report.to_state.value)
        if result.moved and on_moved is not None:
            try:
                on_moved(report)  # the live hub hears about the new state (handoff H-142); never part of the answer to the orchestrator
            except Exception:
                log.warning("announcing the instance state failed", exc_info=True)
        return Response(status_code=204 if result.new else 200, headers={"Cache-Control": "private, no-store"})


def wanted_instance_ids(runtime: "LabRuntime") -> list[str]:
    """The instances the platform wants on its hosts (handoff H-123, contract section 8a): the instance of every attempt that is ready or running, and every
    instance whose start is under way (`_starting`, set before the create is sent), sorted. Instances of submitted, expired, cancelled or deleted attempts are
    not wanted: the orchestrator removes them if they are still there. Raises when the attempt store cannot be read (the route then answers 503: safe mode)."""
    from vulnmart.ports.attempts import AttemptState

    ids: set[str] = set(runtime._starting.values())  # noqa: SLF001 - the runtime and this receiver are one package
    for rec in runtime.engine.in_states(AttemptState.READY, AttemptState.RUNNING):
        if rec.instance_id:
            ids.add(rec.instance_id)
    return sorted(ids)


def install_desired_route(app: FastAPI, runtime: "LabRuntime", key: bytes, *, nonces: NonceCache | None = None) -> None:
    """`GET /internal/v1/orch/desired`, signed with the orchestrator key like a state report (empty body)."""
    cache = nonces or NonceCache()

    @app.get(DESIRED_ROUTE, include_in_schema=False)
    async def get_desired(request: Request) -> Response:
        raw_path = request.scope.get("raw_path") or request.scope["path"].encode()
        target = raw_path.decode("latin-1")
        query = request.scope.get("query_string", b"")
        if query:
            target += "?" + query.decode("latin-1")
        try:
            verify_request(key, request.method, target, request.headers, b"", nonces=cache)
        except BadSignature:
            log.warning("desired-state request refused: bad signature")
            raise ProblemError(ErrorCode.ORCH_BAD_SIGNATURE) from None
        try:
            ids = wanted_instance_ids(runtime)
        except Exception:
            log.exception("the wanted instances cannot be listed")
            return Response(status_code=503, headers={"Cache-Control": "private, no-store"})  # the orchestrator stays in safe mode
        return JSONResponse({"instance_ids": ids}, headers={"Cache-Control": "private, no-store"})


def install_state_reports(app: FastAPI, runtime: "LabRuntime", environ: Mapping[str, str] | None = None) -> bool:
    """Mount the route when `VULNMART_ORCH_REPORT_KEY_FILE` is set. Returns False and mounts nothing when it is not; a key file that
    cannot be used raises (the service must not start with a receiver that cannot verify)."""
    env = os.environ if environ is None else environ
    path = env.get(KEY_FILE_VAR, "")
    if not path:
        return False
    key = read_report_key(path)
    nonces = NonceCache()  # one memory for both routes: a nonce is never accepted twice on either
    install_state_report_route(app, runtime.state_reports, key, nonces=nonces, on_moved=runtime.announce_instance)
    install_desired_route(app, runtime, key, nonces=nonces)
    return True
