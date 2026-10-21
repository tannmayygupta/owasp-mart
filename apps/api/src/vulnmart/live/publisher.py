"""Publishing an event (story P-22): the IF-3 event goes into `domain_events`, in the transaction of its cause when the caller gives its session, in a transaction of its
own otherwise. The audiences are resolved later by the relay, from the attempt; the publisher never names one (IF-3).

`LiveOutbox` is the `OutboxPort` of a process that has a database but no request session to put emails in: events are durable, emails still go to the stand-in
until the mail outbox gets its session (story P-09).
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.outbox import EmailJob, OutboxEntry, OutboxPort, audiences_for, check_event

from .models import DomainEvent

Clock = Callable[[], datetime]


def _now() -> datetime:
    return datetime.now(UTC)


class DbEventPublisher:
    def __init__(self, sessions: sessionmaker[Session], session_source: Callable[[], Session] | None = None, *, now: Clock = _now):
        self._sessions, self._session_source, self._now = sessions, session_source, now

    def publish(self, event: Mapping[str, Any]) -> OutboxEntry:
        """Queue one IF-3 event. Raises EventInvalid (the same rules as the in-memory outbox). With a `session_source` the row is added to that session and committed
        or rolled back with it; without one it is committed here."""
        check_event(event)
        plain = json.loads(json.dumps(event))  # a copy that is certainly JSON
        now = self._now()
        row = DomainEvent(type=plain["type"], payload=plain, created_at=now)
        if self._session_source is not None:
            session = self._session_source()
            session.add(row)
            session.flush()
        else:
            with self._sessions.begin() as session:
                session.add(row)
                session.flush()
        return OutboxEntry(id=row.id, event=plain, audiences=audiences_for(plain), created_at=now.isoformat())


class LiveOutbox:
    """`publish` is durable (the database), `enqueue_email` is the stand-in's; with no stand-in (production) it fails closed instead of losing the mail in memory."""

    def __init__(self, events: DbEventPublisher, emails: OutboxPort | None):
        self._events, self._emails = events, emails

    def publish(self, event: Mapping[str, Any]) -> OutboxEntry:
        return self._events.publish(event)

    def enqueue_email(self, *, template: str, to_user_id: str, params: Mapping[str, Any] | None = None) -> EmailJob:
        if self._emails is None:
            raise RuntimeError("this outbox carries domain events only: emails are written with DbOutboxPort in the caller's own transaction")
        return self._emails.enqueue_email(template=template, to_user_id=to_user_id, params=params)
