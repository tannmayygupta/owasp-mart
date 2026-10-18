"""Paste submission of a flag (story 6.3, FR-FLG-05, `submitFlag` in lab.openapi.yaml).

`submit_flag(attempt_id, challenge_key, text)` answers `correct` or `incorrect` (never the reason: no oracle) and a credit of
`credited`, `held` or `none`. A wrong value, a decoy, a flag of an earlier epoch and a flag of another instance are all
`incorrect`; each counts toward 5 incorrect pastes per challenge in 10 minutes, and the next call raises `FlagRateLimited`
(the API answers 429 with Retry-After), even for the right value. The pasted text is checked by recomputing and is never
stored, logged, echoed or put into an error; only `(attempt, challenge, result)` goes to the log.
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
from vulnmart.ports.reports import CHALLENGE_KEYS

MAX_INCORRECT = 5
WINDOW_S = 600
MAX_TEXT = 512


@dataclass(frozen=True, slots=True)
class FlagSubmissionResult:
    result: str  # correct | incorrect
    credit: str  # credited | held | none


class FlagSubmitService:
    def __init__(self, *, attempts: AttemptPort, directory: InstanceDirectory, checker: FlagChecker, milestones: MilestoneStore,
                 integrity: IntegritySink, log: FlagSubmissionLog, clock: Callable[[], datetime],
                 gate: ActivityGate | None = None, max_incorrect: int = MAX_INCORRECT, window_s: int = WINDOW_S) -> None:
        self.attempts, self.directory, self.checker = attempts, directory, checker
        self.milestones, self.integrity, self.log, self.clock = milestones, integrity, log, clock
        self.gate: ActivityGate = gate or AllowAllGate()
        self.max_incorrect, self.window_s = max_incorrect, window_s
        self._lock = threading.Lock()
        self._misses: dict[tuple[str, str], deque[datetime]] = defaultdict(deque)  # in memory; the real store is Akshay's

    def _retry_after(self, key: tuple[str, str], now: datetime) -> int | None:
        """Seconds to wait when the limit is reached, else None. Drops misses older than the window."""
        q = self._misses[key]
        while q and q[0] <= now - timedelta(seconds=self.window_s):
            q.popleft()
        if len(q) < self.max_incorrect:
            return None
        return math.ceil((q[0] + timedelta(seconds=self.window_s) - now).total_seconds())

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
        with self._lock:
            wait = self._retry_after(key, now)
            if wait is not None:
                self.log.record(attempt_id, challenge_key, "rate_limited", now)
                raise FlagRateLimited("too many incorrect submissions", retry_after=wait)
            correct, credit = self._check(info, challenge_key, text, now)
            if not correct:
                self._misses[key].append(now)
            self.log.record(attempt_id, challenge_key, "correct" if correct else "incorrect", now)
        return FlagSubmissionResult("correct" if correct else "incorrect", credit)

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
