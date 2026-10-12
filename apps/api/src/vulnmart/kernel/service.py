"""One factory for every entrypoint of the codebase (api, ingest, live, worker, scheduler; architecture 01 section 2).

Each service answers (architecture 02 section 12, NFR-OBS-02):
- `GET /healthz`: liveness, the process answers (no dependency is checked, so a database outage never restarts it);
- `GET /readyz`: readiness, Postgres and Valkey answer within the timeout; 503 otherwise;
- `GET /version`: service name, version and commit.
These are internal routes: the dashboards' proxy forwards `/api/*` only, and the origin-secret check (`origin.py`)
applies to `/api/*` only, so probes never need the secret. Answers carry no error text (NFR-SEC-03),
are never cached, and every request has an id (`observability.RequestIdMiddleware`).
"""
from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import AbstractAsyncContextManager

import valkey.asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import text

from vulnmart.problem import install_problem_handlers

from .db import make_engine
from .observability import RequestIdMiddleware, configure_logging
from .origin import OriginSecretMiddleware, parse_secrets
from .settings import Settings, get_settings

logger = logging.getLogger("vulnmart.health")

Check = Callable[[], Awaitable[None]]
NO_STORE = {"Cache-Control": "private, no-store"}


class NotConfigured(RuntimeError):
    """A dependency whose address is not set: the service is not ready."""


def postgres_check(dsn: str | None, timeout: float) -> Check:
    """SELECT 1 over one small pooled engine, created on first use (a check never opens a new connection per call)."""
    engine = None

    def ping() -> None:
        with engine.connect() as conn:  # type: ignore[union-attr]
            conn.execute(text("SELECT 1"))

    async def check() -> None:
        nonlocal engine
        if not dsn:
            raise NotConfigured("postgres")
        if engine is None:
            engine = make_engine(dsn, pool_size=1, max_overflow=1, pool_timeout=timeout,
                                 connect_args={"connect_timeout": max(1, math.ceil(timeout))})
        await asyncio.to_thread(ping)

    return check


def valkey_check(url: str | None, timeout: float) -> Check:
    """PING over one client and its connection pool, created on first use."""
    client = None

    async def check() -> None:
        nonlocal client
        if not url:
            raise NotConfigured("valkey")
        if client is None:
            client = valkey.asyncio.Valkey.from_url(url, socket_connect_timeout=timeout, socket_timeout=timeout, max_connections=2)
        await client.ping()

    return check


def default_checks(settings: Settings) -> dict[str, Check]:
    return {
        "postgres": postgres_check(settings.postgres_dsn, settings.check_timeout_seconds),
        "valkey": valkey_check(settings.valkey_url, settings.check_timeout_seconds),
    }


async def _run(name: str, check: Check, timeout: float) -> str:
    try:
        async with asyncio.timeout(timeout):
            await check()
    except Exception as exc:  # noqa: BLE001 - any failure, including the timeout, means down
        logger.warning("readiness check %s failed (%s)", name, type(exc).__name__)
        return "down"
    return "ok"


async def run_checks(checks: Mapping[str, Check], timeout: float) -> dict[str, str]:
    names = list(checks)
    results = await asyncio.gather(*(_run(n, checks[n], timeout) for n in names))
    return dict(zip(names, results, strict=True))


Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[None]]


def create_service_app(
    service: str,
    *,
    checks: Mapping[str, Check] | None = None,
    settings: Settings | None = None,
    timeout: float | None = None,
    lifespan: Lifespan | None = None,
    configure_logs: bool = False,
) -> FastAPI:
    """The app of one entrypoint with its three operational routes. Tests pass fake `checks`."""
    settings = settings or get_settings()
    if configure_logs:
        configure_logging(service, settings.log_level)
    active = dict(checks) if checks is not None else default_checks(settings)
    limit = timeout if timeout is not None else settings.check_timeout_seconds

    app = FastAPI(title=f"VulnMart {service}", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.service = service
    app.state.checks = active
    app.state.check_timeout = limit
    install_problem_handlers(app)
    # Added first, so it runs inside the request-id middleware (its 403 carries the request id).
    origin_secrets = parse_secrets(settings.origin_secrets_value())
    if not origin_secrets and settings.env in ("staging", "production"):
        # fail closed: without a secret the check is off and every /api/ route would be open to anyone who reaches the origin
        raise RuntimeError(f"VULNMART_ENV={settings.env} needs an origin secret (VULNMART_ORIGIN_SECRET or VULNMART_ORIGIN_SECRET_FILE)")
    app.add_middleware(OriginSecretMiddleware, secrets=origin_secrets)
    app.add_middleware(RequestIdMiddleware)

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> JSONResponse:
        return JSONResponse({"status": "ok", "service": service}, headers=NO_STORE)

    @app.get("/readyz", include_in_schema=False)
    async def readyz() -> JSONResponse:
        deps = await run_checks(active, limit)
        ready = all(v == "ok" for v in deps.values())
        return JSONResponse({"status": "ok" if ready else "degraded", "checks": deps}, status_code=200 if ready else 503, headers=NO_STORE)

    @app.get("/version", include_in_schema=False)
    async def version() -> JSONResponse:
        return JSONResponse({"service": service, "version": settings.version, "commit": settings.commit}, headers=NO_STORE)

    return app


async def heartbeat(service: str, interval: float, stop: asyncio.Event) -> None:
    """The loop of a skeleton worker or scheduler: it only proves the process runs until its story gives it work."""
    while not stop.is_set():
        logger.debug("%s idle", service)
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            continue


def background_lifespan(service: str, interval: float = 30.0) -> Lifespan:
    """A lifespan that runs `heartbeat` beside the health routes and stops it cleanly on shutdown."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        stop = asyncio.Event()
        task = asyncio.create_task(heartbeat(service, interval, stop))
        app.state.background_task = task
        logger.info("%s started (skeleton: no jobs yet)", service)
        try:
            yield
        finally:
            stop.set()
            await task

    return lifespan
