"""Ports of the event receiver (story edge-4): where accepted events go, who knows the current epoch, who hears of a refusal.

`EventStore` is keyed `(instance_id, epoch, seq)` and keeps the raw-body digest, so an identical replay is a no-op and a
changed body is a mismatch. The in-memory store is the only one until the events table migration (P-06, H-07); events then
live in the ingest process only. `EventSink` is the hand-off to the milestone engine (`MilestoneEngine.process` fits it).
Nothing here keeps a key or a signature.
"""
from __future__ import annotations

import enum
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

DEFAULT_MAX_STORED = 100_000


class PutResult(enum.Enum):
    ACCEPTED = "accepted"
    DUPLICATE = "duplicate"  # the same triple with the same body
    MISMATCH = "mismatch"  # the same triple with another body
    FULL = "full"


@runtime_checkable
class EventStore(Protocol):
    def put(self, event: Mapping[str, Any], digest: str, received_at: datetime) -> PutResult:
        """Store one verified event. The check and the write are one atomic step."""
        ...


@runtime_checkable
class InstanceEpochs(Protocol):
    def current(self, instance_id: str) -> int | None:
        """The current epoch of an instance, or None when the platform does not know it."""
        ...


@runtime_checkable
class EventSink(Protocol):
    def __call__(self, event: Mapping[str, Any], received_at: datetime) -> object:
        """Called once per newly accepted event (never for a replay). The milestone engine's `process` is one."""
        ...


@runtime_checkable
class SecuritySink(Protocol):
    def raise_event(self, kind: str, instance_id: str, epoch: int, seq: int) -> None:
        """A 401 happened. Kind and the claimed identity only: never the body, a key or a signature."""
        ...


@dataclass(frozen=True, slots=True)
class StoredRow:
    event: Mapping[str, Any]
    received_at: datetime
    digest: str


class MemoryEventStore:
    def __init__(self, max_stored: int = DEFAULT_MAX_STORED) -> None:
        self._lock = threading.Lock()
        self._max = max_stored
        self._rows: dict[tuple[str, int, int], StoredRow] = {}

    def put(self, event: Mapping[str, Any], digest: str, received_at: datetime) -> PutResult:
        triple = (event["instance_id"], event["epoch"], event["seq"])
        with self._lock:
            old = self._rows.get(triple)
            if old is not None:
                return PutResult.DUPLICATE if old.digest == digest else PutResult.MISMATCH
            if len(self._rows) >= self._max:
                return PutResult.FULL
            self._rows[triple] = StoredRow(event, received_at, digest)
            return PutResult.ACCEPTED

    def triples(self) -> list[tuple[str, int, int]]:
        """The stored (instance_id, epoch, seq) in the platform's order (epoch, seq) per instance."""
        with self._lock:
            return sorted(self._rows, key=lambda t: (t[0], t[1], t[2]))

    def rows(self) -> list[StoredRow]:
        with self._lock:
            return [self._rows[t] for t in sorted(self._rows, key=lambda t: (t[0], t[1], t[2]))]

    def __len__(self) -> int:
        with self._lock:
            return len(self._rows)


class MemoryInstanceEpochs:
    """Current epochs, set by the orchestrator state report receiver (H-106) when it exists, by a test until then."""

    def __init__(self, epochs: Mapping[str, int] | None = None) -> None:
        self._lock = threading.Lock()
        self._epochs: dict[str, int] = dict(epochs or {})

    def set(self, instance_id: str, epoch: int) -> None:
        if type(epoch) is not int or epoch < 1:
            raise ValueError("epoch must be an integer of at least 1")
        with self._lock:
            self._epochs[instance_id] = epoch

    def current(self, instance_id: str) -> int | None:
        with self._lock:
            return self._epochs.get(instance_id)


@dataclass(frozen=True, slots=True)
class SecurityRecord:
    kind: str
    instance_id: str
    epoch: int
    seq: int


class MemorySecuritySink:
    def __init__(self) -> None:
        self.records: list[SecurityRecord] = []

    def raise_event(self, kind: str, instance_id: str, epoch: int, seq: int) -> None:
        self.records.append(SecurityRecord(kind, instance_id, epoch, seq))
