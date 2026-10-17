"""In-memory stand-ins for the parts of the email path other stories own: the provider, the address lookup, the renderer.

`RegistryRenderer` is the seam of story P-10: it ships one built-in template (`system.test`) and P-10 registers the real ones.
`StaticRecipients` stands in for the account lookup of story P-11. Used by tests and by a development process with no accounts yet.
"""
from __future__ import annotations

import threading
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from .provider import OutgoingEmail, SendError
from .service import Rendered, UnknownTemplate


class FakeEmailProvider:
    """Records what it was asked to send. `script` is a list consumed one entry per call: None sends, an exception raises it."""

    def __init__(self, script: Iterable[Exception | None] = ()):
        self.sent: list[OutgoingEmail] = []
        self.calls = 0
        self._script = list(script)
        self._lock = threading.Lock()

    def send(self, mail: OutgoingEmail) -> str:
        with self._lock:
            self.calls += 1
            outcome = self._script.pop(0) if self._script else None
            if isinstance(outcome, Exception):
                raise outcome
            self.sent.append(mail)
            return f"<fake-{len(self.sent)}@vulnmart.invalid>"


class StaticRecipients:
    def __init__(self, addresses: Mapping[str, str]):
        self._addresses = dict(addresses)

    def address_for(self, user_id: str) -> str | None:
        return self._addresses.get(user_id)


class FallbackRecipients:
    """The first lookup that knows the user id wins. In development the real lookup comes first and `DevRecipients` catches the ids
    of hand-made outbox rows (the stack test writes rows for users that do not exist)."""

    def __init__(self, *lookups):
        self._lookups = lookups

    def address_for(self, user_id: str) -> str | None:
        for lookup in self._lookups:
            address = lookup.address_for(user_id)
            if address:
                return address
        return None


class DevRecipients:
    """Development and test only (the worker refuses it in staging and production): every user id has the address
    `<user id>@users.vulnmart.invalid`, which Mailpit catches. Story P-11 replaces it with the account lookup."""

    def address_for(self, user_id: str) -> str | None:
        return f"{user_id}@users.vulnmart.invalid" if user_id else None


Template = Callable[[Mapping[str, Any]], Rendered]


class RegistryRenderer:
    def __init__(self) -> None:
        self._templates: dict[str, Template] = {"system.test": lambda p: Rendered("VulnMart test message", "This is a test message from VulnMart.")}

    def register(self, name: str, template: Template) -> None:
        self._templates[name] = template

    def render(self, template: str, params: Mapping[str, Any]) -> Rendered:
        try:
            return self._templates[template](params)
        except KeyError as exc:
            if template in self._templates:
                raise  # a template that failed on its own parameters is a bug, not an unknown name
            raise UnknownTemplate(template) from exc


__all__ = ["DevRecipients", "FakeEmailProvider", "FallbackRecipients", "RegistryRenderer", "SendError", "StaticRecipients"]
