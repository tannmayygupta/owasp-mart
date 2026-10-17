"""Shared builders of the story edge-4 tests (the real event receiver): throwaway keys from the written key vector, signed
requests, a handler with in-memory stores and a fixed clock. Only tests use the fake KeyPort."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from vulnmart.ingest.handler import IngestHandler
from vulnmart.ingest.store import MemoryEventStore, MemoryInstanceEpochs, MemorySecuritySink
from vulnmart.ingest.verify import sign_body
from vulnmart.ports.fakes import FakeKeyPort

ROOT = Path(__file__).resolve().parents[3]
EXAMPLES = ROOT / "contracts" / "events" / "examples"
VECTOR = json.loads((EXAMPLES / "event-key-vector.json").read_text(encoding="utf-8"))
MASTER = bytes.fromhex(VECTOR["master_hex"])  # a FAKE master, written in the contract
KEYS = FakeKeyPort(event_master=MASTER)
NOW = datetime(2026, 1, 1, 0, 10, 0, tzinfo=UTC)
A, B = "i-AAAAAAAAAAAAAAAA", "i-BBBBBBBBBBBBBBBB"
JSON_HEADERS = {"content-type": "application/json"}


def example(name: str, kind: str = "valid") -> dict:
    return json.loads((EXAMPLES / kind / "instance-events" / name).read_text(encoding="utf-8"))


def flag_event(**over) -> dict:
    return {**example("proxy.flag_seen.json"), **over}


def signed(event: dict, *, key: str | None = None, body: bytes | None = None, headers: dict | None = None):
    """(headers, raw) for a request. `key` defaults to the real key of the event's own (instance, epoch)."""
    raw = body if body is not None else json.dumps(event).encode("utf-8")
    k = key if key is not None else KEYS.event_key(event["instance_id"], event["epoch"])
    out = {**JSON_HEADERS, "x-vm-signature": sign_body(k, event["instance_id"], event["epoch"], event["seq"], raw)}
    out.update(headers or {})
    return out, raw


class Parts:
    """A handler and the stores behind it, so a test can look at what happened."""

    def __init__(self, epochs: dict | None = None, **kw) -> None:
        self.epochs = MemoryInstanceEpochs(epochs if epochs is not None else {A: 1})
        self.store = MemoryEventStore(kw.pop("max_stored", 100_000))
        self.security = MemorySecuritySink()
        self.sunk: list = []
        sink = kw.pop("sink", None) or (lambda event, at: self.sunk.append((event, at)))
        self.handler = IngestHandler(keys=KEYS, epochs=self.epochs, store=self.store, sink=sink, security=self.security,
                                     now=lambda: NOW, **kw)

    def post(self, event: dict, **kw):
        headers, raw = signed(event, **kw)
        return self.handler.handle(headers, raw, "req-test-0001")
