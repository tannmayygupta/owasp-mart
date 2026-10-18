"""The attempt state machine (architecture 04 section 10.1, FR-SES-08). There is no paused state (C-1)."""
from __future__ import annotations

from enum import StrEnum


class AttemptState(StrEnum):
    """Same strings as vulnmart.ports.attempts.AttemptState (a test in apps/api compares the two)."""

    INVITED = "invited"
    CONSENT = "consent"
    READY = "ready"
    RUNNING = "running"
    SUBMITTED = "submitted"
    REPORTED = "reported"
    WITHDRAWN = "withdrawn"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    DELETED = "deleted"


class InvalidTransition(Exception):
    """A move that the transition table does not allow (a skip, a reopen, a move out of deleted)."""

    def __init__(self, source: AttemptState, target: AttemptState) -> None:
        super().__init__(f"attempt cannot move from {source.value} to {target.value}")
        self.source = source
        self.target = target


S = AttemptState

# Exactly the edges of the diagram in architecture 04 section 10.1.
TRANSITIONS: dict[AttemptState, frozenset[AttemptState]] = {
    S.INVITED: frozenset({S.CONSENT, S.DELETED}),
    S.CONSENT: frozenset({S.READY, S.WITHDRAWN, S.DELETED}),
    S.READY: frozenset({S.RUNNING, S.CANCELLED, S.WITHDRAWN, S.DELETED}),
    S.RUNNING: frozenset({S.SUBMITTED, S.EXPIRED, S.CANCELLED, S.WITHDRAWN, S.DELETED}),
    S.EXPIRED: frozenset({S.SUBMITTED}),
    S.SUBMITTED: frozenset({S.REPORTED, S.WITHDRAWN, S.DELETED}),
    S.REPORTED: frozenset({S.DELETED}),
    S.WITHDRAWN: frozenset({S.DELETED}),
    S.CANCELLED: frozenset({S.DELETED}),
    S.DELETED: frozenset(),
}

CANCELLABLE = frozenset({S.READY, S.RUNNING})
WITHDRAWABLE = frozenset({S.CONSENT, S.READY, S.RUNNING, S.SUBMITTED})
TERMINAL = frozenset({S.DELETED})


def _state(value: AttemptState | str) -> AttemptState:
    """Accept a state or its string; an unknown name (for example "paused") raises ValueError."""
    return AttemptState(value)


def can_move(source: AttemptState | str, target: AttemptState | str) -> bool:
    return _state(target) in TRANSITIONS[_state(source)]


def move(source: AttemptState | str, target: AttemptState | str) -> AttemptState:
    """Return the new state, or raise InvalidTransition (ValueError for an unknown state name)."""
    src, dst = _state(source), _state(target)
    if dst not in TRANSITIONS[src]:
        raise InvalidTransition(src, dst)
    return dst
