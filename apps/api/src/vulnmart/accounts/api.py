"""The public account routes of IF-1 (contracts/api/platform/platform.openapi.yaml): createAccount, verifyEmail, resendVerification.

Each route: limit by client address first (cheap, before the body is read), read a bounded JSON body, validate it, limit by address
or email, then call the service. Answers follow the contract: 202 `{"status":"accepted"}` whatever the address is, 200
`{"status":"verified"}`, IF-8 problems for everything else, and `Cache-Control: private, no-store` on all of them.

Memory: a password hash needs about 19 MiB, so at most `HASH_SLOTS` hashes run at once in one process (the API container has
256 MiB); more requests wait for a slot instead of exhausting memory.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
from typing import Any, TypeVar

from fastapi import APIRouter, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, field_validator
from vulnmart_models.error_codes import ErrorCode

from vulnmart.kernel.ratelimit import RateLimiter, RateLimiterUnavailable, email_key
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .security import normalize_email
from .service import AccountService, InvalidInput, TokenInvalid

logger = logging.getLogger("vulnmart.accounts")

MAX_BODY_BYTES = 16 * 1024
HASH_SLOTS = 4
HOUR = 3600
router = APIRouter(tags=["accounts"])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


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


M = TypeVar("M", bound=BaseModel)


def client_ip(request: Request, *, trust_forwarded: bool, hops: int) -> str:
    """The address rate limits are counted for. `x-forwarded-for` counts only when the origin secret protects this API (architecture 03
    rule 4); then the entry `hops` from the right is taken (the proxies we run append theirs). An IPv6 address is reduced to its /64,
    because one subscriber owns a whole /64 and could otherwise change address for every request."""
    raw = request.client.host if request.client else "unknown"
    if trust_forwarded and hops > 0:
        parts = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
        if len(parts) >= hops:
            raw = parts[-hops]
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        return "unknown"
    if isinstance(address, ipaddress.IPv6Address):
        return str(ipaddress.ip_network(f"{address}/64", strict=False).network_address) + "/64"
    return str(address)


async def read_json(request: Request, model: type[M]) -> M:
    """A bounded JSON body, validated. 415 for another media type, 413 when too large, 422 (never echoing a value) when it does not fit."""
    media = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if media != "application/json":
        raise ProblemError(ErrorCode.REQ_UNSUPPORTED_MEDIA_TYPE)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise ProblemError(ErrorCode.REQ_TOO_LARGE)
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY_BYTES:
            raise ProblemError(ErrorCode.REQ_TOO_LARGE)
    try:
        data: Any = json.loads(bytes(body))
    except (ValueError, UnicodeDecodeError):
        raise RequestValidationError([{"type": "json_invalid", "loc": ("body",), "msg": "", "input": None}]) from None
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from None


def _invalid(exc: InvalidInput) -> RequestValidationError:
    loc = ("body", *[p for p in exc.pointer.split("/") if p])
    return RequestValidationError([{"type": "value_error", "loc": loc, "msg": "", "input": None}])


def _services(request: Request) -> tuple[AccountService, RateLimiter]:
    service = getattr(request.app.state, "accounts", None)
    limiter = getattr(request.app.state, "rate_limiter", None)
    if service is None or limiter is None:
        logger.error("account routes called but the service is not configured (no database address)")
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service, limiter


def _limit(request: Request, limiter: RateLimiter, name: str, key: str, per_hour_setting: str) -> None:
    ports = request.app.state.ports
    try:
        decision = limiter.hit(f"{name}:{key}", int(ports.settings.get(per_hour_setting)), HOUR)
    except RateLimiterUnavailable:
        logger.error("rate limiter unavailable: request refused (fail closed)")
        raise ProblemError(ErrorCode.REQ_INTERNAL) from None
    if not decision.allowed:
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": str(decision.retry_after)})


def _ip(request: Request) -> str:
    settings = request.app.state.settings
    return client_ip(request, trust_forwarded=bool(settings.origin_secrets_value()), hops=settings.trusted_proxy_hops)


def _hash_slots(request: Request) -> asyncio.Semaphore:
    state = request.app.state
    if getattr(state, "hash_slots", None) is None:
        state.hash_slots = asyncio.Semaphore(HASH_SLOTS)
    return state.hash_slots


def _accepted() -> JSONResponse:
    return JSONResponse({"status": "accepted"}, status_code=202, headers=NO_STORE)


@router.post("/api/v1/accounts", operation_id="createAccount", status_code=202)
async def create_account(request: Request) -> JSONResponse:
    service, limiter = _services(request)
    _limit(request, limiter, "signup:ip", _ip(request), "rate_signup_per_ip_per_hour")
    body = await read_json(request, SignupBody)
    address = normalize_email(body.email)
    if address is None:
        raise _invalid(InvalidInput("/email"))
    _limit(request, limiter, "signup:email", email_key(address), "rate_signup_per_email_per_hour")
    try:
        async with _hash_slots(request):
            await asyncio.to_thread(service.signup, email=body.email, password=body.password, display_name=body.display_name)
    except InvalidInput as exc:
        raise _invalid(exc) from None
    return _accepted()


@router.post("/api/v1/accounts/verify-email", operation_id="verifyEmail")
async def verify_email(request: Request) -> JSONResponse:
    service, limiter = _services(request)
    _limit(request, limiter, "verify:ip", _ip(request), "rate_verify_per_ip_per_hour")
    body = await read_json(request, TokenBody)
    try:
        await asyncio.to_thread(service.verify_email, body.token)
    except TokenInvalid:
        raise ProblemError(ErrorCode.AUTH_TOKEN_INVALID) from None
    return JSONResponse({"status": "verified"}, headers=NO_STORE)


@router.post("/api/v1/accounts/verify-email/resend", operation_id="resendVerification", status_code=202)
async def resend_verification(request: Request) -> JSONResponse:
    service, limiter = _services(request)
    _limit(request, limiter, "resend:ip", _ip(request), "rate_signup_per_ip_per_hour")
    body = await read_json(request, EmailBody)
    address = normalize_email(body.email)
    if address is None:
        raise _invalid(InvalidInput("/email"))
    _limit(request, limiter, "resend:email", email_key(address), "rate_resend_per_email_per_hour")
    try:
        async with _hash_slots(request):  # the unknown-address branch spends one hash worth of time
            await asyncio.to_thread(service.resend_verification, email=body.email)
    except InvalidInput as exc:
        raise _invalid(exc) from None
    return _accepted()
