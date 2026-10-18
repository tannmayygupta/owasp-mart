"""The outbox relay (story P-22, FR-LIV-06, ADR 0052): `domain_events` rows to the Valkey streams, in order, at least once.

`EventRelay.run_once` takes the unpublished rows in outbox order (one relay at a time: a Postgres advisory lock), resolves each event's audiences from its attempt
(`AudienceResolver`: the attempt's owner and, for a candidate attempt, its company; the kinds come from `audiences.json` via `audiences_for`), appends the event to the
stream of each audience and marks the row published. A crash between the append and the mark makes the next pass append again, and the store refuses the second append
(it remembers the newest outbox row per stream), so a stream never holds an event twice. An attempt that cannot be found is retried a few passes (its row may still be
in flight) and then dropped, logged by id and type only.
"""
from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.outbox import audiences_for

from .models import DomainEvent
from .store import StreamWriter

logger = logging.getLogger("vulnmart.live")

BATCH = 100
MAX_RELAY_ATTEMPTS = 20
LOCK_KEY = "live-relay"


@dataclass(frozen=True, slots=True)
class Owner:
    user_id: str
    org_id: str | None  # set for a candidate attempt


class AudienceResolver:
    """Who owns an attempt, read from the lab's attempts table (a system read: the relay has no user in scope)."""

    def __init__(self, sessions: sessionmaker[Session]):
        self._sessions = sessions

    def owners(self, attempt_ids: set[str]) -> dict[str, Owner]:
        if not attempt_ids:
            return {}
        from vulnmart.lab.models import Attempt

        with self._sessions() as session:
            rows = session.execute(select(Attempt.id, Attempt.user_id, Attempt.org_id).where(Attempt.id.in_(attempt_ids))).all()
        return {r.id: Owner(r.user_id, r.org_id) for r in rows}


def streams_for(event: dict[str, Any], owner: Owner) -> list[str]:
    """The streams of the audiences of one checked event. Learner practice never reaches a company: the audience table has no `org` for it, and a learner attempt has
    no `org_id` to name."""
    out: list[str] = []
    for kind in audiences_for(event):
        if kind == "user":
            out.append(f"live:user:{owner.user_id}")
        elif kind == "org" and owner.org_id:
            out.append(f"live:org:{owner.org_id}")
        elif kind == "admin":
            out.append("live:admin")
    return out


class EventRelay:
    def __init__(self, sessions: sessionmaker[Session], resolver: AudienceResolver, writer: StreamWriter, *, batch: int = BATCH,
                 now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._sessions, self._resolver, self._writer, self._batch, self._now = sessions, resolver, writer, batch, now

    def run_once(self) -> int:
        """One pass. Returns how many events were published (dropped ones are not counted)."""
        published = 0
        with self._sessions.begin() as session:
            if session.get_bind().dialect.name == "postgresql":
                if not session.execute(text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": LOCK_KEY}).scalar():
                    return 0  # another relay is working; it will take these rows
            rows = session.scalars(select(DomainEvent).where(DomainEvent.published_at.is_(None)).order_by(DomainEvent.id).limit(self._batch)).all()
            if not rows:
                return 0
            owners = self._resolver.owners({r.payload["data"].get("attempt_id") for r in rows} - {None})
            for row in rows:
                event = row.payload
                owner = owners.get(event["data"].get("attempt_id"))
                if owner is None:
                    row.relay_attempts += 1
                    if row.relay_attempts >= MAX_RELAY_ATTEMPTS:
                        row.published_at, row.dropped = self._now(), True
                        logger.warning("domain event %s (%s) dropped: its attempt was not found after %s passes", row.id, row.type, MAX_RELAY_ATTEMPTS)
                        continue
                    break  # keep the order: later rows wait for this one until it is dropped
                body = json.dumps(event, separators=(",", ":"))
                for stream in streams_for(event, owner):
                    self._writer.append(stream, row.id, body)
                row.published_at = self._now()
                published += 1
        return published


class RelayLoop:
    """Runs `EventRelay.run_once` every `interval` seconds on a thread of its own (the worker process starts it)."""

    def __init__(self, relay: EventRelay, interval: float):
        self._relay, self._interval = relay, interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="live-relay", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                while self._relay.run_once() >= BATCH:
                    pass
            except Exception:  # noqa: BLE001 - the loop must survive a database or Valkey outage and try again
                logger.exception("live relay pass failed; trying again in %ss", self._interval)
            self._stop.wait(self._interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
