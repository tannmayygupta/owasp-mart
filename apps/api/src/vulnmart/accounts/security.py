"""Passwords, ids and link tokens of the accounts module.

- Passwords: Argon2id (D-21, ASVS 5.0 chapter 11), at the OWASP minimum profile (19 MiB, 2 passes, 1 lane), checked in constant time
  by the library; `needs_rehash` lets a later login upgrade a hash when the profile is raised. A hash is a PHC string that carries
  its own parameters and salt.
- Link tokens: 32 random bytes in URL-safe Base64 (43 characters, matches the contract's `Token`), shown once in the link and kept
  only as a SHA-256 hash. The token is high-entropy, so a fast hash is enough and the lookup can be by hash.
- User ids: `u-` and 16 Base32 characters from 10 random bytes (the contract's `UserId`).
- Email addresses: one canonical form for the unique column and the lookups.
"""
from __future__ import annotations

import base64
import hashlib
import re
import secrets
import unicodedata

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

# OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19456 KiB, t=2, p=1. Raise it when the VM can afford it.
HASHER = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_EMAIL = 254


def hash_password(password: str) -> str:
    return HASHER.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    """True when the password matches. Never raises for a wrong password or a malformed stored hash."""
    try:
        return HASHER.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    return HASHER.check_needs_rehash(stored_hash)


# A real hash of a random value, computed once: work done for an unknown account so that "no such account" costs the same as a wrong password.
_DUMMY = hash_password(secrets.token_urlsafe(16))


def spend_the_same_time() -> None:
    verify_password(_DUMMY, "not the password")


def new_user_id() -> str:
    return "u-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_email(raw: str) -> str | None:
    """The canonical form (trimmed, NFKC, lower case), or None when the text is not an address of the shape `a@b.c` within the limit.

    The same person is the same account whatever the case of the address; the part before the `@` is not changed further (no
    removal of `+tags` or dots: those are real, different addresses at most providers)."""
    text = unicodedata.normalize("NFKC", raw).strip()
    if not 3 <= len(text) <= MAX_EMAIL or not _EMAIL.fullmatch(text) or any(ord(c) < 32 or ord(c) == 127 for c in text):
        return None
    return text.lower()
