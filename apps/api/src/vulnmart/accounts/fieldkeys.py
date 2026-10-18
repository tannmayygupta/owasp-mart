"""The field key of the accounts module (architecture 04 and 06: `K_field`, "encrypt TOTP secrets"): what must be read back later (a TOTP secret) is
sealed with AES-256-GCM; what is only ever compared (a recovery code) is hashed with a keyed hash.

Both keys come from one secret, `VULNMART_FIELD_KEY` (or a secret file), through HKDF-SHA256 with their own labels, so the two uses never share a key.
The sealed value is `v1.` and the URL-safe Base64 of nonce, ciphertext and tag; the account id is the associated data, so a sealed secret cannot be
copied onto another account's row. When the key service (story P-17) provides `K_field`, only `FieldKeys.from_secret` has to change.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from vulnmart.ports.keys import hkdf_sha256

MIN_SECRET = 32
_SALT = b"vm-field-salt-v1"
_SEAL_LABEL = b"vm-field-seal-v1"
_RECOVERY_LABEL = b"vm-field-recovery-v1"
PREFIX = "v1."


class FieldKeyError(Exception):
    """A sealed value could not be opened (wrong key, another account's value, or damage)."""


class FieldKeys:
    def __init__(self, seal_key: bytes, recovery_key: bytes):
        self._aes = AESGCM(seal_key)
        self._recovery_key = recovery_key

    @classmethod
    def from_secret(cls, secret: bytes) -> FieldKeys:
        if len(secret) < MIN_SECRET:
            raise ValueError(f"the field key secret is at least {MIN_SECRET} bytes")
        return cls(hkdf_sha256(secret, _SALT, _SEAL_LABEL), hkdf_sha256(secret, _SALT, _RECOVERY_LABEL))

    def seal(self, plaintext: str, *, account: str) -> str:
        nonce = os.urandom(12)
        sealed = self._aes.encrypt(nonce, plaintext.encode("utf-8"), account.encode("utf-8"))
        return PREFIX + base64.urlsafe_b64encode(nonce + sealed).decode("ascii")

    def open(self, value: str, *, account: str) -> str:
        if not value.startswith(PREFIX):
            raise FieldKeyError("unknown format")
        try:
            raw = base64.urlsafe_b64decode(value[len(PREFIX):])
            return self._aes.decrypt(raw[:12], raw[12:], account.encode("utf-8")).decode("utf-8")
        except (InvalidTag, ValueError) as exc:
            raise FieldKeyError("cannot open") from exc

    def recovery_hash(self, account: str, code: str) -> str:
        """The stored form of a recovery code: a keyed hash, so a copy of the table cannot be searched for the 50-bit codes offline."""
        return hmac.new(self._recovery_key, f"{account}:{code}".encode(), hashlib.sha256).hexdigest()
