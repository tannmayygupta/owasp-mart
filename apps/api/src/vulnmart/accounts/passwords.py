"""Password quality (FR-ACC-08): the rules a new password must pass, in one place for signup, reset and change.

The rules follow NIST SP 800-63B and OWASP ASVS 5.0 (no composition rules, any character allowed, a generous maximum, a check against
passwords that attackers already have):
1. Length 12 to 128 characters (the contract's `Password`; the minimum is a proposal the requirements leave to be tuned).
2. Not trivial: at least 4 different characters (so `xxxxxxxxxxxx` and `abababababab` are out).
3. Not made of the person's own details: it must not contain their email address, the part before the `@` (4 characters or more) or
   their display name (4 characters or more).
4. Not on the bundled list of the 10,000 most common passwords (`data/common-passwords-10k.txt`, case-insensitive).
5. Optionally not in a breach corpus: the Pwned Passwords range API, which receives only the first 5 characters of the SHA-1 of the
   password (k-anonymity) and never the password. Off by default (a third party would see a hash prefix); `VULNMART_BREACH_CHECK=hibp`
   turns it on. If that service does not answer, the password is accepted on rules 1 to 4 and a warning is logged: refusing every new
   password during somebody else's outage would be worse.

A refusal is an `InvalidInput` with a `kind` that the problem answer turns into a fixed, helpful sentence; the password itself is never
in an error, a log or a message.
"""
from __future__ import annotations

import hashlib
import logging
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from functools import lru_cache
from importlib import resources
from typing import Any, Protocol, runtime_checkable

from vulnmart.kernel.settings import Settings

logger = logging.getLogger("vulnmart.accounts")

MIN_LENGTH, MAX_LENGTH = 12, 128
RANGE_URL = "https://api.pwnedpasswords.com/range/"


class InvalidPassword(ValueError):
    """A password that does not pass. `kind` is one of password_length, password_common, password_breached, password_identity."""

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


class BreachCheckUnavailable(RuntimeError):
    """The breach service did not answer in time or answered nonsense."""


@runtime_checkable
class BreachCheck(Protocol):
    def is_breached(self, password: str) -> bool:
        """True when the password is known to a breach corpus. Raises BreachCheckUnavailable when it cannot tell."""
        ...


@lru_cache(maxsize=1)
def _common_passwords() -> frozenset[str]:
    text = resources.files("vulnmart.accounts").joinpath("data/common-passwords-10k.txt").read_text(encoding="utf-8")
    return frozenset(line.strip().lower() for line in text.splitlines() if line.strip())


class CommonPasswordList:
    """The bundled list of the most common passwords (data/README.md says where it came from)."""

    def is_breached(self, password: str) -> bool:
        return password.lower() in _common_passwords()

    def __len__(self) -> int:
        return len(_common_passwords())


Opener = Callable[..., Any]


class PwnedPasswordsRange:
    """Have I Been Pwned, Pwned Passwords, range API: the password is hashed with SHA-1, only the first 5 hex characters are sent, and the
    answer (every suffix with that prefix and a count) is searched here. `Add-Padding` makes every answer about the same size."""

    def __init__(self, *, url: str = RANGE_URL, timeout: float = 3.0, opener: Opener | None = None):
        self._url, self._timeout = url, timeout
        self._open = opener or urllib.request.urlopen

    def is_breached(self, password: str) -> bool:
        digest = hashlib.sha1(password.encode("utf-8"), usedforsecurity=False).hexdigest().upper()  # SHA-1 is the service's format, not our security
        prefix, suffix = digest[:5], digest[5:]
        request = urllib.request.Request(self._url + prefix, headers={"Add-Padding": "true", "User-Agent": "vulnmart-password-check"})
        try:
            with self._open(request, timeout=self._timeout) as response:
                body = response.read().decode("ascii", errors="replace")
        except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
            raise BreachCheckUnavailable(type(exc).__name__) from exc
        for line in body.splitlines():
            found, _, count = line.strip().partition(":")
            if found.upper() == suffix:
                return count.strip().isdigit() and int(count) > 0  # padding lines carry a count of 0
        return False


_SEPARATORS = re.compile(r"[\s._\-]+")  # spaces, dots, underscores and hyphens do not hide a name: "ada.lovelace" is "ada lovelace"


class PasswordPolicy:
    def __init__(self, common: BreachCheck | None = None, remote: BreachCheck | None = None):
        self._common, self._remote = common, remote

    def check(self, password: str, *, email: str | None = None, display_name: str | None = None,
              min_length: int = MIN_LENGTH) -> None:
        """Raise InvalidPassword unless the password passes every rule (see the module text)."""
        if not min_length <= len(password) <= MAX_LENGTH:
            raise InvalidPassword("password_length")
        if len(set(password)) < 4:
            raise InvalidPassword("password_common")
        squashed = _SEPARATORS.sub("", password.lower())
        for detail in self._details(email, display_name):
            if detail in squashed:
                raise InvalidPassword("password_identity")
        if self._common is not None and self._common.is_breached(password):
            raise InvalidPassword("password_common")
        if self._remote is not None:
            try:
                if self._remote.is_breached(password):
                    raise InvalidPassword("password_breached")
            except BreachCheckUnavailable as exc:
                logger.warning("the breach service did not answer (%s): the password was checked against the bundled list only", exc)

    @staticmethod
    def _details(email: str | None, display_name: str | None) -> list[str]:
        """What a password must not contain, in the squashed form of `_SEPARATORS`: the address, its part before the `@` and the name."""
        found: list[str] = []
        if email:
            email = email.lower()
            found.append(_SEPARATORS.sub("", email))
            local = _SEPARATORS.sub("", email.partition("@")[0])
            if len(local) >= 4:
                found.append(local)
        if display_name:
            name = _SEPARATORS.sub("", display_name.lower())
            if len(name) >= 4:
                found.append(name)
        return found


def make_policy(settings: Settings) -> PasswordPolicy:
    """The policy of this process. `local` (default): rules 1 to 4. `hibp`: plus the range API. `off`: length and triviality only; the
    service refuses to start in staging or production with it (an unchecked password store is not a deployment)."""
    mode = settings.breach_check
    if mode == "off":
        if settings.env in ("staging", "production"):
            raise RuntimeError(f"VULNMART_ENV={settings.env} does not run with VULNMART_BREACH_CHECK=off")
        return PasswordPolicy()
    return PasswordPolicy(CommonPasswordList(), PwnedPasswordsRange() if mode == "hibp" else None)
