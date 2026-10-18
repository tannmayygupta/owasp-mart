"""The live routes of IF-1: openLiveStream and getLiveSnapshot (story P-22, FR-LIV-01, 02, 04, 05). `createLiveTicket` is PENDING the spike S-14 and is not served.

Both need a session. The streams a connection reads come from that session and the standing of the caller's company, never from anything the client sends
(`StreamAuthoriser`, story P-23): the caller's own user stream, their company's stream for an active recruiter of an active company, the admin stream for an admin. The
stream answer is never cached or buffered by a proxy.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import (
    HOUR, Authenticated, authenticated_passive, limiter_call, services, session_service, timestamp,
)
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .authorise import StreamAuthoriser
from .hub import LiveHub
from .snapshot import SnapshotSource

logger = logging.getLogger("vulnmart.live")
router = APIRouter(tags=["live"])

CONNECTS_PER_HOUR = 600  # a placeholder (OI-25): a browser reconnects after every 15-minute stream and every drop, never hundreds of times an hour
STREAM_HEADERS = {"Cache-Control": "private, no-store", "X-Accel-Buffering": "no"}


def live_authoriser(request: Request) -> StreamAuthoriser:
    return getattr(request.app.state, "live_authoriser", None) or StreamAuthoriser()  # none configured: own stream (and the admin's) only, never a company's


async def session_still_allowed(service: SessionService, authoriser: StreamAuthoriser, token: str, keys: list[str]) -> bool:
    """The session is still live and still has exactly the streams the connection was opened with (FR-LIV-05: audiences are checked while the stream is open)."""
    def check() -> bool:
        now = service.resolve(token, touch=False)  # looking is not activity: an idle owner's session still times out
        return now is not None and authoriser.streams(now) == keys

    return await asyncio.to_thread(check)


def live_hub(request: Request) -> LiveHub:
    hub = getattr(request.app.state, "live_hub", None)
    if hub is None:
        logger.error("live routes called but the hub is not configured (no Valkey address)")
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return hub


@router.get("/api/v1/live", operation_id="openLiveStream")
async def open_live(request: Request, auth: Authenticated = Depends(authenticated_passive)) -> StreamingResponse:
    hub = live_hub(request)
    _, limiter = services(request)
    user_id = auth.session.user.id
    decision = limiter_call(limiter.hit, f"live:connect:{user_id}", CONNECTS_PER_HOUR, HOUR)
    if not decision.allowed:
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": str(decision.retry_after)})
    if hub.full(user_id):
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": "5"})
    authoriser = live_authoriser(request)
    keys = await asyncio.to_thread(authoriser.streams, auth.session)
    token, service = auth.token, session_service(request)

    async def still_allowed() -> bool:
        return await session_still_allowed(service, authoriser, token, keys)

    body = hub.stream(user_id, keys, request.headers.get("last-event-id"), still_allowed)
    return StreamingResponse(body, media_type="text/event-stream", headers=STREAM_HEADERS)


@router.get("/api/v1/live/snapshot", operation_id="getLiveSnapshot")
async def get_snapshot(request: Request, auth: Authenticated = Depends(authenticated_passive)) -> JSONResponse:
    source: SnapshotSource | None = getattr(request.app.state, "live_snapshot", None)
    if source is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    attempts, instances = await asyncio.to_thread(source.snapshot, auth.session.user.id)
    return JSONResponse({"server_time": timestamp(now), "attempts": attempts, "instances": instances}, headers=NO_STORE)
