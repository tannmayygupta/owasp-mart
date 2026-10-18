"""Account types and roles (FR-ACC-05, FR-ACC-06).

One login system, three account types: participant, recruiter, admin. Only a participant holds the roles `learner` and `candidate`
(a participant may hold both). The database already refuses a role row for a recruiter or admin (composite foreign key, migration
0003); this module is the code that grants and removes roles and says why it refuses.

- `grant_candidate_role`: what accepting an invite does (FR-ACC-06): the same login gets the candidate role on top of the learner role,
  nothing else changes. A recruiter or admin is refused with `RoleNotAllowed`, which the invite route turns into the clear message of
  FR-ACC-05.
- `grant` and `revoke`: an Admin changes a participant's roles (FR-ACC-05: only an Admin may, and it is audited). Taking a role away
  also ends the person's sessions, so no old session keeps a privilege that is gone.
- The account type itself is never changed by any function here: it is set at creation and the database refuses to change it while the
  account holds a role.
- Every change is appended to the audit log (`AuditPort`) before it is committed: a failing audit write undoes the change. Today the audit
  port in a running process is the in-memory stand-in (the durable log is story P-17), so the entries do not survive a restart yet.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.audit import AuditPort
from vulnmart.ports.scope import Scope

from .models import ROLES, User, UserRole
from .sessions import SessionService

logger = logging.getLogger("vulnmart.accounts")

Clock = Callable[[], datetime]
SYSTEM_INVITE = "system:invite"


def utc_now() -> datetime:
    return datetime.now(UTC)


class RoleNotAllowed(Exception):
    """The account type cannot hold this role (a recruiter or admin cannot be a learner or candidate)."""

    def __init__(self, account_type: str):
        super().__init__(account_type)
        self.account_type = account_type


class NotAnAdmin(Exception):
    """The caller is not an active admin."""


class UnknownUser(Exception):
    """No active account with that id."""


class RoleService:
    def __init__(self, sessions: sessionmaker[Session], audit: AuditPort, session_service: SessionService | None = None):
        self._sessions = sessions
        self._audit = audit
        self._session_service = session_service

    def roles_of(self, user_id: str) -> frozenset[str]:
        with self._sessions() as session:
            return frozenset(session.scalars(select(UserRole.role).where(UserRole.user_id == user_id)))

    # -- the candidate role at invite acceptance ----------------------------------------------------------------------

    def grant_candidate_role(self, user_id: str) -> bool:
        """Give a participant the candidate role (FR-ACC-06). True when it was added, False when they already had it."""
        return self._grant(SYSTEM_INVITE, user_id, "candidate", via="invite")

    # -- an admin's changes -------------------------------------------------------------------------------------------

    def grant(self, actor: Scope, user_id: str, role: str) -> bool:
        admin_id = self._require_admin(actor)
        return self._grant(admin_id, user_id, role, via="admin")

    def revoke(self, actor: Scope, user_id: str, role: str) -> bool:
        admin_id = self._require_admin(actor)
        self._check_role(role)
        with self._sessions.begin() as session:
            user = self._active_participant(session, user_id)
            held = session.scalar(select(UserRole).where(UserRole.user_id == user.id, UserRole.role == role))
            if held is None:
                return False
            self._audit.append(actor=admin_id, action="role.revoked", subject=user.id, details={"role": role})
            session.execute(delete(UserRole).where(UserRole.user_id == user.id, UserRole.role == role))
        if self._session_service is not None:
            self._session_service.revoke_all(user_id)  # a removed privilege must not live on in an old session
        return True

    # -- shared -------------------------------------------------------------------------------------------------------

    def _check_role(self, role: str) -> None:
        if role not in ROLES:
            raise ValueError(f"unknown role {role!r}")

    def require_admin(self, actor: Scope) -> str:
        """For other modules (story P-18): the admin's user id, or NotAnAdmin."""
        return self._require_admin(actor)

    def _require_admin(self, actor: Scope) -> str:
        """The admin's user id. The scope says admin and the database must agree: an account that stopped being an active admin is refused."""
        if not actor.is_admin:
            raise NotAnAdmin
        with self._sessions() as session:
            user = session.get(User, actor.user_id)
            if user is None or user.account_type != "admin" or user.status != "active":
                raise NotAnAdmin
        return actor.user_id

    def _active_participant(self, session: Session, user_id: str) -> User:
        user = session.get(User, user_id)
        if user is None or user.status != "active":
            raise UnknownUser
        if user.account_type != "participant":
            raise RoleNotAllowed(user.account_type)
        return user

    def _grant(self, actor: str, user_id: str, role: str, *, via: str) -> bool:
        self._check_role(role)
        with self._sessions.begin() as session:
            user = self._active_participant(session, user_id)
            if session.scalar(select(UserRole).where(UserRole.user_id == user.id, UserRole.role == role)) is not None:
                return False
            self._audit.append(actor=actor, action="role.granted", subject=user.id, details={"role": role, "via": via})
            try:
                with session.begin_nested():  # a savepoint: two grants at once leave one row and no error
                    session.add(UserRole(user_id=user.id, role=role, account_type="participant"))
                    session.flush()
            except IntegrityError:
                return False
            return True
