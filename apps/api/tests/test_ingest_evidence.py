"""Story 6.4: evidence sealed through KeyPort (FR-DET-03, D-22, D-77). Every row of the I/O matrix, with FakeKeyPort."""
from __future__ import annotations

import json
import logging
from datetime import timedelta

import pytest
from ingest_support import A, B, CATALOG_DIR, KEYS, T0, World, digest, load_schema  # noqa: F401

from vulnmart.ingest.evidence import (
    MARKER, EvidenceReader, EvidenceRecorder, InMemoryEvidenceStore, aad_of, blank_secrets, has_flag_pattern, redact_flag_like,
    redact_headers,
)
from vulnmart.ports.errors import AttemptGone, AttemptNotFound, KeyShredded
from vulnmart.ports.fakes import FakeKeyPort
from vulnmart.ports.reports import IntegrityType

REF = "r-AAAAAAAAAAAAAAAA"
REF2 = "r-BBBBBBBBBBBBBBBB"


class Rig:
    def __init__(self, *, keys=None, gate=None, max_body_bytes=8192):
        self.world = World(gate=gate)
        self.keys = keys or FakeKeyPort()
        self.store = InMemoryEvidenceStore()
        self.alarms: list[str] = []
        self.rec = EvidenceRecorder(keys=self.keys, store=self.store, directory=self.world.directory, checker=self.world.checker,
                                    milestones=self.world.milestones, integrity=self.world.integrity,
                                    max_body_bytes=max_body_bytes, alarm=self.alarms.append)
        self.reader = EvidenceReader(store=self.store, keys=self.keys)
        self.world.add_instance(A, "a-1")
        self.world.checker.keys = self.keys  # one KeyPort: the flags of the checker are the flags of this rig
        self.keys.create_attempt_key("a-1")

    def feed(self, etype, data, *, dt=0.0, **kw):
        self.world.now = self.world.now + timedelta(seconds=dt)
        ev = self.world.event(etype, data, **kw)
        res = self.world.engine.process(ev, self.world.now)
        self.rec.observe(ev, self.world.now, res)
        return res

    def flag(self, challenge="C05", *, ref=REF, kind="real", decoy=None, of_instance=None, of_epoch=None, **kw):
        iid = kw.get("iid", A)
        epoch = of_epoch if of_epoch is not None else self.world.directory.get(iid).epoch
        text = self.keys.decoy(of_instance or iid, challenge, epoch, decoy) if decoy is not None else self.keys.flag(of_instance or iid, challenge, epoch)
        data = {"kind": kind, "candidate_sha256": digest(text), "request_ref": ref}
        if kind != "foreign":
            data["challenge_key"] = challenge
        return self.feed("proxy.flag_seen", data, **kw)

    def capture(self, body="GET /_stub/planted-flag?key=C05\n\nuser=u1", *, ref=REF, headers=None, **kw):
        return self.feed("evidence.capture", {"request_ref": ref, "body": body, "headers_redacted": headers or {"user-agent": "t"}}, **kw)


def test_credited_capture_is_sealed_and_readable_and_unreadable_after_shred():
    r = Rig()
    r.flag()
    r.capture()
    items = r.reader.evidence("a-1")
    assert len(items) == 1 and items[0].challenge_key == "C05" and items[0].size > 0
    assert r.reader.evidence_body("a-1", items[0].evidence_id) == b"GET /_stub/planted-flag?key=C05\n\nuser=u1"
    row = r.store.rows("a-1")[0]
    assert row.sealed.ciphertext.startswith(b"FAKE-SEALED:") and b"planted" not in row.sealed.ciphertext  # the row holds sealed bytes only
    assert r.world.best("C05") == "M3"
    assert r.rec.stats.sealed == 1
    r.keys.shred("a-1")
    with pytest.raises(KeyShredded):
        r.reader.evidence_body("a-1", items[0].evidence_id)
    with pytest.raises(AttemptGone):
        r.reader.evidence("a-1")


def test_capture_first_is_held_and_sealed_when_the_flag_arrives():
    r = Rig()
    r.capture()
    assert r.store.rows("a-1") == []
    r.flag(dt=5)
    assert len(r.reader.evidence("a-1")) == 1


def test_capture_first_is_dropped_after_60_seconds_when_never_credited():
    r = Rig()
    r.capture()
    r.feed("proxy.request", {"method": "GET", "route_template": "/x", "status": 200, "resp_len": 1, "client_class": "other"}, dt=61)
    assert r.rec.stats.dropped_uncredited == 1
    r.flag(dt=1)  # too late: the capture is gone
    assert r.store.rows("a-1") == []


def test_late_capture_of_a_credited_flag_attaches_up_to_300_seconds_and_not_after():
    r = Rig()
    r.flag()
    r.capture(dt=250)
    assert len(r.store.rows("a-1")) == 1
    r2 = Rig()
    r2.flag()
    r2.capture(dt=301)  # the credited sighting is forgotten after 300 s: the capture waits and is dropped
    assert r2.store.rows("a-1") == []


@pytest.mark.parametrize("make", ["decoy", "foreign", "stale", "uncredited"])
def test_decoy_foreign_stale_or_uncredited_capture_stores_nothing(make):
    r = Rig()
    r.world.add_instance(B, "a-2", epoch=1)
    r.keys.create_attempt_key("a-2")
    if make == "decoy":
        r.flag(kind="decoy", decoy=0)
    elif make == "foreign":
        r.flag(kind="foreign", of_instance=B)
    elif make == "stale":
        r.world.reset(A)  # epoch 2 now
        r.flag(epoch=1, of_epoch=1)  # the sidecar of epoch 1 still reports the old flag
    else:  # a held flag is stored; a value that is correct but never reached the engine as credit does not exist, so use a wrong digest
        r.feed("proxy.flag_seen", {"kind": "real", "challenge_key": "C05", "candidate_sha256": digest("not a flag"), "request_ref": REF})
    r.capture(**({"epoch": 1} if make == "stale" else {}))
    assert r.store.rows("a-1") == [] and r.store.rows("a-2") == []
    assert r.rec.stats.sealed == 0 and r.rec.stats.dropped_uncredited >= 1


def test_held_flag_is_sealed_too():
    class Deny:
        def allows(self, attempt_id, challenge_key, at):
            return False

    r = Rig(gate=Deny())
    res = r.flag()
    assert res.held == ["C05"] and r.world.best("C05") == "none"
    r.capture()
    assert len(r.reader.evidence("a-1")) == 1


def test_over_8_kib_is_refused_counted_and_flagged():
    r = Rig()
    r.flag()
    r.capture(body="x" * 9000)
    assert r.store.rows("a-1") == []
    assert r.rec.stats.refused_too_large == 1
    assert [f.kind for f in r.world.integrity.of("a-1")] == [IntegrityType.ACTIVITY]
    assert "x" * 50 not in r.world.integrity.of("a-1")[0].explanation


def test_a_flag_still_in_the_body_is_stored_held_with_an_empty_body_and_an_integrity_flag():
    r = Rig()
    r.flag()
    leaked = "VM{" + "Q" * 24 + "}"
    r.capture(body=f"POST /x\n\nnote={leaked}")
    row = r.store.rows("a-1")[0]
    assert row.held_empty and row.size == 0
    assert r.reader.evidence_body("a-1", row.evidence_id) == b""
    assert r.rec.stats.flag_in_body == 1 and r.alarms == ["flag pattern in an evidence capture"]
    flags = r.world.integrity.of("a-1", IntegrityType.ACTIVITY)
    assert len(flags) == 1 and leaked not in flags[0].explanation


@pytest.mark.parametrize("body", ["a vm%7Bxyz", "a VM%7bxyz", "x \\u0056M{abc}", "x ｖＭ｛abc｝", "x vM{"])
def test_flag_patterns_in_other_forms_are_caught(body):
    assert has_flag_pattern(body)


def test_flag_pattern_in_a_header_is_caught():
    r = Rig()
    r.flag()
    r.capture(headers={"referer": "https://x/?q=VM{ABCDEFGH}"})
    assert r.store.rows("a-1")[0].held_empty


def test_second_redaction_pass_blanks_secrets_and_flag_like_text():
    text = 'POST /login\n\n{"password": "hunter2", "token":"abc", "name": "ok"}\npassword=pw&x=1&Cookie=zzz'
    out = blank_secrets(text)
    assert "hunter2" not in out and "abc" not in out and "pw&" not in out and "zzz" not in out and '"name": "ok"' in out
    assert redact_flag_like("see VM{ABC and VM%7BXYZ%7D end") == f"see {MARKER} and {MARKER} end"
    assert redact_headers({"Authorization": "Bearer q", "x-note": "a VM{AB}"}) == {"Authorization": "", "x-note": f"a {MARKER}"}


def test_the_sealed_body_has_the_secrets_blanked_again_on_arrival():
    r = Rig()
    r.flag()
    r.capture(body='POST /login\n\n{"password": "hunter2", "q": "ok"}')
    item = r.reader.evidence("a-1")[0]
    body = r.reader.evidence_body("a-1", item.evidence_id)
    assert b"hunter2" not in body and b'"q": "ok"' in body


def test_shredded_or_missing_key_drops_the_capture_and_never_writes_plaintext():
    r = Rig()
    r.keys.shred("a-1")
    r.flag()
    r.capture()
    assert r.store.rows("a-1") == [] and r.rec.stats.dropped_key == 1
    r2 = Rig(keys=FakeKeyPort())
    r2.keys._keys.clear()  # no key at all: AttemptNotFound
    r2.flag()
    r2.capture()
    assert r2.store.rows("a-1") == [] and r2.rec.stats.dropped_key == 1


def test_a_second_attempt_cannot_read_the_first_ones_evidence():
    r = Rig()
    r.world.add_instance(B, "a-2")
    r.keys.create_attempt_key("a-2")
    r.flag()
    r.capture()
    eid = r.reader.evidence("a-1")[0].evidence_id
    with pytest.raises(AttemptNotFound):
        r.reader.evidence_body("a-2", eid)
    assert r.reader.evidence("a-2") == ()
    with pytest.raises(AttemptNotFound):
        r.reader.evidence_body("a-1", "ev-nope")
    # the AAD binds instance, epoch, challenge and request: a different request ref does not open it
    row = r.store.rows("a-1")[0]
    assert row.aad == aad_of(A, 1, "C05", REF)
    from vulnmart.ports.errors import KeyIntegrity
    with pytest.raises(KeyIntegrity):
        r.keys.decrypt("a-1", row.sealed, aad_of(A, 1, "C05", REF2))


def test_one_row_per_request_ref_and_oldest_first():
    r = Rig()
    r.flag("C05", ref=REF)
    r.capture(ref=REF)
    r.capture(ref=REF)  # a duplicate of the same request
    r.flag("C01", ref=REF2, dt=2)
    r.capture(body="GET /two", ref=REF2, dt=1)
    items = r.reader.evidence("a-1")
    assert [i.challenge_key for i in items] == ["C05", "C01"] and r.rec.stats.duplicates == 1


def test_no_sealed_row_and_no_log_line_holds_a_flag(caplog):
    caplog.set_level(logging.DEBUG)
    r = Rig()
    real = r.keys.flag(A, "C05", 1)
    r.flag()
    r.capture(body=f"POST /x\n\nv={real}")  # a leak: held empty
    r.capture(body="POST /y", ref=REF2)  # no flag for this ref
    rows = r.store.rows("a-1")
    blob = repr(rows) + json.dumps([{"p": i.__dict__ if hasattr(i, "__dict__") else str(i)} for i in r.reader.evidence("a-1")], default=str)
    blob += repr(r.world.integrity.rows) + caplog.text + repr(r.rec.stats)
    assert real not in blob and "VM{" not in blob
    assert real.encode() not in b"".join(x.sealed.ciphertext for x in rows)


def test_bot_and_internal_events_never_become_evidence():
    r = Rig()
    r.flag(session_kind="bot", source="bot")
    r.capture(session_kind="bot", source="bot")
    assert r.store.rows("a-1") == [] and r.world.best("C05") == "none"


def test_unknown_instance_has_no_effect():
    r = Rig()
    ev = r.world.event("evidence.capture", {"request_ref": REF, "body": "x", "headers_redacted": {}})
    ev["instance_id"] = "i-ZZZZZZZZZZZZZZZZ"
    r.rec.observe(ev, T0)
    assert r.store.rows("a-1") == []
