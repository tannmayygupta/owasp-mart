"""Learner signup, email verification and resending the link (FR-ACC-01, FR-ACC-02), and the address lookup of the mail worker.

Rules this module keeps:
- The answer to a signup never depends on whether the address has an account (no oracle): a new address gets a verification mail,
  a known one gets a mail that says so, and the caller sees the same result. The password is hashed in both cases, so the time does
  not tell them apart either.
- The verification link is single use and kept only as a hash. It is claimed with one conditional UPDATE, so two simultaneous uses
  cannot both win. A used, expired, unknown or wrong-purpose token is the same error (`TokenInvalid`).
- Emails are written to the outbox in the same transaction as the account (the mail exists exactly when the account does).
- Passwords, tokens and addresses are never logged.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.ports.settings import SettingsPort

from .models import EmailToken, User, UserRole, UserSession
from .passwords import InvalidPassword, PasswordPolicy
from .security import hash_password, new_token, new_user_id, normalize_email, spend_the_same_time, token_hash

logger = logging.getLogger("vulnmart.accounts")

Clock = Callable[[], datetime]
PASSWORD_MIN, PASSWORD_MAX = 12, 128
NAME_MAX = 60
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")
_SPACE = re.compile(r"\s+")


def utc_now() -> datetime:
    return datetime.now(UTC)


class InvalidInput(ValueError):
    """A value is not acceptable. `pointer` names it (JSON pointer into the body); the value is never kept."""

    def __init__(self, pointer: str, kind: str = "value_error"):
        super().__init__(pointer)
        self.pointer = pointer
        self.kind = kind  # a password rule that failed (passwords.py) or the generic "value_error"


class TokenInvalid(Exception):
    """The link was used, expired, never existed or is for another purpose. One error for all four (the answer is not an oracle)."""


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)  # SQLite hands back naive UTC


def clean_display_name(raw: str) -> str:
    text = _SPACE.sub(" ", _CONTROL.sub(" ", unicodedata.normalize("NFC", raw))).strip()
    if not 1 <= len(text) <= NAME_MAX:
        raise InvalidInput("/display_name")
    return text


def check_password(password: str) -> None:
    """Length only, as the contract says (12 to 128). The breach-list check and the quality rules come with story P-14 (FR-ACC-08)."""
    if not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
        raise InvalidInput("/password")


def check_new_password(policy: PasswordPolicy, password: str, *, pointer: str, email: str | None, display_name: str | None,
                       min_length: int = PASSWORD_MIN) -> None:
    """Run the password rules and turn a refusal into an InvalidInput that names the field and the rule (never the password)."""
    try:
        policy.check(password, email=email, display_name=display_name, min_length=min_length)
    except InvalidPassword as exc:
        raise InvalidInput(pointer, exc.kind) from None


class AccountService:
    def __init__(self, sessions: sessionmaker[Session], settings: SettingsPort, *, public_origin: str, now: Clock = utc_now,
                 policy: PasswordPolicy | None = None):
        self._sessions = sessions
        self._settings = settings
        self._origin = public_origin.rstrip("/")
        self._now = now
        self._policy = policy or PasswordPolicy()  # rules 1 to 3 of passwords.py; the process passes one with the common-password list

    # -- helpers -----------------------------------------------------------------------------------------------------

    def _outbox(self, session: Session) -> DbOutboxPort:
        return DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params)

    def _issue_verify_token(self, session: Session, user_id: str, now: datetime) -> str:
        hours = int(self._settings.get("email_token_hours"))
        token = new_token()
        session.add(EmailToken(token_hash=token_hash(token), user_id=user_id, purpose="verify", expires_at=now + timedelta(hours=hours)))
        return token

    def _send_verification(self, session: Session, user_id: str, now: datetime) -> None:
        token = self._issue_verify_token(session, user_id, now)
        self._outbox(session).enqueue_email(
            template="account.verify", to_user_id=user_id,
            params={"link": f"{self._origin}/verify-email?token={token}", "expires_in_hours": int(self._settings.get("email_token_hours"))})

    def _send_already_registered(self, session: Session, user: User) -> None:
        if user.status == "active":  # a disabled or deleted account gets no mail
            self._outbox(session).enqueue_email(template="account.already_registered", to_user_id=user.id,
                                                params={"login_url": f"{self._origin}/login"})

    # -- signup ------------------------------------------------------------------------------------------------------

    def signup(self, *, email: str, password: str, display_name: str) -> None:
        """Create a learner and queue the verification mail, or queue the "already registered" mail. Returns nothing either way."""
        self.signup_account(email=email, password=password, display_name=display_name)

    def signup_account(self, *, email: str, password: str, display_name: str, account_type: str = "participant",
                       check_email: Callable[[str], None] | None = None, on_create: Callable[[Session, User], None] | None = None) -> None:
        """The signup of any account type (the learner signup above, the recruiter signup of story P-18). `check_email` gets the canonical address and
        raises InvalidInput to refuse it (it must not depend on whether the address has an account); `on_create` runs in the same transaction
        right after a new user row exists (never for a known address), so what it adds is made exactly when the account is."""
        email_ci = normalize_email(email)
        if email_ci is None:
            raise InvalidInput("/email")
        if check_email is not None:
            check_email(email_ci)
        name = clean_display_name(display_name)
        check_new_password(self._policy, password, pointer="/password", email=email_ci, display_name=name)
        password_hash = hash_password(password)  # always, so a known address costs the same time as a new one
        now = self._now()
        try:
            with self._sessions.begin() as session:
                existing = session.scalar(select(User).where(User.email_ci == email_ci))
                if existing is not None:
                    self._send_already_registered(session, existing)
                    return
                user = User(id=new_user_id(), account_type=account_type, email=email.strip()[:254], email_ci=email_ci,
                            password_hash=password_hash, display_name=name, status="active", age_declared_at=now)
                session.add(user)
                session.flush()
                if account_type == "participant":
                    session.add(UserRole(user_id=user.id, role="learner", account_type="participant"))
                if on_create is not None:
                    on_create(session, user)
                self._send_verification(session, user.id, now)
        except IntegrityError:
            # Two signups for one address at the same moment: the second one lost the unique index. Answer as for a known address.
            with self._sessions.begin() as session:
                existing = session.scalar(select(User).where(User.email_ci == email_ci))
                if existing is not None:
                    self._send_already_registered(session, existing)

    # -- verification ------------------------------------------------------------------------------------------------

    def verify_email(self, token: str) -> None:
        """Use a verification link once. Raises TokenInvalid for a link that was used, expired, never existed or is not a verification link."""
        digest = token_hash(token)
        now = self._now()
        with self._sessions.begin() as session:
            row = session.get(EmailToken, digest)
            if row is None or row.purpose != "verify" or row.used_at is not None or _aware(row.expires_at) <= now:
                raise TokenInvalid
            claimed = session.execute(
                update(EmailToken).where(EmailToken.token_hash == digest, EmailToken.used_at.is_(None)).values(used_at=now)).rowcount
            if claimed != 1:
                raise TokenInvalid  # another request used it between our read and our update
            user = session.get(User, row.user_id)
            if user is None or user.status != "active":
                raise TokenInvalid
            if user.email_verified_at is None:
                user.email_verified_at = now

    def resend_verification(self, *, email: str) -> None:
        """Send a new link to an unverified account and make the old ones useless. Does nothing, silently, for any other address."""
        email_ci = normalize_email(email)
        if email_ci is None:
            raise InvalidInput("/email")
        now = self._now()
        with self._sessions.begin() as session:
            user = session.scalar(select(User).where(User.email_ci == email_ci))
            if user is None or user.status != "active" or user.email_verified_at is not None:
                spend_the_same_time()  # a stand-in for the work below, so the answer time says little
                return
            session.execute(update(EmailToken).where(EmailToken.user_id == user.id, EmailToken.purpose == "verify",
                                                     EmailToken.used_at.is_(None)).values(used_at=now))
            self._send_verification(session, user.id, now)

    # -- password reset (FR-ACC-08) ------------------------------------------------------------------------------------

    def request_reset(self, *, email: str) -> None:
        """Mail a reset link to an active account and make its older unused reset links useless. Silent for any other address: the
        answer, and about the time it takes, do not tell whether the address has an account. An unverified account may reset too: the
        link proves the person reads that mailbox (and confirming it verifies the address)."""
        email_ci = normalize_email(email)
        if email_ci is None:
            raise InvalidInput("/email")
        now = self._now()
        with self._sessions.begin() as session:
            user = session.scalar(select(User).where(User.email_ci == email_ci))
            if user is None or user.status != "active":
                spend_the_same_time()
                return
            session.execute(update(EmailToken).where(EmailToken.user_id == user.id, EmailToken.purpose == "reset",
                                                     EmailToken.used_at.is_(None)).values(used_at=now))
            hours = int(self._settings.get("email_token_hours"))
            token = new_token()
            session.add(EmailToken(token_hash=token_hash(token), user_id=user.id, purpose="reset", expires_at=now + timedelta(hours=hours)))
            self._outbox(session).enqueue_email(template="account.password_reset", to_user_id=user.id,
                                                params={"link": f"{self._origin}/reset-password?token={token}", "expires_in_hours": hours})

    def confirm_reset(self, *, token: str, new_password: str) -> str:
        """Set a new password with a reset link, once. Returns the account's canonical email (so the caller can clear its failed-login
        count). Raises TokenInvalid for a link that was used, expired, never existed or is not a reset link, and InvalidInput (the link
        is not used up) for a password that breaks a rule. On success every session of the account ends (contract) and the address is
        marked verified, because the link proved the person reads it."""
        digest = token_hash(token)
        now = self._now()
        with self._sessions() as session:  # first look, without changing anything: is the link good, and whose is it
            row = session.get(EmailToken, digest)
            user = session.get(User, row.user_id) if row is not None else None
            if (row is None or row.purpose != "reset" or row.used_at is not None or _aware(row.expires_at) <= now
                    or user is None or user.status != "active"):
                raise TokenInvalid
            email_ci, name, user_id = user.email_ci, user.display_name, user.id
        check_new_password(self._policy, new_password, pointer="/new_password", email=email_ci, display_name=name)
        new_hash = hash_password(new_password)
        with self._sessions.begin() as session:
            claimed = session.execute(
                update(EmailToken).where(EmailToken.token_hash == digest, EmailToken.used_at.is_(None)).values(used_at=now)).rowcount
            if claimed != 1:
                raise TokenInvalid  # another request used it between our look and our update
            session.execute(update(EmailToken).where(EmailToken.user_id == user_id, EmailToken.purpose == "reset",
                                                     EmailToken.used_at.is_(None)).values(used_at=now))  # any other reset link dies too
            user = session.get(User, user_id)
            user.password_hash = new_hash
            if user.email_verified_at is None:
                user.email_verified_at = now
            session.execute(update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None)).values(revoked_at=now))
        return email_ci


class DbRecipients:
    """The mail worker's RecipientLookup (handoff H-127): the current address of an active account, verified or not (the
    verification mail goes to an account that is not verified yet)."""

    def __init__(self, sessions: sessionmaker[Session]):
        self._sessions = sessions

    def address_for(self, user_id: str) -> str | None:
        with self._sessions() as session:
            return session.scalar(select(User.email).where(User.id == user_id, User.status == "active"))
