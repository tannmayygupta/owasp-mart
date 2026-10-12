"""InstancePort: the learner's and admin's instance actions (IF-9, provided by stream L).

PROPOSAL written by stream P in story P-05 (decision 2 of its plan); stream L owns it (H-79: Tanmay writes the
real one) and confirms or changes it. It sits ABOVE `InstanceHost` (the orchestrator client, IF-5): it decides
quotas, epochs, flag material and access, then calls `InstanceHost`. It does not redefine it and reuses its state,
access and health values.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from .instance_host import RESETTABLE, Access, Health, InstanceState

# States in which a browser may open the instance.
OPENABLE = RESETTABLE


@dataclass(frozen=True, slots=True)
class InstanceView:
    instance_id: str
    attempt_id: str
    state: InstanceState
    access: Access
    health: Health
    epoch: int
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class Ticket:
    """A one-time ticket that opens the instance at its host name (architecture 03)."""

    url: str
    expires_at: str


@dataclass(frozen=True, slots=True)
class Capacity:
    total_memory_mb: int
    used_memory_mb: int
    running: int


@runtime_checkable
class InstancePort(Protocol):
    def request(self, attempt_id: str, *, user_id: str, org_id: str | None = None) -> InstanceView:
        """Start (or return) the attempt's instance. Raises AttemptNotFound, AttemptGone (purged), InstanceQuotaReached (QuotaPort says no)."""
        ...

    def get(self, instance_id: str) -> InstanceView:
        """Raises InstanceMissing."""
        ...

    def open_ticket(self, instance_id: str) -> Ticket:
        """Raises InstanceMissing, InstanceNotReady (not ready, active or idle, or access not open)."""
        ...

    def reset(self, instance_id: str) -> InstanceView:
        """New epoch, new flags. Raises InstanceMissing, InstanceStateInvalid (not ready, active or idle)."""
        ...

    def stop(self, instance_id: str) -> InstanceView:
        """The owner stops it. Stopping a stopped one is not an error. Raises InstanceMissing."""
        ...

    def force_stop(self, instance_id: str, *, by: str) -> InstanceView:
        """An admin stops it at once, whatever its state. Raises InstanceMissing."""
        ...

    def capacity(self) -> Capacity:
        """Memory in use across the hosts (admin screen)."""
        ...
