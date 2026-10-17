"""Stores of the milestone engine (story 6.3): Protocols and in-memory fakes.

The real tables (`events`, `milestones`, `integrity_flags`, `flag_submissions`) are Akshay's (handoff H-330); nothing here
migrates. Nothing in these stores ever holds a flag, a digest of a flag or a pasted text.
"""
from __future__ import annotations

import threading
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

from vulnmart.ports.reports import IntegrityType, Milestone

MILESTONE_ORDER = {Milestone.NONE: 0, Milestone.M1: 1, Milestone.M2: 2, Milestone.M3: 3}
MAX_RECENT_INSTANCES = 200


@dataclass(frozen=True, slots=True)
class InstanceInfo:
    """What the engine needs to know of an instance: whose attempt it is, its current flag epoch and its challenges."""

    instance_id: str
    attempt_id: str
    template_id: str
    epoch: int
    challenge_keys: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class StoredEvent:
    """An event as the log keeps it: the IF-4 envelope and the platform's arrival time (never the instance clock)."""

    event: Mapping[str, Any]
    received_at: datetime

    @property
    def order(self) -> tuple[int, int]:
        return (self.event["epoch"], self.event["seq"])


@runtime_checkable
class EventLog(Protocol):
    def append(self, event: Mapping[str, Any], received_at: datetime) -> bool:
        """Store the event. False when `(instance_id, epoch, seq)` is already there (a replay): nothing changes."""
        ...

    def read(self, instance_id: str, epoch: int | None = None) -> list[StoredEvent]:
        """The events of an instance (of one epoch when given), ordered by `(epoch, seq)`."""
        ...


@runtime_checkable
class MilestoneStore(Protocol):
    def best(self, attempt_id: str, challenge_key: str) -> Milestone: ...

    def credit(self, attempt_id: str, challenge_key: str, milestone: Milestone, at: datetime) -> bool:
        """Keep the better of the stored and the new milestone. True when the stored value rose (the milestone is new)."""
        ...

    def hold(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        """Record a capture that waits for a human (the activity gate said no). True when new."""
        ...


@runtime_checkable
class IntegritySink(Protocol):
    def add(self, attempt_id: str, kind: IntegrityType, explanation: str, dedupe_key: str) -> bool:
        """Write one integrity flag, once per `(attempt_id, dedupe_key)`. True when written."""
        ...


@runtime_checkable
class InstanceDirectory(Protocol):
    def get(self, instance_id: str) -> InstanceInfo | None: ...

    def for_attempt(self, attempt_id: str) -> InstanceInfo | None: ...

    def recent(self, challenge_key: str, template_id: str, within_s: int) -> Mapping[str, int]:
        """Live and recently ended instances of a template and challenge: instance id to its current epoch, at most 200."""
        ...


@runtime_checkable
class ActivityGate(Protocol):
    def allows(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        """The activity check of FR-ACH-02. False holds the capture for a human."""
        ...


@runtime_checkable
class FlagSubmissionLog(Protocol):
    def record(self, attempt_id: str, challenge_key: str, result: str, at: datetime) -> None:
        """Keep `(attempt, challenge, result)`. Never the pasted text."""
        ...


# ---- in-memory fakes ----

class InMemoryEventLog:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._seen: set[tuple[str, int, int]] = set()
        self._by_instance: dict[str, list[StoredEvent]] = defaultdict(list)

    def append(self, event: Mapping[str, Any], received_at: datetime) -> bool:
        triple = (event["instance_id"], event["epoch"], event["seq"])
        with self._lock:
            if triple in self._seen:
                return False
            self._seen.add(triple)
            rows = self._by_instance[event["instance_id"]]
            rows.append(StoredEvent(event, received_at))
            rows.sort(key=lambda r: r.order)
            return True

    def read(self, instance_id: str, epoch: int | None = None) -> list[StoredEvent]:
        with self._lock:
            return [r for r in self._by_instance.get(instance_id, []) if epoch is None or r.event["epoch"] == epoch]


class InMemoryMilestoneStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.items: dict[tuple[str, str], tuple[Milestone, datetime]] = {}
        self.held: dict[tuple[str, str], datetime] = {}

    def best(self, attempt_id: str, challenge_key: str) -> Milestone:
        with self._lock:
            return self.items.get((attempt_id, challenge_key), (Milestone.NONE, None))[0]

    def credit(self, attempt_id: str, challenge_key: str, milestone: Milestone, at: datetime) -> bool:
        with self._lock:
            if MILESTONE_ORDER[milestone] <= MILESTONE_ORDER[self.best(attempt_id, challenge_key)]:
                return False
            self.items[(attempt_id, challenge_key)] = (milestone, at)
            return True

    def hold(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        with self._lock:
            if (attempt_id, challenge_key) in self.held:
                return False
            self.held[(attempt_id, challenge_key)] = at
            return True


@dataclass(frozen=True, slots=True)
class IntegrityRow:
    attempt_id: str
    kind: IntegrityType
    explanation: str


class InMemoryIntegritySink:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._keys: set[tuple[str, str]] = set()
        self.rows: list[IntegrityRow] = []

    def add(self, attempt_id: str, kind: IntegrityType, explanation: str, dedupe_key: str) -> bool:
        with self._lock:
            if (attempt_id, dedupe_key) in self._keys:
                return False
            self._keys.add((attempt_id, dedupe_key))
            self.rows.append(IntegrityRow(attempt_id, kind, explanation))
            return True

    def of(self, attempt_id: str, kind: IntegrityType | None = None) -> list[IntegrityRow]:
        return [r for r in self.rows if r.attempt_id == attempt_id and (kind is None or r.kind is kind)]


@dataclass(slots=True)
class InMemoryInstanceDirectory:
    """Test directory: `add` registers an instance; `recent` lists every other registered instance of the template."""

    items: dict[str, InstanceInfo] = field(default_factory=dict)

    def add(self, info: InstanceInfo) -> InstanceInfo:
        self.items[info.instance_id] = info
        return info

    def get(self, instance_id: str) -> InstanceInfo | None:
        return self.items.get(instance_id)

    def for_attempt(self, attempt_id: str) -> InstanceInfo | None:
        return next((i for i in self.items.values() if i.attempt_id == attempt_id), None)

    def recent(self, challenge_key: str, template_id: str, within_s: int) -> Mapping[str, int]:
        found = {i.instance_id: i.epoch for i in self.items.values()
                 if i.template_id == template_id and challenge_key in i.challenge_keys}
        return dict(list(found.items())[:MAX_RECENT_INSTANCES])


class AllowAllGate:
    def allows(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        return True


class InMemoryFlagSubmissionLog:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []

    def record(self, attempt_id: str, challenge_key: str, result: str, at: datetime) -> None:
        self.rows.append((attempt_id, challenge_key, result))
