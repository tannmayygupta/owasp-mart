"""Tracer-bullet API: one endpoint that reports whether Postgres and Valkey answer.

Story 1.6 replaces this with settings, request IDs and separate health, readiness
and version endpoints, so this module is kept small and replaceable.
The response never carries error text or internals (NFR-SEC-03).
"""

import asyncio
import logging
import math
import os
from collections.abc import Awaitable, Callable, Mapping

import psycopg
import valkey.asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse

logger = logging.getLogger("vulnmart.healthz")

CHECK_TIMEOUT_SECONDS = 2.0

Check = Callable[[], Awaitable[None]]


async def check_postgres() -> None:
    """Open a connection and run SELECT 1. Raises on any failure."""
    dsn = os.environ["VULNMART_POSTGRES_DSN"]
    async with await psycopg.AsyncConnection.connect(
        dsn, connect_timeout=max(1, math.ceil(CHECK_TIMEOUT_SECONDS))
    ) as conn:
        await conn.execute("SELECT 1")


async def check_valkey() -> None:
    """Send PING. Raises on any failure."""
    url = os.environ["VULNMART_VALKEY_URL"]
    client = valkey.asyncio.Valkey.from_url(
        url,
        socket_connect_timeout=CHECK_TIMEOUT_SECONDS,
        socket_timeout=CHECK_TIMEOUT_SECONDS,
    )
    try:
        await client.ping()
    finally:
        await client.aclose()


async def _run_check(name: str, check: Check, timeout: float) -> str:
    """Return "ok" or "down". A slow or failing check is "down"; its text is never exposed."""
    try:
        async with asyncio.timeout(timeout):
            await check()
    except Exception as exc:  # noqa: BLE001 - any failure, including timeout, means down
        logger.warning("healthz check %s failed (%s)", name, type(exc).__name__)
        return "down"
    return "ok"


def create_app(
    checks: Mapping[str, Check] | None = None,
    timeout: float = CHECK_TIMEOUT_SECONDS,
) -> FastAPI:
    """Build the app. Tests pass fake checks; production uses the real ones."""
    active: Mapping[str, Check] = (
        checks
        if checks is not None
        else {"postgres": check_postgres, "valkey": check_valkey}
    )
    app = FastAPI(title="VulnMart platform API")

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        names = list(active)
        results = await asyncio.gather(*(_run_check(n, active[n], timeout) for n in names))
        deps = dict(zip(names, results, strict=True))
        healthy = all(v == "ok" for v in deps.values())
        body = {"status": "ok" if healthy else "degraded", **deps}
        return JSONResponse(body, status_code=200 if healthy else 503)

    return app


app = create_app()
