"""Login, server-side sessions, timeouts and the CSRF token (FR-ACC-03, FR-ACC-04, NFR-SEC-03).

How a session works here:
- The cookie holds 256 random bits (`new_token`); the database holds only their SHA-256 hash (`sessions.id_hash`).
- Every login makes a new session value (a login never reuses one). `rotate` does the same at a privilege change (FR-ACC-03): the old
  value stops working at once, the absolute deadline stays (rotation never extends a session's life).
- Two clocks end a session: idle (`session_idle_minutes`, shorter for an admin) and absolute (`session_absolute_hours`). Both are
  checked on every request with the server clock; an ended session is marked revoked, so a later clock change cannot revive it.
- `last_seen_at` is written at most once a minute. The cost: a session can end up to a minute earlier than 30 idle minutes after the
  last request, never later.
- The CSRF token is HMAC-SHA256 of the session value under a server key (contract, ADR 0019 M2): it is tied to one session, needs no
  storage, and is recomputed for `GET /session`.
- A wrong password and an unknown, disabled or deleted account are the same `InvalidCredentials`, and an unknown account costs the same
  time as a wrong password. The "email not verified" answer is only given after the password was right (FR-ACC-02).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.scope import Role, Scope
from vulnmart.ports.settings import SettingsPort

from .models import User, UserRole, UserSession
from .security import needs_rehash, hash_password, new_token, normalize_email, spend_the_same_time, token_hash, verify_password

logger = logging.getLogger("vulnmart.accounts")

Clock = Callable[[], datetime]
TOUCH_EVERY = timedelta(seconds=60)


def utc_now() -> datetime:
    return datetime.now(UTC)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)  # SQLite hands back naive UTC


class InvalidCredentials(Exception):
    """Wrong password, or an account that is unknown, disabled or deleted (the same error for all)."""


class EmailNotVerified(Exception):
    """The password was right but the address is not verified yet (FR-ACC-02)."""


class MfaUnavailable(RuntimeError):
    """The account needs a second factor (every admin, FR-ACC-07) and the second-factor login does not exist yet (story P-15).
    The login is refused: an admin must never get a session with the password alone."""


@dataclass(frozen=True, slots=True)
class UserView:
    id: str
    email: str
    display_name: str
    account_type: str
    email_verified: bool
    mfa_enabled: bool
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ResolvedSession:
    token_hash: str
    user: UserView
    roles: frozenset[Role]
    last_seen_at: datetime
    idle_expires_at: datetime
    absolute_expires_at: datetime

    @property
    def scope(self) -> Scope:
        return Scope(user_id=self.user.id, org_id=None, roles=self.roles)  # org_id arrives with the company stories (P-18, P-19)


@dataclass(frozen=True, slots=True)
class LoginResult:
    token: str
    session: ResolvedSession


@dataclass(frozen=True, slots=True)
class SessionInfo:
    ref: str  # the first 16 characters of the stored hash: a handle a user can revoke by, useless as a credential
    created_at: datetime
    last_seen_at: datetime
    ip_trunc: str | None
    ua_class: str | None
    current: bool


def _view(user: User) -> UserView:
    return UserView(id=user.id, email=user.email, display_name=user.display_name, account_type=user.account_type,
                    email_verified=user.email_verified_at is not None, mfa_enabled=False,  # the second factor arrives with story P-15
                    created_at=_aware(user.created_at))


class SessionService:
    def __init__(self, sessions: sessionmaker[Session], settings: SettingsPort, csrf_key: bytes, *, now: Clock = utc_now):
        if len(csrf_key) < 16:
            raise ValueError("the CSRF key is at least 16 bytes")
        self._sessions = sessions
        self._settings = settings
        self._csrf_key = csrf_key
        self._now = now

    # -- limits ------------------------------------------------------------------------------------------------------

    def _idle(self, account_type: str) -> timedelta:
        name = "session_idle_minutes_admin" if account_type == "admin" else "session_idle_minutes"
        return timedelta(minutes=int(self._settings.get(name)))

    def _absolute(self) -> timedelta:
        return timedelta(hours=int(self._settings.get("session_absolute_hours")))

    # -- login -------------------------------------------------------------------------------------------------------

    def login(self, *, email: str, password: str, ip_trunc: str | None = None, ua_class: str | None = None) -> LoginResult:
        email_ci = normalize_email(email)
        with self._sessions() as session:
            user = session.scalar(select(User).where(User.email_ci == email_ci)) if email_ci else None
        if user is None or user.status != "active":
            spend_the_same_time()
            raise InvalidCredentials
        if not verify_password(user.password_hash, password):
            raise InvalidCredentials
        if user.email_verified_at is None:
            raise EmailNotVerified
        if user.account_type == "admin":
            logger.error("an admin login was refused: the second-factor login does not exist yet (story P-15)")
            raise MfaUnavailable
        new_hash = hash_password(password) if needs_rehash(user.password_hash) else None  # raise the cost of an old hash at a login
        now = self._now()
        with self._sessions.begin() as session:
            row = session.get(User, user.id)
            row.last_login_at = now
            if new_hash:
                row.password_hash = new_hash
            token = self._create(session, user.id, now, now + self._absolute(), ip_trunc, ua_class)
        resolved = self.resolve(token)
        assert resolved is not None  # created a moment ago
        return LoginResult(token=token, session=resolved)

    def _create(self, session: Session, user_id: str, now: datetime, absolute_expires_at: datetime, ip_trunc: str | None,
                ua_class: str | None) -> str:
        token = new_token()
        session.add(UserSession(id_hash=token_hash(token), user_id=user_id, last_seen_at=now, absolute_expires_at=absolute_expires_at,
                                ip_trunc=ip_trunc, ua_class=ua_class))
        return token

    # -- using a session ---------------------------------------------------------------------------------------------

    def resolve(self, token: str) -> ResolvedSession | None:
        """The live session behind a cookie value, or None (unknown, revoked, ended, or its account is no longer active). Counts as activity."""
        digest = token_hash(token)
        now = self._now()
        with self._sessions.begin() as session:
            row = session.get(UserSession, digest)
            if row is None or row.revoked_at is not None:
                return None
            user = session.get(User, row.user_id)
            if user is None or user.status != "active":
                row.revoked_at = now
                return None
            idle = self._idle(user.account_type)
            last_seen, absolute = _aware(row.last_seen_at), _aware(row.absolute_expires_at)
            if now >= absolute or now - last_seen >= idle:
                row.revoked_at = now  # ended for good: no later clock reading brings it back
                return None
            if now - last_seen >= TOUCH_EVERY:
                row.last_seen_at = last_seen = now
            roles = {Role(r) for r in session.scalars(select(UserRole.role).where(UserRole.user_id == user.id))}
            if user.account_type == "recruiter":
                roles.add(Role.RECRUITER)
            elif user.account_type == "admin":
                roles.add(Role.ADMIN)
            return ResolvedSession(token_hash=digest, user=_view(user), roles=frozenset(roles), last_seen_at=last_seen,
                                   idle_expires_at=last_seen + idle, absolute_expires_at=absolute)

    def logout(self, token: str) -> bool:
        """End the session now (FR-ACC-03). False when there was nothing live to end."""
        with self._sessions.begin() as session:
            done = session.execute(update(UserSession).where(UserSession.id_hash == token_hash(token), UserSession.revoked_at.is_(None))
                                   .values(revoked_at=self._now())).rowcount
        return done == 1

    def rotate(self, token: str) -> str | None:
        """A new session value for the same login after a privilege change (FR-ACC-03): the old value stops working, the absolute
        deadline stays. None when the old value is not a live session."""
        with self._sessions.begin() as session:
            return self.rotate_in(session, token)

    def rotate_in(self, session: Session, token: str) -> str | None:
        """`rotate` inside a transaction the caller owns (a password change does everything or nothing)."""
        digest, now = token_hash(token), self._now()
        row = session.get(UserSession, digest)
        if row is None or row.revoked_at is not None:
            return None
        row.revoked_at = now
        return self._create(session, row.user_id, now, _aware(row.absolute_expires_at), row.ip_trunc, row.ua_class)

    # -- a user's own sessions (FR-ACC-04) ----------------------------------------------------------------------------

    def list_sessions(self, user_id: str, *, current: str | None = None) -> list[SessionInfo]:
        now, current_hash = self._now(), token_hash(current) if current else None
        with self._sessions() as session:
            user = session.get(User, user_id)
            if user is None:
                return []
            idle = self._idle(user.account_type)
            rows = session.scalars(select(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
                                   .order_by(UserSession.created_at.desc())).all()
            return [SessionInfo(ref=r.id_hash[:16], created_at=_aware(r.created_at), last_seen_at=_aware(r.last_seen_at), ip_trunc=r.ip_trunc,
                                ua_class=r.ua_class, current=r.id_hash == current_hash)
                    for r in rows if now < _aware(r.absolute_expires_at) and now - _aware(r.last_seen_at) < idle]

    def revoke(self, user_id: str, ref: str) -> bool:
        """End one of the user's own sessions by its `ref`. A ref of another user's session is simply not found."""
        if len(ref) != 16:
            return False
        with self._sessions.begin() as session:
            done = session.execute(update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None),
                                                             UserSession.id_hash.like(ref + "%")).values(revoked_at=self._now())).rowcount
        return done == 1

    def revoke_all(self, user_id: str, *, keep: str | None = None) -> int:
        """Log out everywhere (FR-ACC-04), optionally keeping the session behind the `keep` cookie value (a password change)."""
        with self._sessions.begin() as session:
            return self.revoke_all_in(session, user_id, keep=keep)

    def revoke_all_in(self, session: Session, user_id: str, *, keep: str | None = None) -> int:
        """`revoke_all` inside a transaction the caller owns."""
        query = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        if keep:
            query = query.where(UserSession.id_hash != token_hash(keep))
        return session.execute(query.values(revoked_at=self._now())).rowcount
    # -- CSRF --------------------------------------------------------------------------------------------------------

    def csrf_token(self, token: str) -> str:
        digest = hmac.new(self._csrf_key, token.encode("utf-8"), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")  # 43 characters

    def csrf_ok(self, token: str, supplied: str | None) -> bool:
        return bool(supplied) and hmac.compare_digest(self.csrf_token(token), supplied)
