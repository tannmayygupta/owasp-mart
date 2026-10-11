"""GENERATED from contracts/errors/error-codes.yaml. Do not edit: run `node scripts/generate-error-codes.mjs`.

Error registry (IF-8) version 0.1.0.
"""

from dataclasses import dataclass
from enum import StrEnum

REGISTRY_VERSION = "0.1.0"
PROBLEM_TYPE_PREFIX = "urn:vulnmart:error:"


class ErrorCode(StrEnum):
    ATT_CHALLENGE_NOT_FOUND = "ATT-CHALLENGE-NOT-FOUND"
    ATT_FLAG_RATE_LIMITED = "ATT-FLAG-RATE-LIMITED"
    ATT_HINTS_DISABLED = "ATT-HINTS-DISABLED"
    ATT_INVALID_STATE = "ATT-INVALID-STATE"
    ATT_NOT_FOUND = "ATT-NOT-FOUND"
    AUTH_CSRF_FAILED = "AUTH-CSRF-FAILED"
    AUTH_ORIGIN_FORBIDDEN = "AUTH-ORIGIN-FORBIDDEN"
    AUTH_SESSION_REQUIRED = "AUTH-SESSION-REQUIRED"
    EVT_BAD_SIGNATURE = "EVT-BAD-SIGNATURE"
    EVT_DUPLICATE_MISMATCH = "EVT-DUPLICATE-MISMATCH"
    EVT_SCHEMA = "EVT-SCHEMA"
    EVT_STORE_FULL = "EVT-STORE-FULL"
    EVT_TOO_LARGE = "EVT-TOO-LARGE"
    INST_HEALTH_TIMEOUT = "INST-HEALTH-TIMEOUT"
    INST_INJECT_BAD_DOCUMENT = "INST-INJECT-BAD-DOCUMENT"
    INST_INJECT_FAILED = "INST-INJECT-FAILED"
    INST_INJECT_MARKER_WRITE = "INST-INJECT-MARKER-WRITE"
    INST_INJECT_PLACEMENT_WRITE = "INST-INJECT-PLACEMENT-WRITE"
    INST_INJECT_SNAPSHOT_PATCH = "INST-INJECT-SNAPSHOT-PATCH"
    INST_INVALID_STATE = "INST-INVALID-STATE"
    INST_LOST = "INST-LOST"
    INST_NOT_FOUND = "INST-NOT-FOUND"
    INST_NOT_READY = "INST-NOT-READY"
    INST_QUOTA_REACHED = "INST-QUOTA-REACHED"
    ORCH_BAD_SIGNATURE = "ORCH-BAD-SIGNATURE"
    ORCH_BODY_TOO_LARGE = "ORCH-BODY-TOO-LARGE"
    ORCH_BUSY = "ORCH-BUSY"
    ORCH_FIELD_FORBIDDEN = "ORCH-FIELD-FORBIDDEN"
    ORCH_INSTANCE_EXISTS = "ORCH-INSTANCE-EXISTS"
    ORCH_INSTANCE_NOT_FOUND = "ORCH-INSTANCE-NOT-FOUND"
    ORCH_INTERNAL = "ORCH-INTERNAL"
    ORCH_INVALID_STATE = "ORCH-INVALID-STATE"
    ORCH_LABEL_UNKNOWN = "ORCH-LABEL-UNKNOWN"
    ORCH_METHOD_NOT_ALLOWED = "ORCH-METHOD-NOT-ALLOWED"
    ORCH_RATE_LIMITED = "ORCH-RATE-LIMITED"
    ORCH_REQUEST_MISMATCH = "ORCH-REQUEST-MISMATCH"
    ORCH_ROUTE_UNKNOWN = "ORCH-ROUTE-UNKNOWN"
    ORCH_STALE_ACCESS_EPOCH = "ORCH-STALE-ACCESS-EPOCH"
    ORCH_STALE_EPOCH = "ORCH-STALE-EPOCH"
    ORCH_TEMPLATE_UNKNOWN = "ORCH-TEMPLATE-UNKNOWN"
    ORCH_UNAVAILABLE = "ORCH-UNAVAILABLE"
    ORCH_VALIDATION = "ORCH-VALIDATION"
    REQ_INTERNAL = "REQ-INTERNAL"
    REQ_METHOD_NOT_ALLOWED = "REQ-METHOD-NOT-ALLOWED"
    REQ_ROUTE_UNKNOWN = "REQ-ROUTE-UNKNOWN"
    REQ_TOO_LARGE = "REQ-TOO-LARGE"
    REQ_UNSUPPORTED_MEDIA_TYPE = "REQ-UNSUPPORTED-MEDIA-TYPE"
    REQ_VALIDATION = "REQ-VALIDATION"


@dataclass(frozen=True)
class ErrorInfo:
    code: ErrorCode
    status: int | None  # HTTP status, or None when the code is never sent as an HTTP answer
    title: str  # the fixed, generic text sent to clients
    retryable: bool
    exit_code: int | None = None


ERRORS: dict[ErrorCode, ErrorInfo] = {
    ErrorCode.ATT_CHALLENGE_NOT_FOUND: ErrorInfo(ErrorCode.ATT_CHALLENGE_NOT_FOUND, 404, "Challenge not found.", False),
    ErrorCode.ATT_FLAG_RATE_LIMITED: ErrorInfo(ErrorCode.ATT_FLAG_RATE_LIMITED, 429, "Too many attempts. Try again later.", True),
    ErrorCode.ATT_HINTS_DISABLED: ErrorInfo(ErrorCode.ATT_HINTS_DISABLED, 404, "Hints are not available for this attempt.", False),
    ErrorCode.ATT_INVALID_STATE: ErrorInfo(ErrorCode.ATT_INVALID_STATE, 409, "This action is not allowed in the attempt's current state.", False),
    ErrorCode.ATT_NOT_FOUND: ErrorInfo(ErrorCode.ATT_NOT_FOUND, 404, "Attempt not found.", False),
    ErrorCode.AUTH_CSRF_FAILED: ErrorInfo(ErrorCode.AUTH_CSRF_FAILED, 403, "The request could not be verified.", False),
    ErrorCode.AUTH_ORIGIN_FORBIDDEN: ErrorInfo(ErrorCode.AUTH_ORIGIN_FORBIDDEN, 403, "The request origin is not allowed.", False),
    ErrorCode.AUTH_SESSION_REQUIRED: ErrorInfo(ErrorCode.AUTH_SESSION_REQUIRED, 401, "Sign in to continue.", False),
    ErrorCode.EVT_BAD_SIGNATURE: ErrorInfo(ErrorCode.EVT_BAD_SIGNATURE, 401, "The event could not be authenticated.", False),
    ErrorCode.EVT_DUPLICATE_MISMATCH: ErrorInfo(ErrorCode.EVT_DUPLICATE_MISMATCH, 409, "An event with this identity was already accepted with different content.", False),
    ErrorCode.EVT_SCHEMA: ErrorInfo(ErrorCode.EVT_SCHEMA, 422, "The event is not valid.", False),
    ErrorCode.EVT_STORE_FULL: ErrorInfo(ErrorCode.EVT_STORE_FULL, 503, "The event store is full.", True),
    ErrorCode.EVT_TOO_LARGE: ErrorInfo(ErrorCode.EVT_TOO_LARGE, 413, "The event is too large.", False),
    ErrorCode.INST_HEALTH_TIMEOUT: ErrorInfo(ErrorCode.INST_HEALTH_TIMEOUT, None, "The instance did not become healthy in time.", True),
    ErrorCode.INST_INJECT_BAD_DOCUMENT: ErrorInfo(ErrorCode.INST_INJECT_BAD_DOCUMENT, None, "The injection document is missing or not valid.", False, exit_code=10),
    ErrorCode.INST_INJECT_FAILED: ErrorInfo(ErrorCode.INST_INJECT_FAILED, None, "The injector failed.", False),
    ErrorCode.INST_INJECT_MARKER_WRITE: ErrorInfo(ErrorCode.INST_INJECT_MARKER_WRITE, None, "The flags file or the marker could not be written.", False, exit_code=13),
    ErrorCode.INST_INJECT_PLACEMENT_WRITE: ErrorInfo(ErrorCode.INST_INJECT_PLACEMENT_WRITE, None, "A placement file could not be written.", False, exit_code=12),
    ErrorCode.INST_INJECT_SNAPSHOT_PATCH: ErrorInfo(ErrorCode.INST_INJECT_SNAPSHOT_PATCH, None, "The snapshot patch failed.", False, exit_code=11),
    ErrorCode.INST_INVALID_STATE: ErrorInfo(ErrorCode.INST_INVALID_STATE, 409, "This action is not allowed in the instance's current state.", False),
    ErrorCode.INST_LOST: ErrorInfo(ErrorCode.INST_LOST, None, "The instance was lost.", False),
    ErrorCode.INST_NOT_FOUND: ErrorInfo(ErrorCode.INST_NOT_FOUND, 404, "Instance not found.", False),
    ErrorCode.INST_NOT_READY: ErrorInfo(ErrorCode.INST_NOT_READY, 409, "The instance is not ready yet.", True),
    ErrorCode.INST_QUOTA_REACHED: ErrorInfo(ErrorCode.INST_QUOTA_REACHED, 409, "The instance limit has been reached.", False),
    ErrorCode.ORCH_BAD_SIGNATURE: ErrorInfo(ErrorCode.ORCH_BAD_SIGNATURE, 401, "The request could not be authenticated.", False),
    ErrorCode.ORCH_BODY_TOO_LARGE: ErrorInfo(ErrorCode.ORCH_BODY_TOO_LARGE, 413, "The request body is too large.", False),
    ErrorCode.ORCH_BUSY: ErrorInfo(ErrorCode.ORCH_BUSY, 429, "No capacity is available right now.", True),
    ErrorCode.ORCH_FIELD_FORBIDDEN: ErrorInfo(ErrorCode.ORCH_FIELD_FORBIDDEN, 422, "The request names a field that is not allowed.", False),
    ErrorCode.ORCH_INSTANCE_EXISTS: ErrorInfo(ErrorCode.ORCH_INSTANCE_EXISTS, 409, "An instance with this identity already exists.", False),
    ErrorCode.ORCH_INSTANCE_NOT_FOUND: ErrorInfo(ErrorCode.ORCH_INSTANCE_NOT_FOUND, 404, "Instance not found.", False),
    ErrorCode.ORCH_INTERNAL: ErrorInfo(ErrorCode.ORCH_INTERNAL, 500, "Internal error.", True),
    ErrorCode.ORCH_INVALID_STATE: ErrorInfo(ErrorCode.ORCH_INVALID_STATE, 409, "This action is not allowed in the instance's current state.", False),
    ErrorCode.ORCH_LABEL_UNKNOWN: ErrorInfo(ErrorCode.ORCH_LABEL_UNKNOWN, 422, "The label filter is not known.", False),
    ErrorCode.ORCH_METHOD_NOT_ALLOWED: ErrorInfo(ErrorCode.ORCH_METHOD_NOT_ALLOWED, 405, "Method not allowed.", False),
    ErrorCode.ORCH_RATE_LIMITED: ErrorInfo(ErrorCode.ORCH_RATE_LIMITED, 429, "Too many requests. Try again later.", True),
    ErrorCode.ORCH_REQUEST_MISMATCH: ErrorInfo(ErrorCode.ORCH_REQUEST_MISMATCH, 409, "This request identity was already used with different content.", False),
    ErrorCode.ORCH_ROUTE_UNKNOWN: ErrorInfo(ErrorCode.ORCH_ROUTE_UNKNOWN, 404, "Route not found.", False),
    ErrorCode.ORCH_STALE_ACCESS_EPOCH: ErrorInfo(ErrorCode.ORCH_STALE_ACCESS_EPOCH, 409, "The access epoch is out of date.", False),
    ErrorCode.ORCH_STALE_EPOCH: ErrorInfo(ErrorCode.ORCH_STALE_EPOCH, 409, "The epoch is out of date.", False),
    ErrorCode.ORCH_TEMPLATE_UNKNOWN: ErrorInfo(ErrorCode.ORCH_TEMPLATE_UNKNOWN, 422, "The template is not known.", False),
    ErrorCode.ORCH_UNAVAILABLE: ErrorInfo(ErrorCode.ORCH_UNAVAILABLE, 503, "The orchestrator could not be reached or understood.", True),
    ErrorCode.ORCH_VALIDATION: ErrorInfo(ErrorCode.ORCH_VALIDATION, 422, "The request is not valid.", False),
    ErrorCode.REQ_INTERNAL: ErrorInfo(ErrorCode.REQ_INTERNAL, 500, "Something went wrong. Try again later.", True),
    ErrorCode.REQ_METHOD_NOT_ALLOWED: ErrorInfo(ErrorCode.REQ_METHOD_NOT_ALLOWED, 405, "Method not allowed.", False),
    ErrorCode.REQ_ROUTE_UNKNOWN: ErrorInfo(ErrorCode.REQ_ROUTE_UNKNOWN, 404, "Route not found.", False),
    ErrorCode.REQ_TOO_LARGE: ErrorInfo(ErrorCode.REQ_TOO_LARGE, 413, "The request body is too large.", False),
    ErrorCode.REQ_UNSUPPORTED_MEDIA_TYPE: ErrorInfo(ErrorCode.REQ_UNSUPPORTED_MEDIA_TYPE, 415, "The request must be JSON.", False),
    ErrorCode.REQ_VALIDATION: ErrorInfo(ErrorCode.REQ_VALIDATION, 422, "The request is not valid.", False),
}


def problem_type(code: ErrorCode) -> str:
    """The `type` member of an error body for this code."""
    return PROBLEM_TYPE_PREFIX + code.value
