"""RFC 9457 problem details for the IF-5 errors (contract section 6, D1 of story 3.2).

Every error answer is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance` and the extension members
`code`, `request_id` and (for a field error) `field`. `title` is fixed per code, `detail` says what happened this time, at most 500
characters. An answer never holds a stack trace, an exception message, a secret or the text of a request body.
"""
from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from dataclasses import field as dc_field

PROBLEM_BASE = "https://vulnmart.invalid/problems/"
MEDIA_TYPE = "application/problem+json"

# Codes of the service that are not in the contract table (the fake orchestrator has the first and the last; the middle one marks the
# reset placeholder of story 3.2). They follow the same shape and are never listed in the OpenAPI file.
ROUTE_UNKNOWN = "ORCH-ROUTE-UNKNOWN"
NOT_IMPLEMENTED = "ORCH-NOT-IMPLEMENTED"
INTERNAL = "ORCH-INTERNAL"

TITLES = {
    "ORCH-BAD-SIGNATURE": "Bad signature", "ORCH-INSTANCE-NOT-FOUND": "Instance not found",
    "ORCH-METHOD-NOT-ALLOWED": "Method not allowed", "ORCH-REQUEST-MISMATCH": "Same identity, different body",
    "ORCH-INSTANCE-EXISTS": "Instance exists", "ORCH-INVALID-STATE": "Invalid state", "ORCH-STALE-EPOCH": "Stale epoch",
    "ORCH-STALE-ACCESS-EPOCH": "Stale access epoch", "ORCH-BODY-TOO-LARGE": "Body too large",
    "ORCH-UNSUPPORTED-MEDIA-TYPE": "Unsupported media type", "ORCH-FIELD-FORBIDDEN": "Field forbidden",
    "ORCH-TEMPLATE-UNKNOWN": "Template unknown", "ORCH-LABEL-UNKNOWN": "Label unknown", "ORCH-VALIDATION": "Validation failed",
    "ORCH-CURSOR-INVALID": "Cursor invalid", "ORCH-BUSY": "No capacity", "ORCH-RATE-LIMITED": "Rate limited",
    ROUTE_UNKNOWN: "No such call", NOT_IMPLEMENTED: "Not implemented yet", INTERNAL: "Internal error",
}

STATUS = {
    "ORCH-BAD-SIGNATURE": 401, "ORCH-INSTANCE-NOT-FOUND": 404, "ORCH-METHOD-NOT-ALLOWED": 405, "ORCH-REQUEST-MISMATCH": 409,
    "ORCH-INSTANCE-EXISTS": 409, "ORCH-INVALID-STATE": 409, "ORCH-STALE-EPOCH": 409, "ORCH-STALE-ACCESS-EPOCH": 409,
    "ORCH-BODY-TOO-LARGE": 413, "ORCH-UNSUPPORTED-MEDIA-TYPE": 415, "ORCH-FIELD-FORBIDDEN": 422, "ORCH-TEMPLATE-UNKNOWN": 422,
    "ORCH-LABEL-UNKNOWN": 422, "ORCH-VALIDATION": 422, "ORCH-CURSOR-INVALID": 422, "ORCH-BUSY": 429, "ORCH-RATE-LIMITED": 429,
    ROUTE_UNKNOWN: 404, NOT_IMPLEMENTED: 501, INTERNAL: 500,
}

RETRY_AFTER_BUSY = "5"


@dataclass
class ProblemError(Exception):
    """Raised anywhere in a request; the service turns it into the answer."""

    code: str
    detail: str
    field: str | None = None
    headers: dict[str, str] = dc_field(default_factory=dict)

    def __post_init__(self) -> None:
        super().__init__(self.code)

    @property
    def status(self) -> int:
        return STATUS[self.code]


def new_request_id() -> str:
    return "req-" + secrets.token_hex(6)


def problem_body(code: str, detail: str, field_name: str | None = None, request_id: str | None = None) -> tuple[int, bytes, str]:
    """The status, the JSON bytes and the request id of a problem answer."""
    rid = request_id or new_request_id()
    status = STATUS[code]
    body: dict[str, object] = {
        "type": PROBLEM_BASE + code.lower(), "title": TITLES.get(code, "Error"), "status": status, "detail": str(detail)[:500],
        "instance": "urn:vulnmart:request:" + rid, "code": code, "request_id": rid,
    }
    if field_name:
        body["field"] = field_name[:200]
    return status, json.dumps(body, separators=(",", ":")).encode(), rid
