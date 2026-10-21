"""A signed-in user's own account (FR-ACC-09): the profile and the password.

- `update_profile`: the display name today (the contract: an email change needs its own verification step and comes later).
- `change_password`: the current password must be right, the new one must pass the rules of `passwords.py` and differ from the old one.
  In one transaction the password changes, the session value changes (FR-ACC-03) and every other session of the user ends (contract), so
  a stolen session does not survive a password change and a crash cannot leave half of it done.

Wrong current passwords are counted by the route (a throttle like the login's), not here.

- `request_email_change` / `confirm_email_change` (WP-B): the current password is needed; a single-use link goes to the NEW address and nothing changes until it is used. A new
  address that already has an account gets the "already registered" mail instead (the answer is the same, so the route does not tell). Using the link: the address is
  changed and counts as verified (the link proved the mailbox), every session ends (the person signs in again with the new address), any unused password-reset or verification link
  made for the old address dies, and the OLD address is told (the address is sealed into the mail row, so it does not depend on the account any more). Consent records and invites
  bound to the account stay as they are (they hang on the account id); an invite is accepted only by a verified address equal to the invite's, so after the change an invite made for
  the new address can be accepted by this same account (FR-ACC-05). Admin accounts cannot change their address here.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params

from .models import EmailChange, EmailToken, User, UserSession
from .passwords import PasswordPolicy
from .security import hash_password, new_token, normalize_email, spend_the_same_time, token_hash, verify_password
from .service import InvalidInput, TokenInvalid, check_new_password, clean_display_name
from .sessions import InvalidCredentials, SessionService, UserView, _view, mfa_enabled

logger = logging.getLogger("vulnmart.accounts")


class EmailChangeNotAllowed(Exception):
    """This kind of account does not change its address here (an administrator's account)."""


class EmailChangeUnavailable(RuntimeError):
    """The process has no field key to seal an address with, so it cannot mail a new address."""


class SessionEnded(Exception):
    """The session that asked for the change ended while the change was being made."""


class SelfService:
    def __init__(self, sessions: sessionmaker[Session], session_service: SessionService, policy: PasswordPolicy | None = None, *, settings=None, keys=None,
                 public_origin: str = "", audit=None, now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._sessions = sessions
        self._session_service = session_service
        self._policy = policy or PasswordPolicy()
        self._settings, self._keys, self._origin, self._audit, self._now = settings, keys, public_origin.rstrip("/"), audit, now

    def update_profile(self, user_id: str, *, display_name: str) -> UserView:
        name = clean_display_name(display_name)
        with self._sessions.begin() as session:
            user = session.get(User, user_id)
            user.display_name = name
            session.flush()
            return _view(user, mfa=mfa_enabled(session, user.id))

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

    # ---- changing the address (WP-B) ----

    def _outbox(self, session: Session) -> DbOutboxPort:
        sealer = (lambda address, aad: self._keys.seal(address, account=aad)) if self._keys is not None else None
        return DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params, address_sealer=sealer)

    def request_email_change(self, *, user_id: str, current_password: str, new_email: str, check_email: Callable[[str], None] | None = None) -> None:
        """Mail a link to the new address. Raises InvalidCredentials (wrong password), InvalidInput (`/new_email`: not an address, the same address, refused by `check_email`),
        EmailChangeNotAllowed, EmailChangeUnavailable. Returns nothing for a free address and for one that has an account alike."""
        if self._keys is None or self._settings is None or not self._origin:
            raise EmailChangeUnavailable
        with self._sessions() as session:
            user = session.get(User, user_id)
            if user is None or user.status != "active":
                raise InvalidCredentials
            current_hash, current_ci, kind = user.password_hash, user.email_ci, user.account_type
        if kind == "admin":
            raise EmailChangeNotAllowed
        if not verify_password(current_hash, current_password):
            raise InvalidCredentials
        new_ci = normalize_email(new_email)
        if new_ci is None:
            raise InvalidInput("/new_email")
        if new_ci == current_ci:
            raise InvalidInput("/new_email", "same_address")
        if check_email is not None:
            check_email(new_ci)
        now = self._now()
        hours = int(self._settings.get("email_token_hours"))
        token = new_token()
        with self._sessions.begin() as session:
            taken = session.scalar(select(User).where(User.email_ci == new_ci))
            if taken is not None:
                if taken.status == "active":
                    self._outbox(session).enqueue_email(template="account.already_registered", to_user_id=taken.id, params={"login_url": f"{self._origin}/login"})
                spend_the_same_time()
                return
            session.execute(delete(EmailChange).where(EmailChange.user_id == user_id))
            session.add(EmailChange(user_id=user_id, new_email=new_email.strip()[:254], new_email_ci=new_ci, token_hash=token_hash(token), expires_at=now + timedelta(hours=hours)))
            self._outbox(session).enqueue_email(template="account.email_change", to_user_id=user_id, to_address=new_email.strip()[:254],
                                                params={"link": f"{self._origin}/confirm-email-change?token={token}", "expires_in_hours": hours})
        if self._audit is not None:
            self._audit.append(actor=user_id, action="account.email_change_requested", subject=user_id, details={})

    def confirm_email_change(self, token: str) -> str:
        """Use the link once. Returns the account id. Raises TokenInvalid for a link that was used, replaced, expired, never existed, or whose address was taken meanwhile."""
        digest = token_hash(token)
        now = self._now()
        old_address = None
        with self._sessions.begin() as session:
            row = session.scalar(select(EmailChange).where(EmailChange.token_hash == digest))
            if row is None:
                spend_the_same_time()
                raise TokenInvalid
            expires = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=UTC)
            user = session.get(User, row.user_id)
            if expires <= now or user is None or user.status != "active" or user.account_type == "admin":
                session.execute(delete(EmailChange).where(EmailChange.user_id == row.user_id))
                raise TokenInvalid
            user_id, new_email, new_ci, old_address = user.id, row.new_email, row.new_email_ci, user.email
            if session.scalar(select(User.id).where(User.email_ci == new_ci, User.id != user_id)) is not None:
                session.execute(delete(EmailChange).where(EmailChange.user_id == user_id))
                raise TokenInvalid  # someone else took the address since the request
            session.execute(delete(EmailChange).where(EmailChange.user_id == user_id))  # single use: the row is gone before anything else can use the link
            user.email, user.email_ci, user.email_verified_at = new_email, new_ci, now
            session.execute(update(EmailToken).where(EmailToken.user_id == user_id, EmailToken.purpose.in_(("reset", "verify")), EmailToken.used_at.is_(None)).values(used_at=now))
            session.execute(update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None)).values(revoked_at=now))
            try:
                session.flush()
            except IntegrityError:
                raise TokenInvalid from None
            if self._keys is not None:
                self._outbox(session).enqueue_email(template="account.email_changed", to_user_id=user_id, to_address=old_address, params={})
        if self._audit is not None:
            self._audit.append(actor=user_id, action="account.email_changed", subject=user_id, details={})
        return user_id