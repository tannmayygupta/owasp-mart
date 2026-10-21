"""The audit log on Postgres (story P-17, FR-PRV-10, architecture 04 section 4): `DbAuditPort`, chain verification and the daily anchor.

`DbAuditPort` is the real `AuditPort`. Each entry is hashed as `SHA-256(prev_hash || canonical JSON of the entry)`, exactly as the in-memory fake
does, and written under a transaction-scoped advisory lock, so entries are strictly numbered 1, 2, 3 ... with no gap and the chain stays correct when
several writers append at once. An entry is written in a transaction of its own and committed before the caller's own transaction commits: an
action that is then rolled back still leaves its entry ("attempted"), and an entry is never missing for an action that happened. The application
database role can only read and insert (migration 0007).

Nothing secret is written: keys with the name of a secret and values that look like a token or a long random string are refused with a ValueError, so
a caller that passes one fails in its own tests instead of leaking into a log that cannot be edited.

`verify` re-walks the chain (from the latest checkpoint when old rows were purged). `AuditAnchors` writes one line a day, `date seq head-hash signature`,
to the table `audit_anchor` and to a sink outside the database (a file on VM-P that an operator ships off the machine: OI-28, self-hosted), so
rewriting the whole chain and its table would still disagree with the lines kept elsewhere.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Protocol

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.audit import GENESIS_HASH, AuditPort, AuditRecord, canonical_json, chain_hash

from .models import AuditAnchor, AuditCheckpoint, AuditLog

logger = logging.getLogger("vulnmart.audit")

CHAIN_LOCK = 7_240_011_001  # the key of the advisory lock that serialises writers of the chain (any constant, unique among our locks)
MAX_DETAILS_BYTES = 4096
SECRET_KEYS = re.compile(r"(password|passwd|secret|token|api[_-]?key|authorization|cookie|otp|private[_-]?key|credential)", re.I)
TOKEN_LIKE = re.compile(r"^[A-Za-z0-9_\-+/=]{40,}$")
HEX_HASH = re.compile(r"^[0-9a-f]{40,128}$")  # a hash is not a secret: it is what the log is meant to hold
ACTION = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$")  # `consent.granted`, `role.revoked`


class AuditChainBroken(Exception):
    """The chain does not verify; nothing is anchored."""


@dataclass(frozen=True, slots=True)
class VerifyResult:
    ok: bool
    checked: int
    head_seq: int | None
    head_hash: str | None
    bad_seq: int | None = None
    reason: str | None = None


def _stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)  # SQLite (the fast tests) hands back naive times; Postgres never does


def _string_keys(value: Any) -> None:
    """JSON turns a number key into text silently; an entry must hold exactly what the caller passed, so a key that is not text is refused."""
    if isinstance(value, Mapping):
        for key, inner in value.items():
            if not isinstance(key, str):
                raise ValueError("details has a key that is not text")
            _string_keys(inner)
    elif isinstance(value, (list, tuple)):
        for inner in value:
            _string_keys(inner)


def check_details(value: Any, *, path: str = "details") -> None:
    """Refuse anything that looks like a secret. Raises ValueError (naming the key, never the value)."""
    if isinstance(value, Mapping):
        for key, inner in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{path} has a key that is not text")
            if SECRET_KEYS.search(key):
                raise ValueError(f"{path}.{key}: the name of a secret may not be written to the audit log")
            check_details(inner, path=f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for i, inner in enumerate(value):
            check_details(inner, path=f"{path}[{i}]")
    elif isinstance(value, str) and TOKEN_LIKE.match(value) and not HEX_HASH.match(value):
        raise ValueError(f"{path}: a value that looks like a token or key may not be written to the audit log")


class DbAuditPort:
    """The real `AuditPort` over `audit_log`. `sessions` should come from an engine with a small pool of its own, because `append` opens its own
    transaction while the caller may hold one."""

    def __init__(self, sessions: sessionmaker[Session], *, now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._sessions, self._now = sessions, now

    def append(self, *, actor: str, action: str, subject: str | None = None, details: Mapping[str, Any] | None = None) -> AuditRecord:
        if not actor or not action:
            raise ValueError("actor and action are required")
        if not ACTION.match(action):
            raise ValueError("action is a dotted lower-case name such as consent.granted")
        try:
            _string_keys(details or {})
            details_json = canonical_json(details or {}).decode("utf-8")
            clean = json.loads(details_json)  # the same value the hash will cover after a round trip through the database
        except (TypeError, ValueError) as exc:
            raise ValueError(f"details must be JSON values with string keys: {exc}") from None
        if len(details_json) > MAX_DETAILS_BYTES:
            raise ValueError("details are too large for an audit entry")
        check_details(clean)
        moment = self._now()
        with self._sessions.begin() as session:
            if session.get_bind().dialect.name == "postgresql":
                session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": CHAIN_LOCK})
            head = session.execute(select(AuditLog.seq, AuditLog.row_hash).order_by(AuditLog.seq.desc()).limit(1)).first()
            if head is None:
                checkpoint = session.execute(select(AuditCheckpoint.seq, AuditCheckpoint.hash).order_by(AuditCheckpoint.seq.desc()).limit(1)).first()
                head = checkpoint if checkpoint is not None else (0, GENESIS_HASH)
            seq, prev = head[0] + 1, head[1]
            body = {"seq": seq, "at": _stamp(moment), "actor": actor, "action": action, "subject": subject, "details": clean}
            row_hash = chain_hash(prev, body)
            session.add(AuditLog(seq=seq, at=moment.replace(microsecond=0), actor=actor, action=action, subject=subject, details=details_json,
                                 prev_hash=prev, row_hash=row_hash))
        return AuditRecord(seq=seq, at=body["at"], actor=actor, action=action, subject=subject, details=clean, prev_hash=prev, row_hash=row_hash)

    # ---- reading ----

    def head(self) -> tuple[int, str] | None:
        """The newest entry's (seq, hash), or None for an empty log."""
        with self._sessions() as session:
            row = session.execute(select(AuditLog.seq, AuditLog.row_hash).order_by(AuditLog.seq.desc()).limit(1)).first()
        return None if row is None else (row[0], row[1])

    def entries(self, *, subject: str | None = None, action: str | None = None, after_seq: int = 0, limit: int = 100) -> list[AuditRecord]:
        """Entries oldest first, filtered by subject and/or action, for the screens that show them (every read of the log is itself logged by the caller)."""
        query = select(AuditLog).where(AuditLog.seq > after_seq).order_by(AuditLog.seq).limit(max(1, min(limit, 1000)))
        if subject is not None:
            query = query.where(AuditLog.subject == subject)
        if action is not None:
            query = query.where(AuditLog.action == action)
        with self._sessions() as session:
            return [_record(r) for r in session.scalars(query)]

    def verify(self, *, batch: int = 1000) -> VerifyResult:
        """Walk the chain from the latest checkpoint (or the first entry) to the head and re-hash every entry."""
        with self._sessions() as session:
            checkpoint = session.execute(select(AuditCheckpoint.seq, AuditCheckpoint.hash).order_by(AuditCheckpoint.seq.desc()).limit(1)).first()
            prev, expected = (checkpoint[1], checkpoint[0] + 1) if checkpoint else (GENESIS_HASH, 1)
            checked, last = 0, expected - 1
            while True:
                rows = session.scalars(select(AuditLog).where(AuditLog.seq > last).order_by(AuditLog.seq).limit(batch)).all()
                if not rows:
                    break
                for row in rows:
                    problem = None
                    if row.seq != expected:
                        problem = "an entry is missing or out of order"
                    elif row.prev_hash != prev:
                        problem = "an entry does not follow the one before it"
                    else:
                        try:
                            body = {"seq": row.seq, "at": _stamp(_aware(row.at)), "actor": row.actor, "action": row.action, "subject": row.subject,
                                    "details": json.loads(row.details)}
                            if chain_hash(row.prev_hash, body) != row.row_hash:
                                problem = "an entry was changed"
                        except ValueError:
                            problem = "an entry cannot be read"
                    if problem:
                        return VerifyResult(False, checked, None, None, row.seq, problem)
                    prev, expected, last, checked = row.row_hash, row.seq + 1, row.seq, checked + 1
                session.expire_all()
        return VerifyResult(True, checked, last if checked or checkpoint else None, prev if checked or checkpoint else None)


def _record(row: AuditLog) -> AuditRecord:
    return AuditRecord(seq=row.seq, at=_stamp(_aware(row.at)), actor=row.actor, action=row.action, subject=row.subject, details=json.loads(row.details),
                       prev_hash=row.prev_hash, row_hash=row.row_hash)


# ---- the daily anchor -----------------------------------------------------------------------------------------------------------------------

class AnchorSink(Protocol):
    def publish(self, line: str) -> None:
        """Write one anchor line somewhere outside the database. Raises OSError when it cannot."""
        ...


class FileAnchorSink:
    """Appends lines to a file on VM-P, flushed to disk. An operator copies the file off the machine (backups, OI-28)."""

    def __init__(self, path: str | os.PathLike[str]):
        self._path = Path(path)
        self._lock = threading.Lock()

    def publish(self, line: str) -> None:
        if "\n" in line or "\r" in line:
            raise ValueError("one anchor is one line")
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self._path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
            try:
                os.write(fd, (line + "\n").encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)

    def lines(self) -> list[str]:
        return self._path.read_text(encoding="utf-8").splitlines() if self._path.exists() else []


class ListAnchorSink:
    """Keeps lines in memory (tests)."""

    def __init__(self) -> None:
        self.published: list[str] = []

    def publish(self, line: str) -> None:
        self.published.append(line)


@dataclass(frozen=True, slots=True)
class AnchorResult:
    anchor_date: date
    head_seq: int
    head_hash: str
    created: bool  # False when the day already had an anchor (it is not replaced)
    witness: str


Signer = Callable[[str], str]  # signs the text `date seq hash`; from the field key (`FieldKeys.context_hash("audit-anchor", text)`)


class AuditAnchors:
    def __init__(self, audit: DbAuditPort, sessions: sessionmaker[Session], sign: Signer, sink: AnchorSink | None = None, *,
                 now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._audit, self._sessions, self._sign, self._sink, self._now = audit, sessions, sign, sink, now

    def line(self, day: date, seq: int, head_hash: str) -> str:
        body = f"{day.isoformat()} {seq} {head_hash}"
        return f"{body} {self._sign(body)}"

    def anchor(self) -> AnchorResult:
        """Verify the chain, then record today's head in `audit_anchor` and in the sink. One anchor a day: a second call the same day changes nothing.
        An empty log is started with one entry first. Raises AuditChainBroken (and anchors nothing) when the chain does not verify, and OSError when the sink cannot be written."""
        moment = self._now()
        day = moment.astimezone(UTC).date()
        result = self._audit.verify()
        if not result.ok:
            raise AuditChainBroken(f"entry {result.bad_seq}: {result.reason}")
        if result.head_seq is None or result.head_hash is None:
            # A new deployment: nothing has been logged yet, so there is nothing to anchor. An empty log is not a broken chain: the first anchor starts the chain with one
            # entry of its own and anchors that (before this, the first daily run failed once and the failure entry itself made the retry succeed).
            self._audit.append(actor="job:audit_anchor", action="audit.chain_started", subject=None, details={})
            result = self._audit.verify()
            if not result.ok or result.head_seq is None or result.head_hash is None:
                raise AuditChainBroken("the log is empty and could not be started")
        with self._sessions() as session:
            existing = session.get(AuditAnchor, day)
        if existing is not None:
            return AnchorResult(day, existing.head_seq, existing.head_hash, False, existing.witness)
        witness = "file" if self._sink is not None else "db"
        if self._sink is not None:
            self._sink.publish(self.line(day, result.head_seq, result.head_hash))  # outside the database first: a lost row is harmless, a lost line is not
        try:
            with self._sessions.begin() as session:
                session.add(AuditAnchor(anchor_date=day, head_seq=result.head_seq, head_hash=result.head_hash, anchored_at=moment, witness=witness))
        except IntegrityError:  # another process anchored the same day first
            with self._sessions() as session:
                existing = session.get(AuditAnchor, day)
            if existing is None:
                raise
            return AnchorResult(day, existing.head_seq, existing.head_hash, False, existing.witness)
        return AnchorResult(day, result.head_seq, result.head_hash, True, witness)

    def check(self, lines: Iterable[str]) -> list[str]:
        """Compare anchor lines kept outside the database with the chain. Returns the problems, empty when every line is genuine and matches."""
        problems: list[str] = []
        for number, raw in enumerate(lines, 1):
            parts = raw.strip().split(" ")
            if len(parts) != 4 or not parts[1].isdigit():
                problems.append(f"line {number}: not an anchor line")
                continue
            day, seq, head_hash, signature = parts[0], int(parts[1]), parts[2], parts[3]
            if signature != self._sign(f"{day} {seq} {head_hash}"):
                problems.append(f"line {number}: the signature does not match")
                continue
            with self._sessions() as session:
                row = session.get(AuditLog, seq)
                latest = session.execute(select(AuditCheckpoint.seq, AuditCheckpoint.hash).order_by(AuditCheckpoint.seq.desc()).limit(1)).first()
                at_checkpoint = session.get(AuditCheckpoint, seq)
            if row is not None:
                if row.row_hash != head_hash:
                    problems.append(f"line {number}: entry {seq} is not the one that was anchored")
            elif at_checkpoint is not None:
                if at_checkpoint.hash != head_hash:
                    problems.append(f"line {number}: the checkpoint at {seq} is not the entry that was anchored")
            elif latest is None or seq > latest[0]:
                problems.append(f"line {number}: entry {seq} is gone (the log was cut short)")
            # else: purged after the anchor was written (12 months); nothing is left to compare with
        return problems
