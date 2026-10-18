"""Bot visits (story 6.4, FR-DET-09): a record of `bot.visit` events, never a credit and never evidence of a player capture.

A `bot.visit` event (source `bot`, session kind `bot`) is stored as `(instance_id, epoch, visit_id, ticket_id, phase, at)` and counted.
The milestone engine ignores every bot event (`engine.is_countable`); `collector.hit` credits only through the C03 rule of
`milestone_rules.json` (`bot_tagged`). The evidence recorder ignores bot events too. The store is a Protocol with an in-memory fake until
Akshay's table exists (H-330).
"""
from __future__ import annotations

import threading
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

BOT_EVENT = "bot.visit"
PHASES = ("queued", "start", "end")


@dataclass(frozen=True, slots=True)
class BotVisit:
    instance_id: str
    epoch: int
    visit_id: str
    ticket_id: str
    phase: str
    at: datetime  # the platform's arrival time


@runtime_checkable
class BotVisitStore(Protocol):
    def add(self, visit: BotVisit) -> bool:
        """True when new: the same `(instance_id, epoch, visit_id, phase)` twice is stored once."""
        ...

    def visits(self, instance_id: str) -> list[BotVisit]: ...

    def count(self, instance_id: str, phase: str | None = None) -> int: ...


class InMemoryBotVisitStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._rows: list[BotVisit] = []
        self._seen: set[tuple[str, int, str, str]] = set()

    def add(self, visit: BotVisit) -> bool:
        key = (visit.instance_id, visit.epoch, visit.visit_id, visit.phase)
        with self._lock:
            if key in self._seen:
                return False
            self._seen.add(key)
            self._rows.append(visit)
            return True

    def visits(self, instance_id: str) -> list[BotVisit]:
        with self._lock:
            return [v for v in self._rows if v.instance_id == instance_id]

    def count(self, instance_id: str, phase: str | None = None) -> int:
        return sum(1 for v in self.visits(instance_id) if phase is None or v.phase == phase)


def is_bot_event(event: Mapping[str, Any]) -> bool:
    return event.get("source") == "bot" or event.get("session_kind") == "bot"


class BotRecorder:
    """Records `bot.visit` events. Returns True when a visit was stored. Everything else is ignored here."""

    def __init__(self, store: BotVisitStore) -> None:
        self.store = store

    def observe(self, event: Mapping[str, Any], received_at: datetime) -> bool:
        if event.get("type") != BOT_EVENT or not is_bot_event(event):
            return False
        d = event.get("data") or {}
        if d.get("phase") not in PHASES or not d.get("visit_id") or not d.get("ticket_id"):
            return False
        return self.store.add(BotVisit(event["instance_id"], event["epoch"], d["visit_id"], d["ticket_id"], d["phase"], received_at))
