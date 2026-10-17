"""The public password-reset routes of IF-1: requestPasswordReset and confirmPasswordReset (FR-ACC-08).

The request answers 202 whatever the address is (no oracle) and is limited per visitor address and per email address. The confirm takes
the link's token and the new password: 204 on success (every session of the account ends), 400 AUTH-TOKEN-INVALID for a used, expired or
unknown link, 422 with a fixed sentence for a password that breaks a rule (the link is then not used up). A successful reset also clears
the account's failed-login count, so the person who just proved they own the mailbox is not kept waiting.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field
from vulnmart_models.error_codes import ErrorCode

from vulnmart.kernel.ratelimit import email_key
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .api import EmailBody
from .http import Strict, accepted, check_origin, hash_slots, invalid, ip_of, limit, limiter_call, read_json, services
from .security import normalize_email
from .service import InvalidInput, TokenInvalid

router = APIRouter(tags=["password-reset"])


class ResetBody(Strict):
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{32,128}$")
    new_password: str = Field(min_length=12, max_length=128)


@router.post("/api/v1/password-reset/request", operation_id="requestPasswordReset", status_code=202)
async def request_password_reset(request: Request) -> JSONResponse:
    check_origin(request)
    service, limiter = services(request)
    limit(request, limiter, "reset:ip", ip_of(request), "rate_reset_request_per_ip_per_hour")
    body = await read_json(request, EmailBody)
    address = normalize_email(body.email)
    if address is None:
        raise invalid(InvalidInput("/email"))
    limit(request, limiter, "reset:email", email_key(address), "rate_reset_request_per_email_per_hour")
    try:
        async with hash_slots(request):  # the unknown-address branch spends one hash worth of time
            await asyncio.to_thread(service.request_reset, email=body.email)
    except InvalidInput as exc:
        raise invalid(exc) from None
    return accepted()


@router.post("/api/v1/password-reset/confirm", operation_id="confirmPasswordReset", status_code=204)
async def confirm_password_reset(request: Request) -> Response:
    check_origin(request)
    service, limiter = services(request)
    limit(request, limiter, "reset-confirm:ip", ip_of(request), "rate_verify_per_ip_per_hour")  # guesses at link tokens
    body = await read_json(request, ResetBody)
    try:
        async with hash_slots(request):
            email_ci = await asyncio.to_thread(service.confirm_reset, token=body.token, new_password=body.new_password)
    except TokenInvalid:
        raise ProblemError(ErrorCode.AUTH_TOKEN_INVALID) from None
    except InvalidInput as exc:
        raise invalid(exc) from None
    limiter_call(limiter.reset, "login:fail:" + email_key(email_ci))
    return Response(status_code=204, headers=NO_STORE)
