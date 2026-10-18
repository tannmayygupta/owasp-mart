"""`POST /internal/v1/events`: the HTTP front of `IngestHandler` (IF-4).

It reads the body in pieces and stops at the cap, so a request over 16 KiB is answered 413 without reading the rest (the
connection is then closed). The handler is `app.state.ingest_handler` (set by the process that wires the keys and the stores),
or the one passed here. Without one the route answers REQ-INTERNAL and logs that it is not configured. No cookies, ever.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from vulnmart.ingest.handler import IngestHandler, Reply
from vulnmart.problem import PROBLEM_MEDIA_TYPE, ProblemError, request_id_for
from vulnmart_models.error_codes import ErrorCode

logger = logging.getLogger("vulnmart.ingest")
ROUTE = "/internal/v1/events"


def _send(reply: Reply, extra: dict[str, str] | None = None) -> JSONResponse:
    media = PROBLEM_MEDIA_TYPE if reply.problem else "application/json"
    return JSONResponse(reply.body, status_code=reply.status, media_type=media, headers={**reply.headers, **(extra or {})})


def install_event_route(app: FastAPI, handler: IngestHandler | None = None) -> None:
    if handler is not None:
        app.state.ingest_handler = handler

    @app.post(ROUTE, include_in_schema=False)
    async def post_event(request: Request) -> JSONResponse:
        h: IngestHandler | None = getattr(request.app.state, "ingest_handler", None)
        if h is None:
            logger.error("the event receiver has no handler configured")
            raise ProblemError(ErrorCode.REQ_INTERNAL)
        rid = request_id_for(request)
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > h.max_body_bytes:
            return _send(h.too_large(rid), {"Connection": "close"})
        chunks: list[bytes] = []
        size = 0
        async for part in request.stream():
            size += len(part)
            if size > h.max_body_bytes:
                return _send(h.too_large(rid), {"Connection": "close"})
            chunks.append(part)
        return _send(h.handle(request.headers, b"".join(chunks), rid))
