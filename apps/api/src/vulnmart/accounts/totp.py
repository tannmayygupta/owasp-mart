"""Time-based one-time passwords (RFC 6238 over RFC 4226), standard library only.

What an authenticator app does: HMAC-SHA1 of the 30-second time step under a shared secret, cut down to 6 digits. SHA-1, 6 digits and 30
seconds are the values every authenticator app supports; HMAC-SHA1 is still sound for this use (RFC 6238, RFC 4226 section 7).

`verify` accepts the code of the current step and of one step either side (a phone clock a few seconds off), and refuses a step that is
not newer than the last one used for this secret: a code works once, so an eavesdropper who sees a code cannot replay it.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
from datetime import datetime
from urllib.parse import quote

STEP_SECONDS = 30
DIGITS = 6
WINDOW = 1  # steps accepted either side of the current one
SECRET_BYTES = 20  # 160 bits, the length RFC 4226 recommends


def new_secret() -> str:
    """A new shared secret in Base32 (32 characters), the form authenticator apps take."""
    return base64.b32encode(secrets.token_bytes(SECRET_BYTES)).decode("ascii")


def time_step(at: datetime) -> int:
    return int(at.timestamp()) // STEP_SECONDS


def _hotp(secret: bytes, counter: int, digits: int) -> str:
    digest = hmac.new(secret, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** digits)).zfill(digits)


def code_for(secret_b32: str, step: int, *, digits: int = DIGITS) -> str:
    return _hotp(base64.b32decode(secret_b32, casefold=True), step, digits)


def verify(secret_b32: str, code: str, at: datetime, *, last_used_step: int | None = None) -> int | None:
    """The time step the code belongs to, or None. A step at or before `last_used_step` is refused (a code is single use). Every step of the
    window is compared, in constant time, whether or not an earlier one matched."""
    if len(code) != DIGITS or not code.isascii() or not code.isdigit():
        return None
    secret = base64.b32decode(secret_b32, casefold=True)
    now_step = time_step(at)
    found: int | None = None
    for step in range(now_step - WINDOW, now_step + WINDOW + 1):
        if hmac.compare_digest(_hotp(secret, step, DIGITS), code) and (last_used_step is None or step > last_used_step):
            found = step if found is None else max(found, step)
    return found


def otpauth_uri(email: str, secret_b32: str, issuer: str = "VulnMart") -> str:
    """The `otpauth://` address an authenticator app reads from a QR code (Google Authenticator key URI format)."""
    label = quote(f"{issuer}:{email}", safe="")
    return f"otpauth://totp/{label}?secret={secret_b32}&issuer={quote(issuer, safe='')}&algorithm=SHA1&digits={DIGITS}&period={STEP_SECONDS}"
