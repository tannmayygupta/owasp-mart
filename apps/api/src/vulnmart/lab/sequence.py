"""One challenge at a time, each with its own countdown (stream L; decision of the developer, 2026-10-20).

A learner's practice run walks the challenges in catalogue order. Only the current challenge is visible: the ones before it are solved or timed out, the
ones after it do not exist for the learner yet. The current challenge is `ready` until the learner begins it; beginning starts its countdown by tier (Easy
20, Medium 40, Hard 60 minutes). It ends when its flag is captured (`solved`, also a capture held for review) or its time is over (`expired`), and the next
challenge becomes current. A challenge that ended gives no more credit and no more hints; what it earned stays.

Nothing here runs on a timer: the state of a challenge is worked out from the stored instant it was begun, the milestones and the clock. A company
assessment is not sequenced (its template and its own time limit apply), so `SequencedMilestones` passes those attempts straight through.
"""
from __future__ import annotations

import threading
from collections.abc import Callable, Mapping, Sequence as Seq
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol

from vulnmart.ingest.stores import MilestoneStore
from vulnmart.ports.reports import Milestone

TIER_MINUTES: Mapping[str, int] = {"Easy": 20, "Medium": 40, "Hard": 60}
DEFAULT_MINUTES = 40  # a challenge whose tier is not in the catalogue gets the middle time
RUN_MARGIN_MINUTES = 30  # the run limit is the sum of the challenge times plus this

READY, ACTIVE, SOLVED, EXPIRED, FUTURE = "ready", "active", "solved", "expired", "future"


class ChallengeClockLedger(Protocol):
    def opened_at(self, attempt_id: str, challenge_key: str) -> datetime | None:
        """When the learner began this challenge, or None."""
        ...

    def open(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        """Record the beginning once. False when it was already begun (the first instant stays)."""
        ...


class InMemoryChallengeClockLedger:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._at: dict[tuple[str, str], datetime] = {}

    def opened_at(self, attempt_id: str, challenge_key: str) -> datetime | None:
        with self._lock:
            return self._at.get((attempt_id, challenge_key))

    def open(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        with self._lock:
            if (attempt_id, challenge_key) in self._at:
                return False
            self._at[(attempt_id, challenge_key)] = at
            return True


@dataclass(frozen=True, slots=True)
class ChallengeClock:
    challenge_key: str
    state: str  # ready | active | solved | expired | future
    limit_seconds: int
    opened_at: datetime | None
    expires_at: datetime | None

    @property
    def visible(self) -> bool:
        return self.state != FUTURE

    @property
    def closed(self) -> bool:
        return self.state in (SOLVED, EXPIRED)

    def seconds_left(self, now: datetime) -> int | None:
        if self.state != ACTIVE or self.expires_at is None:
            return None
        return max(0, int((self.expires_at - now).total_seconds()))


class Sequence:
    """The order of the challenges, the time of each and the state of each for one attempt."""

    def __init__(self, ledger: ChallengeClockLedger, milestones: MilestoneStore, keys: Seq[str], tier_of: Callable[[str], str | None],
                 clock: Callable[[], datetime]) -> None:
        self.ledger, self.milestones, self.keys, self._tier_of, self._clock = ledger, milestones, tuple(keys), tier_of, clock

    def limit_minutes(self, key: str) -> int:
        return TIER_MINUTES.get(self._tier_of(key) or "", DEFAULT_MINUTES)

    def total_minutes(self) -> int:
        return sum(self.limit_minutes(k) for k in self.keys)

    def run_limit_minutes(self) -> int:
        return self.total_minutes() + RUN_MARGIN_MINUTES

    def clocks(self, attempt_id: str, now: datetime | None = None) -> list[ChallengeClock]:
        """One entry per challenge, in order: solved and expired ones, then the current one, then the future ones."""
        now = now or self._clock()
        out: list[ChallengeClock] = []
        current_found = False
        for key in self.keys:
            limit = self.limit_minutes(key) * 60
            opened = self.ledger.opened_at(attempt_id, key)
            expires = opened + timedelta(seconds=limit) if opened is not None else None
            solved = self.milestones.best(attempt_id, key) is Milestone.M3 or self.milestones.is_held(attempt_id, key)
            if solved:
                out.append(ChallengeClock(key, SOLVED, limit, opened, expires))
            elif expires is not None and now >= expires:
                out.append(ChallengeClock(key, EXPIRED, limit, opened, expires))
            elif current_found:
                out.append(ChallengeClock(key, FUTURE, limit, None, None))
            else:
                current_found = True
                out.append(ChallengeClock(key, ACTIVE if opened is not None else READY, limit, opened, expires))
        return out

    def clock_of(self, attempt_id: str, key: str, now: datetime | None = None) -> ChallengeClock | None:
        for c in self.clocks(attempt_id, now):
            if c.challenge_key == key:
                return c
        return None

    def current(self, attempt_id: str, now: datetime | None = None) -> ChallengeClock | None:
        for c in self.clocks(attempt_id, now):
            if c.state in (READY, ACTIVE):
                return c
        return None

    def finished(self, attempt_id: str, now: datetime | None = None) -> bool:
        """Every challenge is solved or timed out."""
        return all(c.closed for c in self.clocks(attempt_id, now))

    def begin(self, attempt_id: str, key: str, at: datetime) -> ChallengeClock | None:
        """Start the countdown of the current challenge (once). The clock of the challenge afterwards, or None when `key` is not the current one."""
        cur = self.current(attempt_id, at)
        if cur is None or cur.challenge_key != key:
            return None
        self.ledger.open(attempt_id, key, at)
        return self.clock_of(attempt_id, key, at)


class SequencedMilestones:
    """The milestone store of a learner's run with the sequence applied: credit and hold count only for the challenge that is active right now.

    Everything else is the wrapped store. A company assessment, and an attempt the runtime does not know, pass straight through."""

    def __init__(self, inner: MilestoneStore, sequence: Sequence, is_learner: Callable[[str], bool]) -> None:
        self._inner, self._sequence, self._is_learner = inner, sequence, is_learner

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def _counts(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        if not self._is_learner(attempt_id):
            return True
        c = self._sequence.clock_of(attempt_id, challenge_key, at)
        # solved counts too: a capture held for review is credited when a reviewer accepts it, after the challenge already moved on
        return c is not None and c.state in (ACTIVE, SOLVED)

    def credit(self, attempt_id: str, challenge_key: str, milestone: Milestone, at: datetime) -> bool:
        return self._counts(attempt_id, challenge_key, at) and self._inner.credit(attempt_id, challenge_key, milestone, at)

    def hold(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        return self._counts(attempt_id, challenge_key, at) and self._inner.hold(attempt_id, challenge_key, at)
