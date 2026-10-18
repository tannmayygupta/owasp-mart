"""Held-capture review (FR-ACH-07, FR-SCR-10, D-92 for OI-38).

A held capture stays out of the score until a named reviewer accepts it. A rejection keeps it excluded and
zeroes nobody. Every decision is audited (reviewer id, decision, time, note). The library does no login: the
platform supplies `may_review(reviewer, attempt_id)`.
"""
from __future__ import annotations

import _thread
import hashlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Any, Protocol

from .clock import Clock
from .scoring import Fact, Milestone

NOTE_LIMIT = 500
OVERDUE_AFTER = timedelta(days=7)  # a reminder only; it never changes a score (D-92)
DECISIONS = ("accept", "reject")


class ReviewForbidden(Exception):
    """The caller is not allowed to review this attempt."""


class ReviewFinal(Exception):
    """A different decision was already recorded; decisions are final."""


class NotHeld(KeyError):
    """No held capture exists for that attempt and challenge."""


@dataclass(frozen=True, slots=True)
class HeldItem:
    attempt_id: str
    challenge_key: str
    milestone: Milestone  # the held milestone
    fallback: Milestone  # best milestone that is not held
    held_at: datetime
    evidence_ids: tuple[str, ...] = ()
    status: str = "open"  # open | accepted | rejected
    reminded: bool = False

    def to_fact(self, hint_levels: tuple[int, ...] = ()) -> Fact:
        """The scoring fact: accepted counts in full; open and rejected stay held (excluded, never zeroed)."""
        if self.status == "accepted":
            return Fact(self.milestone, hint_levels)
        return Fact(self.milestone, hint_levels, held=True, fallback=self.fallback)


class HeldStore(Protocol):
    def add(self, item: HeldItem) -> None: ...

    def get(self, attempt_id: str, challenge_key: str) -> HeldItem | None: ...

    def items(self, attempt_id: str) -> tuple[HeldItem, ...]: ...

    def open_items(self) -> tuple[HeldItem, ...]: ...

    def release_held(self, attempt_id: str, challenge_key: str) -> HeldItem:
        """Accept: the held milestone counts."""
        ...

    def keep_held(self, attempt_id: str, challenge_key: str) -> HeldItem:
        """Reject: stays excluded."""
        ...

    def mark_reminded(self, attempt_id: str, challenge_key: str) -> bool:
        """True the first time only."""
        ...


class InMemoryHeldStore:
    def __init__(self) -> None:
        self._lock = _thread.allocate_lock()
        self._items: dict[tuple[str, str], HeldItem] = {}

    def add(self, item: HeldItem) -> None:
        with self._lock:
            self._items.setdefault((item.attempt_id, item.challenge_key), item)

    def get(self, attempt_id: str, challenge_key: str) -> HeldItem | None:
        with self._lock:
            return self._items.get((attempt_id, challenge_key))

    def items(self, attempt_id: str) -> tuple[HeldItem, ...]:
        with self._lock:
            return tuple(v for (a, _), v in sorted(self._items.items()) if a == attempt_id)

    def open_items(self) -> tuple[HeldItem, ...]:
        with self._lock:
            return tuple(v for _, v in sorted(self._items.items()) if v.status == "open")

    def _set(self, attempt_id: str, challenge_key: str, **changes: Any) -> HeldItem:
        with self._lock:
            key = (attempt_id, challenge_key)
            if key not in self._items:
                raise NotHeld(key)
            self._items[key] = replace(self._items[key], **changes)
            return self._items[key]

    def release_held(self, attempt_id: str, challenge_key: str) -> HeldItem:
        return self._set(attempt_id, challenge_key, status="accepted")

    def keep_held(self, attempt_id: str, challenge_key: str) -> HeldItem:
        return self._set(attempt_id, challenge_key, status="rejected")

    def mark_reminded(self, attempt_id: str, challenge_key: str) -> bool:
        with self._lock:
            key = (attempt_id, challenge_key)
            item = self._items.get(key)
            if item is None or item.reminded:
                return False
            self._items[key] = replace(item, reminded=True)
            return True


@dataclass(frozen=True, slots=True)
class AuditRecord:
    reviewer: str
    decision: str
    at: datetime
    attempt_id: str
    challenge_key: str
    note_id: str  # sha-256 prefix of the note, a stable reference
    note: str  # the recruiter's own words, cut at NOTE_LIMIT characters; never a flag


class AuditSink(Protocol):
    def record(self, entry: AuditRecord) -> None: ...


class InMemoryAudit:
    def __init__(self) -> None:
        self.rows: list[AuditRecord] = []

    def record(self, entry: AuditRecord) -> None:
        self.rows.append(entry)


def default_may_review(org_of_attempt: Mapping[str, str]) -> Callable[[Mapping[str, str], str], bool]:
    """D-92 default: a `recruiter` or `admin` of the organisation that owns the attempt's assessment; nobody else.
    The reviewer is a mapping `{"id", "role", "org_id"}` supplied by the platform after login."""
    def may_review(reviewer: Mapping[str, str], attempt_id: str) -> bool:
        org = org_of_attempt.get(attempt_id)
        return org is not None and reviewer.get("org_id") == org and reviewer.get("role") in ("recruiter", "admin")
    return may_review


class HeldCaptureReview:
    def __init__(self, store: HeldStore, audit: AuditSink, clock: Clock,
                 may_review: Callable[[Any, str], bool], events: Callable[[dict[str, Any]], None] | None = None) -> None:
        self._store = store
        self._audit = audit
        self._clock = clock
        self._may_review = may_review
        self._events = events or (lambda _e: None)
        self._lock = _thread.allocate_lock()

    def held(self, attempt_id: str) -> tuple[HeldItem, ...]:
        """Held captures still waiting for a decision, with their evidence ids."""
        return tuple(i for i in self._store.items(attempt_id) if i.status == "open")

    def decide(self, attempt_id: str, challenge_key: str, reviewer: Any, decision: str, note: str = "") -> HeldItem:
        if decision not in DECISIONS:
            raise ValueError("decision must be 'accept' or 'reject'")
        if not self._may_review(reviewer, attempt_id):
            raise ReviewForbidden("this reviewer may not review this attempt")
        reviewer_id = reviewer["id"] if isinstance(reviewer, Mapping) else str(reviewer)
        key = (attempt_id, challenge_key)
        with self._lock:
            item = self._store.get(attempt_id, challenge_key)
            if item is None:
                raise NotHeld(key)
            if item.status != "open":
                # finality comes from the stored status, so it survives a restart and a second worker (review finding B6)
                if ("accept" if item.status == "accepted" else "reject") != decision:
                    raise ReviewFinal("a different decision is already recorded")
                return item  # same decision again: no second audit row
            text = note[:NOTE_LIMIT]
            now = self._clock()
            self._audit.record(AuditRecord(reviewer_id, decision, now, attempt_id, challenge_key,
                                           hashlib.sha256(note.encode("utf-8")).hexdigest()[:16], text))
            return self._store.release_held(*key) if decision == "accept" else self._store.keep_held(*key)

    def remind_overdue(self) -> tuple[HeldItem, ...]:
        """Emit `held_review_overdue` once for each open held capture older than 7 days. Nothing else changes."""
        now = self._clock()
        out = []
        for item in self._store.open_items():
            if now - item.held_at >= OVERDUE_AFTER and self._store.mark_reminded(item.attempt_id, item.challenge_key):
                try:
                    self._events({"event": "held_review_overdue", "attempt_id": item.attempt_id,
                                  "at": now.isoformat(), "challenge_key": item.challenge_key})
                except Exception:  # a failing sink must not stop the other reminders (review finding B7)
                    pass
                out.append(item)
        return tuple(out)
