"""A signed-in user's own account (FR-ACC-09): the profile and the password.

- `update_profile`: the display name today (the contract: an email change needs its own verification step and comes later).
- `change_password`: the current password must be right, the new one must pass the rules of `passwords.py` and differ from the old one.
  In one transaction the password changes, the session value changes (FR-ACC-03) and every other session of the user ends (contract), so
  a stolen session does not survive a password change and a crash cannot leave half of it done.

Wrong current passwords are counted by the route (a throttle like the login's), not here.
"""
from __future__ import annotations

from sqlalchemy.orm import Session, sessionmaker

from .models import User
from .passwords import PasswordPolicy
from .security import hash_password, verify_password
from .service import InvalidInput, check_new_password, clean_display_name
from .sessions import InvalidCredentials, SessionService, UserView, _view


class SessionEnded(Exception):
    """The session that asked for the change ended while the change was being made."""


class SelfService:
    def __init__(self, sessions: sessionmaker[Session], session_service: SessionService, policy: PasswordPolicy | None = None):
        self._sessions = sessions
        self._session_service = session_service
        self._policy = policy or PasswordPolicy()

    def update_profile(self, user_id: str, *, display_name: str) -> UserView:
        name = clean_display_name(display_name)
        with self._sessions.begin() as session:
            user = session.get(User, user_id)
            user.display_name = name
            session.flush()
            return _view(user)

    def change_password(self, *, user_id: str, token: str, current_password: str, new_password: str) -> str:
        """Change the password and return the new session value (the caller sets it as the cookie). Raises InvalidCredentials for a wrong
        current password, InvalidInput (with the rule that failed) for a new one that is not acceptable, SessionEnded when the session
        is gone."""
        with self._sessions() as session:
            user = session.get(User, user_id)
            current_hash, email_ci, name = user.password_hash, user.email_ci, user.display_name
        if not verify_password(current_hash, current_password):
            raise InvalidCredentials
        if new_password == current_password:
            raise InvalidInput("/new_password", "password_same")
        check_new_password(self._policy, new_password, pointer="/new_password", email=email_ci, display_name=name)
        new_hash = hash_password(new_password)
        with self._sessions.begin() as session:
            user = session.get(User, user_id)
            if user.password_hash != current_hash:
                raise InvalidCredentials  # the password changed under us (another change or a reset): start again
            user.password_hash = new_hash
            new_token = self._session_service.rotate_in(session, token)
            if new_token is None:
                raise SessionEnded
            self._session_service.revoke_all_in(session, user_id, keep=new_token)
            return new_token
