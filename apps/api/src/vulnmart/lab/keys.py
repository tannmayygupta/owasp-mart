"""A real `KeyPort` for the lab runtime (stream L): AES-256-GCM evidence sealing, per-attempt keys stored wrapped, stable derived keys.

What it replaces: `FakeKeyPort` holds the plaintext of every sealed value in memory and invents new master keys each time the process
starts, so a restart would orphan every flag, event key and piece of evidence. This one is stable and stores nothing readable:

- One master secret (a file, 32 or more characters, mode 0600 on POSIX). HKDF-SHA256 derives from it the event master, the flag key, the
  owner key and the key-encryption key (KEK). The master never leaves the process and is never logged.
- A data key (DEK) per attempt: 32 random bytes, stored wrapped under the KEK (AES-256-GCM, the attempt id is the associated data) in the
  `deks` table. Evidence is sealed under it with a fresh 96-bit nonce and the caller's associated data.
- Shredding an attempt overwrites its wrapped key with nothing and stamps `shredded_at`: the evidence rows stay but can never be opened
  again (architecture 04 section 5). A shredded attempt never gets a new key.

Architecture 04 section 5.2 puts `deks` in a separate `vm_keystore` database; this class takes its own engine, so the keystore can be
another database or, on one small host, the same one (`python -m vulnmart.lab.keys init`, run by the owner role).
"""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import Engine, LargeBinary, MetaData, String, Table, Column, Integer, DateTime, create_engine, func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from vulnmart.kernel.settings import sqlalchemy_url
from vulnmart.ports.errors import AttemptNotFound, KeyIntegrity, KeyShredded
from vulnmart.ports.keys import AttemptKey, Sealed, derive_event_key, derive_flag, derive_owner_hash, hkdf_sha256

MIN_MASTER_LENGTH = 32
SALT = b"vm-lab-keys-salt-v1"
NONCE_BYTES = 12
KEY_FILE_VAR = "VULNMART_LAB_KEY_FILE"

_meta = MetaData()
deks = Table(
    "deks", _meta,
    Column("attempt_id", String(64), primary_key=True),
    Column("dek_id", String(32), nullable=False),
    Column("kek_version", Integer, nullable=False),
    Column("wrapped", LargeBinary, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("shredded_at", DateTime(timezone=True)),
)


def read_master_key(path: str) -> bytes:
    """The master secret from a file. On POSIX a file readable or writable by group or others is refused. The message never holds the key."""
    st = os.stat(path)
    if os.name != "nt" and st.st_mode & 0o077:
        raise ValueError(f"{KEY_FILE_VAR} file {path} has mode {st.st_mode & 0o777:03o}: it must be 0600 or stricter (chmod 600)")
    key = Path(path).read_text(encoding="utf-8").strip().encode()
    if len(key) < MIN_MASTER_LENGTH:
        raise ValueError(f"the lab master key must be at least {MIN_MASTER_LENGTH} characters")
    return key


def _subkey(master: bytes, label: str) -> bytes:
    return hkdf_sha256(master, SALT, label.encode("ascii"))


class StoredKeyPort:
    def __init__(self, engine: Engine, master: bytes, *, kek_version: int = 1) -> None:
        if len(master) < MIN_MASTER_LENGTH:
            raise ValueError(f"the lab master key must be at least {MIN_MASTER_LENGTH} bytes")
        self._engine = engine
        self._kek_version = kek_version
        self._kek = AESGCM(_subkey(master, f"kek-v{kek_version}"))
        self._event_master = _subkey(master, "event-master")
        self._flag_key = _subkey(master, "flag-key")
        self._owner_key = _subkey(master, "owner-key")

    # ---- the attempt's data key ----

    def _wrap(self, attempt_id: str, dek_id: str, dek: bytes) -> bytes:
        nonce = os.urandom(NONCE_BYTES)
        return nonce + self._kek.encrypt(nonce, dek, f"{attempt_id}|{dek_id}".encode())

    def _unwrap(self, attempt_id: str, dek_id: str, wrapped: bytes) -> bytes:
        try:
            return self._kek.decrypt(bytes(wrapped[:NONCE_BYTES]), bytes(wrapped[NONCE_BYTES:]), f"{attempt_id}|{dek_id}".encode())
        except InvalidTag:
            raise KeyIntegrity("the stored key of this attempt cannot be opened (wrong master key or altered row)") from None

    def _row(self, attempt_id: str):
        with self._engine.connect() as c:
            return c.execute(select(deks).where(deks.c.attempt_id == attempt_id)).one_or_none()

    def create_attempt_key(self, attempt_id: str) -> AttemptKey:
        """Create the attempt's DEK, or return the existing one (idempotent). Raises KeyShredded after a shred."""
        dek_id = f"dek-{secrets.token_hex(8)}"
        wrapped = self._wrap(attempt_id, dek_id, os.urandom(32))
        with self._engine.begin() as c:
            c.execute(pg_insert(deks).values(attempt_id=attempt_id, dek_id=dek_id, kek_version=self._kek_version, wrapped=wrapped)
                      .on_conflict_do_nothing())
        row = self._row(attempt_id)
        if row.shredded_at is not None:
            raise KeyShredded(f"the key of {attempt_id} was shredded")
        return AttemptKey(attempt_id, row.dek_id, row.kek_version)

    def _dek(self, attempt_id: str) -> tuple[str, int, bytes]:
        row = self._row(attempt_id)
        if row is None:
            raise AttemptNotFound(f"no key for {attempt_id}")
        if row.shredded_at is not None:
            raise KeyShredded(f"the key of {attempt_id} was shredded")
        return row.dek_id, row.kek_version, self._unwrap(attempt_id, row.dek_id, row.wrapped)

    def encrypt(self, attempt_id: str, plaintext: bytes, aad: bytes = b"") -> Sealed:
        dek_id, kek_version, dek = self._dek(attempt_id)
        nonce = os.urandom(NONCE_BYTES)
        return Sealed(dek_id, kek_version, nonce.hex(), AESGCM(dek).encrypt(nonce, bytes(plaintext), bytes(aad)))

    def decrypt(self, attempt_id: str, sealed: Sealed, aad: bytes = b"") -> bytes:
        dek_id, _, dek = self._dek(attempt_id)
        if sealed.dek_id != dek_id:
            raise KeyIntegrity("the sealed value is not this attempt's, or its associated data differs")
        try:
            return AESGCM(dek).decrypt(bytes.fromhex(sealed.nonce), bytes(sealed.ciphertext), bytes(aad))
        except (InvalidTag, ValueError):
            raise KeyIntegrity("the sealed value is not this attempt's, or its associated data differs") from None

    def shred(self, attempt_id: str) -> bool:
        with self._engine.begin() as c:
            done = c.execute(update(deks).where(deks.c.attempt_id == attempt_id, deks.c.shredded_at.is_(None))
                             .values(wrapped=b"", shredded_at=func.now()).returning(deks.c.attempt_id)).one_or_none()
        return done is not None

    # ---- derivations (stable across restarts) ----

    def event_key(self, instance_id: str, epoch: int) -> str:
        return derive_event_key(self._event_master, instance_id, epoch)

    def flag(self, instance_id: str, challenge_key: str, epoch: int) -> str:
        return derive_flag(self._flag_key, instance_id, challenge_key, epoch)

    def decoy(self, instance_id: str, challenge_key: str, epoch: int, index: int) -> str:
        return derive_flag(self._flag_key, instance_id, challenge_key, epoch, decoy_index=index)

    def owner_hash(self, user_id: str) -> str:
        return derive_owner_hash(self._owner_key, user_id)


def init_keystore(owner_dsn: str, app_role: str = "vulnmart_app") -> None:
    """Create the `deks` table and let the app role read, add and shred keys (no DELETE: a shred leaves a tombstone). Run by the owner role."""
    if not app_role.replace("_", "").isalnum() or not app_role[0].isalpha():
        raise SystemExit(f"{app_role!r} is not a plain role name")
    engine = create_engine(sqlalchemy_url(owner_dsn))
    with engine.begin() as c:
        _meta.create_all(c)
        c.execute(text(f"GRANT SELECT, INSERT, UPDATE ON deks TO {app_role}"))
    engine.dispose()


def main(argv: list[str]) -> int:
    if len(argv) >= 1 and argv[0] == "init":
        dsn = os.environ.get("VULNMART_KEYSTORE_OWNER_DSN") or os.environ.get("VULNMART_MIGRATE_DSN")
        if not dsn:
            print("set VULNMART_KEYSTORE_OWNER_DSN (the owner role of the keystore database)", file=sys.stderr)
            return 2
        init_keystore(dsn, os.environ.get("VULNMART_APP_ROLE", "vulnmart_app"))
        print("keystore ready")
        return 0
    print("usage: python -m vulnmart.lab.keys init", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
