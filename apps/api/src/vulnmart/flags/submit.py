"""Paste submission of a flag (story 6.3, FR-FLG-05, `submitFlag` in lab.openapi.yaml).

`submit_flag(attempt_id, challenge_key, text)` answers `correct` or `incorrect` (never the reason: no oracle) and a credit of
`credited`, `held` or `none`. A wrong value, a decoy, a flag of an earlier epoch and a flag of another instance are all
`incorrect`; each counts toward 5 incorrect pastes per challenge in 10 minutes, and the next call raises `FlagRateLimited`
(the API answers 429 with Retry-After), even for the right value. The pasted text is checked by recomputing and is never
stored, logged, echoed or put into an error; only `(attempt, challenge, result)` goes to the log.

FR-ACH-01's second AC, the hard cap: 30 wrong pastes for one challenge over the whole assessment, not just the 10-minute
window (the window resets after its lock; the cap never does). It raises the same `FlagRateLimited` (same IF-8 code, so no
contract change), with a long `retry_after` standing for "not in this assessment", because the shared error shape has no
separate "permanent" field; a distinct code is a reasonable follow-up if the wording needs to differ for the learner.
"""
from __future__ import annotations

import math
import threading
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from vulnmart.flags.checker import FlagChecker, FlagClass
from vulnmart.ingest.engine import apply_check, classify_digest
from vulnmart.ingest.stores import (
    ActivityGate, AllowAllGate, FlagSubmissionLog, InstanceDirectory, IntegritySink, MilestoneStore,
)
from vulnmart.ports.attempts import AttemptPort, AttemptState
from vulnmart.ports.errors import AttemptStateInvalid, ChallengeNotFound, FlagRateLimited, InstanceMissing
from vulnmart.ports.reports import CHALLENGE_KEYS, Milestone

MAX_INCORRECT = 5
WINDOW_S = 600
MAX_TEXT = 512
MAX_INCORRECT_PER_ASSESSMENT = 30  # FR-ACH-01 AC2: a hard cap, never reset within the assessment
CAP_RETRY_AFTER_S = 24 * 3600  # "not again in this assessment"; the attempt itself ends well before this elapses


@dataclass(frozen=True, slots=True)
class FlagSubmissionResult:
    result: str  # correct | incorrect
    credit: str  # credited | held | none


class FlagSubmitService:
    def __init__(self, *, attempts: AttemptPort, directory: InstanceDirectory, checker: FlagChecker, milestones: MilestoneStore,
                 integrity: IntegritySink, log: FlagSubmissionLog, clock: Callable[[], datetime],
                 gate: ActivityGate | None = None, max_incorrect: int = MAX_INCORRECT, window_s: int = WINDOW_S,
                 per_minute_of: Callable[[str], int | None] | None = None) -> None:
        # `per_minute_of(attempt_id)`: the company template's limit of pasted flags per minute for this attempt (None: no extra limit)
        self._per_minute_of = per_minute_of
        self._pastes: dict[str, deque[datetime]] = defaultdict(deque)
        self.attempts, self.directory, self.checker = attempts, directory, checker
        self.milestones, self.integrity, self.log, self.clock = milestones, integrity, log, clock
        self.gate: ActivityGate = gate or AllowAllGate()
        self.max_incorrect, self.window_s = max_incorrect, window_s
        self._lock = threading.Lock()
        self._misses: dict[tuple[str, str], deque[datetime]] = defaultdict(deque)  # in memory; the real store is Akshay's
        self._lifetime_misses: dict[tuple[str, str], int] = defaultdict(int)  # fallback only, when the log has no incorrect_total

    def _retry_after(self, key: tuple[str, str], now: datetime) -> int | None:
        """Seconds to wait when the limit is reached, else None. The misses come from the stored submission log when it can say
        (so a restart or a second process does not reset the budget); otherwise from memory, dropping those older than the window."""
        since = now - timedelta(seconds=self.window_s)
        stored = getattr(self.log, "incorrect_since", None)
        if stored is not None:
            times = [t for t in stored(key[0], key[1], since) if t > since]
        else:
            q = self._misses[key]
            while q and q[0] <= since:
                q.popleft()
            times = list(q)
        if len(times) < self.max_incorrect:
            return None
        return math.ceil((times[0] + timedelta(seconds=self.window_s) - now).total_seconds())

    def _cap_reached(self, key: tuple[str, str]) -> bool:
        """FR-ACH-01 AC2: 30 wrong pastes for this challenge over the whole assessment. Read from the durable log when it can
        count the whole history (so a restart does not reset it); otherwise an in-memory count that only grows."""
        counted = getattr(self.log, "incorrect_total", None)
        total = counted(key[0], key[1]) if counted is not None else self._lifetime_misses[key]
        return total >= MAX_INCORRECT_PER_ASSESSMENT

    def submit_flag(self, attempt_id: str, challenge_key: str, text: str) -> FlagSubmissionResult:
        """Raises AttemptNotFound, AttemptGone, AttemptStateInvalid (not running), ChallengeNotFound, InstanceMissing,
        FlagRateLimited."""
        attempt = self.attempts.get(attempt_id)
        if attempt.state is not AttemptState.RUNNING:
            raise AttemptStateInvalid("the attempt is not running")
        if challenge_key not in CHALLENGE_KEYS:
            raise ChallengeNotFound("not a challenge key")
        info = self.directory.for_attempt(attempt_id)
        if info is None:
            raise InstanceMissing("the attempt has no instance")
        now = self.clock()
        key = (attempt_id, challenge_key)
        repeat = self._repeat_of_credit(attempt_id, challenge_key, info, text)
        if repeat is not None:
            return FlagSubmissionResult("correct", repeat)  # IF-2: before the rate limit, records nothing new
        with self._lock:
            if self._cap_reached(key):
                self.log.record(attempt_id, challenge_key, "rate_limited", now)
                raise FlagRateLimited("too many incorrect submissions for this challenge in this assessment", retry_after=CAP_RETRY_AFTER_S)
            wait = self._pasted_too_fast(attempt_id, now)
            if wait is None:
                wait = self._retry_after(key, now)
            if wait is not None:
                self.log.record(attempt_id, challenge_key, "rate_limited", now)
                raise FlagRateLimited("too many incorrect submissions", retry_after=wait)
            correct, credit = self._check(info, challenge_key, text, now)
            if not correct:
                self._misses[key].append(now)
                if getattr(self.log, "incorrect_total", None) is None:
                    self._lifetime_misses[key] += 1
            self.log.record(attempt_id, challenge_key, "correct" if correct else "incorrect", now)
        return FlagSubmissionResult("correct" if correct else "incorrect", credit)

    def _pasted_too_fast(self, attempt_id: str, now: datetime) -> int | None:
        """Seconds to wait when the attempt pasted its template's number of flags in the last minute, else None; a paste that is let through is counted."""
        limit = self._per_minute_of(attempt_id) if self._per_minute_of is not None else None
        if limit is None:
            return None
        q = self._pastes[attempt_id]
        while q and q[0] <= now - timedelta(seconds=60):
            q.popleft()
        if len(q) >= limit:
            return max(1, math.ceil((q[0] + timedelta(seconds=60) - now).total_seconds()))
        q.append(now)
        return None

    def _repeat_of_credit(self, attempt_id: str, challenge_key: str, info, text: object) -> str | None:
        """`credited` or `held` when the right value is pasted again for a challenge that already has that credit; else None."""
        credited = self.milestones.best(attempt_id, challenge_key) is Milestone.M3
        held = (not credited) and self.milestones.is_held(attempt_id, challenge_key)
        if not (credited or held):
            return None
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            return None
        try:
            check = classify_digest(self.checker, self.directory, info, epoch=info.epoch, candidate=text.strip(), claimed=challenge_key)
        except (ValueError, UnicodeEncodeError):
            return None
        if check.flag_class is FlagClass.CORRECT and check.challenge_key == challenge_key:
            return "credited" if credited else "held"
        return None

    def _check(self, info, challenge_key: str, text: object, now: datetime) -> tuple[bool, str]:
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            return False, "none"
        try:
            check = classify_digest(self.checker, self.directory, info, epoch=info.epoch, candidate=text.strip(),
                                    claimed=challenge_key)
        except (ValueError, UnicodeEncodeError):
            return False, "none"
        if check.flag_class is FlagClass.CORRECT and check.challenge_key != challenge_key:
            return False, "none"  # right flag, other challenge: no credit, no oracle
        credit, _ = apply_check(check, info, event_epoch=info.epoch, at=now, milestones=self.milestones,
                                integrity=self.integrity, gate=self.gate)
        if check.flag_class is FlagClass.CORRECT and check.challenge_key == challenge_key:
            return True, credit
        return False, "none"
