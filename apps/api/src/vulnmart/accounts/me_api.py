"""The signed-in user's own routes of IF-1: getMe, updateMe, changePassword, requestEmailChange (FR-ACC-09).

`changePassword` needs the current password: a wrong one is 401 AUTH-INVALID-CREDENTIALS and the session stays, but wrong guesses are
counted per account like a login's (a stolen session must not be a free password-guessing oracle) and the route is limited per visitor
address. On success the answer is 204 with a new session cookie, and every other session of the account has ended.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field, model_validator
from vulnmart_models.error_codes import ErrorCode

from vulnmart.kernel.ratelimit import email_key
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .security import normalize_email
from .http import (
    accepted, Authenticated, Strict, authenticated, authenticated_with_csrf, hash_slots, invalid, ip_of, limit, limiter_call, read_json, services,
    set_session_cookie, userview_body, session_service,
)
from .self_service import EmailChangeNotAllowed, EmailChangeUnavailable, SelfService, SessionEnded
from .service import InvalidInput
from .sessions import InvalidCredentials

router = APIRouter(tags=["me"])


class UpdateMeBody(Strict):
    display_name: str | None = Field(default=None, min_length=1, max_length=60)

    @model_validator(mode="after")
    def _at_least_one(self):
        if not self.model_fields_set:
            raise ValueError("at least one member")
        return self


class ChangeEmailBody(Strict):
    new_email: str = Field(min_length=3, max_length=254)
    current_password: str = Field(min_length=1, max_length=128)


class ChangePasswordBody(Strict):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)


def self_service(request: Request) -> SelfService:
    service = getattr(request.app.state, "self_service", None)
    if service is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service


@router.get("/api/v1/me", operation_id="getMe")
async def get_me(auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    return JSONResponse(userview_body(auth.session.user), headers=NO_STORE)


@router.patch("/api/v1/me", operation_id="updateMe")
async def update_me(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    service = self_service(request)
    body = await read_json(request, UpdateMeBody)
    try:
        view = await asyncio.to_thread(service.update_profile, auth.session.user.id, display_name=body.display_name or "")
    except InvalidInput as exc:
        raise invalid(exc) from None
    return JSONResponse(userview_body(view), headers=NO_STORE)


@router.post("/api/v1/me/password", operation_id="changePassword", status_code=204)
async def change_password(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> Response:
    service = self_service(request)
    _, limiter = services(request)
    settings = request.app.state.ports.settings
    user_id = auth.session.user.id
    limit(request, limiter, "pwchange:ip", ip_of(request), "rate_login_per_ip_per_hour")
    body = await read_json(request, ChangePasswordBody)
    key = f"pwchange:fail:{user_id}"
    allowed = int(settings.get("login_failures_per_window"))
    wait = limiter_call(limiter.peek, key, allowed)
    if not wait.allowed:
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": str(wait.retry_after)})
    try:
        async with hash_slots(request):
            new_token = await asyncio.to_thread(service.change_password, user_id=user_id, token=auth.token,
                                                current_password=body.current_password, new_password=body.new_password)
    except InvalidCredentials:
        limiter_call(limiter.hit, key, allowed, int(settings.get("login_failure_window_minutes")) * 60)
        raise ProblemError(ErrorCode.AUTH_INVALID_CREDENTIALS) from None
    except InvalidInput as exc:
        raise invalid(exc) from None
    except SessionEnded:
        raise ProblemError(ErrorCode.AUTH_SESSION_REQUIRED) from None
    limiter_call(limiter.reset, key)
    response = Response(status_code=204, headers=NO_STORE)
    set_session_cookie(response, new_token)
    return response


@router.post("/api/v1/me/email", operation_id="requestEmailChange", status_code=202)
async def request_email_change(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    """Ask to use another address (WP-B): the current password is needed, a link goes to the new address, nothing changes until it is used. 202 for a free address and for one
    that has an account alike. A wrong password is 401 AUTH-INVALID-CREDENTIALS and counted like a login's; an administrator's account is 409 ATT-INVALID-STATE."""
    service = self_service(request)
    _, limiter = services(request)
    settings = request.app.state.ports.settings
    user_id = auth.session.user.id
    limit(request, limiter, "emailchange:ip", ip_of(request), "rate_login_per_ip_per_hour")
    body = await read_json(request, ChangeEmailBody)
    address = normalize_email(body.new_email)
    if address is None:
        raise invalid(InvalidInput("/new_email"))
    limit(request, limiter, "emailchange:email", email_key(address), "rate_signup_per_email_per_hour")  # also bounds the mails one address can receive
    key = f"pwchange:fail:{user_id}"  # the same count as the password change: both check the current password
    allowed = int(settings.get("login_failures_per_window"))
    wait = limiter_call(limiter.peek, key, allowed)
    if not wait.allowed:
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": str(wait.retry_after)})

    def refuse_disposable(address_ci: str) -> None:
        if auth.session.user.account_type == "recruiter":
            from vulnmart.orgs.disposable import is_disposable

            if is_disposable(address_ci):
                raise InvalidInput("/new_email", "disposable_email")

    try:
        async with hash_slots(request):
            await asyncio.to_thread(lambda: service.request_email_change(user_id=user_id, current_password=body.current_password, new_email=body.new_email,
                                                                         check_email=refuse_disposable))
    except InvalidCredentials:
        limiter_call(limiter.hit, key, allowed, int(settings.get("login_failure_window_minutes")) * 60)
        raise ProblemError(ErrorCode.AUTH_INVALID_CREDENTIALS) from None
    except InvalidInput as exc:
        raise invalid(exc) from None
    except EmailChangeNotAllowed:
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    except EmailChangeUnavailable:
        raise ProblemError(ErrorCode.REQ_INTERNAL) from None
    return accepted()