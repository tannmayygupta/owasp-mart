"""The origin-secret check in the API: defence in depth behind the platform edge (story P-07, decision 1).

Architecture 03: the dashboards' proxy (Vercel in production, `apps/web/proxy.ts` locally) adds `x-origin-secret` to
every forwarded `/api/*` request, and `caddy-p` refuses anything without it (LE-3, stream L). The API checks it too,
when `VULNMART_ORIGIN_SECRET` is set: a browser route reached directly, without the secret, answers 403
AUTH-ORIGIN-FORBIDDEN. Several values may be set, comma-separated, so the secret can be rotated (accept old and new,
architecture 06 section 3). The operational routes (`/healthz`, `/readyz`, `/version`) are not under `/api/` and are
never checked: probes do not carry the secret. Without a configured secret the check is off (tests, laptop).

The comparison takes the same time whatever the value (`hmac.compare_digest` against every configured value), and the
answer never says whether a secret was missing or wrong.
"""
from __future__ import annotations

import hmac

from starlette.types import ASGIApp, Receive, Scope, Send
from vulnmart_models.error_codes import ErrorCode

from .observability import current_request_id, new_request_id

HEADER = b"x-origin-secret"
CHECKED_PREFIX = "/api/"


def parse_secrets(value: str | None) -> tuple[bytes, ...]:
    """`a,b` -> (b"a", b"b"); empty parts are ignored; a value shorter than 16 characters is refused (too guessable)."""
    secrets = tuple(part.strip().encode() for part in (value or "").split(",") if part.strip())
    if any(len(s) < 16 for s in secrets):
        raise ValueError("an origin secret has at least 16 characters")
    return secrets


def matches(supplied: bytes, secrets: tuple[bytes, ...]) -> bool:
    ok = False
    for s in secrets:
        ok |= hmac.compare_digest(supplied, s)  # no early exit: the time does not depend on which value matched
    return ok


class OriginSecretMiddleware:
    def __init__(self, app: ASGIApp, *, secrets: tuple[bytes, ...]):
        self.app = app
        self.secrets = secrets

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.secrets or scope["type"] not in ("http", "websocket") or not scope.get("path", "").startswith(CHECKED_PREFIX):
            await self.app(scope, receive, send)
            return
        supplied = next((v for k, v in scope.get("headers", []) if k.lower() == HEADER), b"")
        if matches(supplied, self.secrets):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})  # policy violation, before the handshake is accepted
            return
        from vulnmart.problem import problem_response

        response = problem_response(ErrorCode.AUTH_ORIGIN_FORBIDDEN, current_request_id() or new_request_id())
        await response(scope, receive, send)
