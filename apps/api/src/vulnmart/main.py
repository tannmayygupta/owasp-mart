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

from vulnmart.kernel.service import NO_STORE, Check, create_service_app, run_checks
from vulnmart.kernel.services import build_ports
from vulnmart.kernel.settings import Settings, get_settings

PUBLIC_HEALTH_REUSE_SECONDS = 2.0


def create_app(
    checks: Mapping[str, Check] | None = None,
    timeout: float | None = None,
    *,
    settings: Settings | None = None,
    configure_logs: bool = False,
) -> FastAPI:
    """Build the API. Tests pass fake `checks` and their own `settings`; production reads the environment."""
    settings = settings or get_settings()
    app = create_service_app("api", checks=checks, settings=settings, timeout=timeout, configure_logs=configure_logs)
    app.state.ports = build_ports(settings)

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
