"""The second-factor routes of IF-1: startMfaEnrolment, confirmMfaEnrolment, disableMfa (signed in) and completeMfaLogin (the second step of a login).

Failed codes are counted per account in Valkey (the same limits as a login's: 10 in 15 minutes, then a wait that ends by itself) and a login ticket
allows five tries. A login that reaches the second step first checks that wait before it issues a ticket, so the count cannot be dodged by asking
for new tickets. Wrong, expired, used and unknown tickets and codes are one 401 AUTH-MFA-INVALID.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field
from vulnmart_models.error_codes import ErrorCode

from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .http import (
    Authenticated, Strict, authenticated_with_csrf, check_origin, hash_slots, ip_of, ip_trunc, limit, limiter_call, mfa_service, read_json, services,
    session_body, session_service, set_session_cookie, ua_class,
)
from .mfa import MfaInvalid, MfaState
from .self_service import SessionEnded
from .sessions import InvalidCredentials

router = APIRouter(tags=["mfa"])


class CodeBody(Strict):
    code: str = Field(pattern=r"^[0-9]{6}$")


class PasswordBody(Strict):
    password: str = Field(min_length=1, max_length=128)


class MfaLoginBody(Strict):
    mfa_ticket: str = Field(pattern=r"^[A-Za-z0-9_-]{32,128}$")
    code: str = Field(pattern=r"^([0-9]{6}|[A-Z2-7]{10})$")


def failure_key(user_id: str) -> str:
    return f"mfa:fail:{user_id}"


def check_wait(request: Request, limiter, key: str) -> None:
    """Refuse (429, with the time left) while the account is waiting after too many wrong codes."""
    allowed = int(request.app.state.ports.settings.get("login_failures_per_window"))
    wait = limiter_call(limiter.peek, key, allowed)
    if not wait.allowed:
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": str(wait.retry_after)})


def count_failure(request: Request, limiter, key: str) -> None:
    settings = request.app.state.ports.settings
    limiter_call(limiter.hit, key, int(settings.get("login_failures_per_window")), int(settings.get("login_failure_window_minutes")) * 60)


@router.post("/api/v1/me/mfa", operation_id="startMfaEnrolment")
async def start_enrolment(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    service = mfa_service(request)
    _, limiter = services(request)
    limit(request, limiter, "mfa-enrol:ip", ip_of(request), "rate_login_per_ip_per_hour")
    try:
        uri = await asyncio.to_thread(service.start_enrolment, auth.session.user.id)
    except MfaState:
        raise ProblemError(ErrorCode.AUTH_MFA_STATE) from None
    return JSONResponse({"otpauth_uri": uri}, headers=NO_STORE)


@router.post("/api/v1/me/mfa/confirm", operation_id="confirmMfaEnrolment")
async def confirm_enrolment(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    service = mfa_service(request)
    _, limiter = services(request)
    user_id = auth.session.user.id
    limit(request, limiter, "mfa-enrol:ip", ip_of(request), "rate_login_per_ip_per_hour")
    body = await read_json(request, CodeBody)
    key = failure_key(user_id)
    check_wait(request, limiter, key)
    try:
        new_token, codes = await asyncio.to_thread(service.confirm_enrolment, user_id=user_id, token=auth.token, code=body.code)
    except MfaInvalid:
        count_failure(request, limiter, key)
        raise ProblemError(ErrorCode.AUTH_MFA_INVALID) from None
    except MfaState:
        raise ProblemError(ErrorCode.AUTH_MFA_STATE) from None
    except SessionEnded:
        raise ProblemError(ErrorCode.AUTH_SESSION_REQUIRED) from None
    limiter_call(limiter.reset, key)
    response = JSONResponse({"recovery_codes": codes}, headers=NO_STORE)
    set_session_cookie(response, new_token)
    return response


@router.delete("/api/v1/me/mfa", operation_id="disableMfa", status_code=204)
async def disable_mfa(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> Response:
    service = mfa_service(request)
    _, limiter = services(request)
    user_id = auth.session.user.id
    limit(request, limiter, "mfa-disable:ip", ip_of(request), "rate_login_per_ip_per_hour")
    body = await read_json(request, PasswordBody)
    key = f"pwchange:fail:{user_id}"  # the same guess budget as changing the password: the password is what is being guessed
    check_wait(request, limiter, key)
    try:
        async with hash_slots(request):
            new_token = await asyncio.to_thread(service.disable, user_id=user_id, token=auth.token, password=body.password)
    except InvalidCredentials:
        count_failure(request, limiter, key)
        raise ProblemError(ErrorCode.AUTH_INVALID_CREDENTIALS) from None
    except MfaState:
        raise ProblemError(ErrorCode.AUTH_MFA_STATE) from None
    except SessionEnded:
        raise ProblemError(ErrorCode.AUTH_SESSION_REQUIRED) from None
    limiter_call(limiter.reset, key)
    response = Response(status_code=204, headers=NO_STORE)
    set_session_cookie(response, new_token)
    return response


@router.post("/api/v1/session/mfa", operation_id="completeMfaLogin")
async def complete_mfa_login(request: Request) -> JSONResponse:
    check_origin(request)
    service = mfa_service(request)
    sessions = session_service(request)
    _, limiter = services(request)
    address = ip_of(request)
    limit(request, limiter, "mfa-login:ip", address, "rate_login_per_ip_per_hour")
    body = await read_json(request, MfaLoginBody)
    try:
        result = await asyncio.to_thread(service.complete_login, ticket=body.mfa_ticket, code=body.code, ip_trunc=ip_trunc(address),
                                         ua_class=ua_class(request))
    except MfaInvalid as exc:
        if exc.user_id:
            count_failure(request, limiter, failure_key(exc.user_id))
        raise ProblemError(ErrorCode.AUTH_MFA_INVALID) from None
    limiter_call(limiter.reset, failure_key(result.session.user.id))
    response = JSONResponse(session_body(sessions, result.token, result.session), headers=NO_STORE)
    set_session_cookie(response, result.token)
    return response
