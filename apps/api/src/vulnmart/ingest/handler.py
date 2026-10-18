"""The event receiver's decision, as a pure function of headers and raw bytes (IF-4, app-events.md sections 5 and 6, H-08).

Order and answers are those of the Node fake (`contracts/mocks/fake-ingest/ingest.mjs`, `handle`): size 413, content type 422,
JSON and object 422, usable instance_id/epoch/seq 422, signature 401 (an unknown instance costs the same HMAC work), epoch above
the current one 401, evidence body over 8 KiB 413, schema 422, `ts` 422 and at most 10 minutes ahead, duplicate identical 200,
other body 409, store full 503, else 202. One event per request: an array is 422. An older epoch is late history: accepted and
stored under its own epoch. Events of a bot or an internal session are stored like any other and handed on unflagged (the engine
decides what counts). No event data, key or signature is ever logged; a 401 raises a security event (kind and ids only).
"""
from __future__ import annotations

import itertools
import json
import logging
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from vulnmart_models.error_codes import ERRORS, ErrorCode, problem_type

from vulnmart.ingest import schema as schema_mod
from vulnmart.ingest import verify
from vulnmart.ports.keys import KeyPort
from vulnmart.ingest.store import (
    DEFAULT_MAX_STORED, EventSink, EventStore, InstanceEpochs, MemoryEventStore, MemorySecuritySink, PutResult, SecuritySink,
)

logger = logging.getLogger("vulnmart.ingest")

MAX_BODY_BYTES = 16 * 1024
EVIDENCE_BODY_BYTES = 8 * 1024
SKEW = timedelta(minutes=10)
_JSON_TYPE = re.compile(r"application/json(\s*;|$)", re.IGNORECASE)
_MAX_POINTER, _MAX_DETAIL, _MAX_ERRORS = 200, 200, 50


@dataclass(frozen=True, slots=True)
class Reply:
    status: int
    body: dict[str, Any]
    problem: bool = False
    headers: Mapping[str, str] = field(default_factory=dict)


def problem_body(code: ErrorCode, request_id: str, errors: list[tuple[str, str]] | None = None) -> dict[str, Any]:
    """The IF-8 body. `errors` ((pointer, detail) pairs) is added for a 422 only; the title is the registry's fixed text."""
    info = ERRORS[code]
    body: dict[str, Any] = {"type": problem_type(code), "title": info.title, "status": info.status, "code": code.value,
                            "request_id": request_id}
    if info.status == 422 and errors:
        body["errors"] = [{"pointer": p if len(p) <= _MAX_POINTER else "", "detail": d[:_MAX_DETAIL]} for p, d in errors[:_MAX_ERRORS]]
    return body


class IngestHandler:
    def __init__(self, *, keys: KeyPort, epochs: InstanceEpochs, store: EventStore | None = None, sink: EventSink | None = None,
                 security: SecuritySink | None = None, now: Callable[[], datetime] | None = None,
                 max_body_bytes: int = MAX_BODY_BYTES, evidence_body_bytes: int = EVIDENCE_BODY_BYTES,
                 max_stored: int = DEFAULT_MAX_STORED, schema_file: str | None = None) -> None:
        self.keys, self.epochs = keys, epochs
        self.store: EventStore = store if store is not None else MemoryEventStore(max_stored)
        self.sink = sink
        self.security: SecuritySink = security if security is not None else MemorySecuritySink()
        self.now = now or (lambda: datetime.now(UTC))
        self.max_body_bytes, self.evidence_body_bytes = max_body_bytes, evidence_body_bytes
        self._schema_file = schema_file
        self._ids = itertools.count(1)

    # ---- helpers ----

    def _problem(self, code: ErrorCode, request_id: str | None, errors: list[tuple[str, str]] | None = None) -> Reply:
        rid = request_id or f"ing-{next(self._ids):08d}"
        return Reply(ERRORS[code].status, problem_body(code, rid, errors), True, {"Cache-Control": "private, no-store"})

    def too_large(self, request_id: str | None = None) -> Reply:
        """The 413 for a body past the cap, for a front that stopped reading (no body is needed)."""
        return self._problem(ErrorCode.EVT_TOO_LARGE, request_id)

    def _refuse(self, kind: str, event: Mapping[str, Any], request_id: str | None) -> Reply:
        # The claimed identity is usable here (checked before the signature); nothing else of the request is recorded.
        self.security.raise_event(kind, event["instance_id"], event["epoch"], event["seq"])
        logger.warning("event refused: %s", kind)
        return self._problem(ErrorCode.EVT_BAD_SIGNATURE, request_id)

    # ---- the decision ----

    def handle(self, headers: Mapping[str, str] | None, raw: bytes, request_id: str | None = None) -> Reply:
        rid = request_id
        if len(raw) > self.max_body_bytes:
            return self.too_large(rid)
        ctype = verify.header_value(headers, "content-type") or ""
        if _JSON_TYPE.match(ctype) is None:
            return self._problem(ErrorCode.EVT_SCHEMA, rid, [("", "content type must be application/json")])
        try:
            event = json.loads(raw.decode("utf-8", errors="replace"), parse_constant=_reject_constant)
        except (ValueError, RecursionError):
            return self._problem(ErrorCode.EVT_SCHEMA, rid, [("", "the body is not valid JSON")])
        if not isinstance(event, dict):
            return self._problem(ErrorCode.EVT_SCHEMA, rid, [("", "must be object")])

        bad = verify.usable_identity(event)
        if bad:
            return self._problem(ErrorCode.EVT_SCHEMA, rid, bad)
        # Integral floats (1.0) are the same number as 1 for the signature and the store, as in JavaScript.
        event["epoch"], event["seq"] = verify.as_count(event["epoch"]), verify.as_count(event["seq"])
        iid, epoch, seq = event["instance_id"], event["epoch"], event["seq"]

        current = self.epochs.current(iid)
        key = self.keys.event_key(iid, epoch) if current is not None else None
        # Both branches do one HMAC, so an unknown instance costs the same time as a wrong signature.
        ok = verify.verify_signature(verify.DUMMY_KEY if key is None else key, iid, epoch, seq, raw,
                                     verify.header_value(headers, verify.SIGNATURE_HEADER))
        if key is None:
            return self._refuse("unknown_instance", event, rid)
        if not ok:
            return self._refuse("bad_signature", event, rid)
        if epoch > current:
            return self._refuse("future_epoch", event, rid)

        data = event.get("data")
        if (event.get("type") == "evidence.capture" and isinstance(data, dict) and isinstance(data.get("body"), str)
                and len(data["body"].encode("utf-8", errors="surrogatepass")) > self.evidence_body_bytes):
            return self._problem(ErrorCode.EVT_TOO_LARGE, rid)
        errors = schema_mod.schema_errors(event, self._schema_file)
        if errors:
            return self._problem(ErrorCode.EVT_SCHEMA, rid, errors)
        ts = schema_mod.parse_ts(event["ts"])
        if ts is None:
            return self._problem(ErrorCode.EVT_SCHEMA, rid, [("/ts", "ts is not a usable time")])
        received = self.now()
        if ts > received + SKEW:
            return self._problem(ErrorCode.EVT_SCHEMA, rid, [("/ts", "is too far in the future")])

        outcome = self.store.put(event, verify.body_digest(raw), received)
        ident = {"instance_id": iid, "epoch": epoch, "seq": seq}
        if outcome is PutResult.DUPLICATE:
            return Reply(200, {"status": "duplicate", **ident})
        if outcome is PutResult.MISMATCH:
            return self._problem(ErrorCode.EVT_DUPLICATE_MISMATCH, rid)
        if outcome is PutResult.FULL:
            return self._problem(ErrorCode.EVT_STORE_FULL, rid)
        if self.sink is not None:
            try:
                self.sink(event, received)
            except Exception as exc:  # noqa: BLE001 - the event is stored; a failing consumer must not turn into a refusal
                logger.error("event consumer failed (%s) type=%s seq=%s", type(exc).__name__, event.get("type"), seq)
        return Reply(202, {"status": "accepted", **ident})


def _reject_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")
