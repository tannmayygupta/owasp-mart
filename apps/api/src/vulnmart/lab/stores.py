"""The stores of the lab runtime as one bundle (stream L): in memory for tests and the demo, Postgres in `vulnmart.lab.pg`.

`LabRuntime` takes a `LabStores` and never reaches into a store's fields, so the same code runs on either.
"""
from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from vulnmart_attempts import AttemptStore, InMemoryAttemptStore
from vulnmart_attempts.attempt_log import AttemptLog, InMemoryAttemptLog
from vulnmart_attempts.review import AuditSink, HeldStore, InMemoryAudit, InMemoryHeldStore

from vulnmart.ingest.activity import ActivityStore, InMemoryActivityStore
from vulnmart.ingest.bots import BotVisitStore, InMemoryBotVisitStore
from vulnmart.ingest.evidence import EvidenceStore, InMemoryEvidenceStore
from vulnmart.ingest.store import EventStore, InstanceEpochs, MemoryEventStore, MemoryInstanceEpochs, MemorySecuritySink, SecuritySink
from vulnmart.ingest.stores import (
    EventLog,
    FlagSubmissionLog,
    InMemoryEventLog,
    InMemoryFlagSubmissionLog,
    InMemoryInstanceDirectory,
    InMemoryIntegritySink,
    InMemoryMilestoneStore,
    InstanceDirectory,
    IntegritySink,
    MilestoneStore,
)
from vulnmart.lab.sequence import ChallengeClockLedger, InMemoryChallengeClockLedger


class HintLedger(Protocol):
    def levels(self, attempt_id: str, challenge_key: str) -> tuple[int, ...]:
        """The unlocked levels of a challenge, ascending."""
        ...

    def add(self, attempt_id: str, challenge_key: str, level: int, at: datetime) -> bool:
        """Record an unlocked level once. False when that level was already unlocked."""
        ...


class InMemoryHintLedger:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._levels: dict[tuple[str, str], dict[int, datetime]] = {}

    def levels(self, attempt_id: str, challenge_key: str) -> tuple[int, ...]:
        with self._lock:
            return tuple(sorted(self._levels.get((attempt_id, challenge_key), ())))

    def add(self, attempt_id: str, challenge_key: str, level: int, at: datetime) -> bool:
        with self._lock:
            have = self._levels.setdefault((attempt_id, challenge_key), {})
            if level in have:
                return False
            have[level] = at
            return True


@dataclass(slots=True)
class LabStores:
    attempts: AttemptStore
    attempt_log: AttemptLog
    hints: HintLedger
    milestones: MilestoneStore
    integrity: IntegritySink
    directory: InstanceDirectory
    epochs: InstanceEpochs
    events: EventLog
    event_store: EventStore
    security: SecuritySink
    evidence: EvidenceStore
    activity: ActivityStore
    bots: BotVisitStore
    flag_log: FlagSubmissionLog
    held: HeldStore
    audit: AuditSink
    purge: Callable[[str], Any] | None = None  # deletes the data of an attempt once it is `deleted` (withdrawal, FR-SES-10)
    challenge_clock: ChallengeClockLedger | None = None  # when a learner began each challenge (the per-challenge countdown); None means in memory

    @property
    def persistent(self) -> bool:
        return getattr(self.attempts, "persistent", False)


def memory_stores() -> LabStores:
    return LabStores(
        attempts=InMemoryAttemptStore(), attempt_log=InMemoryAttemptLog(), hints=InMemoryHintLedger(),
        milestones=InMemoryMilestoneStore(), integrity=InMemoryIntegritySink(), directory=InMemoryInstanceDirectory(),
        epochs=MemoryInstanceEpochs(), events=InMemoryEventLog(), event_store=MemoryEventStore(), security=MemorySecuritySink(),
        evidence=InMemoryEvidenceStore(), activity=InMemoryActivityStore(), bots=InMemoryBotVisitStore(),
        flag_log=InMemoryFlagSubmissionLog(), held=InMemoryHeldStore(), audit=InMemoryAudit(),
        challenge_clock=InMemoryChallengeClockLedger(),
    )


class OrgOf:
    """`Mapping.get` over the stored attempts: the organisation that owns an attempt, for the reviewer rule (D-92)."""

    def __init__(self, attempts: AttemptStore) -> None:
        self._attempts = attempts

    def get(self, attempt_id: str, default: Any = None) -> Any:
        rec = self._attempts.get(attempt_id)
        return default if rec is None or rec.org_id is None else rec.org_id
