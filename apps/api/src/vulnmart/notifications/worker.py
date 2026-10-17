"""The mail worker: a Dramatiq actor that delivers one outbox row, and the relay loop that feeds it (FR-NTF-02).

The broker is Dramatiq's Redis broker pointed at Valkey (compatibility is spike S-18; the broker only uses plain Redis commands).
The actor has `max_retries=0` on purpose: the outbox row owns retries and back-off (see service.py and ADR 0040), so a lost queue
only delays mail. `RelayLoop` runs inside the worker service process (kernel/entrypoints/worker.py) beside Dramatiq's own threads.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

import dramatiq
from dramatiq import Broker

from vulnmart.kernel.settings import Settings

from .fakes import DevRecipients
from .provider import BrevoApiProvider, EmailProvider, SmtpProvider
from .service import EmailOutboxService, RecipientLookup, Renderer
from .templates import TemplateRenderer

logger = logging.getLogger("vulnmart.notifications")

QUEUE = "email"
ACTOR_NAME = "vulnmart.deliver_email"


def broker_url(valkey_url: str) -> str:
    """redis-py does not know the `valkey://` scheme the rest of the platform uses; the wire protocol is the same."""
    for prefix, target in (("valkey://", "redis://"), ("valkeys://", "rediss://")):
        if valkey_url.startswith(prefix):
            return target + valkey_url[len(prefix):]
    return valkey_url


def make_broker(valkey_url: str) -> Broker:
    from dramatiq.brokers.redis import RedisBroker

    return RedisBroker(url=broker_url(valkey_url))


def make_provider(settings: Settings) -> EmailProvider:
    """The adapter the environment names. Brevo needs its key; an unset key fails the start, not the first send."""
    if settings.email_provider == "brevo":
        key = settings.brevo_key_value()
        if not key:
            raise RuntimeError("VULNMART_EMAIL_PROVIDER=brevo needs VULNMART_BREVO_API_KEY or VULNMART_BREVO_API_KEY_FILE")
        return BrevoApiProvider(key)
    return SmtpProvider(settings.smtp_host or "mailpit", settings.smtp_port, starttls=settings.smtp_starttls,
                        username=settings.smtp_username, password=settings.smtp_password)


def make_delivery_actor(broker: Broker, service: EmailOutboxService) -> dramatiq.Actor:
    def deliver_email(outbox_id: int) -> None:
        service.deliver(outbox_id)

    return dramatiq.actor(deliver_email, broker=broker, actor_name=ACTOR_NAME, queue_name=QUEUE, max_retries=0, time_limit=60_000)


class RelayLoop:
    """Claims due rows and sends their ids to the actor, every `interval` seconds, on a thread of its own."""

    def __init__(self, service: EmailOutboxService, actor: dramatiq.Actor, interval: float = 5.0):
        self._service, self._actor, self._interval = service, actor, interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="email-relay", daemon=True)

    def relay_once(self) -> int:
        ids = self._service.claim_due()
        for outbox_id in ids:
            self._actor.send(outbox_id)
        return len(ids)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.relay_once()
            except Exception:  # noqa: BLE001 - one failed pass (database or Valkey down) must not end the loop
                logger.exception("email relay pass failed; trying again")
            self._stop.wait(self._interval)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=10)


def build_email_service(settings: Settings, sessions: Any, settings_port: Any, *, provider: EmailProvider | None = None,
                        recipients: RecipientLookup | None = None, renderer: Renderer | None = None,
                        now: Callable[..., Any] | None = None) -> EmailOutboxService:
    extra = {"now": now} if now else {}
    if recipients is None:
        if settings.env in ("staging", "production"):
            # fail closed: until story P-11 provides the account lookup, a deployed worker would turn every mail into `failed`
            raise RuntimeError(f"VULNMART_ENV={settings.env} needs a RecipientLookup (story P-11 provides it)")
        recipients = DevRecipients()
    return EmailOutboxService(
        sessions, provider or make_provider(settings), recipients, renderer or TemplateRenderer(),
        settings_port, sender_address=settings.email_sender_address, sender_name=settings.email_sender_name, **extra)
