"""What other modules may ask the accounts module about a person (story P-18): `UserDirectory`.

A small read-only interface, so the companies module does not read the `users` table itself. It never returns a password hash, a token or a full
address: the display name, the account type, the status, whether the address is verified, and the domain of the address.
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .models import User


@dataclass(frozen=True, slots=True)
class UserBrief:
    id: str
    account_type: str
    status: str
    display_name: str
    email_domain: str
    email_verified: bool
    email_ci: str | None = None  # the canonical address, for the one caller that must compare it (an invite is bound to one address, story P-21)


def _brief(user: User) -> UserBrief:
    return UserBrief(user.id, user.account_type, user.status, user.display_name, user.email_ci.rsplit("@", 1)[-1], user.email_verified_at is not None, user.email_ci)


class UserDirectory:
    def __init__(self, sessions: sessionmaker[Session]):
        self._sessions = sessions

    def brief(self, user_id: str) -> UserBrief | None:
        with self._sessions() as session:
            user = session.get(User, user_id)
            return None if user is None else _brief(user)

    def briefs(self, user_ids: Iterable[str]) -> dict[str, UserBrief]:
        ids = list(dict.fromkeys(user_ids))
        if not ids:
            return {}
        with self._sessions() as session:
            return {u.id: _brief(u) for u in session.scalars(select(User).where(User.id.in_(ids)))}
