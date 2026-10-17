"""Story P-09: the email outbox, delivery with retries and the daily cap, the provider adapters, and the Dramatiq actor.

Runs on SQLite and in-memory fakes (no Docker). The Postgres part (migration 0002, claims by several workers) is in
test_notifications_postgres.py.
"""
from __future__ import annotations

import io
import json
import smtplib
import threading
import urllib.error
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import dramatiq
import pytest
from dramatiq import Worker
from dramatiq.brokers.stub import StubBroker
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.kernel.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from vulnmart.kernel.db import Base
from vulnmart.notifications.fakes import FakeEmailProvider, RegistryRenderer, StaticRecipients
from vulnmart.notifications.models import EmailOutbox
from vulnmart.notifications.provider import (
    BrevoApiProvider, DailyCapReached, OutgoingEmail, PermanentSendError, SmtpProvider, TransientSendError,
)
from vulnmart.notifications.service import (
    BACKOFF, DbOutboxPort, EmailOutboxService, Rendered, UnknownTemplate, start_of_next_day,
)
from vulnmart.notifications.worker import RelayLoop, broker_url, make_delivery_actor
from vulnmart.ports.fakes import FakeOutboxPort, FakeSettingsPort
from vulnmart.ports.outbox import OutboxPort

T0 = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)


class Clock:
    def __init__(self, start: datetime = T0):
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kw) -> None:
        self.now += timedelta(**kw)


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[EmailOutbox.__table__])
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def clock():
    return Clock()


def make_service(sessions, clock, provider=None, *, cap=300, users=None, **kw):
    settings = FakeSettingsPort({"email_daily_cap": cap})
    return EmailOutboxService(
        sessions, provider or FakeEmailProvider(), StaticRecipients(users or {"u1": "ada@example.invalid"}), RegistryRenderer(), settings,
        now=clock, **kw)


def enqueue(sessions, clock, n=1, user="u1", template="system.test"):
    ids = []
    with sessions.begin() as session:
        port = DbOutboxPort(lambda: session, FakeOutboxPort(), now=clock)
        for _ in range(n):
            ids.append(port.enqueue_email(template=template, to_user_id=user, params={"k": "v"}).id)
    return ids


def row(sessions, outbox_id) -> EmailOutbox:
    with sessions() as session:
        return session.get(EmailOutbox, outbox_id)


# ---- the outbox port -------------------------------------------------------------------------------------------------

def test_db_outbox_satisfies_the_port(sessions, clock):
    with sessions() as session:
        assert isinstance(DbOutboxPort(lambda: session, FakeOutboxPort()), OutboxPort)


def test_email_is_written_in_the_callers_transaction_and_rolls_back_with_it(sessions, clock):
    with pytest.raises(RuntimeError):
        with sessions.begin() as session:
            DbOutboxPort(lambda: session, FakeOutboxPort(), now=clock).enqueue_email(template="system.test", to_user_id="u1")
            raise RuntimeError("the cause failed")
    with sessions() as session:
        assert session.scalars(select(EmailOutbox)).all() == []
    (outbox_id,) = enqueue(sessions, clock)
    stored = row(sessions, outbox_id)
    assert (stored.state, stored.attempts, stored.template, stored.to_user_id, stored.params) == ("pending", 0, "system.test", "u1", {"k": "v"})


@pytest.mark.parametrize("kwargs", [
    {"template": "", "to_user_id": "u1"},
    {"template": "t", "to_user_id": ""},
    {"template": "t", "to_user_id": "u1", "params": {"to": "ada@example.invalid"}},
    {"template": "t", "to_user_id": "u1", "params": {"blob": object()}},
    {"template": "t", "to_user_id": "u1", "params": {"big": "x" * 9000}},
    {"template": "t" * 65, "to_user_id": "u1"},
    {"template": "t", "to_user_id": "u1", "params": {"nested": {"deep": ["ada@example.invalid"]}}},
])
def test_bad_arguments_are_refused_and_nothing_is_stored(sessions, clock, kwargs):
    with sessions.begin() as session:
        with pytest.raises(ValueError):
            DbOutboxPort(lambda: session, FakeOutboxPort(), now=clock).enqueue_email(**kwargs)
    with sessions() as session:
        assert session.scalars(select(EmailOutbox)).all() == []


def test_events_still_go_to_the_event_sink(sessions):
    events = FakeOutboxPort()
    with sessions() as session:
        port = DbOutboxPort(lambda: session, events)
        event = {"schema_version": 1, "type": "attempt.flag_captured", "occurred_at": "2026-10-17T10:00:00Z",
                 "data": {"attempt_id": "a1", "mode": "learner", "challenge_key": "c1"}}
        assert port.publish(event).audiences == ("user",)
    assert len(events.events) == 1


# ---- delivery --------------------------------------------------------------------------------------------------------

def test_an_email_is_delivered_once(sessions, clock):
    provider = FakeEmailProvider()
    service = make_service(sessions, clock, provider)
    (outbox_id,) = enqueue(sessions, clock)
    assert service.claim_due() == [outbox_id]
    assert service.deliver(outbox_id) == "sent"
    assert service.deliver(outbox_id) == "skipped"  # the same queue message arriving twice
    assert [m.to for m in provider.sent] == ["ada@example.invalid"]
    stored = row(sessions, outbox_id)
    assert (stored.state, stored.attempts, stored.sent_at is not None, stored.provider_message_id) == ("sent", 1, True, "<fake-1@vulnmart.invalid>")
    assert service.claim_due() == []


def test_a_claimed_row_is_not_claimed_again_until_its_lease_ends(sessions, clock):
    service = make_service(sessions, clock)
    (outbox_id,) = enqueue(sessions, clock)
    assert service.claim_due() == [outbox_id]
    assert service.claim_due() == []
    clock.advance(minutes=6)  # the worker died: the lease ran out
    assert service.claim_due() == [outbox_id]


def test_a_failed_send_is_retried_with_backoff_and_then_succeeds(sessions, clock):
    provider = FakeEmailProvider([TransientSendError("network"), TransientSendError("provider-busy")])
    service = make_service(sessions, clock, provider)
    (outbox_id,) = enqueue(sessions, clock)
    expected_wait = [BACKOFF[0], BACKOFF[1]]
    for wait in expected_wait:
        assert service.claim_due() == [outbox_id]
        assert service.deliver(outbox_id) == "retry"
        stored = row(sessions, outbox_id)
        assert stored.state == "pending" and stored.last_error_code
        assert service.claim_due() == []  # not due yet
        clock.advance(seconds=wait.total_seconds() - 1)
        assert service.claim_due() == []
        clock.advance(seconds=1)
    assert service.claim_due() == [outbox_id]
    assert service.deliver(outbox_id) == "sent"
    stored = row(sessions, outbox_id)
    assert (stored.state, stored.attempts, stored.last_error_code) == ("sent", 3, None)
    assert provider.calls == 3


def test_after_the_last_attempt_the_row_is_failed_and_visible_to_admins(sessions, clock):
    provider = FakeEmailProvider([TransientSendError("network")] * 10)
    service = make_service(sessions, clock, provider)
    (outbox_id,) = enqueue(sessions, clock)
    outcomes = []
    for _ in range(service.max_attempts):
        assert service.claim_due() == [outbox_id]
        outcomes.append(service.deliver(outbox_id))
        clock.advance(hours=7)
    assert outcomes == ["retry"] * (service.max_attempts - 1) + ["failed"]
    assert service.claim_due() == []
    (failed,) = service.failed_rows()
    assert (failed.id, failed.attempts, failed.last_error_code) == (outbox_id, service.max_attempts, "network")
    assert service.stats()["failed"] == 1
    # an admin puts it back: fresh attempts, and it goes out
    assert service.requeue(outbox_id) is True and service.requeue(outbox_id) is False
    provider._script.clear()
    assert service.claim_due() == [outbox_id]
    assert service.deliver(outbox_id) == "sent"


@pytest.mark.parametrize("error_code", ["recipient-refused", "provider-refused"])
def test_a_permanent_refusal_fails_at_once(sessions, clock, error_code):
    service = make_service(sessions, clock, FakeEmailProvider([PermanentSendError(error_code)]))
    (outbox_id,) = enqueue(sessions, clock)
    service.claim_due()
    assert service.deliver(outbox_id) == "failed"
    stored = row(sessions, outbox_id)
    assert (stored.state, stored.attempts, stored.last_error_code) == ("failed", 1, error_code)


def test_an_unknown_recipient_or_template_fails_without_calling_the_provider(sessions, clock):
    provider = FakeEmailProvider()
    service = make_service(sessions, clock, provider)
    ghost, odd = enqueue(sessions, clock, user="ghost")[0], enqueue(sessions, clock, template="nope")[0]
    service.claim_due()
    assert service.deliver(ghost) == "failed" and service.deliver(odd) == "failed"
    assert row(sessions, ghost).last_error_code == "no-recipient"
    assert row(sessions, odd).last_error_code == "bad-template"
    assert provider.calls == 0


def test_a_bug_in_a_renderer_keeps_the_mail_and_does_not_raise(sessions, clock):
    service = make_service(sessions, clock)
    service._renderer = type("Broken", (), {"render": lambda self, t, p: 1 / 0})()
    (outbox_id,) = enqueue(sessions, clock)
    service.claim_due()
    assert service.deliver(outbox_id) == "retry"
    assert row(sessions, outbox_id).last_error_code == "internal"


def test_the_error_code_never_holds_provider_text(sessions, clock):
    service = make_service(sessions, clock, FakeEmailProvider([TransientSendError("network")]))
    (outbox_id,) = enqueue(sessions, clock)
    service.claim_due()
    service.deliver(outbox_id)
    assert "@" not in (row(sessions, outbox_id).last_error_code or "")


# ---- the daily cap ---------------------------------------------------------------------------------------------------

def test_a_cap_below_the_backlog_delivers_everything_over_days_in_order(sessions, clock):
    provider = FakeEmailProvider()
    service = make_service(sessions, clock, provider, cap=2, users={f"u{i}": f"u{i}@example.invalid" for i in range(5)})
    ids = []
    for i in range(5):
        ids += enqueue(sessions, clock, user=f"u{i}")
    sent_per_day = []
    for _day in range(3):
        before = len(provider.sent)
        for _pass in range(4):  # several relay passes a day
            for outbox_id in service.claim_due():
                service.deliver(outbox_id)
        sent_per_day.append(len(provider.sent) - before)
        clock.now = start_of_next_day(clock.now)
    assert sent_per_day == [2, 2, 1]
    assert [m.to for m in provider.sent] == [f"u{i}@example.invalid" for i in range(5)]
    # the loop ended on the morning of day 4, so nothing was sent "today" yet
    assert service.stats() == {"pending": 0, "sent": 5, "failed": 0, "oldest_pending_age_seconds": None, "sent_today": 0}


def test_rows_leased_by_another_worker_count_against_the_cap(sessions, clock):
    first = make_service(sessions, clock, cap=3)
    second = make_service(sessions, clock, cap=3)
    enqueue(sessions, clock, n=10)
    took_first, took_second = first.claim_due(), second.claim_due()
    assert len(took_first) == 3 and took_second == [], "the second worker finds the cap already spoken for"


def test_a_cap_of_zero_means_no_cap(sessions, clock):
    service = make_service(sessions, clock, cap=0)
    enqueue(sessions, clock, n=60)
    assert len(service.claim_due()) == 50  # one batch


def test_a_provider_that_reports_its_cap_defers_to_tomorrow_without_using_an_attempt(sessions, clock):
    provider = FakeEmailProvider([DailyCapReached("provider-cap")])
    service = make_service(sessions, clock, provider)
    (outbox_id,) = enqueue(sessions, clock)
    service.claim_due()
    assert service.deliver(outbox_id) == "deferred"
    stored = row(sessions, outbox_id)
    assert (stored.state, stored.attempts, stored.last_error_code) == ("pending", 0, "provider-cap")
    assert service.claim_due() == []
    clock.now = start_of_next_day(clock.now)
    assert service.claim_due() == [outbox_id]
    assert service.deliver(outbox_id) == "sent"


def test_stats_report_the_age_of_the_oldest_pending_row(sessions, clock):
    service = make_service(sessions, clock)
    enqueue(sessions, clock)
    assert service.stats()["pending"] == 1


# ---- provider adapters -----------------------------------------------------------------------------------------------

MAIL = OutgoingEmail(to="ada@example.invalid", subject="Hello", text="Body <b>", html=None, sender_address="sender@vulnmart.example",
                     sender_name="VulnMart")


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(status, body):
    return urllib.error.HTTPError("https://api.brevo.test", status, "x", {}, io.BytesIO(json.dumps(body).encode()))


def test_brevo_sends_the_documented_request_and_returns_the_message_id():
    seen = {}

    def opener(request, timeout):
        seen.update(url=request.full_url, method=request.get_method(), headers={k.lower(): v for k, v in request.header_items()},
                    body=json.loads(request.data), timeout=timeout)
        return Response(json.dumps({"messageId": "<abc@relay>"}).encode())

    assert BrevoApiProvider("k-test", opener=opener).send(MAIL) == "<abc@relay>"
    assert seen["url"] == "https://api.brevo.com/v3/smtp/email" and seen["method"] == "POST"
    assert seen["headers"]["api-key"] == "k-test" and seen["headers"]["content-type"] == "application/json"
    assert seen["body"]["sender"] == {"email": "sender@vulnmart.example", "name": "VulnMart"}
    assert seen["body"]["to"] == [{"email": "ada@example.invalid"}] and seen["body"]["subject"] == "Hello"
    assert seen["body"]["textContent"] == "Body <b>" and seen["body"]["htmlContent"] == "<pre>Body &lt;b&gt;</pre>"


@pytest.mark.parametrize("status,body,kind,code", [
    (400, {"code": "not_enough_credits", "message": "x"}, DailyCapReached, "provider-cap"),
    (400, {"code": "invalid_parameter"}, PermanentSendError, "provider-refused"),
    (401, {"code": "unauthorized"}, TransientSendError, "provider-auth"),
    (429, {}, TransientSendError, "provider-busy"),
    (503, {}, TransientSendError, "provider-busy"),
])
def test_brevo_errors_are_classified(status, body, kind, code):
    def opener(request, timeout):
        raise http_error(status, body)

    with pytest.raises(kind) as caught:
        BrevoApiProvider("k", opener=opener).send(MAIL)
    assert caught.value.code == code


def test_brevo_network_failures_and_empty_answers_are_transient():
    def down(request, timeout):
        raise urllib.error.URLError("no route")

    with pytest.raises(TransientSendError):
        BrevoApiProvider("k", opener=down).send(MAIL)
    with pytest.raises(TransientSendError):
        BrevoApiProvider("k", opener=lambda r, timeout: Response(b"{}")).send(MAIL)
    with pytest.raises(ValueError):
        BrevoApiProvider("")


def test_smtp_provider_builds_a_message(monkeypatch):
    sent = []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            self.target = (host, port)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def send_message(self, message):
            sent.append((self.target, message))

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    message_id = SmtpProvider("mailpit", 1025).send(replace(MAIL, html="<p>hi</p>"))
    ((target, message),) = sent
    assert target == ("mailpit", 1025) and message["To"] == "ada@example.invalid" and message["Message-ID"] == message_id
    assert "sender@vulnmart.example" in message["From"] and message.get_body(("html",)) is not None


def test_smtp_provider_maps_failures(monkeypatch):
    def refuse(self, host, port, timeout):
        raise ConnectionRefusedError

    class Refusing:
        def __init__(self, host, port, timeout):
            raise ConnectionRefusedError

    monkeypatch.setattr(smtplib, "SMTP", Refusing)
    with pytest.raises(TransientSendError):
        SmtpProvider("nowhere").send(MAIL)


# ---- Dramatiq --------------------------------------------------------------------------------------------------------

def test_valkey_urls_become_redis_urls():
    assert broker_url("valkey://valkey:6379/0") == "redis://valkey:6379/0"
    assert broker_url("valkeys://h:1/2") == "rediss://h:1/2"
    assert broker_url("redis://h") == "redis://h"


def test_the_relay_hands_claimed_rows_to_a_dramatiq_worker_which_delivers_them(sessions, clock):
    provider = FakeEmailProvider()
    service = make_service(sessions, clock, provider)
    broker = StubBroker()
    broker.emit_after("process_boot")
    dramatiq.set_broker(broker)
    actor = make_delivery_actor(broker, service)
    ids = enqueue(sessions, clock, n=3)
    relay = RelayLoop(service, actor)
    worker = Worker(broker, worker_timeout=100)
    worker.start()
    try:
        assert relay.relay_once() == 3
        broker.join(actor.queue_name, timeout=10_000)
        worker.join()
    finally:
        worker.stop()
    assert [row(sessions, i).state for i in ids] == ["sent"] * 3
    assert len(provider.sent) == 3
    assert actor.options["max_retries"] == 0  # retries live in the outbox row (ADR 0040)


def test_a_relay_pass_that_fails_does_not_end_the_loop(sessions, clock):
    calls = []
    ready = threading.Event()

    class Service:
        def claim_due(self):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("database down")
            ready.set()
            return []

    relay = RelayLoop(Service(), None, interval=0.01)  # type: ignore[arg-type]
    relay.start()
    assert ready.wait(5)
    relay.stop()
    assert len(calls) >= 2


def test_every_template_name_is_registered_or_unknown():
    renderer = RegistryRenderer()
    assert renderer.render("system.test", {}).subject
    with pytest.raises(UnknownTemplate):
        renderer.render("missing", {})
    renderer.register("x", lambda p: Rendered("S", p["a"]))
    assert renderer.render("x", {"a": "b"}).text == "b"
