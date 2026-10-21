"""Error answers in the IF-8 format (contracts/errors/problem.schema.json).

A body carries the RFC 9457 members `type`, `title` and `status` plus our `code` and `request_id`, and for a
422 an `errors` list. `title` is the registry's fixed generic text: nothing a client sent and nothing about the
server is ever copied into a body (NFR-SEC-03). The request id is the one the request-ID middleware chose
(`vulnmart.kernel.observability`), so the body, the `X-Request-ID` header and the log lines agree.
"""

import logging
import re
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request
from vulnmart_models.error_codes import ERRORS, ErrorCode, problem_type

logger = logging.getLogger("vulnmart.problem")

PROBLEM_MEDIA_TYPE = "application/problem+json"
MAX_ERRORS = 50
MAX_POINTER = 200  # the schema limit; a longer pointer is answered as "the whole body"
_REQUEST_ID = re.compile(r"[A-Za-z0-9-]{8,64}")

# What Starlette itself raises, mapped to registry codes. Any other framework status becomes REQ-INTERNAL (500),
# logged as a warning with the original status; route code that needs a specific code raises ProblemError.
_HTTP_STATUS_TO_CODE = {
    404: ErrorCode.REQ_ROUTE_UNKNOWN,
    405: ErrorCode.REQ_METHOD_NOT_ALLOWED,
    413: ErrorCode.REQ_TOO_LARGE,
    415: ErrorCode.REQ_UNSUPPORTED_MEDIA_TYPE,
}


class ProblemError(Exception):
    """Raise this from route code to answer with a registry code: `raise ProblemError(ErrorCode.ATT_NOT_FOUND)`.

    A plain `HTTPException` cannot name a registry code (its 404 is "route unknown"), so deliberate errors use this.
    Only codes that are sent as an HTTP answer are accepted.
    """

    def __init__(self, code: ErrorCode, *, headers: Mapping[str, str] | None = None, field: str | None = None) -> None:
        if ERRORS[code].status is None:
            raise ValueError(f"{code.value} is never sent as an HTTP answer")
        super().__init__(code.value)
        self.code = code
        self.headers = dict(headers or {})
        self.field = field  # a JSON Pointer that tells the client what to fix or where to go (a fixed pointer, never a submitted value)


# Headers of a framework error that stay useful to the client.
_KEPT_HEADERS = ("allow", "retry-after", "www-authenticate")


def request_id_for(request: Request) -> str:
    """The id the middleware chose for this request; without the middleware, the caller's well-formed id or a new one."""
    chosen = getattr(request.state, "request_id", None)
    if chosen:
        return chosen
    supplied = request.headers.get("x-request-id", "")
    return supplied if _REQUEST_ID.fullmatch(supplied) else f"req-{uuid.uuid4().hex}"


def problem_response(
    code: ErrorCode,
    request_id: str,
    *,
    errors: Sequence[Mapping[str, str]] | None = None,
    headers: Mapping[str, str] | None = None,
    field: str | None = None,
) -> JSONResponse:
    """Build the answer for a registry code. A code that is never an HTTP answer is a programming error."""
    info = ERRORS[code]
    if info.status is None:
        raise ValueError(f"{code.value} is never sent as an HTTP answer")
    body: dict[str, Any] = {
        "type": problem_type(code),
        "title": info.title,
        "status": info.status,
        "code": code.value,
        "request_id": request_id,
    }
    if field is not None:
        body["field"] = field
    if errors:
        body["errors"] = [dict(e) for e in errors][:MAX_ERRORS]
    # Every error answer is uncacheable: the proxy honours upstream cache headers (architecture 03, section 1.3).
    out_headers = {"Cache-Control": "private, no-store", **(headers or {})}
    return JSONResponse(body, status_code=info.status, media_type=PROBLEM_MEDIA_TYPE, headers=out_headers)


def _pointer(loc: Sequence[object]) -> str:
    parts = list(loc)
    if parts and parts[0] == "body":
        parts = parts[1:]
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


_DETAILS = {
    "missing": "This field is required.",
    "json_invalid": "The request body is not valid JSON.",
    # password quality (story P-14): fixed sentences that tell the person what to change and never repeat the password
    "password_length": "The password must be 12 to 128 characters long.",
    "password_common": "This password is too easy to guess. Choose another one.",
    "password_breached": "This password has appeared in a data breach. Choose another one.",
    "password_identity": "The password must not contain your email address or your name.",
    "password_same": "The new password must be different from the current one.",
}


def _validation_entry(err: Mapping[str, Any]) -> dict[str, str]:
    """One 422 entry: where, and a fixed text. A body that is not JSON is about the whole body (pointer "")."""
    kind = str(err.get("type", ""))
    pointer = "" if kind == "json_invalid" else _pointer(err.get("loc", ()))
    if len(pointer) > MAX_POINTER:
        pointer = ""  # a very long client-chosen key: say "the whole body" rather than break the schema
    return {"pointer": pointer, "detail": _DETAILS.get(kind, "This value is not valid.")}


def install_problem_handlers(app: FastAPI) -> None:
    """Answer unknown routes, bad methods, invalid bodies and unhandled errors in the IF-8 format."""

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_STATUS_TO_CODE.get(exc.status_code)
        if code is None:
            logger.warning("unmapped HTTP error %s answered as REQ-INTERNAL", exc.status_code)
            code = ErrorCode.REQ_INTERNAL
        kept = {k: v for k, v in (exc.headers or {}).items() if k.lower() in _KEPT_HEADERS}
        return problem_response(code, request_id_for(request), headers=kept)

    @app.exception_handler(ProblemError)
    async def _problem(request: Request, exc: ProblemError) -> JSONResponse:
        return problem_response(exc.code, request_id_for(request), headers=exc.headers, field=exc.field)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Only the location and a fixed text: the submitted value is never echoed.
        entries = [_validation_entry(err) for err in exc.errors()]
        return problem_response(ErrorCode.REQ_VALIDATION, request_id_for(request), errors=entries)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        request_id = request_id_for(request)
        logger.error("unhandled error (%s) request_id=%s", type(exc).__name__, request_id, exc_info=exc)
        return problem_response(ErrorCode.REQ_INTERNAL, request_id)
