"""The ids-only attempt event log (FR-TIM-04, D-90). Only names and fields on the allow-list are accepted.

The log holds ids, state names, levels, costs, result words and UTC instants. No names, emails, request bodies,
flags, digests or pasted text can be stored: an unknown event name or field is refused with ValueError.
"""
from __future__ import annotations

import _thread
from collections import defaultdict
from collections.abc import Mapping
from typing import Any, Protocol

COMMON_FIELDS = frozenset({"event", "attempt_id", "at"})

# FR-TIM-04 event names, plus the engine's own withdrawal and review events. Value: the extra fields each may carry.
EVENT_FIELDS: dict[str, frozenset[str]] = {
    "invite_created": frozenset(),
    "invite_opened": frozenset(),
    "consent_given": frozenset(),
    "session_started": frozenset({"state", "instance_id"}),
    "instance_requested": frozenset({"instance_id"}),
    "instance_ready": frozenset({"instance_id"}),
    "request_seen": frozenset({"instance_id", "challenge_key"}),  # a summary marker only, never the request
    "milestone_reached": frozenset({"instance_id", "challenge_key", "level"}),
    "flag_auto_detected": frozenset({"instance_id", "challenge_key"}),
    "flag_submitted": frozenset({"instance_id", "challenge_key", "result"}),  # the result word only
    "hint_unlocked": frozenset({"challenge_key", "level", "cost"}),
    "instance_reset": frozenset({"state", "reset_count", "instance_id"}),
    "time_warning_sent": frozenset({"state", "minutes_left"}),
    "session_expired": frozenset({"state", "deadline_at"}),
    "session_submitted": frozenset({"state", "submitted_at", "reason"}),
    "instance_destroyed": frozenset({"instance_id", "state"}),
    "recruiter_viewed_report": frozenset({"viewer_id"}),
    "results_released": frozenset({"viewer_id"}),  # H-355: the recruiter released the candidate's results (a failed write must not pass silently, so the route appends directly)
    "attempt_withdrawn": frozenset({"state", "delete_after"}),
    "withdrawal_undone": frozenset({"state"}),
    "time_extended": frozenset({"state", "minutes", "deadline_at", "viewer_id"}),  # R-25: the recruiter gave extra time (the id of the recruiter, never a name)
    "held_review_overdue": frozenset({"challenge_key"}),
}

MAX_VALUE_LENGTH = 100
_SCALARS = (str, int, bool, type(None))


class AttemptLog(Protocol):
    def append(self, event: Mapping[str, Any]) -> None: ...

    def read(self, attempt_id: str) -> tuple[dict[str, Any], ...]:
        """Events of one attempt in arrival order; an unknown attempt gives an empty tuple."""
        ...

    def read_keyed(self, attempt_id: str) -> tuple[tuple[int, dict[str, Any]], ...]:
        """The same events with a number that grows in arrival order (the timeline cursor is built from it)."""
        ...


def validate_event(event: Mapping[str, Any]) -> dict[str, Any]:
    """Return a clean copy or raise ValueError (unknown name, unknown field, missing id, non-scalar or long value)."""
    name = event.get("event")
    if not isinstance(name, str) or name not in EVENT_FIELDS:
        raise ValueError(f"event is not on the allow-list: {name!r}")
    extra = set(event) - COMMON_FIELDS - EVENT_FIELDS[name]
    if extra:
        raise ValueError(f"field not allowed on {name}: {sorted(extra)}")
    if not isinstance(event.get("attempt_id"), str) or not event["attempt_id"]:
        raise ValueError("attempt_id is required")
    if not event.get("at"):
        raise ValueError("at (a UTC instant) is required")
    for key, value in event.items():
        if not isinstance(value, _SCALARS):
            raise ValueError(f"{key}: only text, numbers and true/false are allowed")
        if isinstance(value, str) and len(value) > MAX_VALUE_LENGTH:
            raise ValueError(f"{key}: value too long for an ids-only log")
    return dict(event)


class EngineBridge:
    """`from_engine`, shared by every log (needs `append`)."""

    def append(self, event: Mapping[str, Any]) -> None:  # pragma: no cover - implemented by the log
        raise NotImplementedError

    def from_engine(self, payload: Mapping[str, Any]) -> None:
        """Connect with `AttemptEngine(..., events=log.from_engine)`.

        The engine's `attempt.state_changed` to `running` is the start of the clock (D-80) and is logged as
        `session_started`; other state changes are duplicated by named events (expired, submitted, ...) and skipped.
        """
        if payload.get("event") == "attempt.state_changed":
            if payload.get("to") != "running":
                return
            self.append({"event": "session_started", "attempt_id": payload["attempt_id"], "at": payload["at"],
                         "state": "running"})
            return
        self.append(payload)


class InMemoryAttemptLog(EngineBridge):
    def __init__(self) -> None:
        self._lock = _thread.allocate_lock()
        self._by_attempt: dict[str, list[dict[str, Any]]] = defaultdict(list)

    def append(self, event: Mapping[str, Any]) -> None:
        clean = validate_event(event)
        with self._lock:
            self._by_attempt[clean["attempt_id"]].append(clean)

    def read(self, attempt_id: str) -> tuple[dict[str, Any], ...]:
        with self._lock:
            return tuple(dict(e) for e in self._by_attempt.get(attempt_id, ()))

    def read_keyed(self, attempt_id: str) -> tuple[tuple[int, dict[str, Any]], ...]:
        with self._lock:
            return tuple((i, dict(e)) for i, e in enumerate(self._by_attempt.get(attempt_id, ()), start=1))
