"""Worker entrypoint (K-04): the job worker. Health routes plus, since story P-09, the mail worker (Dramatiq on Valkey) and its relay loop.

Without a database and Valkey address the process only idles beside the health routes (a laptop or a test with no stack): it logs
that mail is not delivered. With both, `deliver_email` runs on Dramatiq's threads and the relay loop feeds it from `email_outbox`.
"""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from vulnmart.kernel.service import background_lifespan, create_service_app
from vulnmart.kernel.settings import Settings, get_settings

logger = logging.getLogger("vulnmart.worker")


def mail_lifespan(settings: Settings | None = None):
    settings = settings or get_settings()
    idle = background_lifespan("worker")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if not (settings.postgres_dsn and settings.valkey_url):
            logger.warning("worker: no Postgres and Valkey address, so no mail is delivered (idle)")
            async with idle(app):
                yield
            return
        from dramatiq import Worker

        from vulnmart.kernel.services import build_ports
        from vulnmart.notifications.worker import RelayLoop, build_email_service, make_broker, make_delivery_actor

        ports = build_ports(settings)
        assert ports.sessions is not None  # a Postgres address is set
        from vulnmart.accounts.service import DbRecipients
        from vulnmart.notifications.fakes import DevRecipients, FallbackRecipients

        recipients = DbRecipients(ports.sessions)  # the real lookup (story P-11, handoff H-127)
        if settings.env in ("dev", "test"):
            recipients = FallbackRecipients(recipients, DevRecipients())
        service = build_email_service(settings, ports.sessions, ports.settings, recipients=recipients)
        broker = make_broker(settings.valkey_url)
        actor = make_delivery_actor(broker, service)
        worker = Worker(broker, worker_threads=2)
        relay = RelayLoop(service, actor, settings.email_relay_interval_seconds)
        app.state.email_service = service
        worker.start()
        relay.start()
        logger.info("worker started: mail relay every %ss, provider %s", settings.email_relay_interval_seconds, settings.email_provider)
        try:
            async with idle(app):
                yield
        finally:
            relay.stop()
            worker.stop()
            broker.close()

    return lifespan


def create_app(settings: Settings | None = None) -> FastAPI:
    return create_service_app("worker", settings=settings, lifespan=mail_lifespan(settings), configure_logs=True)


app = create_app()
