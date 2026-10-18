"""The live routes of IF-1: openLiveStream and getLiveSnapshot (story P-22, FR-LIV-01, 02, 04, 05). `createLiveTicket` is PENDING the spike S-14 and is not served.

Both need a session. The streams a connection reads come from that session and nothing the client sends (`stream_keys`): the caller's own user stream, their company's
stream when they are a recruiter acting for one, and the admin stream for an admin. The stream answer is never cached or buffered by a proxy.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import (
    HOUR, Authenticated, authenticated, limiter_call, services, session_service, timestamp,
)
from vulnmart.accounts.sessions import ResolvedSession
from vulnmart.kernel.service import NO_STORE
from vulnmart.ports.scope import Role
from vulnmart.problem import ProblemError

from .hub import LiveHub
from .snapshot import SnapshotSource

logger = logging.getLogger("vulnmart.live")
router = APIRouter(tags=["live"])

CONNECTS_PER_HOUR = 600  # a placeholder (OI-25): a browser reconnects after every 15-minute stream and every drop, never hundreds of times an hour
STREAM_HEADERS = {"Cache-Control": "private, no-store", "X-Accel-Buffering": "no"}


def stream_keys(session: ResolvedSession) -> list[str]:
    """The streams this session may read (FR-LIV-05): decided here, on the server, from the session."""
    keys = [f"live:user:{session.user.id}"]
    if Role.RECRUITER in session.roles and session.org_id:
        keys.append(f"live:org:{session.org_id}")
    if Role.ADMIN in session.roles:
        keys.append("live:admin")
    return keys


def live_hub(request: Request) -> LiveHub:
    hub = getattr(request.app.state, "live_hub", None)
    if hub is None:
        logger.error("live routes called but the hub is not configured (no Valkey address)")
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return hub


@router.get("/api/v1/live", operation_id="openLiveStream")
async def open_live(request: Request, auth: Authenticated = Depends(authenticated)) -> StreamingResponse:
    hub = live_hub(request)
    _, limiter = services(request)
    user_id = auth.session.user.id
    decision = limiter_call(limiter.hit, f"live:connect:{user_id}", CONNECTS_PER_HOUR, HOUR)
    if not decision.allowed:
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": str(decision.retry_after)})
    if hub.full(user_id):
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": "5"})
    keys = stream_keys(auth.session)
    token, service = auth.token, session_service(request)

    async def still_allowed() -> bool:
        """The session is still live and still has the same streams (FR-LIV-05: audiences are checked while the stream is open)."""
        now = await asyncio.to_thread(service.resolve, token)
        return now is not None and stream_keys(now) == keys

    body = hub.stream(user_id, keys, request.headers.get("last-event-id"), still_allowed)
    return StreamingResponse(body, media_type="text/event-stream", headers=STREAM_HEADERS)


@router.get("/api/v1/live/snapshot", operation_id="getLiveSnapshot")
async def get_snapshot(request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    source: SnapshotSource | None = getattr(request.app.state, "live_snapshot", None)
    if source is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    attempts, instances = await asyncio.to_thread(source.snapshot, auth.session.user.id)
    return JSONResponse({"server_time": timestamp(now), "attempts": attempts, "instances": instances}, headers=NO_STORE)
