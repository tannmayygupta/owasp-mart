"""KeyPort: the key service (IF-9, provided by stream P, used by stream L's ingest, scoring and worker).

What it does (architecture 04 sections 5 and 11, ADR 0009, ADR 0025):
- one data key (DEK) per attempt; `encrypt` and `decrypt` seal an attempt's evidence with it (AES-256-GCM in the
  real service, with the DEK wrapped by a versioned KEK in the separate `vm_keystore` database);
- `shred` deletes an attempt's DEK, after which nothing sealed with it can be read again (KeyShredded, ATT-GONE);
- the per-instance event key: HKDF-SHA256 over the versioned master `K_evt[v]`, info = label, instance id and
  epoch (H-105; vector `contracts/events/examples/event-key-vector.json`); nothing is stored per instance;
- flags and decoys: domain-separated HMAC-SHA256 over `K_flag[v]` (architecture 04 section 11.1); there is no
  flag table;
- the owner hash for the instance label `vm.owner`: HMAC-SHA256 over the platform label key and the user id (H-20).

The derivation functions below are pure and shared by the real service and the fake; only where the keys come
from differs. No key material is ever in a log: key values are `repr=False`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from dataclasses import dataclass
from dataclasses import field as dc_field
from typing import Protocol, runtime_checkable

EVENT_KEY_SALT = b"vm-evt-salt-v1"
EVENT_KEY_LABEL = b"vm-event-key-v1"
FLAG_LABEL = b"vm-flag-v1"
DECOY_LABEL = b"vm-decoy-v1"
OWNER_LABEL = b"vm-owner-v1"
FLAG_CHARS = 24  # Base32 characters inside VM{...} (flags-file schema: ^VM\{[A-Z2-7]{24}\}$)


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """RFC 5869 extract-then-expand."""
    if not 0 < length <= 255 * 32:
        raise ValueError("HKDF length out of range")
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def derive_event_key(master: bytes, instance_id: str, epoch: int) -> str:
    """The event key of one instance epoch: base64url(HKDF-SHA256(master, salt, label 0x00 instance_id 0x00 decimal(epoch)))."""
    if type(epoch) is not int or epoch < 1:
        raise ValueError("epoch must be a positive integer")
    info = EVENT_KEY_LABEL + b"\x00" + instance_id.encode("ascii") + b"\x00" + str(epoch).encode("ascii")
    return b64url(hkdf_sha256(master, EVENT_KEY_SALT, info))


def _framed(*parts: bytes) -> bytes:
    """The length-prefixed separator of architecture 04 section 11.1: each part as a 4-byte big-endian length, then its bytes."""
    return b"".join(len(p).to_bytes(4, "big") + p for p in parts)


def derive_flag(key: bytes, instance_id: str, challenge_key: str, epoch: int, *, decoy_index: int | None = None) -> str:
    """`VM{` + the first 24 Base32 characters of HMAC-SHA256(key, label | instance | challenge | epoch [| index]) + `}`."""
    if type(epoch) is not int or epoch < 1:
        raise ValueError("epoch must be a positive integer")
    parts = [DECOY_LABEL if decoy_index is not None else FLAG_LABEL, instance_id.encode(), challenge_key.encode(), str(epoch).encode()]
    if decoy_index is not None:
        parts.append(str(decoy_index).encode())
    mac = hmac.new(key, _framed(*parts), hashlib.sha256).digest()
    return "VM{" + base64.b32encode(mac).decode("ascii")[:FLAG_CHARS] + "}"


def derive_owner_hash(key: bytes, user_id: str) -> str:
    """64 lowercase hex characters, an opaque id of the user for the instance label `vm.owner` (never an email)."""
    return hmac.new(key, _framed(OWNER_LABEL, user_id.encode()), hashlib.sha256).hexdigest()


@dataclass(frozen=True, slots=True)
class AttemptKey:
    attempt_id: str
    dek_id: str
    kek_version: int


@dataclass(frozen=True, slots=True)
class Sealed:
    """A value sealed with an attempt's DEK, as the `evidence` table stores it."""

    dek_id: str
    kek_version: int
    nonce: str
    ciphertext: bytes = dc_field(repr=False)


@runtime_checkable
class KeyPort(Protocol):
    def create_attempt_key(self, attempt_id: str) -> AttemptKey:
        """Create the attempt's DEK, or return the existing one (idempotent). Raises KeyShredded after a shred."""
        ...

    def encrypt(self, attempt_id: str, plaintext: bytes, aad: bytes = b"") -> Sealed:
        """Seal with the attempt's DEK. Raises AttemptNotFound without a key, KeyShredded after a shred."""
        ...

    def decrypt(self, attempt_id: str, sealed: Sealed, aad: bytes = b"") -> bytes:
        """Open a sealed value. Raises KeyShredded after a shred, AttemptNotFound without a key, KeyIntegrity when the value
        is not this attempt's or `aad` differs."""
        ...

    def shred(self, attempt_id: str) -> bool:
        """Delete the attempt's DEK for good. True when a key was deleted, False when there was none or it was already gone."""
        ...

    def event_key(self, instance_id: str, epoch: int) -> str:
        """The event key of one instance epoch (H-105), base64url without padding."""
        ...

    def flag(self, instance_id: str, challenge_key: str, epoch: int) -> str:
        """The flag of one challenge in one instance epoch (`VM{...}`)."""
        ...

    def decoy(self, instance_id: str, challenge_key: str, epoch: int, index: int) -> str:
        """Decoy number `index` of one challenge in one instance epoch."""
        ...

    def owner_hash(self, user_id: str) -> str:
        """The opaque owner id for the instance label `vm.owner` (H-20)."""
        ...
