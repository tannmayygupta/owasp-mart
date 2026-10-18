"""What every account route shares: the bounded JSON body, the visitor address, rate limits, the Origin and CSRF checks, the session
cookie and the authentication dependencies (story P-11 for the first part, story P-12 for the rest).

The browser rules of the contract (contracts/api/platform/platform.openapi.yaml, NFR-SEC-03):
- A state-changing call needs an `Origin` equal to the dashboard origin (`public_origin`) and, where the browser sends it,
  `Sec-Fetch-Site: same-origin`. Wrong or missing: 403 AUTH-ORIGIN-FORBIDDEN. This applies to public calls too (a login must not be
  forgeable from another site).
- An authenticated state-changing call also needs the header `X-CSRF-Token` (HMAC of the session value): 403 AUTH-CSRF-FAILED.
- The session cookie is `__Host-vm_session`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, no Domain, no expiry (the server decides when a
  session ends).
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any, TypeVar

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, ValidationError
from vulnmart_models.error_codes import ErrorCode

from vulnmart.kernel.ratelimit import RateLimiter, RateLimiterUnavailable
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.kernel.service import NO_STORE
from vulnmart.ports.scope import Role
from vulnmart.problem import ProblemError

from .service import AccountService, InvalidInput
from .sessions import ResolvedSession, SessionService, UserView

logger = logging.getLogger("vulnmart.accounts")

MAX_BODY_BYTES = 16 * 1024
HASH_SLOTS = 4
HOUR = 3600
SESSION_COOKIE = "__Host-vm_session"
_TOKEN = re.compile(r"[A-Za-z0-9_-]{32,128}")
_scope = ContextScopePort()


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


M = TypeVar("M", bound=BaseModel)


# ---- the visitor ------------------------------------------------------------------------------------------------------

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


def ip_of(request: Request) -> str:
    settings = request.app.state.settings
    return client_ip(request, trust_forwarded=bool(settings.origin_secrets_value()), hops=settings.trusted_proxy_hops)


def ip_trunc(address: str) -> str | None:
    """A coarse network prefix for the user's own session list (IPv4 /24, IPv6 /48), never the address itself."""
    try:
        net = ipaddress.ip_network(address.removesuffix("/64") + ("/48" if ":" in address else "/24"), strict=False)
    except ValueError:
        return None
    return str(net)


def ua_class(request: Request) -> str:
    agent = request.headers.get("user-agent", "").lower()
    if any(word in agent for word in ("curl", "python", "httpx", "bot", "wget", "go-http")):
        return "tool"
    return "mobile" if "mobi" in agent else "browser"


# ---- the body ---------------------------------------------------------------------------------------------------------

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


def invalid(exc: InvalidInput) -> RequestValidationError:
    loc = ("body", *[p for p in exc.pointer.split("/") if p])
    return RequestValidationError([{"type": exc.kind, "loc": loc, "msg": "", "input": None}])


# ---- the services and the limits ----------------------------------------------------------------------------------------

def services(request: Request) -> tuple[AccountService, RateLimiter]:
    service = getattr(request.app.state, "accounts", None)
    limiter = getattr(request.app.state, "rate_limiter", None)
    if service is None or limiter is None:
        logger.error("account routes called but the service is not configured (no database address)")
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service, limiter


def session_service(request: Request) -> SessionService:
    service = getattr(request.app.state, "session_service", None)
    if service is None:
        logger.error("session routes called but the service is not configured (no database address)")
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service


def mfa_service(request: Request):
    service = getattr(request.app.state, "mfa_service", None)
    if service is None:
        logger.error("second-factor routes called but the service is not configured (no database address)")
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service


def limiter_call(fn, *args):
    """Run a rate limiter call; a store failure refuses the request (fail closed) instead of letting it through."""
    try:
        return fn(*args)
    except RateLimiterUnavailable:
        logger.error("rate limiter unavailable: request refused (fail closed)")
        raise ProblemError(ErrorCode.REQ_INTERNAL) from None


def limit(request: Request, limiter: RateLimiter, name: str, key: str, per_hour_setting: str) -> None:
    decision = limiter_call(limiter.hit, f"{name}:{key}", int(request.app.state.ports.settings.get(per_hour_setting)), HOUR)
    if not decision.allowed:
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": str(decision.retry_after)})


def hash_slots(request: Request) -> asyncio.Semaphore:
    """At most `HASH_SLOTS` password hashes at once in this process (each needs about 19 MiB)."""
    state = request.app.state
    if getattr(state, "hash_slots", None) is None:
        state.hash_slots = asyncio.Semaphore(HASH_SLOTS)
    return state.hash_slots


def accepted() -> JSONResponse:
    return JSONResponse({"status": "accepted"}, status_code=202, headers=NO_STORE)


# ---- Origin, cookie, CSRF -----------------------------------------------------------------------------------------------

def check_origin(request: Request) -> None:
    """The Origin check of the contract: the dashboard origin, and a same-origin fetch where the browser says (403 AUTH-ORIGIN-FORBIDDEN)."""
    allowed = request.app.state.settings.public_origin.rstrip("/")
    if request.headers.get("origin", "").rstrip("/") != allowed:
        raise ProblemError(ErrorCode.AUTH_ORIGIN_FORBIDDEN)
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site != "same-origin":
        raise ProblemError(ErrorCode.AUTH_ORIGIN_FORBIDDEN)


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(SESSION_COOKIE, token, path="/", secure=True, httponly=True, samesite="lax")


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", secure=True, httponly=True, samesite="lax")


_CLEARED = f"{SESSION_COOKIE}=\"\"; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=lax"


def timestamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def userview_body(user: UserView) -> dict[str, Any]:
    return {"user_id": user.id, "email": user.email, "display_name": user.display_name, "account_type": user.account_type,
            "email_verified": user.email_verified, "mfa_enabled": user.mfa_enabled, "created_at": timestamp(user.created_at)}


def user_body(session: ResolvedSession) -> dict[str, Any]:
    return userview_body(session.user)

def session_body(service: SessionService, token: str, session: ResolvedSession) -> dict[str, Any]:
    return {"status": "authenticated", "user": user_body(session), "csrf_token": service.csrf_token(token),
            "idle_expires_at": timestamp(session.idle_expires_at), "absolute_expires_at": timestamp(session.absolute_expires_at)}


# ---- who is calling ---------------------------------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class Authenticated:
    token: str
    session: ResolvedSession


async def _authenticate(request: Request) -> Authenticated:
    service = session_service(request)
    token = request.cookies.get(SESSION_COOKIE)
    if not token or not _TOKEN.fullmatch(token):
        raise ProblemError(ErrorCode.AUTH_SESSION_REQUIRED)
    session = await asyncio.to_thread(service.resolve, token)
    if session is None:  # unknown, revoked or ended: the cookie is useless, so the answer also clears it
        raise ProblemError(ErrorCode.AUTH_SESSION_REQUIRED, headers={"Set-Cookie": _CLEARED})
    return Authenticated(token, session)


async def authenticated(request: Request) -> AsyncIterator[Authenticated]:
    """Dependency for a safe (read) route: a live session, with its user and roles in scope for the rest of the request."""
    auth = await _authenticate(request)
    with _scope.acting_as(auth.session.scope):
        yield auth


def requires(*roles: Role, csrf: bool = False):
    """Dependency factory for a route only some roles may use (FR-ACC-01: a learner cannot reach recruiter or admin screens).
    Any one of `roles` is enough. A caller without one is answered 404 REQ-ROUTE-UNKNOWN, the same as for a route that does not exist
    (the contract's "not yours is not found" rule): the answer does not even say the route is there. `csrf=True` for a state-changing route."""
    wanted = frozenset(roles)

    async def dependency(request: Request) -> AsyncIterator[Authenticated]:
        if csrf:
            check_origin(request)
        auth = await _authenticate(request)
        if csrf and not session_service(request).csrf_ok(auth.token, request.headers.get("x-csrf-token")):
            raise ProblemError(ErrorCode.AUTH_CSRF_FAILED)
        if not (auth.session.roles & wanted):
            raise ProblemError(ErrorCode.REQ_ROUTE_UNKNOWN)
        with _scope.acting_as(auth.session.scope):
            yield auth

    return dependency


async def authenticated_with_csrf(request: Request) -> AsyncIterator[Authenticated]:
    """Dependency for a state-changing route: the Origin check, a live session, and the CSRF token of that session."""
    check_origin(request)
    auth = await _authenticate(request)
    if not session_service(request).csrf_ok(auth.token, request.headers.get("x-csrf-token")):
        raise ProblemError(ErrorCode.AUTH_CSRF_FAILED)
    with _scope.acting_as(auth.session.scope):
        yield auth
