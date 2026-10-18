"""The key service (story P-17, FR-PRV-12, IF-9 `KeyPort`): `DbKeyPort`, over the keystore database, and `KekRing`.

One random 256-bit data key (DEK) per attempt. A DEK is stored only wrapped (AES-256-GCM) by a versioned key-encryption key (KEK) from a file secret on
VM-P, in the separate database `vm_keystore` (`kernel/keystore.py`). `encrypt` and `decrypt` seal an attempt's evidence and answers with its DEK
(AES-256-GCM, the attempt id and the caller's associated data authenticated). `shred` deletes the DEK for good and records the attempt id as shredded:
afterwards nothing sealed with it can be read, and because the keystore is backed up under other rules than the data (architecture 04 section 5.3) no
backup of the data can bring it back. The event key, flag, decoy and owner hash are the pure derivations of `vulnmart.ports.keys` over three master keys.

A DEK is read and unwrapped for each call and kept nowhere: a process that shredded a key and another that reads it agree at once, at the price of one
primary-key read per call. Key values never appear in a log or an exception message.
"""
from __future__ import annotations

import base64
import binascii
import logging
import os
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete, insert, select, text, update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.errors import AttemptNotFound, KeyIntegrity, KeyShredded
from vulnmart.ports.keys import AttemptKey, Sealed, derive_event_key, derive_flag, derive_owner_hash

from .keystore import deks, shredded

logger = logging.getLogger("vulnmart.keys")

ATTEMPT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MIN_MASTER = 32
_DEK_AAD = b"vm-dek-v1"
_SEAL_AAD = b"vm-evidence-v1"


class KekUnavailable(Exception):
    """A key was wrapped with a KEK version this process does not have."""


def decode_key(text_value: str, *, what: str) -> bytes:
    """Base64 (standard or URL-safe, padding optional) of at least 32 bytes. The message never contains the value."""
    raw = text_value.strip()
    try:
        data = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except (binascii.Error, ValueError):
        raise ValueError(f"{what} is not base64") from None
    if len(data) < MIN_MASTER:
        raise ValueError(f"{what} is at least {MIN_MASTER} bytes")
    return data


@dataclass(frozen=True)
class KekRing:
    keys: dict[int, bytes] = field(repr=False)
    current: int

    @classmethod
    def parse(cls, value: str) -> KekRing:
        """One `version:base64` per line (blank lines and `#` comments ignored); the highest version wraps new keys, the others only unwrap."""
        keys: dict[int, bytes] = {}
        for number, line in enumerate(value.splitlines(), 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            version, _, key = line.partition(":")
            if not version.isdigit() or int(version) < 1 or not key:
                raise ValueError(f"KEK line {number} is not version:base64")
            if int(version) in keys:
                raise ValueError(f"KEK version {version} appears twice")
            data = decode_key(key, what=f"KEK version {version}")
            if len(data) != 32:
                raise ValueError(f"KEK version {version} is exactly 32 bytes")
            keys[int(version)] = data
        if not keys:
            raise ValueError("no KEK given")
        return cls(keys, max(keys))

    @staticmethod
    def _aad(attempt_id: str, dek_id: str) -> bytes:
        return _DEK_AAD + b"\x00" + attempt_id.encode() + b"\x00" + dek_id.encode()

    def wrap(self, dek: bytes, attempt_id: str, dek_id: str) -> tuple[int, bytes, bytes]:
        nonce = os.urandom(12)
        return self.current, nonce, AESGCM(self.keys[self.current]).encrypt(nonce, dek, self._aad(attempt_id, dek_id))

    def unwrap(self, version: int, nonce: bytes, wrapped: bytes, attempt_id: str, dek_id: str) -> bytes:
        key = self.keys.get(version)
        if key is None:
            raise KekUnavailable(f"KEK version {version} is not available to this process")
        try:
            return AESGCM(key).decrypt(nonce, wrapped, self._aad(attempt_id, dek_id))
        except InvalidTag:
            raise KeyIntegrity("a wrapped key cannot be opened") from None


class DbKeyPort:
    def __init__(self, sessions: sessionmaker[Session], kek: KekRing, *, event_master: bytes, flag_key: bytes, owner_key: bytes,
                 after_shred: Callable[[str], None] | None = None):
        for name, key in (("event master", event_master), ("flag key", flag_key), ("owner key", owner_key)):
            if len(key) < MIN_MASTER:
                raise ValueError(f"the {name} is at least {MIN_MASTER} bytes")
        if len({event_master, flag_key, owner_key}) != 3:
            raise ValueError("the event master, flag key and owner key must differ (one leak must not open the others)")
        self._sessions, self._kek = sessions, kek
        self._event_master, self._flag_key, self._owner_key = event_master, flag_key, owner_key
        self._after_shred = after_shred  # called with the attempt id after a shred commits: the place to take the new keystore snapshot (architecture 04 5.3)

    # ---- helpers ----

    @staticmethod
    def _check(attempt_id: str) -> None:
        if not ATTEMPT_ID.match(attempt_id):
            raise ValueError("not an attempt id")

    @staticmethod
    def _lock(session: Session, attempt_id: str) -> None:
        if session.get_bind().dialect.name == "postgresql":
            session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"dek:{attempt_id}"})

    def _row(self, session: Session, attempt_id: str):
        return session.execute(select(deks).where(deks.c.attempt_id == attempt_id)).first()

    def _missing(self, session: Session, attempt_id: str) -> Exception:
        if session.execute(select(shredded.c.attempt_id).where(shredded.c.attempt_id == attempt_id)).first() is not None:
            return KeyShredded(f"the key of {attempt_id} was shredded")
        return AttemptNotFound(f"no key for {attempt_id}")

    def _dek(self, attempt_id: str) -> tuple[bytes, str, int]:
        with self._sessions() as session:
            row = self._row(session, attempt_id)
            if row is None:
                raise self._missing(session, attempt_id)
        return self._kek.unwrap(row.kek_version, bytes(row.nonce), bytes(row.wrapped), attempt_id, row.dek_id), row.dek_id, row.kek_version

    @staticmethod
    def _aad(attempt_id: str, aad: bytes) -> bytes:
        return _SEAL_AAD + b"\x00" + attempt_id.encode() + b"\x00" + aad

    # ---- the per-attempt key ----

    def create_attempt_key(self, attempt_id: str) -> AttemptKey:
        self._check(attempt_id)
        with self._sessions.begin() as session:
            self._lock(session, attempt_id)
            if session.execute(select(shredded.c.attempt_id).where(shredded.c.attempt_id == attempt_id)).first() is not None:
                raise KeyShredded(f"the key of {attempt_id} was shredded")
            row = self._row(session, attempt_id)
            if row is None:
                dek_id = "dek-" + secrets.token_hex(8)
                version, nonce, wrapped = self._kek.wrap(os.urandom(32), attempt_id, dek_id)
                session.execute(insert(deks).values(attempt_id=attempt_id, dek_id=dek_id, kek_version=version, nonce=nonce, wrapped=wrapped))
                return AttemptKey(attempt_id, dek_id, version)
            return AttemptKey(attempt_id, row.dek_id, row.kek_version)

    def encrypt(self, attempt_id: str, plaintext: bytes, aad: bytes = b"") -> Sealed:
        self._check(attempt_id)
        dek, dek_id, version = self._dek(attempt_id)
        nonce = os.urandom(12)
        return Sealed(dek_id, version, nonce.hex(), AESGCM(dek).encrypt(nonce, bytes(plaintext), self._aad(attempt_id, aad)))

    def decrypt(self, attempt_id: str, sealed: Sealed, aad: bytes = b"") -> bytes:
        self._check(attempt_id)
        dek, dek_id, _ = self._dek(attempt_id)
        if sealed.dek_id != dek_id:
            raise KeyIntegrity("the sealed value is not this attempt's, or its associated data differs")
        try:
            return AESGCM(dek).decrypt(bytes.fromhex(sealed.nonce), bytes(sealed.ciphertext), self._aad(attempt_id, aad))
        except (InvalidTag, ValueError):
            raise KeyIntegrity("the sealed value is not this attempt's, or its associated data differs") from None

    def shred(self, attempt_id: str) -> bool:
        self._check(attempt_id)
        with self._sessions.begin() as session:
            self._lock(session, attempt_id)
            gone = session.execute(delete(deks).where(deks.c.attempt_id == attempt_id).returning(deks.c.dek_id)).first()
            if gone is None:
                return False  # nothing to delete (no key, or already shredded); a key created later is a new key
            session.execute(insert(shredded).values(attempt_id=attempt_id))
        logger.info("the key of an attempt was shredded")  # the id is not logged: a log line outlives the data it names
        if self._after_shred is not None:
            self._after_shred(attempt_id)
        return True

    def rewrap(self, *, batch: int = 100) -> int:
        """After a KEK rotation (a new highest version in the ring): wrap up to `batch` keys that still use an older version with the current one.
        Run it until it returns 0, then the old version can be retired. Returns how many were rewrapped."""
        done = 0
        with self._sessions() as session:
            rows = session.execute(select(deks).where(deks.c.kek_version < self._kek.current).limit(batch)).all()
        for row in rows:
            dek = self._kek.unwrap(row.kek_version, bytes(row.nonce), bytes(row.wrapped), row.attempt_id, row.dek_id)
            version, nonce, wrapped = self._kek.wrap(dek, row.attempt_id, row.dek_id)
            with self._sessions.begin() as session:
                self._lock(session, row.attempt_id)
                done += session.execute(update(deks).where(deks.c.attempt_id == row.attempt_id, deks.c.kek_version == row.kek_version)
                                        .values(kek_version=version, nonce=nonce, wrapped=wrapped)).rowcount
        return done

    # ---- the derived keys (pure functions over the masters) ----

    def event_key(self, instance_id: str, epoch: int) -> str:
        return derive_event_key(self._event_master, instance_id, epoch)

    def flag(self, instance_id: str, challenge_key: str, epoch: int) -> str:
        return derive_flag(self._flag_key, instance_id, challenge_key, epoch)

    def decoy(self, instance_id: str, challenge_key: str, epoch: int, index: int) -> str:
        return derive_flag(self._flag_key, instance_id, challenge_key, epoch, decoy_index=index)

    def owner_hash(self, user_id: str) -> str:
        return derive_owner_hash(self._owner_key, user_id)
