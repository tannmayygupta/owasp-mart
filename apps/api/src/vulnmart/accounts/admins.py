"""Admin accounts (FR-ACC-11): created only by another admin or by the seed command, never by signup.

There is no public route and no signup field that can make an admin (`SignupBody` refuses unknown members, and the signup service
always creates a participant). The two ways in:

- `seed_admin`: the first admin of a platform, made by an operator on the server (`python -m vulnmart.accounts.seed_admin`). It sets the
  password the operator supplies, so the operator must hand it over safely; the account cannot log in until the second factor exists
  (FR-ACC-07, story P-15).
- `create_admin`: an admin creates another. The new admin gets no password from the creator: the account starts with a random one nobody
  knows and a single-use link by email to choose their own (a `reset` token, consumed by the password-reset story P-14).

Both write the audit log (`admin.created`, with who created it and how). The address of an admin is marked verified at creation: the
creator vouches for it, and using the link proves the new admin controls it. Admin passwords are at least 16 characters.
"""
from __future__ import annotations

import logging
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.scope import Scope
from vulnmart.ports.settings import SettingsPort

from .models import EmailToken, User
from .roles import NotAnAdmin
from .security import hash_password, new_token, new_user_id, normalize_email, token_hash
from .passwords import PasswordPolicy
from .service import InvalidInput, check_new_password, clean_display_name

logger = logging.getLogger("vulnmart.accounts")

Clock = Callable[[], datetime]
ADMIN_PASSWORD_MIN = 16
SEED_ACTOR = "system:seed"


def utc_now() -> datetime:
    return datetime.now(UTC)


class EmailInUse(Exception):
    """An account with this address exists already. Said to an admin (who may know), never to the public."""


class AdminService:
    def __init__(self, sessions: sessionmaker[Session], settings: SettingsPort, audit: AuditPort, *, public_origin: str,
                 now: Clock = utc_now, policy: PasswordPolicy | None = None):
        self._sessions = sessions
        self._settings = settings
        self._audit = audit
        self._origin = public_origin.rstrip("/")
        self._now = now
        self._policy = policy or PasswordPolicy()

    def _new_admin(self, session: Session, *, email: str, display_name: str, password: str, now: datetime) -> User:
        email_ci = normalize_email(email)
        if email_ci is None:
            raise InvalidInput("/email")
        name = clean_display_name(display_name)
        check_new_password(self._policy, password, pointer="/password", email=email_ci, display_name=name, min_length=ADMIN_PASSWORD_MIN)
        if session.scalar(select(User.id).where(User.email_ci == email_ci)) is not None:
            raise EmailInUse
        user = User(id=new_user_id(), account_type="admin", email=email.strip()[:254], email_ci=email_ci, password_hash=hash_password(password),
                    display_name=name, status="active", email_verified_at=now)
        session.add(user)
        session.flush()
        return user

    # -- the seed command ---------------------------------------------------------------------------------------------

    def seed_admin(self, *, email: str, display_name: str, password: str) -> bool:
        """Create the first admin. False (and nothing changed) when an account with that address exists already."""
        now = self._now()
        try:
            with self._sessions.begin() as session:
                user = self._new_admin(session, email=email, display_name=display_name, password=password, now=now)
                self._audit.append(actor=SEED_ACTOR, action="admin.created", subject=user.id, details={"via": "seed"})
        except (EmailInUse, IntegrityError):
            return False
        return True

    # -- an admin creates another -------------------------------------------------------------------------------------

    def create_admin(self, actor: Scope, *, email: str, display_name: str) -> str:
        """Create an admin account for someone else and mail them the link to choose a password. Returns the new user id.
        Raises NotAnAdmin unless `actor` is an active admin, EmailInUse for a known address, InvalidInput for a bad value."""
        now = self._now()
        with self._sessions() as session:
            creator = session.get(User, actor.user_id)
            if not actor.is_admin or creator is None or creator.account_type != "admin" or creator.status != "active":
                raise NotAnAdmin
        unusable = secrets.token_urlsafe(32)  # a random password nobody knows (32 bytes: 43 characters, within the admin limits)
        hours = int(self._settings.get("email_token_hours"))
        token = new_token()
        try:
            with self._sessions.begin() as session:
                user = self._new_admin(session, email=email, display_name=display_name, password=unusable, now=now)
                session.add(EmailToken(token_hash=token_hash(token), user_id=user.id, purpose="reset", expires_at=now + timedelta(hours=hours)))
                DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params).enqueue_email(
                    template="account.admin_created", to_user_id=user.id,
                    params={"link": f"{self._origin}/reset-password?token={token}", "expires_in_hours": hours})
                self._audit.append(actor=actor.user_id, action="admin.created", subject=user.id, details={"via": "admin"})
                return user.id
        except IntegrityError:
            raise EmailInUse from None
