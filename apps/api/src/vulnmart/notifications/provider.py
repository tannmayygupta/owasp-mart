"""The email provider adapter (FR-NTF-03): one small interface, an SMTP adapter (Mailpit in development) and the Brevo API adapter.

OI-32 answer of the developer (2026-10-17): Brevo with a verified single sender, so no sender domain is needed. Nothing else in the
platform knows which provider runs: the service only calls `EmailProvider.send` and reacts to the three error kinds.
Errors carry a fixed `code`, never the provider's text (it can contain the address).
"""
from __future__ import annotations

import json
import smtplib
import socket
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any, Protocol, runtime_checkable

BREVO_URL = "https://api.brevo.com/v3/smtp/email"


@dataclass(frozen=True, slots=True)
class OutgoingEmail:
    to: str
    subject: str
    text: str
    html: str | None = None
    sender_address: str = "no-reply@vulnmart.invalid"
    sender_name: str = "VulnMart"


class SendError(Exception):
    """A send that did not happen. `code` is a short fixed label stored on the outbox row."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class TransientSendError(SendError):
    """Worth trying again later (network, timeout, provider 5xx, rate limit, a key that is wrong for now)."""


class PermanentSendError(SendError):
    """Trying again cannot help (the provider refused this message)."""


class DailyCapReached(SendError):
    """The provider's daily allowance is used up: wait for the next day; the attempt is not counted."""


@runtime_checkable
class EmailProvider(Protocol):
    def send(self, mail: OutgoingEmail) -> str:
        """Hand one email to the provider and return its message id. Raises a SendError."""
        ...


class SmtpProvider:
    """Plain SMTP (stdlib). Development points it at Mailpit; Brevo's SMTP relay would also work with `starttls` and a login."""

    def __init__(self, host: str, port: int = 1025, *, starttls: bool = False, username: str | None = None,
                 password: str | None = None, timeout: float = 10.0):
        self._host, self._port, self._starttls = host, port, starttls
        self._username, self._password, self._timeout = username, password, timeout

    def send(self, mail: OutgoingEmail) -> str:
        message = EmailMessage()
        message["From"] = formataddr((mail.sender_name, mail.sender_address))
        message["To"] = mail.to
        message["Subject"] = mail.subject
        message_id = make_msgid(domain="vulnmart.invalid")
        message["Message-ID"] = message_id
        message.set_content(mail.text)
        if mail.html:
            message.add_alternative(mail.html, subtype="html")
        try:
            with smtplib.SMTP(self._host, self._port, timeout=self._timeout) as smtp:
                if self._starttls:
                    smtp.starttls()
                if self._username:
                    smtp.login(self._username, self._password or "")
                smtp.send_message(message)
        except smtplib.SMTPRecipientsRefused as exc:
            raise PermanentSendError("recipient-refused") from exc
        except smtplib.SMTPResponseException as exc:
            raise (PermanentSendError if 500 <= exc.smtp_code < 600 and exc.smtp_code != 535 else TransientSendError)("smtp-error") from exc
        except (smtplib.SMTPException, OSError, socket.timeout) as exc:
            raise TransientSendError("network") from exc
        return message_id


Opener = Callable[..., Any]


class BrevoApiProvider:
    """Brevo's transactional API (POST /v3/smtp/email, `api-key` header; documented at developers.brevo.com).

    201 is a send. Brevo's free plan allows 300 sends a day (help.brevo.com, whether transactional mail counts is unconfirmed),
    and the 400 codes `not_enough_credits` / `Insufficient credits` mean the allowance is gone: that is `DailyCapReached`.
    """

    def __init__(self, api_key: str, *, url: str = BREVO_URL, timeout: float = 10.0, opener: Opener | None = None):
        if not api_key:
            raise ValueError("a Brevo API key is required")
        self._api_key, self._url, self._timeout = api_key, url, timeout
        self._open = opener or urllib.request.urlopen

    def send(self, mail: OutgoingEmail) -> str:
        body: dict[str, Any] = {
            "sender": {"email": mail.sender_address, "name": mail.sender_name},
            "to": [{"email": mail.to}],
            "subject": mail.subject,
            "textContent": mail.text,
        }
        if mail.html:
            body["htmlContent"] = mail.html
        else:
            body["htmlContent"] = "<pre>" + _escape(mail.text) + "</pre>"
        request = urllib.request.Request(
            self._url, data=json.dumps(body).encode(), method="POST",
            headers={"api-key": self._api_key, "content-type": "application/json", "accept": "application/json"},
        )
        try:
            with self._open(request, timeout=self._timeout) as response:
                payload = json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as exc:
            raise _classify(exc.code, _read_json(exc)) from exc
        except (urllib.error.URLError, OSError, socket.timeout, ValueError) as exc:
            raise TransientSendError("network") from exc
        message_id = payload.get("messageId") or (payload.get("messageIds") or [None])[0]
        if not message_id:
            raise TransientSendError("bad-response")
        return str(message_id)


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _read_json(exc: urllib.error.HTTPError) -> dict[str, Any]:
    try:
        data = json.loads(exc.read() or b"{}")
    except (ValueError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _classify(status: int, body: dict[str, Any]) -> SendError:
    code = str(body.get("code", ""))
    if status == 400 and code in ("not_enough_credits", "Insufficient credits"):
        return DailyCapReached("provider-cap")
    if status in (401, 403):
        return TransientSendError("provider-auth")  # the key is the operator's to fix; the mail is kept and retried
    if status == 429 or status >= 500:
        return TransientSendError("provider-busy")
    return PermanentSendError("provider-refused")
