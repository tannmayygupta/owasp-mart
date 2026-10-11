"""AuditPort: append to the platform's audit log (IF-9, provided by stream P, used by both streams).

Architecture 04 section 4: the log is append-only and hash-chained. Every record stores
`row_hash = SHA-256(prev_hash || canonical JSON of the record)`, so changing or removing a record breaks every
later hash. One writer appends at a time (an advisory lock in Postgres), so sequence numbers have no gaps.
Subjects are pseudonymous ids (`subject_map`), never an email address or a name.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

# prev_hash of the first record
GENESIS_HASH = "0" * 64


@dataclass(frozen=True, slots=True)
class AuditRecord:
    seq: int
    at: str  # UTC, RFC 3339 with Z, whole seconds
    actor: str  # pseudonymous subject id of who acted, or a system name such as "job:retention"
    action: str  # dotted name, for example "consent.granted"
    subject: str | None  # pseudonymous id of whom it is about
    details: Mapping[str, Any]
    prev_hash: str
    row_hash: str

    def body(self) -> dict[str, Any]:
        """What the hash covers: everything except the two hashes."""
        return {"seq": self.seq, "at": self.at, "actor": self.actor, "action": self.action, "subject": self.subject, "details": dict(self.details)}


def canonical_json(value: Any) -> bytes:
    """Sorted keys, no spaces, UTF-8: the same bytes for the same record on every machine. NaN and infinity are refused
    (ValueError): they are not JSON."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def chain_hash(prev_hash: str, body: Mapping[str, Any]) -> str:
    return hashlib.sha256(prev_hash.encode("ascii") + canonical_json(body)).hexdigest()


def verify_chain(records: Iterable[AuditRecord], *, start_seq: int = 1, prev_hash: str = GENESIS_HASH) -> bool:
    """True when the records start at `start_seq` after `prev_hash` (seq 1 after the genesis hash, or the record after an
    `audit_checkpoint` with that checkpoint's hash), have no gap, and every hash matches."""
    prev = prev_hash
    expected_seq = start_seq
    for r in records:
        if r.seq != expected_seq:
            return False
        if r.prev_hash != prev or chain_hash(r.prev_hash, r.body()) != r.row_hash:
            return False
        prev, expected_seq = r.row_hash, r.seq + 1
    return True


@runtime_checkable
class AuditPort(Protocol):
    """Append-only audit log. There is no update and no delete (retention runs as a separate checkpointed purge)."""

    def append(self, *, actor: str, action: str, subject: str | None = None, details: Mapping[str, Any] | None = None) -> AuditRecord:
        """Append one record and return it with its sequence number and hash. `details` must be JSON values;
        raises ValueError for an empty actor or action or a value JSON cannot hold."""
        ...
