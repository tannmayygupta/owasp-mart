"""Evidence of a credited capture, sealed per attempt (story 6.4, FR-DET-03, D-22, D-25, D-77).

Only the request that captured a credited (or held) real flag is kept. `proxy.flag_seen` and `evidence.capture` share a
`request_ref`; either may arrive first. A capture waits at most 60 seconds (platform time) for its flag sighting; a credited flag
accepts a late capture for 300 seconds. The body is checked again on arrival (a second redaction pass and a final check that no
flag pattern is left), then sealed with `KeyPort.encrypt(attempt_id, body, aad)`. The plaintext is never kept after sealing and
there is no fallback that writes plaintext when the key is missing or shredded.

`EvidenceReader` has the shape of `ReportPort.evidence` and `ReportPort.evidence_body` (`ports/reports.py`); a later story wires it
as the data source of the real `ReportPort`. The store is a Protocol with an in-memory fake until Akshay's `evidence` table exists
(handoff H-130). No flag, digest, key or body goes into a log line, an exception or an integrity explanation.
"""
from __future__ import annotations

import re
import secrets
import threading
import unicodedata
from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol, runtime_checkable
from urllib.parse import unquote

from vulnmart.flags.checker import FlagChecker, FlagClass
from vulnmart.ingest.engine import ProcessResult, classify_digest, is_countable
from vulnmart.ingest.stores import MILESTONE_ORDER, InstanceDirectory, IntegritySink, MilestoneStore
from vulnmart.ports.errors import AttemptGone, AttemptNotFound, KeyShredded
from vulnmart.ports.keys import KeyPort, Sealed
from vulnmart.ports.reports import EvidenceItem, IntegrityType, Milestone

MARKER = "[FLAG-REDACTED]"
MAX_BODY_BYTES = 8192  # FR-DET-03; the `evidence_max_bytes` setting default
PENDING_TTL_S = 60  # a capture waits this long for its flag sighting
LATE_CAPTURE_S = 300  # a credited flag still accepts its capture for this long
MAX_PENDING = 1000

_SECRET_NAME = r"[A-Za-z0-9_.-]*(?:password|passwd|token|secret|authorization|cookie|api_?key)[A-Za-z0-9_.-]*"
_JSON_FIELD = re.compile(rf'("{_SECRET_NAME}"\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}}\]\s]+)', re.IGNORECASE)
_FORM_FIELD = re.compile(rf"((?:^|[&?\n]){_SECRET_NAME}=)[^&\s]*", re.IGNORECASE)
_FLAGGY = re.compile(r"[Vv][Mm](?:\{|%7[Bb]|｛)")
_FLAGGY_RUN = re.compile(r"[Vv][Mm](?:\{|%7[Bb]|｛)[^\s\"'<>&]*?(?:\}|%7[Dd]|｝|(?=[\s\"'<>&])|$)")
_UNICODE_ESCAPE = re.compile(r"\\u([0-9a-fA-F]{4})")
_SECRET_HEADER = re.compile(r"authorization|cookie|token|secret|password|api[-_]?key", re.IGNORECASE)


def blank_secrets(text: str) -> str:
    """The same blanking as the sidecar: the value of a JSON or form field whose name holds password, token, cookie and the like."""
    return _FORM_FIELD.sub(r"\1", _JSON_FIELD.sub(r'\1""', text))


def redact_flag_like(text: str) -> str:
    return _FLAGGY_RUN.sub(MARKER, text)


def _variants(text: str) -> list[str]:
    out = [text, unquote(text)]
    out.append(_UNICODE_ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), text))
    out += [unicodedata.normalize("NFKC", v) for v in out]
    return out


def has_flag_pattern(text: str) -> bool:
    """True when the text holds a flag shape in plain, percent-encoded, JSON-escaped or full-width form."""
    return any(_FLAGGY.search(v) for v in _variants(text))


def redact_headers(headers: Mapping[str, Any]) -> dict[str, str]:
    """A second pass over the header map: a secret-named header loses its value, a flag-like text is replaced."""
    out: dict[str, str] = {}
    for name, value in headers.items():
        if not isinstance(name, str):
            continue
        out[name] = "" if _SECRET_HEADER.search(name) else redact_flag_like(blank_secrets(str(value)))
    return out


@dataclass(frozen=True, slots=True)
class EvidenceRow:
    """What the `evidence` table keeps: metadata and the sealed bytes. The AAD parts are not secret and are kept to open the row."""

    evidence_id: str
    attempt_id: str
    challenge_key: str
    captured_at: datetime
    size: int  # bytes of the sealed plaintext (0 for a held empty capture)
    sealed: Sealed
    aad: bytes
    held_empty: bool = False


@runtime_checkable
class EvidenceStore(Protocol):
    def add(self, row: EvidenceRow) -> None: ...

    def rows(self, attempt_id: str) -> list[EvidenceRow]:
        """The rows of an attempt, oldest first."""
        ...


class InMemoryEvidenceStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._by_attempt: dict[str, list[EvidenceRow]] = defaultdict(list)

    def add(self, row: EvidenceRow) -> None:
        with self._lock:
            self._by_attempt[row.attempt_id].append(row)
            self._by_attempt[row.attempt_id].sort(key=lambda r: r.captured_at)

    def rows(self, attempt_id: str) -> list[EvidenceRow]:
        with self._lock:
            return list(self._by_attempt.get(attempt_id, []))


@dataclass(slots=True)
class EvidenceStats:
    sealed: int = 0
    dropped_uncredited: int = 0  # a capture whose flag was a decoy, stale, foreign or not credited, or never arrived
    dropped_key: int = 0  # the attempt key was shredded or missing
    refused_too_large: int = 0
    flag_in_body: int = 0  # a flag pattern was still in the capture: stored as held with an empty body
    duplicates: int = 0


def aad_of(instance_id: str, epoch: int, challenge_key: str, request_ref: str) -> bytes:
    return f"{instance_id}|{epoch}|{challenge_key}|{request_ref}".encode()


class EvidenceRecorder:
    """Call `observe(event, received_at, result)` for every verified event right after `MilestoneEngine.process` (`result` is its
    return value). Only `proxy.flag_seen` and `evidence.capture` events have an effect here."""

    def __init__(self, *, keys: KeyPort, store: EvidenceStore, directory: InstanceDirectory, checker: FlagChecker,
                 milestones: MilestoneStore, integrity: IntegritySink, max_body_bytes: int = MAX_BODY_BYTES,
                 pending_ttl_s: int = PENDING_TTL_S, late_capture_s: int = LATE_CAPTURE_S,
                 alarm: Callable[[str], None] | None = None) -> None:
        self.keys, self.store, self.directory, self.checker = keys, store, directory, checker
        self.milestones, self.integrity = milestones, integrity
        self.max_body_bytes, self.pending_ttl_s, self.late_capture_s = max_body_bytes, pending_ttl_s, late_capture_s
        self.alarm = alarm or (lambda word: None)
        self.stats = EvidenceStats()
        self._lock = threading.RLock()
        # (instance_id, epoch, request_ref) -> (event, arrival)
        self._captures: dict[tuple[str, int, str], tuple[Mapping[str, Any], datetime]] = {}
        # credited or held flag sightings: key -> (challenge_key, arrival); a late capture attaches while it is fresh
        self._credited: dict[tuple[str, int, str], tuple[str, datetime]] = {}
        self._rejected: dict[tuple[str, int, str], datetime] = {}  # sightings that credit nothing: their capture is dropped
        self._done: set[tuple[str, int, str]] = set()  # request refs that already have a row

    # ---- public ----

    def observe(self, event: Mapping[str, Any], received_at: datetime, result: ProcessResult | None = None) -> None:
        with self._lock:
            self.expire(received_at)
            if not is_countable(event):  # bot and internal sessions never become evidence
                return
            info = self.directory.get(event["instance_id"])
            if info is None:
                return
            if event["type"] == "proxy.flag_seen":
                self._flag(event, received_at, result)
            elif event["type"] == "evidence.capture":
                self._capture(event, received_at)

    def expire(self, now: datetime) -> None:
        """Drop the halves that waited longer than their time. A capture that never met a credited flag is counted as dropped."""
        with self._lock:
            for k in [k for k, (_, at) in self._captures.items() if now - at > timedelta(seconds=self.pending_ttl_s)]:
                del self._captures[k]
                self.stats.dropped_uncredited += 1
            for k in [k for k, (_, at) in self._credited.items() if now - at > timedelta(seconds=self.late_capture_s)]:
                del self._credited[k]
                self._done.discard(k)
            for k in [k for k, at in self._rejected.items() if now - at > timedelta(seconds=self.pending_ttl_s)]:
                del self._rejected[k]
            for table in (self._captures, self._credited, self._rejected):
                while len(table) > MAX_PENDING:
                    table.pop(next(iter(table)))

    # ---- the two halves ----

    def _key(self, event: Mapping[str, Any], ref: str) -> tuple[str, int, str]:
        return (event["instance_id"], event["epoch"], ref)

    def _flag(self, event: Mapping[str, Any], at: datetime, result: ProcessResult | None) -> None:
        d = event["data"]
        ref = d.get("request_ref")
        if not ref:
            return
        info = self.directory.get(event["instance_id"])
        if d.get("kind") != "real":  # a decoy or foreign sighting: a capture of the same request is never kept
            self._reject(self._key(event, ref), at)
            return
        try:
            check = classify_digest(self.checker, self.directory, info, epoch=event["epoch"],
                                    candidate_sha256=d["candidate_sha256"], claimed=d.get("challenge_key"))
        except (ValueError, KeyError):
            return
        k = self._key(event, ref)
        c = check.challenge_key
        if check.flag_class is not FlagClass.CORRECT or c is None or event["epoch"] != info.epoch or not self._settled(info, c, result):
            self._reject(k, at)
            return
        self._credited[k] = (c, at)
        pending = self._captures.pop(k, None)
        if pending is not None:
            self._seal(info, c, pending[0], k, at)

    def _reject(self, k: tuple[str, int, str], at: datetime) -> None:
        self._rejected[k] = at
        if self._captures.pop(k, None) is not None:
            self.stats.dropped_uncredited += 1

    def _settled(self, info, challenge_key: str, result: ProcessResult | None) -> bool:
        """The flag was credited or is held: this event did it, or the milestone is already M3 (a repeat), or the engine held it."""
        if result is not None:
            if challenge_key in result.held or any(cr.challenge_key == challenge_key and cr.milestone is Milestone.M3
                                                   for cr in result.credits):
                return True
        return MILESTONE_ORDER[self.milestones.best(info.attempt_id, challenge_key)] >= MILESTONE_ORDER[Milestone.M3] \
            or self._is_held(info.attempt_id, challenge_key)

    def _is_held(self, attempt_id: str, challenge_key: str) -> bool:
        held = getattr(self.milestones, "held", None)
        return isinstance(held, Mapping) and (attempt_id, challenge_key) in held

    def _capture(self, event: Mapping[str, Any], at: datetime) -> None:
        ref = event["data"].get("request_ref")
        if not ref:
            return
        k = self._key(event, ref)
        if k in self._done:
            self.stats.duplicates += 1
            return
        if k in self._rejected:
            self.stats.dropped_uncredited += 1
            return
        credited = self._credited.get(k)
        if credited is not None:
            info = self.directory.get(event["instance_id"])
            self._seal(info, credited[0], event, k, at)
            return
        if len(self._captures) < MAX_PENDING:
            self._captures.setdefault(k, (event, at))

    # ---- sealing ----

    def _seal(self, info, challenge_key: str, capture: Mapping[str, Any], k: tuple[str, int, str], at: datetime) -> None:
        d = capture["data"]
        body = d.get("body")
        headers = d.get("headers_redacted") or {}
        if not isinstance(body, str) or not isinstance(headers, Mapping):
            return
        if len(body.encode("utf-8")) > self.max_body_bytes:
            self.stats.refused_too_large += 1
            self.integrity.add(info.attempt_id, IntegrityType.ACTIVITY,
                               f"A captured request of challenge {challenge_key} was larger than the evidence limit and was refused.",
                               f"evidence-size:{k[2]}")
            self._done.add(k)
            return
        held_empty = has_flag_pattern(body) or any(has_flag_pattern(str(v)) for v in headers.values())
        if held_empty:
            self.stats.flag_in_body += 1
            self.alarm("flag pattern in an evidence capture")
            self.integrity.add(info.attempt_id, IntegrityType.ACTIVITY,
                               f"A captured request of challenge {challenge_key} still held a flag pattern; it was stored with an empty body.",
                               f"evidence-flag:{k[2]}")
            plaintext = b""
        else:
            redact_headers(headers)  # second pass over the header map; headers are checked, not kept (only the body is sealed)
            plaintext = redact_flag_like(blank_secrets(body)).encode("utf-8")
        aad = aad_of(k[0], k[1], challenge_key, k[2])
        try:
            sealed = self.keys.encrypt(info.attempt_id, plaintext, aad)
        except (KeyShredded, AttemptNotFound):
            self.stats.dropped_key += 1  # never a plaintext fallback
            self._done.add(k)
            return
        del plaintext
        self.store.add(EvidenceRow(evidence_id="ev-" + secrets.token_hex(8), attempt_id=info.attempt_id, challenge_key=challenge_key,
                                   captured_at=at, size=0 if held_empty else len(body.encode("utf-8")), sealed=sealed, aad=aad,
                                   held_empty=held_empty))
        self.stats.sealed += 1
        self._done.add(k)


class EvidenceReader:
    """`ReportPort.evidence` and `evidence_body` over the store and `KeyPort`."""

    def __init__(self, *, store: EvidenceStore, keys: KeyPort) -> None:
        self.store, self.keys = store, keys

    def evidence(self, attempt_id: str) -> tuple[EvidenceItem, ...]:
        """Oldest first. Raises AttemptGone when the attempt key was shredded (probed through the first sealed row)."""
        rows = self.store.rows(attempt_id)
        if rows:
            self._probe(attempt_id, rows[0])
        return tuple(EvidenceItem(r.evidence_id, r.challenge_key, r.captured_at.strftime("%Y-%m-%dT%H:%M:%SZ"), r.size) for r in rows)

    def evidence_body(self, attempt_id: str, evidence_id: str) -> bytes:
        """Raises AttemptNotFound for an id that is missing or another attempt's, AttemptGone (KeyShredded) after a shred."""
        row = next((r for r in self.store.rows(attempt_id) if r.evidence_id == evidence_id), None)
        if row is None:
            raise AttemptNotFound("no such evidence for this attempt")
        return self.keys.decrypt(attempt_id, row.sealed, row.aad)

    def _probe(self, attempt_id: str, row: EvidenceRow) -> None:
        try:
            self.keys.decrypt(attempt_id, row.sealed, row.aad)
        except KeyShredded as exc:
            raise AttemptGone("the attempt key was shredded") from exc
