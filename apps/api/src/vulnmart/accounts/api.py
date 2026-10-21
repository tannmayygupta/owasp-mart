"""The public account routes of IF-1 (contracts/api/platform/platform.openapi.yaml): createAccount, verifyEmail, resendVerification.

Each route: the Origin check, then a limit by visitor address (cheap, before the body is read), a bounded JSON body, a limit by
address or email, then the service. Answers follow the contract: 202 `{"status":"accepted"}` whatever the address is, 200
`{"status":"verified"}`, IF-8 problems for everything else, and `Cache-Control: private, no-store` on all of them. The shared parts
(body reading, visitor address, limits, Origin) are in `http.py`; the session routes are in `session_api.py`.

Memory: a password hash needs about 19 MiB, so at most `HASH_SLOTS` hashes run at once in one process (the API container has 256 MiB).
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import Field, StrictBool, field_validator
from vulnmart_models.error_codes import ErrorCode

from vulnmart.kernel.ratelimit import email_key
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .http import (  # noqa: F401 - the first three are re-exported for the tests that import them from here
    MAX_BODY_BYTES, Strict, accepted, check_origin, client_ip, hash_slots, invalid, ip_of, limit, read_json, services,
)
from .security import normalize_email
from .service import InvalidInput, TokenInvalid

router = APIRouter(tags=["accounts"])


class SignupBody(Strict):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)
    display_name: str = Field(min_length=1, max_length=60)
    age_declaration: StrictBool  # only JSON `true`: `Literal[True]` would also let the number 1 through
    captcha_token: str | None = Field(default=None, max_length=2048)  # OI-29: rate limits only; the field is accepted and ignored

    @field_validator("age_declaration")
    @classmethod
    def _must_be_true(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("the declaration must be true")
        return value


class EmailBody(Strict):
    email: str = Field(min_length=3, max_length=254)


class TokenBody(Strict):
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{32,128}$")


@router.post("/api/v1/accounts", operation_id="createAccount", status_code=202)
async def create_account(request: Request) -> JSONResponse:
    check_origin(request)
    service, limiter = services(request)
    limit(request, limiter, "signup:ip", ip_of(request), "rate_signup_per_ip_per_hour")
    body = await read_json(request, SignupBody)
    address = normalize_email(body.email)
    if address is None:
        raise invalid(InvalidInput("/email"))
    limit(request, limiter, "signup:email", email_key(address), "rate_signup_per_email_per_hour")
    try:
        async with hash_slots(request):
            await asyncio.to_thread(service.signup, email=body.email, password=body.password, display_name=body.display_name)
    except InvalidInput as exc:
        raise invalid(exc) from None
    return accepted()


@router.post("/api/v1/accounts/verify-email", operation_id="verifyEmail")
async def verify_email(request: Request) -> JSONResponse:
    check_origin(request)
    service, limiter = services(request)
    limit(request, limiter, "verify:ip", ip_of(request), "rate_verify_per_ip_per_hour")
    body = await read_json(request, TokenBody)
    try:
        await asyncio.to_thread(service.verify_email, body.token)
    except TokenInvalid:
        raise ProblemError(ErrorCode.AUTH_TOKEN_INVALID) from None
    return JSONResponse({"status": "verified"}, headers=NO_STORE)


@router.post("/api/v1/accounts/verify-email/resend", operation_id="resendVerification", status_code=202)
async def resend_verification(request: Request) -> JSONResponse:
    check_origin(request)
    service, limiter = services(request)
    limit(request, limiter, "resend:ip", ip_of(request), "rate_signup_per_ip_per_hour")
    body = await read_json(request, EmailBody)
    address = normalize_email(body.email)
    if address is None:
        raise invalid(InvalidInput("/email"))
    limit(request, limiter, "resend:email", email_key(address), "rate_resend_per_email_per_hour")
    try:
        async with hash_slots(request):  # the unknown-address branch spends one hash worth of time
            await asyncio.to_thread(service.resend_verification, email=body.email)
    except InvalidInput as exc:
        raise invalid(exc) from None
    return accepted()


@router.post("/api/v1/accounts/confirm-email-change", operation_id="confirmEmailChange")
async def confirm_email_change(request: Request) -> JSONResponse:
    """Use the link mailed to a new address (WP-B): the account's address changes, its sessions end, the old address is told. No session is needed (the link may be opened on
    another device); a link that was used, replaced, expired or never existed is 400 AUTH-TOKEN-INVALID."""
    check_origin(request)
    _, limiter = services(request)
    service = getattr(request.app.state, "self_service", None)
    if service is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    limit(request, limiter, "verify:ip", ip_of(request), "rate_verify_per_ip_per_hour")
    body = await read_json(request, TokenBody)
    try:
        await asyncio.to_thread(service.confirm_email_change, body.token)
    except TokenInvalid:
        raise ProblemError(ErrorCode.AUTH_TOKEN_INVALID) from None
    return JSONResponse({"status": "changed"}, headers=NO_STORE)