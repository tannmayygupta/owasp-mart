"""The attempt record, the `AttemptStore` Protocol (compare-and-set on a version) and an in-memory store for tests and the demo."""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Protocol

import _thread

from .rules import Rules
from .schedule import AttemptTimes
from .states import AttemptState


class Conflict(Exception):
    """A compare-and-set lost (the stored version moved, or a unique key is taken). The caller reloads and retries."""


@dataclass(frozen=True, slots=True)
class AttemptRecord:
    """One attempt. Frozen: every change is a new record stored with `put_if_version`.

    Only ids, states and UTC instants live here (no names, emails or request bodies).
    """

    id: str
    user_id: str
    template_id: str
    consent_id: str
    created_at: datetime
    rules: Rules = field(default_factory=Rules)
    state: AttemptState = AttemptState.READY
    instance_id: str | None = None
    version: int = 0
    ready_at: datetime | None = None
    started_at: datetime | None = None
    deadline_at: datetime | None = None
    submitted_at: datetime | None = None
    frozen_until: datetime | None = None
    access: str = "open"  # "open" or "frozen" (the IF-5 access value, not a state)
    warnings_sent: tuple[int, ...] = ()
    destroyed: bool = False
    destroy_claim_at: datetime | None = None
    cancelled_by: str | None = None
    cancelled_reason: str | None = None
    cancelled_at: datetime | None = None
    reported_at: datetime | None = None
    reset_count: int = 0  # FR-SES-09: resets counted while running; never decreased
    withdrawn_at: datetime | None = None  # FR-SES-10
    delete_after: datetime | None = None  # withdrawn_at + 7 days; cleared by an undo
    undone_at: datetime | None = None
    deleted_at: datetime | None = None
    org_id: str | None = None  # the organisation of a candidate attempt; None for learner practice
    purged_at: datetime | None = None  # the platform's deletion workflow purged the data (the attempt is gone)

    @property
    def times(self) -> AttemptTimes:
        return AttemptTimes(
            ready_at=self.ready_at,
            started_at=self.started_at,
            deadline_at=self.deadline_at,
            submitted_at=self.submitted_at,
            frozen_until=self.frozen_until,
        )


DUE_STATES = (AttemptState.RUNNING, AttemptState.EXPIRED, AttemptState.SUBMITTED, AttemptState.REPORTED, AttemptState.CANCELLED)


def select_due(records: "Iterable[AttemptRecord]", now: datetime) -> list[AttemptRecord]:
    """The attempts that may need work, by deadline (the rule every store shares): running, expired, submitted, reported or cancelled and
    not yet destroyed, or withdrawn with a deletion date."""
    rows = [
        r for r in records
        if (r.state in DUE_STATES and not (r.destroyed and r.state != AttemptState.RUNNING))
        or (r.state == AttemptState.WITHDRAWN and r.delete_after is not None)
    ]
    epoch = datetime.fromtimestamp(0, tz=now.tzinfo)
    return sorted(rows, key=lambda r: (r.deadline_at is None, r.deadline_at or epoch, r.id))


class AttemptStore(Protocol):
    def get(self, attempt_id: str) -> AttemptRecord | None: ...

    def find(self, user_id: str, template_id: str) -> AttemptRecord | None:
        """The one attempt of this user for this template, if any."""
        ...

    def add(self, record: AttemptRecord) -> AttemptRecord:
        """Insert a new record (version 0). Raises Conflict if the id or the (user, template) pair exists."""
        ...

    def ids(self) -> list[str]:
        """The id of every attempt, oldest first."""
        ...

    def for_user(self, user_id: str) -> list[AttemptRecord]:
        """Every attempt of the user, newest first."""
        ...

    def in_states(self, *states: AttemptState) -> list[AttemptRecord]:
        """Every attempt in one of the states, oldest first."""
        ...

    def put_if_version(self, record: AttemptRecord, expected_version: int) -> AttemptRecord:
        """Store `record` only if the stored version equals `expected_version`; the stored copy has version + 1.
        Raises Conflict otherwise."""
        ...

    def due(self, now: datetime) -> list[AttemptRecord]:
        """Attempts that may need work: running, expired, submitted or cancelled and not yet destroyed, by deadline."""
        ...


class InMemoryAttemptStore:
    def __init__(self) -> None:
        self._lock = _thread.allocate_lock()
        self._by_id: dict[str, AttemptRecord] = {}
        self._by_key: dict[tuple[str, str], str] = {}

    def get(self, attempt_id: str) -> AttemptRecord | None:
        with self._lock:
            return self._by_id.get(attempt_id)

    def find(self, user_id: str, template_id: str) -> AttemptRecord | None:
        with self._lock:
            found = self._by_key.get((user_id, template_id))
            return self._by_id[found] if found else None

    def add(self, record: AttemptRecord) -> AttemptRecord:
        with self._lock:
            key = (record.user_id, record.template_id)
            if record.id in self._by_id or key in self._by_key:
                raise Conflict("attempt already exists")
            stored = replace(record, version=0)
            self._by_id[record.id] = stored
            self._by_key[key] = record.id
            return stored

    def ids(self) -> list[str]:
        with self._lock:
            return list(self._by_id)

    def in_states(self, *states: AttemptState) -> list[AttemptRecord]:
        with self._lock:
            return [r for r in self._by_id.values() if r.state in states]

    def for_user(self, user_id: str) -> list[AttemptRecord]:
        with self._lock:
            rows = [r for r in self._by_id.values() if r.user_id == user_id]
        return sorted(rows, key=lambda r: (r.created_at, r.id), reverse=True)

    def put_if_version(self, record: AttemptRecord, expected_version: int) -> AttemptRecord:
        with self._lock:
            current = self._by_id.get(record.id)
            if current is None or current.version != expected_version:
                raise Conflict("attempt version moved")
            stored = replace(record, version=expected_version + 1)
            self._by_id[record.id] = stored
            return stored

    def due(self, now: datetime) -> list[AttemptRecord]:
        with self._lock:
            return select_due(self._by_id.values(), now)
