"""The session routes of IF-1: createSession (login), getSession, deleteSession (logout). The second step of a login with a second factor (completeMfaLogin)
is in mfa_api.py. The user's own sessions (story 3.6, FR-ACC-04, IF-1 1.7.0): listMySessions, revokeMySession (one, by its ref) and logOutEverywhere (all of
them, this one included).

Login is throttled twice (FR-ACC-10, FR-ACC-08): every attempt from one visitor address counts against an hourly limit, and wrong
passwords for one email address (known or not) count against a failure limit; past it the address waits for the rest of the window,
a back-off that ends by itself, never a permanent lock. A right password clears the failures. The wait applies even to the right
password, which means an attacker can keep one address waiting; the price of not letting guesses through.
"""
from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field
from vulnmart_models.error_codes import ErrorCode

from vulnmart.kernel.ratelimit import email_key
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .http import (
    Authenticated, Strict, authenticated, authenticated_with_csrf, check_origin, clear_session_cookie, hash_slots, ip_of, ip_trunc,
    limit, limiter_call, mfa_service, read_json, services, session_body, session_service, set_session_cookie, timestamp, ua_class,
)
from .security import normalize_email, token_hash
from .sessions import EmailNotVerified, InvalidCredentials, MfaChallenge

router = APIRouter(tags=["session"])


class LoginBody(Strict):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)


@router.post("/api/v1/session", operation_id="createSession")
async def create_session(request: Request) -> JSONResponse:
    check_origin(request)
    _, limiter = services(request)
    sessions = session_service(request)
    settings = request.app.state.ports.settings
    address = ip_of(request)
    limit(request, limiter, "login:ip", address, "rate_login_per_ip_per_hour")
    body = await read_json(request, LoginBody)
    key = "login:fail:" + email_key(normalize_email(body.email) or "invalid-address")
    allowed_failures = int(settings.get("login_failures_per_window"))
    wait = limiter_call(limiter.peek, key, allowed_failures)
    if not wait.allowed:
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": str(wait.retry_after)})
    try:
        async with hash_slots(request):
            result = await asyncio.to_thread(sessions.login, email=body.email, password=body.password, ip_trunc=ip_trunc(address),
                                             ua_class=ua_class(request))
    except InvalidCredentials:
        limiter_call(limiter.hit, key, allowed_failures, int(settings.get("login_failure_window_minutes")) * 60)
        raise ProblemError(ErrorCode.AUTH_INVALID_CREDENTIALS) from None
    except EmailNotVerified:
        raise ProblemError(ErrorCode.AUTH_EMAIL_NOT_VERIFIED) from None
    limiter_call(limiter.reset, key)  # the password was right
    if isinstance(result, MfaChallenge):
        # a second factor is on: no session and no cookie yet, only a short-lived ticket for the second step (after the account's wait, if any)
        mfa_wait = limiter_call(limiter.peek, f"mfa:fail:{result.user_id}", allowed_failures)
        if not mfa_wait.allowed:
            raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": str(mfa_wait.retry_after)})
        ticket, ends = await asyncio.to_thread(mfa_service(request).issue_ticket, result.user_id)
        return JSONResponse({"status": "mfa_required", "mfa_ticket": ticket, "mfa_ticket_expires_at": timestamp(ends)}, headers=NO_STORE)
    response = JSONResponse(session_body(sessions, result.token, result.session), headers=NO_STORE)
    set_session_cookie(response, result.token)
    return response


@router.get("/api/v1/session", operation_id="getSession")
async def get_session(request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    return JSONResponse(session_body(session_service(request), auth.token, auth.session), headers=NO_STORE)


@router.delete("/api/v1/session", operation_id="deleteSession", status_code=204)
async def delete_session(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> Response:
    await asyncio.to_thread(session_service(request).logout, auth.token)
    response = Response(status_code=204, headers=NO_STORE)
    clear_session_cookie(response)
    return response


# -- the user's own sessions (story 3.6, FR-ACC-04) ------------------------------------------------------------------------

@router.get("/api/v1/me/sessions", operation_id="listMySessions")
async def list_my_sessions(request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rows = await asyncio.to_thread(session_service(request).list_sessions, auth.session.user.id, current=auth.token)
    return JSONResponse({"items": [{"ref": r.ref, "created_at": timestamp(r.created_at), "last_seen_at": timestamp(r.last_seen_at), "ip_trunc": r.ip_trunc,
                                    "ua_class": r.ua_class, "current": r.current} for r in rows[:100]]}, headers=NO_STORE)


@router.delete("/api/v1/me/sessions/{ref}", operation_id="revokeMySession", status_code=204)
async def revoke_my_session(request: Request, ref: Annotated[str, Path(pattern="^[0-9a-f]{16}$")],
                            auth: Authenticated = Depends(authenticated_with_csrf)) -> Response:
    """204 whether or not a live session of the caller had this ref (it may have ended already): the list is the place to look."""
    await asyncio.to_thread(session_service(request).revoke, auth.session.user.id, ref)
    response = Response(status_code=204, headers=NO_STORE)
    if token_hash(auth.token).startswith(ref):  # the caller ended the session they are using
        clear_session_cookie(response)
    return response


@router.delete("/api/v1/me/sessions", operation_id="logOutEverywhere", status_code=204)
async def log_out_everywhere(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> Response:
    await asyncio.to_thread(session_service(request).log_out_everywhere, auth.session.user.id)
    response = Response(status_code=204, headers=NO_STORE)
    clear_session_cookie(response)
    return response
