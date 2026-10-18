"""Shared builders of the story 6.3 tests: a small world (directory, stores, engine, clock) and an IF-4 event builder.
Only tests use the fake KeyPort (D-79)."""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from vulnmart.flags.checker import FlagChecker
from vulnmart.ingest.engine import MilestoneEngine
from vulnmart.ingest.stores import (
    InMemoryEventLog, InMemoryFlagSubmissionLog, InMemoryInstanceDirectory, InMemoryIntegritySink, InMemoryMilestoneStore,
    InstanceInfo,
)
from vulnmart.ports.fakes import FakeKeyPort
from vulnmart.ports.reports import CHALLENGE_KEYS

ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = ROOT / "contracts" / "events" / "instance-events.schema.json"
CATALOG_DIR = ROOT / "challenges" / "catalog"
T0 = datetime(2026, 10, 17, 10, 0, 0, tzinfo=UTC)
KEYS = FakeKeyPort()
A, B = "i-AAAAAAAAAAAAAAAA", "i-BBBBBBBBBBBBBBBB"

_SOURCE = {"proxy.": "sidecar", "evidence.capture": "sidecar", "collector.hit": "mock", "meta.request_served": "mock",
           "gateway.ledger_entry": "mock", "import.job": "import"}


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def source_of(event_type: str) -> str:
    for prefix, src in _SOURCE.items():
        if event_type.startswith(prefix):
            return src
    return "shop"


class World:
    def __init__(self, *, rules=None, gate=None) -> None:
        self.directory = InMemoryInstanceDirectory()
        self.log = InMemoryEventLog()
        self.milestones = InMemoryMilestoneStore()
        self.integrity = InMemoryIntegritySink()
        self.submissions = InMemoryFlagSubmissionLog()
        self.checker = FlagChecker(KEYS)
        self.now = T0
        self._seq: dict[tuple[str, int], int] = {}
        kw = {"gate": gate} if gate is not None else {}
        self.engine = MilestoneEngine(log=self.log, milestones=self.milestones, integrity=self.integrity,
                                      directory=self.directory, checker=self.checker, rules=rules, **kw)

    def add_instance(self, iid: str = A, attempt: str = "a-1", epoch: int = 1, cks=CHALLENGE_KEYS,
                     template: str = "t-1") -> InstanceInfo:
        return self.directory.add(InstanceInfo(iid, attempt, template, epoch, tuple(cks)))

    def reset(self, iid: str) -> None:
        old = self.directory.get(iid)
        self.directory.add(InstanceInfo(iid, old.attempt_id, old.template_id, old.epoch + 1, old.challenge_keys))

    def event(self, etype: str, data: dict, *, iid: str = A, epoch: int | None = None, session_kind: str = "player",
              source: str | None = None, seq: int | None = None, user_id: str | None = "u-1001") -> dict:
        ep = epoch if epoch is not None else self.directory.get(iid).epoch
        if seq is None:
            seq = self._seq.get((iid, ep), 0) + 1
        self._seq[(iid, ep)] = max(seq, self._seq.get((iid, ep), 0))
        return {"schema_version": "0.1", "instance_id": iid, "epoch": ep, "seq": seq, "type": etype,
                "source": source or source_of(etype), "session_kind": session_kind, "user_id": user_id,
                "ts": "2026-10-17T10:00:00Z", "data": data}

    def send(self, etype: str, data: dict, *, dt: float = 0, **kw):
        """Build and process one event; `dt` seconds are added to the clock first."""
        self.now = self.now + timedelta(seconds=dt)
        return self.engine.process(self.event(etype, data, **kw), self.now)

    def send_flag(self, challenge: str, *, iid: str = A, epoch: int | None = None, of_instance: str | None = None,
                  of_epoch: int | None = None, kind: str = "real", decoy: int | None = None, **kw):
        ep = epoch if epoch is not None else self.directory.get(iid).epoch
        src_iid = of_instance or iid
        src_ep = of_epoch if of_epoch is not None else ep
        text = KEYS.decoy(src_iid, challenge, src_ep, decoy) if decoy is not None else KEYS.flag(src_iid, challenge, src_ep)
        data = {"kind": kind, "candidate_sha256": digest(text)}
        if kind != "foreign":
            data["challenge_key"] = challenge
        return self.send("proxy.flag_seen", data, iid=iid, epoch=epoch, **kw)

    def best(self, challenge: str, attempt: str = "a-1"):
        return self.milestones.best(attempt, challenge).value
