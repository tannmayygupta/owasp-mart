"""The session routes of IF-1: createSession (login), getSession, deleteSession (logout). The second-factor login (completeMfaLogin)
is story P-15; the user's own session list and "log out everywhere" exist in `SessionService` and get their routes with a contract change.

Login is throttled twice (FR-ACC-10, FR-ACC-08): every attempt from one visitor address counts against an hourly limit, and wrong
passwords for one email address (known or not) count against a failure limit; past it the address waits for the rest of the window,
a back-off that ends by itself, never a permanent lock. A right password clears the failures. The wait applies even to the right
password, which means an attacker can keep one address waiting; the price of not letting guesses through.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field
from vulnmart_models.error_codes import ErrorCode

from vulnmart.kernel.ratelimit import email_key
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .http import (
    Authenticated, Strict, authenticated, authenticated_with_csrf, check_origin, clear_session_cookie, hash_slots, ip_of, ip_trunc,
    limit, limiter_call, read_json, services, session_body, session_service, set_session_cookie, ua_class,
)
from .security import normalize_email
from .sessions import EmailNotVerified, InvalidCredentials, MfaUnavailable

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
    except MfaUnavailable:
        raise ProblemError(ErrorCode.REQ_INTERNAL) from None  # logged by the service; the admin sees a generic error
    limiter_call(limiter.reset, key)
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
