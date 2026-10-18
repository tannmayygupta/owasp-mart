"""The second factor: an authenticator app (TOTP) and recovery codes (FR-ACC-07).

Who needs it: every admin (an admin session without a proved second factor has no admin role, see `SessionService.resolve`), and any account that turns
it on (recruiters may, learners and candidates may too). Who cannot turn it off: an admin.

The flows (contract IF-1):
- Enrolment: `start_enrolment` makes a secret and returns the `otpauth://` address once (the secret is sealed with the field key and bound to the account);
  nothing is active until `confirm_enrolment` receives a good code from the app. Then the factor is on, ten recovery codes are shown once (only keyed
  hashes are stored), and the session value changes with "a second factor was proved" recorded in it.
- Login: the password step of `SessionService.login` answers with a challenge; `issue_ticket` makes a 5-minute single-use ticket (stored as a hash, five tries);
  `complete_login` takes the ticket and a code (TOTP, or one recovery code) and opens the session. A TOTP code works once (its time step must be newer than
  the last used); a recovery code works once. Every claim is one conditional UPDATE, so two simultaneous requests cannot both use the same code or ticket.
- Turning it off: password required, never for an admin; the session value changes.

Wrong, expired, used and unknown all give the same `MfaInvalid`. The route counts failures per account (a throttle like the login's). Every change is
appended to the audit log before it commits.
"""
from __future__ import annotations

import base64
import logging
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.audit import AuditPort

from .fieldkeys import FieldKeys
from .models import EmailToken, MfaCredential, RecoveryCode, User
from .security import new_token, token_hash, verify_password
from .self_service import SessionEnded
from .sessions import InvalidCredentials, LoginResult, SessionService
from .totp import new_secret, otpauth_uri, verify

logger = logging.getLogger("vulnmart.accounts")

Clock = Callable[[], datetime]
TICKET_LIFETIME = timedelta(minutes=5)
TICKET_TRIES = 5
RECOVERY_CODE_COUNT = 10
RECOVERY_BYTES = 6  # 48 bits shown as 10 Base32 characters (the contract's `MfaRecoveryCodes`)


def utc_now() -> datetime:
    return datetime.now(UTC)


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


class MfaInvalid(Exception):
    """The code or the ticket is not good (wrong, used, expired, unknown: one error). `user_id` is set when the ticket was real, so the route can
    count the failure against the account."""

    def __init__(self, user_id: str | None = None):
        super().__init__("invalid")
        self.user_id = user_id


class MfaState(Exception):
    """The second factor is not in a state that allows this (already on, nothing to confirm, an admin turning it off, nothing to turn off)."""


def new_recovery_code() -> str:
    return base64.b32encode(secrets.token_bytes(RECOVERY_BYTES)).decode("ascii")[:10]  # 6 bytes = 48 bits = 10 Base32 characters, no padding


class MfaService:
    def __init__(self, sessions: sessionmaker[Session], keys: FieldKeys, audit: AuditPort, session_service: SessionService, *,
                 now: Clock = utc_now, issuer: str = "VulnMart"):
        self._sessions, self._keys, self._audit, self._session_service = sessions, keys, audit, session_service
        self._now, self._issuer = now, issuer

    # -- enrolment ---------------------------------------------------------------------------------------------------

    def start_enrolment(self, user_id: str) -> str:
        """Make a pending secret (replacing an earlier pending one) and return the `otpauth://` address. MfaState when a factor is already on."""
        with self._sessions.begin() as session:
            user = session.get(User, user_id)
            credential = session.get(MfaCredential, user_id)
            if credential is not None and credential.enabled_at is not None:
                raise MfaState
            secret = new_secret()
            sealed = self._keys.seal(secret, account=user_id)
            if credential is None:
                session.add(MfaCredential(user_id=user_id, type="totp", secret_enc=sealed))
            else:
                credential.secret_enc, credential.last_used_step = sealed, None
            return otpauth_uri(user.email, secret, self._issuer)

    def confirm_enrolment(self, *, user_id: str, token: str, code: str) -> tuple[str, list[str]]:
        """Turn the factor on with a good code. Returns the new session value and the recovery codes (shown this once). MfaInvalid for a wrong
        code, MfaState when there is nothing to confirm, SessionEnded when the session is gone."""
        now = self._now()
        with self._sessions.begin() as session:
            credential = session.get(MfaCredential, user_id)
            if credential is None or credential.enabled_at is not None:
                raise MfaState
            step = verify(self._keys.open(credential.secret_enc, account=user_id), code, now)
            if step is None:
                raise MfaInvalid(user_id)
            self._audit.append(actor=user_id, action="mfa.enabled", subject=user_id, details={"type": "totp"})
            credential.enabled_at, credential.last_used_step = now, step
            codes = [new_recovery_code() for _ in range(RECOVERY_CODE_COUNT)]
            session.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user_id))
            session.add_all(RecoveryCode(code_hash=self._keys.recovery_hash(user_id, c), user_id=user_id) for c in codes)
            new_token_value = self._session_service.rotate_in(session, token, mfa=True)
            if new_token_value is None:
                raise SessionEnded
            return new_token_value, codes

    def disable(self, *, user_id: str, token: str, password: str) -> str:
        """Turn the factor off (a recruiter or other non-admin who gives their password). Returns the new session value. MfaState for an admin or
        when there is nothing to turn off, InvalidCredentials for a wrong password, SessionEnded when the session is gone."""
        with self._sessions() as session:
            user = session.get(User, user_id)
            credential = session.get(MfaCredential, user_id)
            if user.account_type == "admin" or credential is None or credential.enabled_at is None:
                raise MfaState
            password_hash = user.password_hash
        if not verify_password(password_hash, password):
            raise InvalidCredentials
        with self._sessions.begin() as session:
            self._audit.append(actor=user_id, action="mfa.disabled", subject=user_id, details={"type": "totp"})
            session.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user_id))
            session.execute(delete(MfaCredential).where(MfaCredential.user_id == user_id))
            new_token_value = self._session_service.rotate_in(session, token, mfa=False)
            if new_token_value is None:
                raise SessionEnded
            return new_token_value

    # -- login -------------------------------------------------------------------------------------------------------

    def issue_ticket(self, user_id: str) -> tuple[str, datetime]:
        """A single-use ticket that proves the password step for five minutes. Returns it and when it ends."""
        now = self._now()
        ticket = new_token()
        with self._sessions.begin() as session:
            session.add(EmailToken(token_hash=token_hash(ticket), user_id=user_id, purpose="mfa", expires_at=now + TICKET_LIFETIME))
        return ticket, now + TICKET_LIFETIME

    def complete_login(self, *, ticket: str, code: str, ip_trunc: str | None = None, ua_class: str | None = None) -> LoginResult:
        """Finish a login with the ticket and a code (a 6-digit TOTP code or a 10-character recovery code). MfaInvalid for any failure."""
        digest, now = token_hash(ticket), self._now()
        user_id: str | None = None
        accepted = False
        with self._sessions.begin() as session:
            row = session.get(EmailToken, digest)
            if row is not None and row.purpose != "mfa":
                row = None  # a verification or reset link is not a login ticket
            if row is None or row.used_at is not None or _aware(row.expires_at) <= now or row.attempts >= TICKET_TRIES:
                raise MfaInvalid(row.user_id if row is not None else None)
            user_id = row.user_id
            user, credential = session.get(User, user_id), session.get(MfaCredential, user_id)
            if user is not None and user.status == "active" and credential is not None and credential.enabled_at is not None:
                accepted = self._check_code(session, user_id, credential, code, now)
            if accepted:
                claimed = session.execute(update(EmailToken).where(EmailToken.token_hash == digest, EmailToken.used_at.is_(None)).values(used_at=now)).rowcount
                accepted = claimed == 1  # a simultaneous request used the ticket first
            if not accepted:
                session.execute(update(EmailToken).where(EmailToken.token_hash == digest).values(attempts=EmailToken.attempts + 1))
        if not accepted:
            raise MfaInvalid(user_id)
        return self._session_service.open_session(user_id, ip_trunc=ip_trunc, ua_class=ua_class, mfa=True)

    def _check_code(self, session: Session, user_id: str, credential: MfaCredential, code: str, now: datetime) -> bool:
        if len(code) == 6 and code.isdigit():
            step = verify(self._keys.open(credential.secret_enc, account=user_id), code, now, last_used_step=credential.last_used_step)
            if step is None:
                return False
            claimed = session.execute(update(MfaCredential).where(
                MfaCredential.user_id == user_id, (MfaCredential.last_used_step.is_(None)) | (MfaCredential.last_used_step < step))
                .values(last_used_step=step)).rowcount
            return claimed == 1  # two simultaneous requests with one code: one wins
        if len(code) == 10 and code.isalnum() and code.isascii() and code == code.upper():
            used = session.execute(update(RecoveryCode).where(
                RecoveryCode.code_hash == self._keys.recovery_hash(user_id, code), RecoveryCode.user_id == user_id, RecoveryCode.used_at.is_(None))
                .values(used_at=now)).rowcount
            if used == 1:
                self._audit.append(actor=user_id, action="mfa.recovery_code_used", subject=user_id, details={})
                return True
        return False
