"""QuotaPort: how many instances a user may run (IF-9, provided by stream P).

Architecture 04 section 2.7 (`quotas`: scope user, org or global): a user quota beats an organisation quota,
which beats the global one. Per-company and global numbers are open (OI-21); the default is one running
instance per learner (FR-INS-06).
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

from dataclasses import dataclass

# The per-user default when no quota row exists.
DEFAULT_MAX_INSTANCES = 1
# Story 3.6 (FR-INS-06, OI-21): the company and global numbers of the fake. Provisional, until the platform's settings hold them.
DEFAULT_COMPANY_MAX = 5
DEFAULT_TOTAL_MAX = 20


@dataclass(frozen=True, slots=True)
class QuotaLimits:
    """The three limits one request is checked against. All three apply: the request is refused when any of them is reached."""

    user: int  # live instances of this user
    company: int | None  # live instances of the user's company (None: the user has no company)
    total: int  # live instances on the whole platform


@runtime_checkable
class QuotaPort(Protocol):
    def max_instances(self, user_id: str, org_id: str | None = None) -> int:
        """How many instances this user may run at once: the user's quota, else the organisation's, else the global one."""
        ...

    def limits(self, user_id: str, org_id: str | None = None) -> QuotaLimits:
        """The per-user, per-company and platform-wide limits that apply to a request of this user."""
        ...
