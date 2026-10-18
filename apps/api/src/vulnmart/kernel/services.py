"""The ports the platform's code receives (IF-9), wired for this process.

Real today: `ScopePort` (context variable) and `SettingsPort` (the `settings` table) when a database is configured; the audit log (`DbAuditPort`
behind `PseudonymisingAudit`, story P-17) when a database address is configured; the key service (`DbKeyPort`, story P-17) when a keystore address is
configured.
Stubs until their stories (the in-memory fakes of story P-05): the outbox (story P-09, until a request session exists), quotas, and the audit log or
the keys when their database is not configured. A stub keeps state in memory only, so the process logs a warning at start and nothing it holds survives
a restart.
"""
from __future__ import annotations

import base64
import logging
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.audit import AuditPort
from vulnmart.ports.fakes import FakeAuditPort, FakeKeyPort, FakeOutboxPort, FakeQuotaPort, FakeSettingsPort
from vulnmart.ports.keys import KeyPort
from vulnmart.ports.outbox import OutboxPort
from vulnmart.ports.quota import QuotaPort
from vulnmart.ports.settings import SettingsPort

from vulnmart.live.publisher import DbEventPublisher, LiveOutbox
from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.privacy.subjects import PseudonymisingAudit, SubjectService

from .audit import DbAuditPort
from .db import ScopedSession, make_engine, make_sessions
from .keys import DbKeyPort, KekRing, decode_key
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
    audit_db: DbAuditPort | None = None  # the log itself (verify, entries, anchors); `audit` is the port the modules write to
    audit_sessions: sessionmaker[Session] | None = None  # the small pool of its own that the audit log and the pseudonyms use


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
    events: Any = FakeOutboxPort()
    outbox: OutboxPort = events
    if sessions is not None:
        events = DbEventPublisher(sessions, session_source)  # events are durable as soon as there is a database (story P-22)
        outbox = LiveOutbox(events, FakeOutboxPort())  # emails stay in the stand-in until a request session exists
    if sessions is not None and session_source is not None:
        outbox = DbOutboxPort(session_source, events, validator=validate_params)
        stubs.remove("outbox")
    audit: AuditPort = FakeAuditPort()
    audit_db: DbAuditPort | None = None
    audit_sessions: sessionmaker[Session] | None = None
    if settings.postgres_dsn and engine is not None:
        # The audit log and the pseudonyms open transactions of their own while a caller may hold one, so they get a small pool of their own: a
        # pool shared with the callers could be used up by callers that all wait for an audit connection.
        audit_sessions = sessionmaker(make_engine(settings.postgres_dsn, pool_size=4, max_overflow=2), expire_on_commit=False)
        audit_db = DbAuditPort(audit_sessions)
        audit = PseudonymisingAudit(audit_db, SubjectService(audit_sessions))
        stubs.remove("audit")
    keys: KeyPort = FakeKeyPort()
    if settings.keystore_dsn:
        keys = key_port_from(settings)
        stubs.remove("keys")
    if stubs:
        logger.warning("ports %s are in-memory stubs until their stories (P-22)", ", ".join(stubs))
    return Ports(
        scope=scope, settings=settings_port, quota=FakeQuotaPort(), audit=audit, outbox=outbox, keys=keys,
        engine=engine, sessions=sessions, audit_db=audit_db, audit_sessions=audit_sessions,
    )


def key_port_from(settings: Settings) -> DbKeyPort:
    """The key service over `vm_keystore`. Staging and production need the KEK and the three masters; dev refuses to start without a KEK (wrapping keys
    with a key nobody keeps would lose them at the next restart); dev and test make random masters for this process (flags and event keys then
    change on restart)."""
    strict = settings.env in ("staging", "production")
    kek_text = settings.kek_text()
    if kek_text is None:
        if settings.env != "test":
            raise RuntimeError("the key service needs a KEK (VULNMART_KEK or VULNMART_KEK_FILE, lines of version:base64)")
        kek_text = "1:" + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
    variables = {"event": "VULNMART_EVENT_MASTER", "flag": "VULNMART_FLAG_KEY", "owner": "VULNMART_OWNER_KEY"}
    masters: dict[str, bytes] = {}
    for name, variable in variables.items():
        value = settings.master_text(name)  # type: ignore[arg-type]
        if value is None:
            if strict:
                raise RuntimeError(f"VULNMART_ENV={settings.env} needs the {name} master key ({variable} or {variable}_FILE)")
            masters[name] = secrets.token_bytes(32)
        else:
            masters[name] = decode_key(value, what=f"the {name} master key")
    engine = make_engine(settings.keystore_dsn, pool_size=4, max_overflow=2)
    return DbKeyPort(sessionmaker(engine, expire_on_commit=False), KekRing.parse(kek_text), event_master=masters["event"], flag_key=masters["flag"],
                     owner_key=masters["owner"])
