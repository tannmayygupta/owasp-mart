"""AttemptPort: the attempt state machine, as the platform's screens use it (IF-9, provided by stream L).

PROPOSAL written by stream P in story P-05 (decision 2 of its plan) so P's screens and tests can start; stream L
owns it and confirms or changes it (handoffs H-06, H-79). States and modes are IF-2's (architecture 04 section
10.1, no paused state). The platform creates a candidate attempt from a granted consent; cancel, withdraw and
purge follow the state machine.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol, runtime_checkable


class AttemptState(StrEnum):
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


class AttemptMode(StrEnum):
    LEARNER = "learner"
    CANDIDATE = "candidate"


# Architecture 04 section 10.1.
CANCELLABLE = frozenset({AttemptState.READY, AttemptState.RUNNING})
WITHDRAWABLE = frozenset({AttemptState.CONSENT, AttemptState.READY, AttemptState.RUNNING, AttemptState.SUBMITTED})


@dataclass(frozen=True, slots=True)
class Attempt:
    attempt_id: str
    user_id: str
    org_id: str | None  # set for a candidate attempt, None for learner practice
    mode: AttemptMode
    state: AttemptState
    template_id: str | None
    consent_id: str | None


@runtime_checkable
class AttemptPort(Protocol):
    def create_from_consent(self, *, user_id: str, org_id: str, template_id: str, invite_id: str, consent_id: str,
                            attempt_id: str | None = None, rules: Mapping[str, Any] | None = None,
                            history: Mapping[str, datetime | None] | None = None) -> Attempt:
        """Create the candidate attempt of a granted consent, in state `ready`. Idempotent on `consent_id`. `attempt_id` (story P-21, proposal for stream L,
        handoff H-141): the id the consent record already names, used for the new attempt when given. `history` (L-25, FR-TIM-04): the instants the platform knows and the lab does not, `invite_created`, `invite_opened` and `consent_given` (a datetime or None each); the lab writes them into the attempt's event log with those real times, once."""
        ...

    def get(self, attempt_id: str) -> Attempt:
        """Raises AttemptNotFound, or AttemptGone after a purge."""
        ...

    def cancel(self, attempt_id: str, *, by: str) -> Attempt:
        """Recruiter or admin cancels (from ready or running). Raises AttemptNotFound, AttemptGone, AttemptStateInvalid."""
        ...

    def withdraw(self, attempt_id: str) -> Attempt:
        """The candidate withdraws consent (from consent, ready, running or submitted). Raises as cancel."""
        ...

    def purge(self, attempt_id: str) -> None:
        """Delete the attempt's data (retention or deletion request). Afterwards `get` raises AttemptGone."""
        ...
