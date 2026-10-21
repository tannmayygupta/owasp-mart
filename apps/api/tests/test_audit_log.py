"""Story P-17 (FR-PRV-10): the audit log on a database: appending, the hash chain and how it breaks, refused secrets, checkpoints, the daily anchor,
and the pseudonymous subjects. Runs on in-memory SQLite; the concurrent writers and the privileges are in test_audit_postgres.py."""
from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.kernel.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from vulnmart.accounts.fieldkeys import FieldKeys
from vulnmart.kernel.audit import AuditAnchors, AuditChainBroken, DbAuditPort, FileAnchorSink, ListAnchorSink, check_details
from vulnmart.kernel.db import Base
from vulnmart.kernel.models import AuditAnchor, AuditCheckpoint, AuditLog
from vulnmart.ports.audit import GENESIS_HASH, AuditPort, chain_hash, verify_chain
from vulnmart.privacy.models import SubjectMap
from vulnmart.privacy.subjects import PseudonymisingAudit, SubjectService

T0 = datetime(2026, 10, 18, 10, 0, 7, 123456, tzinfo=UTC)
ALICE, BOB = "u-AAAAAAAAAAAAAAAA", "u-BBBBBBBBBBBBBBBB"
KEYS = FieldKeys.from_secret(b"a field key secret of at least 32 bytes!!")


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def audit(sessions, clock):
    return DbAuditPort(sessions, now=clock)


def fill(audit, n=5):
    return [audit.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted", subject="s-BBBBBBBBBBBBBBBB", details={"n": i}) for i in range(n)]


# ---- appending and the chain ------------------------------------------------------------------------------------------------------

def test_the_db_port_is_an_audit_port(audit):
    assert isinstance(audit, AuditPort)


def test_entries_are_numbered_from_one_and_chained_from_the_genesis_hash(audit):
    records = fill(audit, 4)
    assert [r.seq for r in records] == [1, 2, 3, 4]
    assert records[0].prev_hash == GENESIS_HASH and all(b.prev_hash == a.row_hash for a, b in zip(records, records[1:]))
    assert verify_chain(records), "the same chain rule as the in-memory port: the records verify with the shared function"
    assert records[0].at == "2026-10-18T10:00:07Z", "whole seconds, UTC, with a Z"


def test_the_stored_rows_hash_to_what_the_port_returned(audit, sessions):
    records = fill(audit, 3)
    with sessions() as s:
        rows = s.scalars(select(AuditLog).order_by(AuditLog.seq)).all()
    assert [(r.seq, r.row_hash, r.prev_hash) for r in rows] == [(r.seq, r.row_hash, r.prev_hash) for r in records]
    assert json.loads(rows[0].details) == {"n": 0} and rows[0].details == '{"n":0}', "details are stored as the canonical JSON the hash covers"


def test_verify_an_empty_log_and_a_good_log(audit):
    empty = audit.verify()
    assert empty.ok and empty.checked == 0 and empty.head_seq is None
    fill(audit, 7)
    good = audit.verify(batch=3)  # several batches
    assert good.ok and good.checked == 7 and good.head_seq == 7 and len(good.head_hash) == 64


def test_head_and_entries(audit):
    assert audit.head() is None
    records = fill(audit, 4)
    assert audit.head() == (4, records[-1].row_hash)
    assert [r.seq for r in audit.entries(after_seq=2)] == [3, 4]
    audit.append(actor="s-AAAAAAAAAAAAAAAA", action="role.granted", subject="s-CCCCCCCCCCCCCCCC", details={"role": "candidate"})
    assert [r.action for r in audit.entries(action="role.granted")] == ["role.granted"]
    assert len(audit.entries(subject="s-BBBBBBBBBBBBBBBB")) == 4
    assert audit.entries(limit=2)[1].seq == 2 and audit.entries(limit=0)[0].seq == 1, "limit is between 1 and 1000"


def test_a_changed_entry_is_found(audit, sessions):
    fill(audit, 5)
    with sessions.begin() as s:
        s.execute(text("UPDATE audit_log SET actor = 's-EEEEEEEEEEEEEEEE' WHERE seq = 3"))
    result = audit.verify()
    assert (result.ok, result.bad_seq, result.reason) == (False, 3, "an entry was changed")
    assert result.checked == 2


@pytest.mark.parametrize("column,value", [("action", "role.revoked"), ("subject", "s-FFFFFFFFFFFFFFFF"), ("details", '{"n":99}'), ("at", "2030-01-01 00:00:00")])
def test_any_changed_column_is_found(audit, sessions, column, value):
    fill(audit, 3)
    with sessions.begin() as s:
        s.execute(text(f"UPDATE audit_log SET {column} = :v WHERE seq = 2"), {"v": value})
    assert audit.verify().bad_seq == 2


def test_a_removed_entry_is_found(audit, sessions):
    fill(audit, 5)
    with sessions.begin() as s:
        s.execute(text("DELETE FROM audit_log WHERE seq = 3"))
    result = audit.verify()
    assert (result.ok, result.bad_seq, result.reason) == (False, 4, "an entry is missing or out of order")


def test_a_swapped_pair_and_a_rewritten_tail_are_found(audit, sessions):
    fill(audit, 4)
    with sessions.begin() as s:  # rewrite entry 4 with a consistent hash of its own: it no longer follows entry 3
        s.execute(text("UPDATE audit_log SET prev_hash = :h WHERE seq = 4"), {"h": "a" * 64})
    assert audit.verify().reason == "an entry does not follow the one before it"


def test_the_whole_chain_rewritten_consistently_verifies_but_not_against_an_anchor(audit, sessions, clock):
    """This is why the anchor exists: a rewrite of every row and hash is internally consistent, so only a line kept elsewhere can show it."""
    sink = ListAnchorSink()
    fill(audit, 4)
    anchors = AuditAnchors(audit, sessions, lambda t: KEYS.context_hash("audit-anchor", t), sink, now=clock)
    anchors.anchor()
    with sessions.begin() as s:
        s.execute(text("DELETE FROM audit_log"))
    forged = DbAuditPort(sessions, now=clock)
    for i in range(4):
        forged.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted", subject="s-BBBBBBBBBBBBBBBB", details={"n": i, "forged": True})
    assert forged.verify().ok, "a consistent rewrite verifies by itself"
    assert anchors.check(sink.published) == ["line 1: entry 4 is not the one that was anchored"]


# ---- what may not be written -------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("details", [
    {"password": "x"}, {"token": "x"}, {"api_key": "x"}, {"mfa_secret": "x"}, {"Authorization": "x"}, {"session_cookie": "x"}, {"otp": "123456"},
    {"nested": {"deeper": {"private_key": "x"}}}, {"list": [{"credential": "x"}]},
    {"note": "A" * 43}, {"note": "abcDEF0123456789abcDEF0123456789abcDEF0123456789"}, {"list": ["short", "Z" * 60]},
])
def test_secrets_and_token_like_values_are_refused_and_nothing_is_written(audit, sessions, details):
    with pytest.raises(ValueError) as e:
        audit.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted", details=details)
    assert "A" * 40 not in str(e.value) and "abcDEF" not in str(e.value), "the message names the key, never the value"
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(AuditLog)) == 0


def test_hashes_ids_and_short_words_are_allowed(audit):
    audit.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted", details={
        "notice_sha256": "a" * 64, "consent": "k-AAAAAAAAAAAAAAAA", "attempt": "a-BBBBBBBBBBBBBBBB", "via": "seed", "type": "totp", "n": 3, "ok": True, "none": None})
    assert audit.verify().ok


@pytest.mark.parametrize("kw", [
    {"actor": "", "action": "a.b"}, {"actor": "x", "action": ""}, {"actor": "x", "action": "Consent.Granted"}, {"actor": "x", "action": "nodot"},
    {"actor": "x", "action": "a.b", "details": {"v": float("nan")}}, {"actor": "x", "action": "a.b", "details": {1: "x"}},
    {"actor": "x", "action": "a.b", "details": {"big": "x" * 5000}}, {"actor": "x", "action": "a.b", "details": {"bad": object()}},
])
def test_malformed_entries_are_refused(audit, kw):
    with pytest.raises(ValueError):
        audit.append(**kw)


def test_check_details_accepts_plain_values():
    check_details({"a": [1, 2, {"b": "c"}], "d": "e" * 39})


# ---- checkpoint --------------------------------------------------------------------------------------------------------------------------

def test_the_chain_verifies_from_a_checkpoint_after_old_entries_are_purged(audit, sessions):
    records = fill(audit, 6)
    with sessions.begin() as s:  # what the purge of story P-24 will do: write the checkpoint first, then delete the old rows
        s.add(AuditCheckpoint(seq=3, hash=records[2].row_hash, reason="retention"))
        s.execute(text("DELETE FROM audit_log WHERE seq <= 3"))
    result = audit.verify()
    assert result.ok and result.checked == 3 and result.head_seq == 6
    nxt = audit.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted")
    assert nxt.seq == 7 and nxt.prev_hash == records[-1].row_hash and audit.verify().ok


def test_a_wrong_checkpoint_hash_is_found(audit, sessions):
    records = fill(audit, 4)
    with sessions.begin() as s:
        s.add(AuditCheckpoint(seq=2, hash="b" * 64, reason="retention"))
        s.execute(text("DELETE FROM audit_log WHERE seq <= 2"))
    assert audit.verify().bad_seq == 3 and records


def test_a_log_purged_to_nothing_continues_from_the_checkpoint(audit, sessions):
    records = fill(audit, 3)
    with sessions.begin() as s:
        s.add(AuditCheckpoint(seq=3, hash=records[-1].row_hash, reason="retention"))
        s.execute(text("DELETE FROM audit_log"))
    assert audit.verify().ok
    assert audit.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted").seq == 4 and audit.verify().ok


# ---- the anchor --------------------------------------------------------------------------------------------------------------------------

def make_anchors(audit, sessions, clock, sink=None):
    return AuditAnchors(audit, sessions, lambda t: KEYS.context_hash("audit-anchor", t), sink, now=clock)


def test_an_anchor_is_one_signed_line_a_day_in_the_table_and_the_sink(audit, sessions, clock):
    sink = ListAnchorSink()
    anchors = make_anchors(audit, sessions, clock, sink)
    records = fill(audit, 3)
    first = anchors.anchor()
    assert (first.anchor_date, first.head_seq, first.head_hash, first.created, first.witness) == (date(2026, 10, 18), 3, records[-1].row_hash, True, "file")
    [line] = sink.published
    day, seq, head, signature = line.split(" ")
    assert (day, seq, head) == ("2026-10-18", "3", records[-1].row_hash) and signature == KEYS.context_hash("audit-anchor", f"{day} {seq} {head}")
    with sessions() as s:
        row = s.get(AuditAnchor, date(2026, 10, 18))
    assert (row.head_seq, row.head_hash, row.witness) == (3, records[-1].row_hash, "file")
    audit.append(actor="s-AAAAAAAAAAAAAAAA", action="consent.granted")
    again = anchors.anchor()
    assert again.created is False and again.head_seq == 3 and len(sink.published) == 1, "one anchor a day: the same day changes nothing"
    clock.advance(days=1)
    tomorrow = anchors.anchor()
    assert tomorrow.created and tomorrow.head_seq == 4 and len(sink.published) == 2


def test_without_a_sink_the_witness_is_the_database_only(audit, sessions, clock):
    fill(audit, 2)
    assert make_anchors(audit, sessions, clock, None).anchor().witness == "db"


def test_an_empty_log_is_started_by_the_first_anchor_and_a_broken_chain_anchors_nothing(audit, sessions, clock):
    sink = ListAnchorSink()
    anchors = make_anchors(audit, sessions, clock, sink)
    first = anchors.anchor()  # a new deployment: the log is empty, so the anchor starts the chain with one entry and anchors that
    assert first.created and first.head_seq == 1 and len(sink.published) == 1
    assert [r.action for r in audit.entries()] == ["audit.chain_started"]
    assert audit.verify().ok
    fill(audit, 3)
    with sessions.begin() as s:
        s.execute(text("UPDATE audit_log SET actor = 's-ZZZZZZZZZZZZZZZZ' WHERE seq = 2"))
    with pytest.raises(AuditChainBroken, match="entry 2"):
        anchors.anchor()
    assert len(sink.published) == 1
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(AuditAnchor)) == 1


def test_a_sink_that_cannot_write_leaves_no_anchor_row(audit, sessions, clock):
    class Broken:
        def publish(self, line):
            raise OSError("disk full")

    fill(audit, 2)
    with pytest.raises(OSError):
        make_anchors(audit, sessions, clock, Broken()).anchor()
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(AuditAnchor)) == 0


def test_check_finds_a_forged_line_a_wrong_hash_and_a_log_cut_short(audit, sessions, clock):
    sink = ListAnchorSink()
    anchors = make_anchors(audit, sessions, clock, sink)
    fill(audit, 3)
    anchors.anchor()
    fill(audit, 2)
    clock.advance(days=1)
    anchors.anchor()
    assert anchors.check(sink.published) == []
    day, seq, head, signature = sink.published[0].split(" ")
    assert anchors.check([f"{day} {seq} {'c' * 64} {signature}"]) == ["line 1: the signature does not match"]
    forged = f"{day} {seq} {'c' * 64} {KEYS.context_hash('audit-anchor', f'{day} {seq} {chr(99) * 64}')}"
    assert anchors.check([forged]) == ["line 1: entry 3 is not the one that was anchored"], "only a signer with the key could make this line, and the chain disagrees"
    assert anchors.check(["not an anchor"]) == ["line 1: not an anchor line"]
    with sessions.begin() as s:
        s.execute(text("DELETE FROM audit_log WHERE seq > 3"))
    assert anchors.check(sink.published) == ["line 2: entry 5 is gone (the log was cut short)"]


def test_a_line_older_than_the_purge_is_not_a_problem(audit, sessions, clock):
    sink = ListAnchorSink()
    anchors = make_anchors(audit, sessions, clock, sink)
    records = fill(audit, 4)
    anchors.anchor()
    with sessions.begin() as s:
        s.add(AuditCheckpoint(seq=4, hash=records[-1].row_hash, reason="retention"))
        s.execute(text("DELETE FROM audit_log"))
    assert anchors.check(sink.published) == []
    with sessions.begin() as s:
        s.execute(text("UPDATE audit_checkpoint SET hash = :h"), {"h": "d" * 64})
    assert anchors.check(sink.published) == ["line 1: the checkpoint at 4 is not the entry that was anchored"]


def test_the_file_sink_appends_one_line_each_and_refuses_a_second_line(tmp_path):
    sink = FileAnchorSink(tmp_path / "deep" / "anchors.log")
    assert sink.lines() == []
    sink.publish("one")
    sink.publish("two")
    assert sink.lines() == ["one", "two"]
    with pytest.raises(ValueError):
        sink.publish("a\nb")


# ---- pseudonymous subjects ---------------------------------------------------------------------------------------------------------------

@pytest.fixture
def subjects(sessions):
    return SubjectService(sessions)


def test_a_user_has_one_stable_random_pseudonym(subjects, sessions):
    a = subjects.pseudonym(ALICE)
    assert a.startswith("s-") and len(a) == 18 and a == subjects.pseudonym(ALICE) and a != subjects.pseudonym(BOB)
    assert ALICE not in a
    with pytest.raises(ValueError):
        subjects.pseudonym("alice@example.com")


def test_the_identity_is_known_only_until_the_mapping_is_forgotten(subjects, sessions):
    s = subjects.pseudonym(ALICE)
    assert subjects.identity(s) == ALICE
    assert subjects.forget(ALICE) is True and subjects.identity(s) is None and subjects.forget(ALICE) is False
    assert subjects.pseudonym(ALICE) != s, "a returning account gets a new pseudonym; the old entries stay unlinked"


def test_the_pseudonymising_audit_writes_pseudonyms_for_user_ids_everywhere(audit, subjects, sessions):
    port = PseudonymisingAudit(audit, subjects)
    assert isinstance(port, AuditPort)
    record = port.append(actor=ALICE, action="role.granted", subject=BOB, details={"role": "candidate", "by": ALICE, "list": [BOB, "x"], "nested": {"who": ALICE}})
    pa, pb = subjects.pseudonym(ALICE), subjects.pseudonym(BOB)
    assert (record.actor, record.subject) == (pa, pb)
    assert record.details == {"role": "candidate", "by": pa, "list": [pb, "x"], "nested": {"who": pa}}
    with sessions() as s:
        stored = s.scalars(select(AuditLog)).one()
    assert ALICE not in json.dumps([stored.actor, stored.subject, stored.details]) and BOB not in json.dumps([stored.actor, stored.subject, stored.details])
    assert port.verify().ok and port.head()[0] == 1, "reading goes straight to the log"


def test_system_actors_and_non_user_ids_pass_through(audit, subjects):
    port = PseudonymisingAudit(audit, subjects)
    r = port.append(actor="job:retention", action="retention.sweep", subject=None, details={"attempt": "a-AAAAAAAAAAAAAAAA", "org": "o-1"})
    assert r.actor == "job:retention" and r.subject is None and r.details == {"attempt": "a-AAAAAAAAAAAAAAAA", "org": "o-1"}


def test_after_forget_the_entries_stay_valid_and_identify_nobody(audit, subjects, sessions):
    port = PseudonymisingAudit(audit, subjects)
    port.append(actor=ALICE, action="consent.granted", subject=ALICE, details={"attempt": "a-AAAAAAAAAAAAAAAA"})
    port.append(actor=BOB, action="consent.granted", subject=BOB)
    pseudonym = subjects.pseudonym(ALICE)
    subjects.forget(ALICE)
    assert port.verify().ok and subjects.identity(pseudonym) is None
    entry = audit.entries(subject=pseudonym)[0]
    assert entry.actor == pseudonym and entry.action == "consent.granted"
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(SubjectMap).where(SubjectMap.user_id == ALICE)) == 0
