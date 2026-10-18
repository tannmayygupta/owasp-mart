"""The platform API entrypoint (`uvicorn vulnmart.main:app`).

Built by `kernel.service.create_service_app` (health, readiness, version, request ids, JSON logs, IF-8 errors) plus
the browser routes of IF-1. Today that is the public `GET /api/v1/health` of `contracts/api/platform/`: `ok` or
`degraded`, never a store name, never cached. The ports of `kernel.services` are on `app.state.ports`.
"""
from __future__ import annotations

import os
import secrets
import time
from collections.abc import Mapping

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from vulnmart.accounts.api import router as accounts_router
from vulnmart.accounts.admins import AdminService
from vulnmart.accounts.me_api import router as me_router
from vulnmart.accounts.password_api import router as password_router
from vulnmart.accounts.passwords import PasswordPolicy, make_policy
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.session_api import router as session_router
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.ratelimit import InMemoryRateLimiter, RateLimiter, ValkeyRateLimiter
from vulnmart.kernel.service import NO_STORE, Check, create_service_app, run_checks
from vulnmart.kernel.services import build_ports
from vulnmart.kernel.settings import Settings, get_settings
from vulnmart.lab.runtime import LabRuntime
from vulnmart.lab.tickets import TicketMinter, minter_from_environ

PUBLIC_HEALTH_REUSE_SECONDS = 2.0


def _accounts_from(settings: Settings, ports, policy: PasswordPolicy) -> AccountService | None:
    """The account service over the database, or None without a database address (the routes then answer an error)."""
    if ports.sessions is None:
        return None
    if settings.env in ("staging", "production") and not settings.public_origin.startswith("https://"):
        # a verification link sent over plain http would hand its token to anyone on the path
        raise RuntimeError(f"VULNMART_ENV={settings.env} needs VULNMART_PUBLIC_ORIGIN to be an https:// address")
    return AccountService(ports.sessions, ports.settings, public_origin=settings.public_origin, policy=policy)


def _sessions_from(settings: Settings, ports) -> SessionService | None:
    """The session service over the database, or None without a database address. The CSRF key comes from the environment or a file;
    staging and production do not start without one, dev and test make a random key for this process (their CSRF tokens end with it)."""
    key = settings.csrf_key()
    if key is None:
        if settings.env in ("staging", "production"):
            raise RuntimeError(f"VULNMART_ENV={settings.env} needs a CSRF key (VULNMART_CSRF_SECRET or VULNMART_CSRF_SECRET_FILE)")
        key = secrets.token_bytes(32)
    if ports.sessions is None:
        return None
    return SessionService(ports.sessions, ports.settings, key)


def _limiter_from(settings: Settings) -> RateLimiter:
    """Valkey counters when an address is set; in-process counters otherwise (dev and tests only: not shared between processes)."""
    if settings.valkey_url:
        import valkey

        return ValkeyRateLimiter(valkey.Valkey.from_url(settings.valkey_url, socket_timeout=2, socket_connect_timeout=2, max_connections=4))
    if settings.env in ("staging", "production"):
        raise RuntimeError(f"VULNMART_ENV={settings.env} needs VULNMART_VALKEY_URL for the rate limits")
    return InMemoryRateLimiter()


def _lab_from_environ() -> LabRuntime | None:
    """The lab runtime when `VULNMART_LAB_RUNTIME=1` (the platform process then serves the lab routes and the event receiver)."""
    if os.environ.get("VULNMART_LAB_RUNTIME") != "1":
        return None
    from vulnmart.lab.runtime import build_lab_runtime

    return build_lab_runtime(os.environ)


def _mount_lab(app: FastAPI, lab: LabRuntime, tickets: TicketMinter | None) -> None:
    """The IF-2 lab routes, the IF-4 event receiver, the orchestrator report receiver and, only on request, the token-guarded demo routes."""
    from vulnmart.ingest.route import install_event_route
    from vulnmart.lab.api import router as lab_router
    from vulnmart.lab.state_reports import install_state_reports

    app.state.lab = lab
    app.state.lab_tickets = tickets or minter_from_environ(os.environ)
    app.include_router(lab_router)
    install_event_route(app, lab.handler)
    install_state_reports(app, lab, os.environ)
    if os.environ.get("VULNMART_LAB_DEMO") == "1":
        from vulnmart.lab.demo_routes import install_demo_routes

        install_demo_routes(app, lab, os.environ.get("VULNMART_LAB_DEMO_TOKEN", ""))


def create_app(
    checks: Mapping[str, Check] | None = None,
    timeout: float | None = None,
    *,
    settings: Settings | None = None,
    configure_logs: bool = False,
    accounts: AccountService | None = None,
    rate_limiter: RateLimiter | None = None,
    sessions: SessionService | None = None,
    policy: PasswordPolicy | None = None,
    self_service: SelfService | None = None,
    lab: LabRuntime | None = None,
    lab_tickets: TicketMinter | None = None,
) -> FastAPI:
    """Build the API. Tests pass fake `checks`, their own `settings` and, for the account routes, a service and a limiter;
    production reads the environment (the account routes need a database address, and Valkey for the rate limits)."""
    settings = settings or get_settings()
    lab = lab if lab is not None else _lab_from_environ()
    lifespan = None
    if lab is not None:
        from vulnmart.lab.background import lab_lifespan

        lifespan = lab_lifespan(lab, float(os.environ.get("VULNMART_LAB_TICK_S", "10")))
    app = create_service_app("api", checks=checks, settings=settings, timeout=timeout, configure_logs=configure_logs, lifespan=lifespan)
    app.state.settings = settings
    app.state.ports = build_ports(settings)
    policy = policy or make_policy(settings)  # fails to start in staging or production with the breach check off
    app.state.accounts = accounts or _accounts_from(settings, app.state.ports, policy)
    app.state.rate_limiter = rate_limiter or _limiter_from(settings)
    app.state.session_service = sessions or _sessions_from(settings, app.state.ports)
    app.state.self_service = self_service or (SelfService(app.state.ports.sessions, app.state.session_service, policy)
                                              if app.state.ports.sessions is not None and app.state.session_service is not None else None)
    # The role and admin services have no route yet (the admin area is story P-28); later stories find them here. The audit port is the
    # in-memory stand-in until story P-17.
    ports = app.state.ports
    app.state.roles = RoleService(ports.sessions, ports.audit, app.state.session_service) if ports.sessions else None
    app.state.admins = AdminService(ports.sessions, ports.settings, ports.audit, public_origin=settings.public_origin, policy=policy) if ports.sessions else None
    app.include_router(accounts_router)
    app.include_router(session_router)
    app.include_router(password_router)
    app.include_router(me_router)
    if lab is not None:
        _mount_lab(app, lab, lab_tickets)

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
