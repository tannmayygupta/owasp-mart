"""The platform API entrypoint (`uvicorn vulnmart.main:app`).

Built by `kernel.service.create_service_app` (health, readiness, version, request ids, JSON logs, IF-8 errors) plus
the browser routes of IF-1. Today that is the public `GET /api/v1/health` of `contracts/api/platform/`: `ok` or
`degraded`, never a store name, never cached. The ports of `kernel.services` are on `app.state.ports`.
"""
from __future__ import annotations

import os
import secrets
import threading
import time
from collections.abc import Callable, Mapping
from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from vulnmart.accounts.api import router as accounts_router
from vulnmart.accounts.directory import UserDirectory
from vulnmart.accounts.admins import AdminService
from vulnmart.accounts.fieldkeys import FieldKeys, from_settings as fieldkeys_from_settings
from vulnmart.accounts.me_api import router as me_router
from vulnmart.accounts.mfa import MfaService
from vulnmart.accounts.mfa_api import router as mfa_router
from vulnmart.accounts.password_api import router as password_router
from vulnmart.accounts.passwords import PasswordPolicy, make_policy
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.session_api import router as session_router
from vulnmart.accounts.status import AccountStatusService
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.audit import AuditAnchors, FileAnchorSink
from vulnmart.kernel.ratelimit import InMemoryRateLimiter, RateLimiter, ValkeyRateLimiter
from vulnmart.kernel.service import NO_STORE, Check, create_service_app, run_checks
from vulnmart.kernel.services import build_ports
from vulnmart.kernel.settings import Settings, get_settings
from vulnmart.assessments.accept import InviteAcceptance, InviteConsentTargets
from vulnmart.assessments.invite_api import router as invite_router
from vulnmart.lab.runtime import LabRuntime
from vulnmart.live.api import router as live_router
from vulnmart.live.authorise import StreamAuthoriser
from vulnmart.live.hub import HubConfig, LiveHub
from vulnmart.live.snapshot import EmptySnapshot, LabSnapshotSource, SnapshotSource
from vulnmart.live.store import StreamReader, ValkeyStreamStore
from vulnmart.lab.tickets import TicketMinter, minter_from_environ
from vulnmart.assessments.service import AssessmentService
from vulnmart.orgs.colleague_api import router as colleague_router
from vulnmart.orgs.company_api import router as company_router
from vulnmart.orgs.company_privacy_api import router as company_privacy_router
from vulnmart.orgs.service import CompanyService
from vulnmart.ports.attempts import AttemptPort
from vulnmart.privacy.api import router as consent_router
from vulnmart.privacy.deletion_api import router as deletion_router
from vulnmart.privacy.export_api import router as export_router
from vulnmart.admin.api import router as admin_router
from vulnmart.kernel.quota import DbQuotaPort
from vulnmart.privacy.consent import ConsentService
from vulnmart.privacy.targets import ConsentTargets, FakeConsentTargets

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
    return SessionService(ports.sessions, ports.settings, key, audit=ports.audit)


def field_keys_from(settings: Settings) -> FieldKeys:
    """The field key of the accounts module (seals TOTP secrets and the address of an invited candidate in the mail outbox, keys the hash of recovery codes).
    See `accounts.fieldkeys.from_settings`."""
    return fieldkeys_from_settings(settings)


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


def _login_bump(lab: LabRuntime) -> Callable[[str], None]:
    """The login hook of the session service: the bump runs on its own thread so a slow orchestrator never delays a login (the lab retries a failure)."""
    def hook(user_id: str) -> None:
        threading.Thread(target=lab.bump_access_for_user, args=(user_id,), name="login-bump", daemon=True).start()

    return hook


def _mount_lab(app: FastAPI, lab: LabRuntime, tickets: TicketMinter | None) -> None:
    """The IF-2 lab routes, the IF-4 event receiver, the orchestrator report receiver and, only on request, the token-guarded demo routes."""
    from vulnmart.ingest.route import install_event_route
    from vulnmart.lab.api import router as lab_router
    from vulnmart.lab.state_reports import install_state_reports

    app.state.lab = lab
    ports = getattr(app.state, "ports", None)
    if ports is not None and getattr(ports, "outbox", None) is not None:
        lab.live.attach(ports.outbox.publish)  # durable domain events for the live hub (H-142)
    app.state.lab_tickets = tickets or minter_from_environ(os.environ)
    app.include_router(lab_router)
    install_event_route(app, lab.handler)
    install_state_reports(app, lab, os.environ)
    if os.environ.get("VULNMART_LAB_DEMO") == "1":
        from vulnmart.lab.demo_routes import install_demo_routes

        install_demo_routes(app, lab, os.environ.get("VULNMART_LAB_DEMO_TOKEN", ""))


def _combined(*lifespans):
    """Several lifespans as one: started in order, stopped in reverse."""
    @asynccontextmanager
    async def combined(app: FastAPI):
        async with AsyncExitStack() as stack:
            for one in lifespans:
                await stack.enter_async_context(one(app))
            yield

    return combined


def _scheduler_lifespan(interval: float):
    """Runs the retention scheduler (story P-24) beside the API while it serves, when `app.state.scheduler` was built (it needs the database)."""
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        from vulnmart.privacy.retention.scheduler import SchedulerLoop

        scheduler = getattr(app.state, "scheduler", None)
        loop = SchedulerLoop(scheduler, interval) if scheduler is not None else None
        if loop is not None:
            loop.start()
        try:
            yield
        finally:
            if loop is not None:
                loop.stop()

    return lifespan


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
    mfa: MfaService | None = None,
    consent: ConsentService | None = None,
    consent_targets: ConsentTargets | None = None,
    attempts: AttemptPort | None = None,
    live_store: StreamReader | None = None,
    live_config: HubConfig | None = None,
    live_snapshot: SnapshotSource | None = None,
    live_authoriser: StreamAuthoriser | None = None,
) -> FastAPI:
    """Build the API. Tests pass fake `checks`, their own `settings` and, for the account routes, a service and a limiter;
    production reads the environment (the account routes need a database address, and Valkey for the rate limits). `attempts` is the lab's attempt port (IF-9): with it
    the consent routes find the attempts of invites and a granted consent creates the attempt (story P-21); it defaults to the lab runtime's own port when the lab runs in this process; without either the consent targets stay empty."""
    settings = settings or get_settings()
    lab = lab if lab is not None else _lab_from_environ()
    attempts = attempts if attempts is not None else (lab.attempts if lab is not None else None)  # the lab in this process is the attempt port of the consent routes (story P-21)
    lifespans = []
    if lab is not None:
        from vulnmart.lab.background import lab_lifespan

        lifespans.append(lab_lifespan(lab, float(os.environ.get("VULNMART_LAB_TICK_S", "10"))))
    if settings.scheduler_enabled:
        lifespans.append(_scheduler_lifespan(settings.scheduler_interval_seconds))
    lifespan = _combined(*lifespans) if lifespans else None
    app = create_service_app("api", checks=checks, settings=settings, timeout=timeout, configure_logs=configure_logs, lifespan=lifespan)
    app.state.settings = settings
    app.state.ports = build_ports(settings)
    policy = policy or make_policy(settings)  # fails to start in staging or production with the breach check off
    app.state.accounts = accounts or _accounts_from(settings, app.state.ports, policy)
    app.state.rate_limiter = rate_limiter or _limiter_from(settings)
    app.state.session_service = sessions or _sessions_from(settings, app.state.ports)
    app.state.self_service = self_service or (SelfService(app.state.ports.sessions, app.state.session_service, policy, settings=app.state.ports.settings,
                                                                    keys=field_keys_from(settings), public_origin=settings.public_origin, audit=app.state.ports.audit)
                                              if app.state.ports.sessions is not None and app.state.session_service is not None else None)
    # The role and admin services have no route yet (the admin area is story P-28); later stories find them here. The audit port is the
    # real log (DbAuditPort behind PseudonymisingAudit) when a database is configured, the in-memory stand-in otherwise (story P-17).
    ports = app.state.ports
    app.state.roles = RoleService(ports.sessions, ports.audit, app.state.session_service) if ports.sessions else None
    app.state.admins = AdminService(ports.sessions, ports.settings, ports.audit, public_origin=settings.public_origin, policy=policy) if ports.sessions else None
    # Recruiter signup and company approval (story P-18): no route yet (IF-1 has none, handoff H-138); the admin area (P-28) and the invite stories call this.
    app.state.companies = (CompanyService(ports.sessions, app.state.accounts, UserDirectory(ports.sessions), app.state.roles, ports.audit, ports.scope,
                                          ports.settings, AccountStatusService(ports.sessions, app.state.roles, ports.audit), public_origin=settings.public_origin,
                                          end_sessions=app.state.session_service.revoke_all if app.state.session_service is not None else None)
                           if ports.sessions is not None and app.state.accounts is not None and app.state.roles is not None else None)
    if lab is not None and app.state.session_service is not None:
        app.state.session_service.set_login_hook(_login_bump(lab))  # a new login ends the older browser tab's access to the instance (FR-SES-11, H-341)
    if app.state.companies is not None and app.state.session_service is not None:
        app.state.session_service.set_org_resolver(app.state.companies.membership_of)  # a recruiter acts for their company in every request (story P-19)
    field_keys = field_keys_from(settings) if mfa is None else None  # a test that passes its own service needs no key
    app.state.mfa_service = mfa or (MfaService(ports.sessions, field_keys, ports.audit, app.state.session_service)
                                    if ports.sessions is not None and app.state.session_service is not None else None)
    # The daily anchor of the audit log (story P-17). No route and no schedule yet: the scheduler of story P-24 calls `app.state.audit_anchors.anchor()`.
    if ports.audit_db is not None and ports.audit_sessions is not None:
        anchor_keys = field_keys or field_keys_from(settings)
        app.state.audit_anchors = AuditAnchors(ports.audit_db, ports.audit_sessions, lambda line: anchor_keys.context_hash("audit-anchor", line),
                                               FileAnchorSink(settings.audit_anchor_file) if settings.audit_anchor_file else None)
    else:
        app.state.audit_anchors = None
    # Assessment templates and invites (story P-20): no route yet (IF-1 has none for recruiters, story 5.3); the invite story (P-21) and the dashboards use this.
    app.state.assessments = (AssessmentService(ports.sessions, app.state.companies, ports.audit, ports.scope, ports.settings, field_keys or field_keys_from(settings),
                                               public_origin=settings.public_origin, attempts=attempts)
                             if app.state.companies is not None else None)
    # Accepting invites (story P-21): no route yet (story 5.3); the consent routes get the invite side of their port once the lab's attempt port is given.
    app.state.invite_acceptance = (InviteAcceptance(app.state.assessments, UserDirectory(ports.sessions)) if app.state.assessments is not None else None)
    if consent_targets is None and attempts is not None and app.state.assessments is not None and app.state.roles is not None:
        consent_targets = InviteConsentTargets(app.state.assessments, attempts, app.state.roles)
    # Until an attempt port is given the targets are empty, so every attempt id is answered 404.
    app.state.consent_service = consent or (ConsentService(ports.sessions, consent_targets or FakeConsentTargets(), ports.audit, ports.settings,
                                                            field_keys or field_keys_from(settings))
                                            if ports.sessions is not None else None)
    # Live updates (story P-22): the hub reads the streams the worker's relay fills; the snapshot is the lab's own state (nothing without a lab in this process).
    store = live_store if live_store is not None else (ValkeyStreamStore(settings.valkey_url) if settings.valkey_url else None)
    app.state.live_hub = LiveHub(store, live_config) if store is not None else None
    app.state.live_authoriser = live_authoriser or StreamAuthoriser(app.state.companies.active_company_of if app.state.companies is not None else None)
    app.state.live_snapshot = live_snapshot or (LabSnapshotSource(lab) if lab is not None else EmptySnapshot())
    # Retention and housekeeping jobs (story P-24): built here, started by `_scheduler_lifespan` when `VULNMART_SCHEDULER_ENABLED` is on. The lab in this process
    # erases attempts (`lab.erase`); without one a job that needs it fails visibly instead of deleting around it.
    app.state.scheduler = None
    app.state.deletion_service = None
    from vulnmart.privacy.views import ViewHistory

    app.state.view_history = ViewHistory(ports.sessions) if ports.sessions is not None else None  # who viewed me (story P-25); the recruiter views (P-27, P-29) record into it
    # The mails the attempt flows cause (consent withdrawn, time warning, submission, release) and the deletion notices: the lab calls `app.state.mail_triggers`.
    from vulnmart.notifications.triggers import MailTriggers

    app.state.mail_triggers = (MailTriggers(ports.sessions, ports.scope, public_origin=settings.public_origin, keys=field_keys or field_keys_from(settings))
                               if ports.sessions is not None else None)
    if lab is not None and app.state.mail_triggers is not None and getattr(lab, "mail_log", None) is not None:
        from vulnmart.lab.mail_log import mail_sink

        lab.mail_log.sink = mail_sink(app.state.mail_triggers)  # time warning, submission, withdrawal and release now cause their mails (F-10)
    if ports.sessions is not None and app.state.assessments is not None:
        from vulnmart.privacy.subjects import SubjectService
        from vulnmart.privacy.retention.build import build_scheduler

        subjects = SubjectService(ports.audit_sessions) if ports.audit_sessions is not None else None
        # The deletion workflow (story P-25): its person routes are mounted below; the company's side has no route yet (story 5.3). The same eraser as the retention jobs.
        from vulnmart.privacy.deletion import DeletionService
        from vulnmart.privacy.retention.records import SqlAttemptRecords

        app.state.deletion_service = DeletionService(ports.sessions, app.state.assessments, SqlAttemptRecords(ports.sessions), ports.settings, ports.audit, subjects,
                                                     lab.erase if lab is not None else None, mail=app.state.mail_triggers)
        app.state.scheduler = build_scheduler(sessions=ports.sessions, assessments=app.state.assessments, settings=ports.settings, audit=ports.audit,
                                              subjects=subjects,
                                              eraser=lab.erase if lab is not None else None, anchors=app.state.audit_anchors,
                                              streams=store if isinstance(store, ValkeyStreamStore) else None, public_origin=settings.public_origin,
                                              deletion=app.state.deletion_service)
    # The exports (story P-29): a person's own data and a company's results of one template, as zips; the lab's results are read from this process's lab runtime.
    app.state.export_service = None
    if ports.sessions is not None and app.state.assessments is not None:
        from vulnmart.privacy.exports import ExportService

        app.state.export_service = ExportService(sessions=ports.sessions, audit=ports.audit, consent=app.state.consent_service, views=app.state.view_history,
                                                 deletion=getattr(app.state, "deletion_service", None), assessments=app.state.assessments,
                                                 companies=app.state.companies, lab=lambda: getattr(app.state, "lab", None))
    # The admin's operations (story P-28): the queue, users, force-stop, settings, quotas, capacity and the scheduler's runs, behind admin-only routes. They need the database,
    # the company and role services and the quota table; a lab in this process gives force-stop and the capacity view (without one force-stop answers 500 and capacity shows no hosts).
    app.state.admin_ops = None
    if (ports.sessions is not None and app.state.companies is not None and app.state.roles is not None and app.state.accounts is not None
            and app.state.session_service is not None and isinstance(ports.quota, DbQuotaPort)):
        from vulnmart.accounts.status import AccountStatusService as _Status
        from vulnmart.admin.ops import AdminOps
        from vulnmart.privacy.retention.records import SqlAttemptRecords as _Records
        from vulnmart.privacy.subjects import SubjectService as _Subjects

        _subjects = _Subjects(ports.audit_sessions) if ports.audit_sessions is not None else None
        app.state.admin_ops = AdminOps(
            sessions=ports.sessions, roles=app.state.roles, companies=app.state.companies, status=_Status(ports.sessions, app.state.roles, ports.audit),
            accounts=app.state.accounts, settings=ports.settings, quotas=ports.quota, audit=ports.audit, records=_Records(ports.sessions), deletion=app.state.deletion_service,
            end_sessions=app.state.session_service.revoke_all, stopper=lab.force_stop if lab is not None else None,
            host_status=(lambda: lab.host.host_status()) if lab is not None else None, instance_states=(lambda: lab.instance_states) if lab is not None else None,
            job_status=(lambda: app.state.scheduler.status()) if app.state.scheduler is not None else None,
            pseudonym=_subjects.pseudonym if _subjects is not None else None)
    # Break-glass and the audit log for admins (story P-31): a 15-minute session per candidate attempt (D-94), read from this process's lab runtime.
    app.state.break_glass = None
    if ports.sessions is not None and app.state.roles is not None:
        from vulnmart.admin.breakglass import BreakGlassService

        app.state.break_glass = BreakGlassService(sessions=ports.sessions, roles=app.state.roles, audit=ports.audit, companies=app.state.companies,
                                                  lab=lambda: getattr(app.state, "lab", None))
    app.include_router(admin_router)
    app.include_router(accounts_router)
    app.include_router(session_router)
    app.include_router(password_router)
    app.include_router(me_router)
    if lab is not None:
        _mount_lab(app, lab, lab_tickets)
    app.include_router(mfa_router)
    app.include_router(consent_router)
    app.include_router(deletion_router)
    app.include_router(invite_router)
    app.include_router(company_router)
    app.include_router(company_privacy_router)
    app.include_router(colleague_router)
    app.include_router(export_router)
    app.include_router(live_router)

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


def create_entry_app() -> FastAPI:
    """The app of the API process: production does not start with Mailpit, a missing Brevo key or a placeholder sender (FR-NTF-03, wiring finding F-03).
    The check lives here and not in `create_app`, which tests build with any settings."""
    from vulnmart.notifications.config import validate_mail_settings

    validate_mail_settings(get_settings())
    return create_app(configure_logs=True)


app = create_entry_app()
