"""The ports the platform's code receives (IF-9), wired for this process.

Real today: `ScopePort` (context variable) and `SettingsPort` (the `settings` table) when a database is configured.
Stubs until their stories (the in-memory fakes of story P-05): audit and key service (P-17), outbox (P-09), quotas.
A stub keeps state in memory only, so the process logs a warning at start and nothing it holds survives a restart.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.audit import AuditPort
from vulnmart.ports.fakes import FakeAuditPort, FakeKeyPort, FakeOutboxPort, FakeQuotaPort, FakeSettingsPort
from vulnmart.ports.keys import KeyPort
from vulnmart.ports.outbox import OutboxPort
from vulnmart.ports.quota import QuotaPort
from vulnmart.ports.settings import SettingsPort

from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params

from .db import ScopedSession, make_engine, make_sessions
from .scope import ContextScopePort, scope_or_none
from .settings import DbSettingsPort, Settings

logger = logging.getLogger("vulnmart.kernel")

STUBS = ("audit", "outbox", "keys", "quota")


@dataclass
class Ports:
    scope: ContextScopePort
    settings: SettingsPort
    quota: QuotaPort
    audit: AuditPort
    outbox: OutboxPort
    keys: KeyPort
    engine: Engine | None = None
    sessions: sessionmaker[ScopedSession] | None = None


def build_ports(settings: Settings, *, engine: Engine | None = None, session_source: Callable[[], Session] | None = None) -> Ports:
    """Create the ports of this process. Without a database DSN the settings come from their defaults (fake).

    `session_source` returns the session of the transaction in progress; with it (and a database) the outbox writes emails to
    `email_outbox` in that transaction (story P-09). The request layer that owns such a session arrives with story P-11, so the
    API process passes none yet and keeps the in-memory outbox (events stay in memory until story P-22 in any case)."""
    scope = ContextScopePort()
    if engine is None and settings.postgres_dsn:
        engine = make_engine(settings.postgres_dsn)
    sessions = make_sessions(engine, scope_or_none) if engine is not None else None
    settings_port: SettingsPort = DbSettingsPort(sessions) if sessions is not None else FakeSettingsPort()
    stubs = list(STUBS)
    events = FakeOutboxPort()
    outbox: OutboxPort = events
    if sessions is not None and session_source is not None:
        outbox = DbOutboxPort(session_source, events, validator=validate_params)
        stubs.remove("outbox")
    logger.warning("ports %s are in-memory stubs until their stories (P-17, P-22)", ", ".join(stubs))
    return Ports(
        scope=scope, settings=settings_port, quota=FakeQuotaPort(), audit=FakeAuditPort(), outbox=outbox, keys=FakeKeyPort(),
        engine=engine, sessions=sessions,
    )
