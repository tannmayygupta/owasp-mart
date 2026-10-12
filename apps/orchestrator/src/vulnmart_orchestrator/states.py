"""Instance states, the transition table and the error codes of the orchestrator engine.

Mirrors the IF-5 contract (`contracts/orchestrator/orchestrator-api.md` section 3 and `orchestrator.openapi.yaml`). A test
compares the state names and the code shape with the OpenAPI file, so a change there breaks the build here.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class InstanceState(StrEnum):
    REQUESTED = "requested"
    PROVISIONING = "provisioning"
    STARTING = "starting"
    READY = "ready"
    ACTIVE = "active"
    IDLE = "idle"
    RESETTING = "resetting"
    STOPPING = "stopping"
    DESTROYED = "destroyed"
    FAILED = "failed"


S = InstanceState

# (from, to) pairs of the state machine. `None` as the from state is the first entry of an epoch (create accepted).
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
    *((frm, S.STOPPING) for frm in (S.READY, S.ACTIVE, S.IDLE, S.PROVISIONING, S.STARTING, S.REQUESTED, S.FAILED)),
    (S.STOPPING, S.DESTROYED),
})


class ErrorCode:
    """Placeholder codes until the error registry (IF-8) is merged. Shape: `^(ORCH|INST)-[A-Z0-9]+(-[A-Z0-9]+)*$`."""

    TEMPLATE_UNKNOWN = "ORCH-TEMPLATE-UNKNOWN"
    FIELD_FORBIDDEN = "ORCH-FIELD-FORBIDDEN"
    VALIDATION = "ORCH-VALIDATION"
    REQUEST_MISMATCH = "ORCH-REQUEST-MISMATCH"
    INSTANCE_EXISTS = "ORCH-INSTANCE-EXISTS"
    STALE_EPOCH = "ORCH-STALE-EPOCH"
    INSTANCE_NOT_FOUND = "ORCH-INSTANCE-NOT-FOUND"
    INVALID_STATE = "ORCH-INVALID-STATE"
    STALE_ACCESS_EPOCH = "ORCH-STALE-ACCESS-EPOCH"
    LABEL_UNKNOWN = "ORCH-LABEL-UNKNOWN"
    CURSOR_INVALID = "ORCH-CURSOR-INVALID"
    BUSY = "ORCH-BUSY"
    INJECT_BAD_DOCUMENT = "INST-INJECT-BAD-DOCUMENT"
    INJECT_SNAPSHOT_PATCH = "INST-INJECT-SNAPSHOT-PATCH"
    INJECT_PLACEMENT_WRITE = "INST-INJECT-PLACEMENT-WRITE"
    INJECT_MARKER_WRITE = "INST-INJECT-MARKER-WRITE"
    INJECT_FAILED = "INST-INJECT-FAILED"
    HEALTH_TIMEOUT = "INST-HEALTH-TIMEOUT"
    START_FAILED = "INST-START-FAILED"


# Injector exit codes (IF-6 section 5). 0 is success and has no code; any other value is a crash or a kill.
INJECTOR_EXIT_CODES: dict[int, str] = {
    10: ErrorCode.INJECT_BAD_DOCUMENT,
    11: ErrorCode.INJECT_SNAPSHOT_PATCH,
    12: ErrorCode.INJECT_PLACEMENT_WRITE,
    13: ErrorCode.INJECT_MARKER_WRITE,
}


def injector_error_code(exit_code: int) -> str:
    """The failure code for a non-zero injector exit."""
    return INJECTOR_EXIT_CODES.get(exit_code, ErrorCode.INJECT_FAILED)


class EngineError(Exception):
    """Base of the engine's refusals. `code` is the ORCH-* code."""

    code = "ORCH-ERROR"

    def __init__(self, message: str = "", field: str | None = None) -> None:
        super().__init__(message or self.code)
        self.field = field  # a JSON Pointer for a validation error, a name for a forbidden field


class TemplateUnknown(EngineError):
    code = ErrorCode.TEMPLATE_UNKNOWN


class FieldForbidden(EngineError):
    code = ErrorCode.FIELD_FORBIDDEN


class ValidationFailed(EngineError):
    code = ErrorCode.VALIDATION


class RequestMismatch(EngineError):
    code = ErrorCode.REQUEST_MISMATCH


class InstanceExists(EngineError):
    code = ErrorCode.INSTANCE_EXISTS


class StaleEpoch(EngineError):
    code = ErrorCode.STALE_EPOCH


class InstanceNotFound(EngineError):
    code = ErrorCode.INSTANCE_NOT_FOUND


class InvalidState(EngineError):
    code = ErrorCode.INVALID_STATE


class StaleAccessEpoch(EngineError):
    code = ErrorCode.STALE_ACCESS_EPOCH


class LabelUnknown(EngineError):
    code = ErrorCode.LABEL_UNKNOWN


class CursorInvalid(EngineError):
    code = ErrorCode.CURSOR_INVALID


class Busy(EngineError):
    code = ErrorCode.BUSY


@dataclass(frozen=True, slots=True)
class Transition:
    """One numbered state change. Identity is (instance_id, epoch, transition); the number restarts at 1 in a new epoch."""

    instance_id: str
    epoch: int
    transition: int
    from_state: InstanceState | None
    to_state: InstanceState
    at: str
    reason: str
    error_code: str | None
    health: str = "unknown"  # unknown, healthy or unhealthy: the health of the instance after this change


def check_transition(frm: InstanceState | None, to: InstanceState) -> None:
    if (frm, to) not in TRANSITIONS:
        raise ValueError(f"transition {frm} -> {to} is not in the IF-5 state machine")
