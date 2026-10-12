"""Request ids and structured logs (NFR-OBS-01, NFR-PRI-02).

- Every request gets an id: the caller's `X-Request-ID` when it is well formed (8 to 64 letters, digits or dashes,
  as Caddy or Vercel send it), else a new `req-<hex>`. It is echoed in the answer and held in a context variable
  so every log line of the request carries it; error bodies use the same id (`problem.py`).
- Logs are one JSON object per line on stdout: time, level, service, logger, message, request id and extras.
- A filter redacts what must never reach a log: values of keys that name a secret (password, token, cookie,
  authorization, secret, dsn, key), a password inside a database URL, and flag-shaped values `VM{...}`.
"""
from __future__ import annotations

import contextvars
import json
import logging
import re
import sys
import uuid
from datetime import UTC, datetime
from typing import Any

from starlette.types import ASGIApp, Message, Receive, Scope, Send

REQUEST_ID_HEADER = "x-request-id"
_REQUEST_ID = re.compile(r"[A-Za-z0-9-]{8,64}")
request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("vulnmart_request_id", default=None)

REDACTED = "[REDACTED]"
_SECRET_KEY = re.compile(r"(password|passwd|secret|token|cookie|authorization|dsn|api[_-]?key|private[_-]?key)", re.IGNORECASE)
# a flag, also percent-encoded in a logged URL (VM%7B...%7D)
_FLAG = re.compile(r"VM(?:\{|%7B)[A-Z2-7]{8,}(?:\}|%7D)", re.IGNORECASE)
_URL_PASSWORD = re.compile(r"(?P<scheme>[a-z][a-z0-9+.-]*://[^:/@\s]+):[^@\s]+@", re.IGNORECASE)
# a whole header line whose every value is secret (all the cookies of a Cookie header, the full Authorization value)
_SECRET_HEADER = re.compile(r"(?P<key>\b(?:set-)?cookie\b|\bauthorization\b)(?P<sep>[\"']?\s*[=:]\s*)(?P<value>[^\n\r]+)", re.IGNORECASE)
# key=value, key: value, 'key': 'value' and query parameters, also with a prefix or suffix (csrf_token, db_password, ?reset_token=)
_INLINE_SECRET = re.compile(
    r"(?P<key>[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]*)(?P<sep>[\"']?\s*[=:]\s*[\"']?)(?P<value>[^\s,;&\"'}]+)",
    re.IGNORECASE,
)

# Attributes every LogRecord has; anything else on a record is an extra field of the call.
_RECORD_ATTRS = set(vars(logging.LogRecord("", 0, "", 0, "", (), None))) | {"message", "asctime", "taskName"}


def new_request_id() -> str:
    return f"req-{uuid.uuid4().hex}"


def accept_request_id(supplied: str | None) -> str:
    """The supplied id when it is well formed, else a new one."""
    return supplied if supplied and _REQUEST_ID.fullmatch(supplied) else new_request_id()


def current_request_id() -> str | None:
    return request_id_var.get()


class RequestIdMiddleware:
    """ASGI middleware: choose the id, keep it in the context for the request, echo it in the answer."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        supplied = None
        for k, v in scope.get("headers", []):
            if k.decode("latin-1").lower() == REQUEST_ID_HEADER:
                supplied = v.decode("latin-1")
                break
        rid = accept_request_id(supplied)
        scope.setdefault("state", {})["request_id"] = rid
        token = request_id_var.set(rid)

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != REQUEST_ID_HEADER.encode()]
                headers.append((REQUEST_ID_HEADER.encode(), rid.encode()))
                message = {**message, "headers": headers}
            await send(message)

        started = False

        async def tracked(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send_with_id(message)

        try:
            await self.app(scope, receive, tracked)
        except Exception as exc:
            # An unhandled error: answer the IF-8 500 here, inside the request's context, so the answer carries the id
            # header and the log line carries the id (Starlette's own 500 handler runs outside every middleware).
            if started:
                raise
            from vulnmart.problem import problem_response
            from vulnmart_models.error_codes import ErrorCode

            logging.getLogger("vulnmart.problem").error("unhandled error (%s)", type(exc).__name__, exc_info=exc)
            response = problem_response(ErrorCode.REQ_INTERNAL, rid)
            await response(scope, receive, send_with_id)
        finally:
            request_id_var.reset(token)


def redact(value: Any, key: str | None = None) -> Any:
    """Redact one value (recursively for lists and mappings). `key` is the name the value is stored under."""
    if key is not None and _SECRET_KEY.search(key):
        return REDACTED
    if isinstance(value, str):
        value = _URL_PASSWORD.sub(rf"\g<scheme>:{REDACTED}@", value)
        value = _SECRET_HEADER.sub(rf"\g<key>\g<sep>{REDACTED}", value)
        value = _INLINE_SECRET.sub(rf"\g<key>\g<sep>{REDACTED}", value)
        return _FLAG.sub("VM{" + REDACTED + "}", value)
    if isinstance(value, dict):
        return {k: redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    return value


class JsonFormatter(logging.Formatter):
    """One JSON object per line, secrets redacted."""

    def __init__(self, service: str):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname,
            "service": self.service,
            "logger": record.name,
            "message": redact(record.getMessage()),
            "request_id": getattr(record, "request_id", None) or current_request_id(),
        }
        for k, v in vars(record).items():
            if k not in _RECORD_ATTRS and k not in out:
                out[k] = redact(v, k)
        if record.exc_info:
            # the exception type only: a traceback can hold values (NFR-SEC-03); the stack goes to debug logs only
            out["error"] = record.exc_info[0].__name__ if record.exc_info[0] else None
            if record.levelno <= logging.DEBUG:
                out["stack"] = redact(self.formatException(record.exc_info))
        return json.dumps(out, ensure_ascii=False, default=str)


def configure_logging(service: str, level: str = "INFO", stream: Any = None) -> logging.Handler:
    """Send every logger of the process to stdout as JSON. Returns the handler (tests read from their own stream)."""
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(JsonFormatter(service))
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_vulnmart", False):
            root.removeHandler(h)
    handler._vulnmart = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True
    return handler
