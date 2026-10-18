"""Signature and identity checks of the instance-event receiver (IF-4, contracts/events/app-events.md section 4).

`X-VM-Signature: v1=<64 lowercase hex>` is HMAC-SHA256 over `instance_id \\n epoch \\n seq \\n hex(SHA-256(raw body))`; the key is
the event key of `(instance_id, epoch)` (a text, used as its UTF-8 bytes like the Node fake does). The raw bytes are what is
signed, never a re-serialisation. Pure functions: nothing here logs or keeps a key or a signature.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Mapping
from typing import Any

SIGNATURE_HEADER = "x-vm-signature"
INSTANCE_ID = re.compile(r"i-[A-Z2-7]{16}")
_SIGNATURE = re.compile(r"v1=[0-9a-f]{64}")
MAX_SAFE_INTEGER = 2**53 - 1
# Used for an unknown instance so that both branches do the same HMAC work (no timing difference). Not a real key.
DUMMY_KEY = "FAKE-DUMMY-KEY-FOR-UNKNOWN-INSTANCES-0000"


def body_digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def signing_string(instance_id: str, epoch: int, seq: int, raw: bytes) -> str:
    return f"{instance_id}\n{epoch}\n{seq}\n{body_digest(raw)}"


def sign_body(key: str, instance_id: str, epoch: int, seq: int, raw: bytes) -> str:
    mac = hmac.new(key.encode("utf-8"), signing_string(instance_id, epoch, seq, raw).encode("utf-8"), hashlib.sha256)
    return "v1=" + mac.hexdigest()


def verify_signature(key: str, instance_id: str, epoch: int, seq: int, raw: bytes, header: object) -> bool:
    """Constant-time compare. A missing or malformed header is False, after the same HMAC work as a wrong signature."""
    want = sign_body(key, instance_id, epoch, seq, raw).encode("ascii")
    if not isinstance(header, str) or _SIGNATURE.fullmatch(header) is None:
        return False
    return hmac.compare_digest(want, header.encode("ascii"))


def header_value(headers: Mapping[str, str] | None, name: str) -> str | None:
    """Case-insensitive lookup in a plain mapping (a Starlette `Headers` also works)."""
    for k in (headers or {}):
        if k.lower() == name:
            return headers[k]  # type: ignore[index]
    return None


def as_count(value: Any) -> int | None:
    """What JavaScript's `Number.isSafeInteger(v) && v >= 1` accepts: an integer (or an integral float such as 1.0), at
    least 1 and at most 2**53-1. A bool or a string is not a number. None when unusable."""
    if isinstance(value, bool):
        return None
    if isinstance(value, float):
        if not value.is_integer():
            return None
        value = int(value)
    if isinstance(value, int) and 1 <= value <= MAX_SAFE_INTEGER:
        return value
    return None


def usable_identity(event: Mapping[str, Any]) -> list[tuple[str, str]]:
    """The (pointer, detail) pairs that stop the signature check: instance_id, epoch and seq must be usable first."""
    bad: list[tuple[str, str]] = []
    iid = event.get("instance_id")
    if not isinstance(iid, str) or INSTANCE_ID.fullmatch(iid) is None:
        bad.append(("/instance_id", "must be a string like i-<16 Base32 characters>"))
    if as_count(event.get("epoch")) is None:
        bad.append(("/epoch", "must be an integer of at least 1"))
    if as_count(event.get("seq")) is None:
        bad.append(("/seq", "must be an integer of at least 1"))
    return bad
