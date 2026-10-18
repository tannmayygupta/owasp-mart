"""Story P-20: the address of a person with no account (an invited candidate) travels in the outbox row sealed with the field key, bound to the invite id, and is
cleared when the mail has left. Everything else about the outbox (the user-id lookup, retries, the cap) is in test_notifications.py."""
from __future__ import annotations

import logging

import pytest
from sqlalchemy import select

from test_notifications import Clock, clock, enqueue, make_service, row, sessions  # noqa: F401
from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.notifications.fakes import FakeEmailProvider, RegistryRenderer, StaticRecipients
from vulnmart.notifications.models import EmailOutbox
from vulnmart.notifications.provider import TransientSendError
from vulnmart.notifications.service import DbOutboxPort, EmailOutboxService
from vulnmart.ports.fakes import FakeOutboxPort, FakeSettingsPort

KEYS = FieldKeys.from_secret(b"a field key secret of at least 32 bytes!!")
ADDRESS = "candidate@example.org"
INVITE = "i-AAAAAAAAAAAAAAAA"


def seal(address: str, aad: str) -> str:
    return KEYS.seal(address, account=aad)


def open_(sealed: str, aad: str) -> str:
    return KEYS.open(sealed, account=aad)


def enqueue_sealed(sessions, clock, *, to=INVITE, address=ADDRESS, sealer=seal, params=None):
    with sessions.begin() as session:
        port = DbOutboxPort(lambda: session, FakeOutboxPort(), now=clock, address_sealer=sealer)
        return port.enqueue_email(template="system.test", to_user_id=to, params=params or {"k": "v"}, to_address=address).id


def service(sessions, clock, provider, **kw):
    return EmailOutboxService(sessions, provider, StaticRecipients({}), RegistryRenderer(), FakeSettingsPort(), now=clock, **kw)


def test_the_address_is_sealed_in_the_row_and_never_in_the_params(sessions, clock):
    outbox_id = enqueue_sealed(sessions, clock)
    stored = row(sessions, outbox_id)
    assert stored.to_user_id == INVITE and stored.to_address_sealed and stored.to_address_sealed.startswith("v1.")
    assert "@" not in stored.to_address_sealed and "candidate" not in stored.to_address_sealed and "@" not in str(stored.params)
    assert KEYS.open(stored.to_address_sealed, account=INVITE) == ADDRESS
    with pytest.raises(Exception):
        KEYS.open(stored.to_address_sealed, account="i-BBBBBBBBBBBBBBBB")  # bound to its invite: another row's key does not open it


@pytest.mark.parametrize("address", ["", "no-at-sign", "x" * 260 + "@example.org"])
def test_a_bad_address_is_refused_and_nothing_is_stored(sessions, clock, address):
    with pytest.raises(ValueError):
        enqueue_sealed(sessions, clock, address=address)
    with sessions() as s:
        assert s.scalars(select(EmailOutbox)).all() == []


def test_an_outbox_without_a_sealer_refuses_an_address(sessions, clock):
    with pytest.raises(ValueError, match="seal"):
        enqueue_sealed(sessions, clock, sealer=None)


def test_an_address_in_params_is_still_refused(sessions, clock):
    with pytest.raises(ValueError, match="never goes into params"):
        enqueue_sealed(sessions, clock, params={"to": ADDRESS})


def test_a_row_with_a_sealed_address_is_sent_to_it_and_the_address_is_cleared_afterwards(sessions, clock):
    provider = FakeEmailProvider()
    outbox_id = enqueue_sealed(sessions, clock)
    assert service(sessions, clock, provider, address_opener=open_).deliver(outbox_id) == "sent"
    assert [m.to for m in provider.sent] == [ADDRESS]
    stored = row(sessions, outbox_id)
    assert (stored.state, stored.to_address_sealed) == ("sent", None), "the address of a person with no account is not kept once the mail left"


def test_a_retry_keeps_the_sealed_address_until_the_mail_has_left(sessions, clock):
    class Flaky(FakeEmailProvider):
        calls = 0

        def send(self, message):
            Flaky.calls += 1
            if Flaky.calls == 1:
                raise TransientSendError("provider-down")
            return super().send(message)

    provider = Flaky()
    outbox_id = enqueue_sealed(sessions, clock)
    svc = service(sessions, clock, provider, address_opener=open_)
    assert svc.deliver(outbox_id) == "retry"
    assert row(sessions, outbox_id).to_address_sealed is not None
    clock.advance(hours=1)
    assert svc.deliver(outbox_id) == "sent" and row(sessions, outbox_id).to_address_sealed is None and [m.to for m in provider.sent] == [ADDRESS]


def test_without_a_way_to_open_it_the_row_fails_as_no_recipient_and_goes_nowhere(sessions, clock):
    provider = FakeEmailProvider()
    outbox_id = enqueue_sealed(sessions, clock)
    assert service(sessions, clock, provider).deliver(outbox_id) == "failed"
    stored = row(sessions, outbox_id)
    assert (stored.state, stored.last_error_code) == ("failed", "no-recipient") and provider.sent == []


def test_a_wrong_key_fails_the_row_and_logs_nothing_about_the_address(sessions, clock, caplog):
    other = FieldKeys.from_secret(b"another field key secret of 32 bytes!!!")
    provider = FakeEmailProvider()
    outbox_id = enqueue_sealed(sessions, clock)
    with caplog.at_level(logging.DEBUG):
        outcome = service(sessions, clock, provider, address_opener=lambda sealed, aad: other.open(sealed, account=aad)).deliver(outbox_id)
    assert outcome == "failed" and row(sessions, outbox_id).last_error_code == "no-recipient" and provider.sent == []
    assert "example.org" not in caplog.text and "candidate" not in caplog.text and INVITE in caplog.text


def test_a_row_without_a_sealed_address_still_uses_the_user_lookup(sessions, clock):
    provider = FakeEmailProvider()
    (outbox_id,) = enqueue(sessions, clock)
    svc = service(sessions, clock, provider, address_opener=open_)
    svc._recipients = StaticRecipients({"u1": "ada@example.invalid"})
    assert svc.deliver(outbox_id) == "sent" and [m.to for m in provider.sent] == ["ada@example.invalid"]


def test_the_sealed_address_is_not_in_the_failed_rows_the_admin_sees(sessions, clock):
    outbox_id = enqueue_sealed(sessions, clock)
    svc = service(sessions, clock, FakeEmailProvider())
    svc.deliver(outbox_id)
    [failed] = svc.failed_rows()
    assert not hasattr(failed, "to_address_sealed") and "@" not in str(failed)
