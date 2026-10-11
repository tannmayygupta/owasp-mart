"""QuotaPort: how many instances a user may run (IF-9, provided by stream P).

Architecture 04 section 2.7 (`quotas`: scope user, org or global): a user quota beats an organisation quota,
which beats the global one. Per-company and global numbers are open (OI-21); the default is one running
instance per learner (FR-INS-06).
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

# The global default when no quota row exists.
DEFAULT_MAX_INSTANCES = 1


@runtime_checkable
class QuotaPort(Protocol):
    def max_instances(self, user_id: str, org_id: str | None = None) -> int:
        """How many instances this user may run at once: the user's quota, else the organisation's, else the global one."""
        ...
