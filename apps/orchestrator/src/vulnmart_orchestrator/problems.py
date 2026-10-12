"""The IF-8 error body of the IF-5 answers (contracts/errors/problem.schema.json, contract section 6).

Every error answer is `application/problem+json` with the closed set `type`, `title`, `status`, `code`, `request_id` and, for a
422, `field` (one JSON Pointer) or `errors`. The title and the status come from the registry (the generated constants of
`vulnmart_models.error_codes`), never from this service. There is no `detail` and no `instance`: what happened this time is
written to the log under the request id, never into the answer, so no path, secret or submitted value reaches a client.
An answer never holds a stack trace, an exception message or the text of a request body.
"""
from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from dataclasses import field as dc_field

from vulnmart_models.error_codes import ERRORS, ErrorCode, problem_type

MEDIA_TYPE = "application/problem+json"

# Codes of the service that are not in the OpenAPI table of IF-5 (they are in the registry): an unknown path, the reset placeholder of
# story 3.2 and an unexpected failure. They follow the same shape.
ROUTE_UNKNOWN = ErrorCode.ORCH_ROUTE_UNKNOWN.value
NOT_IMPLEMENTED = ErrorCode.ORCH_NOT_IMPLEMENTED.value
INTERNAL = ErrorCode.ORCH_INTERNAL.value

RETRY_AFTER_BUSY = "5"
MAX_POINTER = 200


def pointer(*segments: str) -> str:
    """A JSON Pointer (RFC 6901) made of names of the request, never of values. Over 200 characters it is the whole body (``)."""
    p = "".join("/" + s.replace("~", "~0").replace("/", "~1") for s in segments)
    return p if len(p) <= MAX_POINTER else ""


def status_of(code: str) -> int:
    info = ERRORS[ErrorCode(code)]
    if info.status is None:
        raise ValueError(f"{code} is not an HTTP error code")
    return info.status


@dataclass
class ProblemError(Exception):
    """Raised anywhere in a request; the service turns it into the answer. `detail` is for the log only."""

    code: str
    detail: str
    field: str | None = None
    headers: dict[str, str] = dc_field(default_factory=dict)

    def __post_init__(self) -> None:
        super().__init__(self.code)

    @property
    def status(self) -> int:
        return status_of(self.code)


def new_request_id() -> str:
    return "req-" + secrets.token_hex(6)


def problem_dict(code: str, field_name: str | None = None, request_id: str | None = None) -> dict[str, object]:
    """The IF-8 body of a code as a dict. `field` is kept for a 422 only, and only as a pointer."""
    rid = request_id or new_request_id()
    info = ERRORS[ErrorCode(code)]
    if info.status is None:
        raise ValueError(f"{code} is not an HTTP error code")
    body: dict[str, object] = {
        "type": problem_type(ErrorCode(code)), "title": info.title, "status": info.status, "code": code, "request_id": rid,
    }
    if info.status == 422 and field_name is not None:
        body["field"] = field_name if len(field_name) <= MAX_POINTER else ""
    return body


def problem_body(code: str, field_name: str | None = None, request_id: str | None = None) -> tuple[int, bytes, str]:
    """The status, the JSON bytes and the request id of a problem answer."""
    body = problem_dict(code, field_name, request_id)
    return int(body["status"]), json.dumps(body, separators=(",", ":")).encode(), str(body["request_id"])  # type: ignore[arg-type]
