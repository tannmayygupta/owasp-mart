"""The token of an invite (story P-20, FR-ASM-02): 256 random bits behind a company prefix, kept only as a hash.

`<company>.<secret>`: the company is the UUID of the inviting company in lower-case Base32 (26 characters, not secret: the invite mail names the company), the
secret is 32 random bytes in URL-safe Base64 (43 characters). The prefix is what lets the candidate's request, which has no session and so no company in scope,
find the one row: the lookup sets that company in scope and compares the hash. Only SHA-256 of the whole token is stored. The token is never logged.
"""
from __future__ import annotations

import base64
import hashlib
import re
import secrets
import uuid

TOKEN = re.compile(r"^([a-z2-7]{26})\.([A-Za-z0-9_-]{43})$")


def new_token(org_id: uuid.UUID) -> str:
    prefix = base64.b32encode(org_id.bytes).decode("ascii").rstrip("=").lower()
    return f"{prefix}.{secrets.token_urlsafe(32)}"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def org_of(token: str) -> uuid.UUID | None:
    """The company a well-formed token names, or None. Says nothing about whether the token is real."""
    match = TOKEN.match(token)
    if match is None:
        return None
    try:
        return uuid.UUID(bytes=base64.b32decode(match.group(1).upper() + "======"))
    except ValueError:
        return None
