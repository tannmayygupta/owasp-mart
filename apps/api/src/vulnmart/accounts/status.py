"""An admin suspends and reinstates an account (story P-19, FR-ORG-05): `AccountStatusService`.

A suspended account (`users.status = 'disabled'`) cannot log in and every session it has ends at once (`SessionService.resolve` and `login` already
refuse a status other than `active`); reinstating makes it `active` again. Only a non-admin account can be changed here (an admin is created, and
removed, by the paths of story P-13), the action needs a written reason and is audited under the admin before it commits. A deleted account stays deleted.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.audit import AuditPort
from vulnmart.ports.scope import Scope

from .models import User, UserSession
from .roles import NotAnAdmin, RoleService, UnknownUser
from .service import InvalidInput

REASON_MAX = 500
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")
_SPACE = re.compile(r"\s+")


class InvalidAccountState(Exception):
    """The account is not in a state this change starts from (`state`)."""

    def __init__(self, state: str):
        super().__init__(state)
        self.state = state


def clean_reason(raw: str) -> str:
    text = _SPACE.sub(" ", _CONTROL.sub(" ", unicodedata.normalize("NFC", raw))).strip()
    if not 1 <= len(text) <= REASON_MAX:
        raise InvalidInput("/reason")
    return text


class AccountStatusService:
    def __init__(self, sessions: sessionmaker[Session], roles: RoleService, audit: AuditPort):
        self._sessions, self._roles, self._audit = sessions, roles, audit

    def suspend(self, actor: Scope, user_id: str, reason: str) -> None:
        """active -> disabled: the account cannot sign in and its sessions end now."""
        self._change(actor, user_id, reason, from_status="active", to_status="disabled", action="account.suspended")

    def reinstate(self, actor: Scope, user_id: str, reason: str) -> None:
        """disabled -> active."""
        self._change(actor, user_id, reason, from_status="disabled", to_status="active", action="account.reinstated")

    def _change(self, actor: Scope, user_id: str, reason: str, *, from_status: str, to_status: str, action: str) -> None:
        admin_id = self._roles.require_admin(actor)
        clean_reason(reason)  # the text is shown to nobody here; it must exist, and it is not copied into the audit log
        now = datetime.now(UTC)
        with self._sessions.begin() as session:
            user = session.scalar(select(User).where(User.id == user_id))
            if user is None or user.status == "deleted":
                raise UnknownUser
            if user.account_type == "admin":
                raise NotAnAdmin  # not by this path: the answer says "not allowed", not "not found"
            changed = session.execute(update(User).where(User.id == user_id, User.status == from_status).values(status=to_status)).rowcount
            if changed != 1:
                raise InvalidAccountState(user.status)
            self._audit.append(actor=admin_id, action=action, subject=user_id, details={"reason_given": True})
            if to_status == "disabled":
                session.execute(update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None)).values(revoked_at=now))
