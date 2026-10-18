"""The activity-versus-capture check for pasted flags (FR-ACH-02, D-94; audit blocker B6).

Until now the lab ran with `AllowAllGate`, so nothing was ever held for a human and the integrity signals were library code that nothing called. This gate reads what
the sidecar reported about the instance (the activity buckets: counts per minute, never a body) and decides, for a correct pasted flag:

- consistent: the instance of the current epoch shows at least `min_requests` requests before the capture (the player really used the shop). The capture counts.
- inconsistent: with `activity_check_mode` "hold" (the default of the attempt's rules) the capture is held for a named reviewer (never zeroed, never counted until
  decided); with "flag" it counts and an activity flag is raised for the reviewer.

A capture sooner than `min_capture_seconds` after the attempt started also raises a timing flag (evidence for a human, never a decision; it does not hold).

A flag the sidecar saw in a response to the owning player is not checked here: that request is the activity (the event path of the milestone engine). The numbers are
placeholders until pilot data exists (OI-25, FR-ACH-03).
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any

from vulnmart_attempts.integrity import capture_treatment, timing_signals
from vulnmart_attempts.rules import Rules

from vulnmart.ingest.activity import ActivityStore, minute_of
from vulnmart.ingest.stores import InstanceDirectory, IntegritySink
from vulnmart.ports.reports import IntegrityType

log = logging.getLogger("vulnmart.gate")

MIN_REQUESTS = 5  # placeholder (OI-25): requests an exploit of any class needs at the very least


class RecordedActivityGate:
    def __init__(self, *, activity: ActivityStore, directory: InstanceDirectory, record_of: Callable[[str], Any | None],
                 integrity: IntegritySink, min_requests: int = MIN_REQUESTS) -> None:
        self.activity, self.directory, self.record_of, self.integrity = activity, directory, record_of, integrity
        self.min_requests = min_requests

    def _requests_before(self, instance_id: str, epoch: int, at: datetime) -> int:
        cut = minute_of(at)
        return sum(b.requests for b in self.activity.buckets(instance_id, epoch) if b.minute <= cut)

    def allows(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        info = self.directory.for_attempt(attempt_id)
        rec = self.record_of(attempt_id)
        rules: Rules = getattr(rec, "rules", None) or Rules()
        if info is None:
            return False  # a capture that no instance can explain waits for a human
        self._timing(attempt_id, challenge_key, rec, rules, at)
        consistent = self._requests_before(info.instance_id, info.epoch, at) >= self.min_requests
        treatment = capture_treatment(rules.activity_check_mode, consistent)
        if treatment == "flagged":
            self.integrity.add(attempt_id, IntegrityType.ACTIVITY,
                               f"The capture of {challenge_key} does not match the recorded activity of the instance; it was counted (mode flag) and is shown for review.",
                               f"flagged:{challenge_key}", challenge_key, at)
        return treatment != "held"

    def _timing(self, attempt_id: str, challenge_key: str, rec: Any, rules: Rules, at: datetime) -> None:
        started = getattr(rec, "started_at", None)
        if started is None:
            return
        try:
            for s in timing_signals(attempt_id, challenge_key, (at - started).total_seconds(), float(rules.min_capture_seconds)):
                self.integrity.add(attempt_id, IntegrityType.TIMING, s.explanation, s.dedupe_key, challenge_key, at)
        except Exception:  # a signal never stops a capture
            log.exception("timing signal failed for %s", attempt_id)
