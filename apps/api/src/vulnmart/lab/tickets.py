"""The one-time ticket that opens an instance in a new tab (contracts/edge/gate-ticket.md section 2). Stream L.

`ticket = b64u(payload) "." b64u(HMAC-SHA256(key, "vm-ticket-v1\\n" + b64u(payload)))`, the payload a JSON object with exactly `v`, `inst`,
`own`, `ae`, `exp` and `jti`. The platform signs, the edge gate verifies (`apps/edge/src/tickets.mjs`); both read the same key file
(`VULNMART_GATE_KEY_FILE` here, `gate_key` there). A ticket lives at most 60 seconds and is single use at the gate.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

TICKET_PREFIX = b"vm-ticket-v1"
TICKET_SECONDS = 60
MIN_KEY_BYTES = 32
KEY_FILE_VAR = "VULNMART_GATE_KEY_FILE"
ZONE_VAR = "VULNMART_LABS_ZONE"


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def read_gate_key(path: str) -> bytes:
    """The gate key from a file: 32 bytes or more, and on POSIX not readable by group or others. The message never holds the key."""
    st = os.stat(path)
    if os.name != "nt" and st.st_mode & 0o077:
        raise ValueError(f"{KEY_FILE_VAR} file {path} has mode {st.st_mode & 0o777:03o}: it must be 0600 or stricter (chmod 600)")
    key = Path(path).read_bytes().strip()
    if len(key) < MIN_KEY_BYTES:
        raise ValueError(f"the gate key must be at least {MIN_KEY_BYTES} bytes")
    return key


@dataclass(frozen=True, slots=True)
class OpenTicket:
    url: str
    expires_at: datetime


class TicketMinter:
    def __init__(self, key: bytes, zone: str, *, clock: Callable[[], float] = time.time) -> None:
        if len(key) < MIN_KEY_BYTES:
            raise ValueError(f"the gate key must be at least {MIN_KEY_BYTES} bytes")
        if zone != zone.lower() or "." not in zone or ":" in zone or zone.endswith("."):
            raise ValueError("the labs zone is lower case with at least two labels, no port and no trailing dot")
        self._key, self.zone, self._clock = key, zone, clock

    def mint(self, instance_id: str, owner_hash: str, access_epoch: int) -> OpenTicket:
        exp = int(self._clock()) + TICKET_SECONDS
        payload = _b64u(json.dumps({"v": 1, "inst": instance_id, "own": owner_hash, "ae": access_epoch, "exp": exp,
                                    "jti": _b64u(secrets.token_bytes(16))}, separators=(",", ":")).encode("utf-8"))
        mac = hmac.new(self._key, TICKET_PREFIX + b"\n" + payload.encode("ascii"), hashlib.sha256).digest()
        url = f"https://{instance_id.lower()}.{self.zone}/_vm/enter?t={payload}.{_b64u(mac)}"
        return OpenTicket(url, datetime.fromtimestamp(exp, tz=UTC))


def minter_from_environ(environ: dict[str, str] | os._Environ) -> TicketMinter | None:
    """A minter when `VULNMART_GATE_KEY_FILE` and `VULNMART_LABS_ZONE` are set; None otherwise (the open route then answers an error)."""
    path, zone = environ.get(KEY_FILE_VAR), environ.get(ZONE_VAR)
    if not (path and zone):
        return None
    return TicketMinter(read_gate_key(path), zone)


__all__ = ["OpenTicket", "TicketMinter", "minter_from_environ", "read_gate_key"]
