"""The ports the platform's code receives (IF-9), wired for this process.

Real today: `ScopePort` (context variable) and `SettingsPort` (the `settings` table) when a database is configured.
Stubs until their stories (the in-memory fakes of story P-05): audit and key service (P-17), outbox (P-09), quotas.
A stub keeps state in memory only, so the process logs a warning at start and nothing it holds survives a restart.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import Engine
from sqlalchemy.orm import sessionmaker

from vulnmart.ports.audit import AuditPort
from vulnmart.ports.fakes import FakeAuditPort, FakeKeyPort, FakeOutboxPort, FakeQuotaPort, FakeSettingsPort
from vulnmart.ports.keys import KeyPort
from vulnmart.ports.outbox import OutboxPort
from vulnmart.ports.quota import QuotaPort
from vulnmart.ports.settings import SettingsPort

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


def build_ports(settings: Settings, *, engine: Engine | None = None) -> Ports:
    """Create the ports of this process. Without a database DSN the settings come from their defaults (fake)."""
    scope = ContextScopePort()
    if engine is None and settings.postgres_dsn:
        engine = make_engine(settings.postgres_dsn)
    sessions = make_sessions(engine, scope_or_none) if engine is not None else None
    settings_port: SettingsPort = DbSettingsPort(sessions) if sessions is not None else FakeSettingsPort()
    logger.warning("ports %s are in-memory stubs until their stories (P-09, P-17)", ", ".join(STUBS))
    return Ports(
        scope=scope, settings=settings_port, quota=FakeQuotaPort(), audit=FakeAuditPort(), outbox=FakeOutboxPort(), keys=FakeKeyPort(),
        engine=engine, sessions=sessions,
    )
