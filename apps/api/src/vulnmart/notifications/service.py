"""The email outbox (FR-NTF-02): enqueue in the caller's transaction, claim due rows, deliver with retries and a daily cap.

Postgres is the truth (architecture 02 section 13): a row is `pending` until the provider accepted it. The worker only *relays*
due rows to Dramatiq and delivers them; if Valkey loses its queue, or the worker dies between claim and send, the claim (a lease)
runs out and the next relay pass claims the row again, so nothing is lost. The cost is the usual at-least-once one: a crash after
the provider accepted the mail and before the row is marked `sent` can send that one mail twice.

Retries are kept in the row (`attempts`, `next_attempt_at`), not in Dramatiq's own retry middleware, for the same reason: a
retry that lives only in Valkey would disappear with it (ADR 0040). Admins see `failed` rows and the counts (`failed_rows`,
`stats`); the admin screens that show them are story P-28.
"""
from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Any, Protocol, runtime_checkable

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.outbox import EmailJob
from vulnmart.ports.settings import SettingsPort

from .models import EmailOutbox
from .provider import DailyCapReached, EmailProvider, OutgoingEmail, PermanentSendError, SendError, TransientSendError

logger = logging.getLogger("vulnmart.notifications")

Clock = Callable[[], datetime]

# Wait before attempt 2, 3, 4, ...; after the last delay one more failure gives up. Six attempts span about 8.6 hours.
BACKOFF = (timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=30), timedelta(hours=2), timedelta(hours=6))
MAX_ATTEMPTS = len(BACKOFF) + 1
LEASE = timedelta(minutes=5)
BATCH = 50
MAX_PARAMS_BYTES = 8192
REMOVED = "[removed after sending]"


def utc_now() -> datetime:
    return datetime.now(UTC)


def start_of_next_day(moment: datetime) -> datetime:
    return datetime.combine(moment.astimezone(UTC).date() + timedelta(days=1), time.min, tzinfo=UTC)


@dataclass(frozen=True, slots=True)
class Rendered:
    subject: str
    text: str
    html: str | None = None
    sender_name: str | None = None  # the display name of the sender when it is not VulnMart itself (FR-NTF-01: the mail names its sender)


class UnknownTemplate(Exception):
    """The template name has no renderer (a programming error: `templates.py` owns the list)."""


class InvalidParams(ValueError):
    """The parameters do not fit the template (missing, unknown or malformed). Raised at enqueue and again at render."""


@runtime_checkable
class Renderer(Protocol):
    def render(self, template: str, params: Mapping[str, Any]) -> Rendered:
        """The subject and bodies of one email. Raises UnknownTemplate."""
        ...


@runtime_checkable
class RecipientLookup(Protocol):
    def address_for(self, user_id: str) -> str | None:
        """The current address of an account, or None when the account is gone or has none. Story P-11 provides the real one."""
        ...


class DbOutboxPort:
    """OutboxPort.enqueue_email over `email_outbox`, written in the caller's session and never committed here.

    `session_source` returns the session of the transaction that causes the email, so the row commits or rolls back with its cause
    (the point of an outbox). Events (`publish`) still go to `events` until the events table of story P-22 exists.
    """

    def __init__(self, session_source: Callable[[], Session], events: Any, *, now: Clock = utc_now,
                 validator: Callable[[str, Mapping[str, Any]], None] | None = None):
        self._session_source = session_source
        self._events = events
        self._now = now
        self._validator = validator  # checks the template name and parameters now, in the cause's transaction, not at delivery

    def publish(self, event: Mapping[str, Any]):
        return self._events.publish(event)

    def enqueue_email(self, *, template: str, to_user_id: str, params: Mapping[str, Any] | None = None) -> EmailJob:
        check_email_args(template, to_user_id, params)
        if self._validator is not None:
            self._validator(template, params or {})
        params = dict(params or {})
        now = self._now()
        row = EmailOutbox(template=template, to_user_id=to_user_id, params=params, state="pending", attempts=0, next_attempt_at=now)
        session = self._session_source()
        session.add(row)
        session.flush()  # the id; the caller's commit makes the row real
        return EmailJob(id=row.id, template=template, to_user_id=to_user_id, params=params, created_at=now.isoformat())


def _strings(value: Any):
    """Every string inside a JSON value, at any depth (the keys too)."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for key, item in value.items():
            yield str(key)
            yield from _strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item)


def check_email_args(template: str, to_user_id: str, params: Mapping[str, Any] | None) -> None:
    import json

    if not template or not to_user_id:
        raise ValueError("template and to_user_id are required")
    if len(template) > 64 or len(to_user_id) > 32:
        raise ValueError("template is at most 64 characters and to_user_id at most 32")
    params = params or {}
    try:
        encoded = json.dumps(params)
    except (TypeError, ValueError) as exc:
        raise ValueError("params must be JSON values") from exc
    if any("@" in text for text in _strings(params)):
        raise ValueError("an email address never goes into params; the worker looks it up from to_user_id")
    size = len(encoded)
    if size > MAX_PARAMS_BYTES:
        raise ValueError(f"params are at most {MAX_PARAMS_BYTES} bytes")


@dataclass(frozen=True, slots=True)
class FailedEmail:
    id: int
    template: str
    attempts: int
    last_error_code: str | None
    updated_at: datetime


class EmailOutboxService:
    """Claims due rows and delivers one row; both are safe to run in several worker processes."""

    def __init__(self, sessions: sessionmaker[Session], provider: EmailProvider, recipients: RecipientLookup, renderer: Renderer,
                 settings: SettingsPort, *, sender_address: str = "no-reply@vulnmart.invalid", sender_name: str = "VulnMart",
                 now: Clock = utc_now, backoff: tuple[timedelta, ...] = BACKOFF, lease: timedelta = LEASE, batch: int = BATCH):
        self._sessions = sessions
        self._provider, self._recipients, self._renderer, self._settings = provider, recipients, renderer, settings
        self._sender = (sender_address, sender_name)
        self._now, self._backoff, self._lease, self._batch = now, backoff, lease, batch

    @property
    def max_attempts(self) -> int:
        return len(self._backoff) + 1

    # -- relay side --------------------------------------------------------------------------------------------------

    def sent_today(self, session: Session, now: datetime) -> int:
        midnight = datetime.combine(now.astimezone(UTC).date(), time.min, tzinfo=UTC)
        return session.scalar(select(func.count()).select_from(EmailOutbox).where(EmailOutbox.sent_at >= midnight)) or 0

    def claim_due(self) -> list[int]:
        """Lease the next due rows in outbox order and return their ids, never more than the daily cap still allows.

        With the cap used up nothing is claimed and nothing changes: the rows simply wait, and the pass after midnight (UTC)
        takes them in order. A cap of 0 or less means no cap."""
        now = self._now()
        cap = int(self._settings.get("email_daily_cap"))
        with self._sessions.begin() as session:
            limit = self._batch
            if cap > 0:
                # Rows other workers hold a lease on will be sent too, so they count against today's cap (two workers claiming at
                # once must not both take the last slots).
                leased = session.scalar(select(func.count()).select_from(EmailOutbox).where(
                    EmailOutbox.state == "pending", EmailOutbox.claimed_until >= now)) or 0
                limit = min(limit, cap - self.sent_today(session, now) - leased)
            if limit <= 0:
                return []
            rows = session.scalars(
                select(EmailOutbox)
                .where(EmailOutbox.state == "pending", EmailOutbox.next_attempt_at <= now,
                       or_(EmailOutbox.claimed_until.is_(None), EmailOutbox.claimed_until < now))
                .order_by(EmailOutbox.id).limit(limit).with_for_update(skip_locked=True)
            ).all()
            for row in rows:
                row.claimed_until = now + self._lease
            return [row.id for row in rows]

    # -- worker side -------------------------------------------------------------------------------------------------

    def deliver(self, outbox_id: int) -> str:
        """Send one row and record the result. Returns `sent`, `retry`, `deferred`, `failed` or `skipped`."""
        with self._sessions() as session:
            row = session.get(EmailOutbox, outbox_id)
            if row is None or row.state != "pending":
                return "skipped"  # already sent by an earlier delivery of the same queue message
            template, user_id, params, attempts = row.template, row.to_user_id, dict(row.params), row.attempts
        try:
            address = self._recipients.address_for(user_id)
            if not address:
                raise PermanentSendError("no-recipient")
            try:
                rendered = self._renderer.render(template, params)
            except UnknownTemplate as exc:
                raise PermanentSendError("bad-template") from exc
            except InvalidParams as exc:
                raise PermanentSendError("bad-params") from exc
            message_id = self._provider.send(OutgoingEmail(
                to=address, subject=rendered.subject, text=rendered.text, html=rendered.html,
                sender_address=self._sender[0], sender_name=rendered.sender_name or self._sender[1]))
        except SendError as err:
            return self._record_failure(outbox_id, attempts, err)
        except Exception:  # noqa: BLE001 - a bug in a renderer or lookup must not lose the mail or kill the worker thread
            logger.exception("email %s: unexpected error while sending", outbox_id)
            return self._record_failure(outbox_id, attempts, TransientSendError("internal"))
        now = self._now()
        secret = getattr(self._renderer, "secret_params", lambda name: frozenset())(template)
        with self._sessions.begin() as session:
            row = session.get(EmailOutbox, outbox_id)
            row.state, row.sent_at, row.provider_message_id = "sent", now, message_id[:255]
            row.attempts, row.claimed_until, row.last_error_code = attempts + 1, None, None
            if secret:  # a single-use link is not kept once the mail left: the sent row holds nothing that opens an account
                row.params = {k: (REMOVED if k in secret else v) for k, v in params.items()}
        logger.info("email %s sent (template %s)", outbox_id, template)
        return "sent"

    def _record_failure(self, outbox_id: int, attempts: int, err: SendError) -> str:
        now = self._now()
        with self._sessions.begin() as session:
            row = session.get(EmailOutbox, outbox_id)
            row.last_error_code, row.claimed_until = err.code, None
            if isinstance(err, DailyCapReached):
                row.next_attempt_at = start_of_next_day(now)  # the attempt is not counted
                outcome = "deferred"
            elif isinstance(err, PermanentSendError) or attempts + 1 >= self.max_attempts:
                row.state, row.attempts = "failed", attempts + 1
                outcome = "failed"
            else:
                row.attempts = attempts + 1
                row.next_attempt_at = now + self._backoff[attempts]
                outcome = "retry"
        logger.warning("email %s %s (%s)", outbox_id, outcome, err.code)
        return outcome

    # -- admin side --------------------------------------------------------------------------------------------------

    def failed_rows(self, limit: int = 100) -> list[FailedEmail]:
        with self._sessions() as session:
            rows = session.scalars(select(EmailOutbox).where(EmailOutbox.state == "failed").order_by(EmailOutbox.id).limit(limit)).all()
            return [FailedEmail(r.id, r.template, r.attempts, r.last_error_code, r.updated_at) for r in rows]

    def requeue(self, outbox_id: int) -> bool:
        """Put a failed row back to pending with a fresh set of attempts (an admin's decision). False when it is not failed."""
        with self._sessions.begin() as session:
            row = session.get(EmailOutbox, outbox_id)
            if row is None or row.state != "failed":
                return False
            row.state, row.attempts, row.next_attempt_at, row.claimed_until = "pending", 0, self._now(), None
            return True

    def stats(self) -> dict[str, Any]:
        """Counts per state and the age in seconds of the oldest pending row (the outbox-age metric of architecture 02)."""
        now = self._now()
        with self._sessions() as session:
            counts = dict(session.execute(select(EmailOutbox.state, func.count()).group_by(EmailOutbox.state)).all())
            oldest = session.scalar(select(func.min(EmailOutbox.created_at)).where(EmailOutbox.state == "pending"))
            sent_today = self.sent_today(session, now)
        age = None
        if oldest is not None:
            oldest = oldest if oldest.tzinfo else oldest.replace(tzinfo=UTC)
            age = max(0.0, (now - oldest).total_seconds())
        return {"pending": counts.get("pending", 0), "sent": counts.get("sent", 0), "failed": counts.get("failed", 0),
                "oldest_pending_age_seconds": age, "sent_today": sent_today}
