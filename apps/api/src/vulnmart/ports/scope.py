"""ScopePort: who is acting, and for which organisation (IF-9, provided by stream P).

ADR 0014 and architecture 04 section 3: every query on a scoped table carries the organisation filter, and a
scoped call without a scope is refused, never answered with everything. Participants are scoped by user id.
The real implementation reads the session; the per-transaction Postgres setting for row-level security is set
from the same value (P-06).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol, runtime_checkable


class Role(StrEnum):
    LEARNER = "learner"
    CANDIDATE = "candidate"
    RECRUITER = "recruiter"
    ORG_OWNER = "org_owner"
    ADMIN = "admin"


@dataclass(frozen=True, slots=True)
class Scope:
    user_id: str
    org_id: str | None = None  # the company a recruiter acts for; None for a learner or a candidate
    roles: frozenset[Role] = field(default_factory=frozenset)

    @property
    def is_admin(self) -> bool:
        return Role.ADMIN in self.roles


@runtime_checkable
class ScopePort(Protocol):
    def current(self) -> Scope:
        """The scope of the running request or job. Raises ScopeMissing when nothing is in scope."""
        ...

    def require_org(self) -> str:
        """The organisation id for an org-scoped query. Raises ScopeMissing when there is none."""
        ...
