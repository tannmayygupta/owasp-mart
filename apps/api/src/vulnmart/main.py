"""The platform API entrypoint (`uvicorn vulnmart.main:app`).

Built by `kernel.service.create_service_app` (health, readiness, version, request ids, JSON logs, IF-8 errors) plus
the browser routes of IF-1. Today that is the public `GET /api/v1/health` of `contracts/api/platform/`: `ok` or
`degraded`, never a store name, never cached. The ports of `kernel.services` are on `app.state.ports`.
"""
from __future__ import annotations

import time
from collections.abc import Mapping

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from vulnmart.accounts.api import router as accounts_router
from vulnmart.accounts.service import AccountService
from vulnmart.kernel.ratelimit import InMemoryRateLimiter, RateLimiter, ValkeyRateLimiter
from vulnmart.kernel.service import NO_STORE, Check, create_service_app, run_checks
from vulnmart.kernel.services import build_ports
from vulnmart.kernel.settings import Settings, get_settings

PUBLIC_HEALTH_REUSE_SECONDS = 2.0


def _accounts_from(settings: Settings, ports) -> AccountService | None:
    """The account service over the database, or None without a database address (the routes then answer an error)."""
    if ports.sessions is None:
        return None
    if settings.env in ("staging", "production") and not settings.public_origin.startswith("https://"):
        # a verification link sent over plain http would hand its token to anyone on the path
        raise RuntimeError(f"VULNMART_ENV={settings.env} needs VULNMART_PUBLIC_ORIGIN to be an https:// address")
    return AccountService(ports.sessions, ports.settings, public_origin=settings.public_origin)


def _limiter_from(settings: Settings) -> RateLimiter:
    """Valkey counters when an address is set; in-process counters otherwise (dev and tests only: not shared between processes)."""
    if settings.valkey_url:
        import valkey

        return ValkeyRateLimiter(valkey.Valkey.from_url(settings.valkey_url, socket_timeout=2, socket_connect_timeout=2, max_connections=4))
    if settings.env in ("staging", "production"):
        raise RuntimeError(f"VULNMART_ENV={settings.env} needs VULNMART_VALKEY_URL for the rate limits")
    return InMemoryRateLimiter()


def create_app(
    checks: Mapping[str, Check] | None = None,
    timeout: float | None = None,
    *,
    settings: Settings | None = None,
    configure_logs: bool = False,
    accounts: AccountService | None = None,
    rate_limiter: RateLimiter | None = None,
) -> FastAPI:
    """Build the API. Tests pass fake `checks`, their own `settings` and, for the account routes, a service and a limiter;
    production reads the environment (the account routes need a database address, and Valkey for the rate limits)."""
    settings = settings or get_settings()
    app = create_service_app("api", checks=checks, settings=settings, timeout=timeout, configure_logs=configure_logs)
    app.state.settings = settings
    app.state.ports = build_ports(settings)
    app.state.accounts = accounts or _accounts_from(settings, app.state.ports)
    app.state.rate_limiter = rate_limiter or _limiter_from(settings)
    app.include_router(accounts_router)

    # The route is public and unauthenticated: its answer is reused for a short time, so a burst of anonymous calls costs
    # one round of checks, not one per call (the answer itself is never cached by anyone else: no-store).
    last: dict[str, float | bool] = {"at": float("-inf"), "ok": False}

    @app.get("/api/v1/health", operation_id="getHealth", tags=["health"])
    async def get_health() -> JSONResponse:
        now = time.monotonic()
        if now - float(last["at"]) >= PUBLIC_HEALTH_REUSE_SECONDS:
            deps = await run_checks(app.state.checks, app.state.check_timeout)
            last.update(at=time.monotonic(), ok=all(v == "ok" for v in deps.values()))
        ok = bool(last["ok"])
        return JSONResponse({"status": "ok" if ok else "degraded"}, status_code=200 if ok else 503, headers=NO_STORE)

    return app


app = create_app(configure_logs=True)
