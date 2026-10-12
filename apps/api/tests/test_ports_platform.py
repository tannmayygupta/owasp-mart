"""The six ports stream P provides (IF-9) and their in-memory fakes: each fake satisfies its Protocol and behaves as the
port's docstring says (audit hash chain, outbox checks, key service derivations and shredding, scope refusals,
settings and quotas). The key derivations are checked against the shared HKDF vector of IF-4."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import threading
from dataclasses import replace

import pytest
from jsonschema import Draft202012Validator

from support import ROOT
from vulnmart.ports import errors
from vulnmart.ports.audit import GENESIS_HASH, AuditPort, canonical_json, chain_hash, verify_chain
from vulnmart.ports.fakes import (
    FAKE_EVENT_MASTER, FakeAuditPort, FakeKeyPort, FakeOutboxPort, FakeQuotaPort, FakeScopePort, FakeSettingsPort,
)
from vulnmart.ports.keys import KeyPort, derive_event_key, derive_flag, hkdf_sha256
from vulnmart.ports.outbox import AUDIENCES, EVENT_TYPES, OutboxPort
from vulnmart.ports.quota import DEFAULT_MAX_INSTANCES, QuotaPort
from vulnmart.ports.scope import Role, Scope, ScopePort
from vulnmart.ports.settings import SETTINGS, SettingsPort
from vulnmart_models.error_codes import ERRORS

DOMAIN_EVENTS = ROOT / "contracts" / "domain-events"
VECTOR = json.loads((ROOT / "contracts" / "events" / "examples" / "event-key-vector.json").read_text(encoding="utf-8"))
FIXED = "2026-10-12T09:00:00Z"


def clock() -> str:
    return FIXED


@pytest.mark.parametrize(("fake", "port"), [
    (FakeAuditPort(), AuditPort), (FakeOutboxPort(), OutboxPort), (FakeKeyPort(), KeyPort),
    (FakeScopePort(), ScopePort), (FakeSettingsPort(), SettingsPort), (FakeQuotaPort(), QuotaPort),
])
def test_every_fake_satisfies_its_protocol(fake, port):
    assert isinstance(fake, port)


def test_every_port_error_carries_a_registry_code_and_its_status_one_class_per_code():
    for code, cls in errors.ERRORS_BY_CODE.items():
        assert cls.code is code and cls.http_status == (ERRORS[code].status or 500), cls.__name__
    for sub in (errors.ScopeMissing, errors.UnknownSetting, errors.KeyIntegrity):
        assert issubclass(sub, errors.ERRORS_BY_CODE[sub.code]) and sub.http_status == 500
    err = errors.KeyShredded("x")
    assert (err.code.value, err.http_status) == ("ATT-GONE", 410)
    assert isinstance(err, errors.AttemptGone), "a shred is answered like a purge"
    assert not isinstance(errors.AttemptGone("purged"), errors.KeyShredded), "except KeyShredded does not catch a purge"


# ---- audit ----

def test_audit_appends_a_gapless_hash_chain():
    audit = FakeAuditPort(now=clock)
    a = audit.append(actor="u-AAAAAAAAAAAAAAAA", action="consent.granted", subject="s-1", details={"notice_version": 3})
    b = audit.append(actor="job:retention", action="attempt.purged", subject="s-2")
    c = audit.append(actor="u-AAAAAAAAAAAAAAAA", action="session.created")
    assert [r.seq for r in audit.records] == [1, 2, 3]
    assert a.prev_hash == GENESIS_HASH and b.prev_hash == a.row_hash and c.prev_hash == b.row_hash
    # the documented formula, recomputed independently
    body = {"seq": 1, "at": FIXED, "actor": "u-AAAAAAAAAAAAAAAA", "action": "consent.granted", "subject": "s-1", "details": {"notice_version": 3}}
    expected = hashlib.sha256(GENESIS_HASH.encode() + json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert a.row_hash == expected == chain_hash(GENESIS_HASH, body)
    assert verify_chain(audit.records)


@pytest.mark.parametrize("change", ["details", "drop", "swap", "action"])
def test_a_changed_removed_or_reordered_record_breaks_the_chain(change):
    audit = FakeAuditPort(now=clock)
    for n in range(4):
        audit.append(actor="u-A", action=f"act.{n}", details={"n": n})
    records = list(audit.records)
    if change == "details":
        records[1] = replace(records[1], details={"n": 99})
    elif change == "action":
        records[2] = replace(records[2], action="act.other")
    elif change == "drop":
        del records[1]
    else:
        records[1], records[2] = records[2], records[1]
    assert not verify_chain(records)


def test_audit_refuses_an_empty_actor_or_action_and_values_json_cannot_hold():
    audit = FakeAuditPort()
    with pytest.raises(ValueError):
        audit.append(actor="", action="x")
    with pytest.raises(ValueError):
        audit.append(actor="u", action="")
    with pytest.raises((ValueError, TypeError)):
        audit.append(actor="u", action="x", details={"bad": float("nan")})
    with pytest.raises((ValueError, TypeError)):
        audit.append(actor="u", action="x", details={"bad": object()})
    assert audit.records == []


def test_audit_appends_from_many_threads_keep_one_chain():
    audit = FakeAuditPort()
    threads = [threading.Thread(target=lambda i=i: [audit.append(actor="u", action=f"a.{i}") for _ in range(25)]) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r.seq for r in audit.records] == list(range(1, 201))
    assert verify_chain(audit.records)


def test_canonical_json_is_the_same_bytes_whatever_the_key_order():
    assert canonical_json({"b": 1, "a": "é"}) == canonical_json({"a": "é", "b": 1}) == '{"a":"é","b":1}'.encode()


# ---- outbox ----

def valid_examples() -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted((DOMAIN_EVENTS / "examples" / "valid").glob("*.json"))]


def test_the_outbox_accepts_every_valid_if3_example_of_a_publishable_type_in_order():
    outbox = FakeOutboxPort(now=clock)
    schema = json.loads((DOMAIN_EVENTS / "domain-events.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    published = [e for e in valid_examples() if e["type"] in EVENT_TYPES]
    assert {e["type"] for e in published} == set(EVENT_TYPES), "every publishable type has a valid example"
    for e in published:
        outbox.publish(e)
    assert [x.id for x in outbox.events] == list(range(1, len(published) + 1))
    for entry, sent in zip(outbox.events, published, strict=True):
        assert entry.event == sent
        assert not list(validator.iter_errors(entry.event)), "what the relay reads is an IF-3 event"


def test_the_publishable_types_are_the_if3_types_except_the_control_event():
    audiences = json.loads((DOMAIN_EVENTS / "audiences.json").read_text(encoding="utf-8"))
    assert set(EVENT_TYPES) == set(audiences["types"])
    assert not set(audiences["control"]) & EVENT_TYPES


def test_the_audience_table_is_the_one_of_if3():
    table = json.loads((DOMAIN_EVENTS / "audiences.json").read_text(encoding="utf-8"))["types"]
    assert {t: {m: list(k) for m, k in modes.items()} for t, modes in AUDIENCES.items()} == table


def test_each_published_event_carries_the_audiences_the_server_resolves():
    outbox = FakeOutboxPort()
    by_type = {e["type"]: e for e in valid_examples()}
    learner = {**by_type["attempt.milestone_reached"], "data": {**by_type["attempt.milestone_reached"]["data"], "mode": "learner"}}
    candidate = {**learner, "data": {**learner["data"], "mode": "candidate"}}
    assert outbox.publish(learner).audiences == ("user",)
    assert outbox.publish(candidate).audiences == ("org",), "a candidate's own milestone goes to the company only (OI-15)"
    assert outbox.publish(by_type["instance.state_changed"]).audiences == ("user", "admin")
    # the privacy wall: no learner event ever reaches an organisation
    for t in AUDIENCES:
        if t.startswith("attempt."):
            ev = {**by_type[t], "data": {**by_type[t]["data"], "mode": "learner"}}
            assert "org" not in outbox.publish(ev).audiences, t
    with pytest.raises(errors.EventInvalid):
        outbox.publish({**learner, "data": {**learner["data"], "mode": "visitor"}})


@pytest.mark.parametrize(("change", "field"), [
    ({"type": "stream.resync"}, "/type"),
    ({"type": "attempt.unknown"}, "/type"),
    ({"schema_version": 2}, "/schema_version"),
    ({"audience": "org"}, "/audience"),
    ({"data": None}, "/data"),
    ({"data": {"attempt_id": "a-AAAAAAAAAAAAAAAA", "state": "running", "previous_state": "ready", "deadline_at": None}}, "/data/mode"),
    ({"data": {"attempt_id": "a-AAAAAAAAAAAAAAAA", "mode": "visitor", "state": "running", "previous_state": "ready", "deadline_at": None}}, "/data/mode"),
])
def test_the_outbox_refuses_what_is_not_an_if3_event(change, field):
    outbox = FakeOutboxPort()
    event = {**next(e for e in valid_examples() if e["type"] == "attempt.state_changed"), **change}
    with pytest.raises(errors.EventInvalid) as err:
        outbox.publish(event)
    assert err.value.field == field
    assert err.value.code.value == "EVT-SCHEMA"
    assert outbox.events == []


def test_the_outbox_keeps_a_copy_so_a_later_change_by_the_caller_does_not_change_the_queue():
    outbox = FakeOutboxPort()
    event = json.loads(json.dumps(next(e for e in valid_examples() if e["type"] == "attempt.flag_captured")))
    original = event["data"]["challenge_key"]
    outbox.publish(event)
    event["data"]["challenge_key"] = "C01" if original != "C01" else "C02"
    assert outbox.events[0].event["data"]["challenge_key"] == original


def test_emails_name_a_template_and_a_user_never_an_address():
    outbox = FakeOutboxPort(now=clock)
    job = outbox.enqueue_email(template="invite", to_user_id="u-AAAAAAAAAAAAAAAA", params={"assessment": "Spring hiring"})
    assert (job.id, job.template, job.created_at) == (1, "invite", FIXED)
    with pytest.raises(ValueError):
        outbox.enqueue_email(template="invite", to_user_id="u-A", params={"to": "ada@example.org"})
    with pytest.raises(ValueError):
        outbox.enqueue_email(template="", to_user_id="u-A")
    assert len(outbox.emails) == 1


# ---- keys ----

@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda c: f"{c['instance_id']}-e{c['epoch']}")
def test_the_event_key_reproduces_the_if4_vector(case):
    assert bytes.fromhex(VECTOR["master_hex"]) == FAKE_EVENT_MASTER
    assert FakeKeyPort().event_key(case["instance_id"], case["epoch"]) == case["key"]
    assert derive_event_key(FAKE_EVENT_MASTER, case["instance_id"], case["epoch"]) == case["key"]


def test_hkdf_matches_rfc_5869_test_case_1():
    ikm = bytes.fromhex("0b" * 22)
    okm = hkdf_sha256(ikm, bytes.fromhex("000102030405060708090a0b0c"), bytes.fromhex("f0f1f2f3f4f5f6f7f8f9"), 42)
    assert okm.hex() == "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"


def test_the_event_key_refuses_an_epoch_that_is_not_a_positive_integer():
    for bad in (0, -1, True, 1.0, "1"):
        with pytest.raises(ValueError):
            FakeKeyPort().event_key("i-AAAAAAAAAAAAAAAA", bad)


def test_flags_and_decoys_have_the_contract_format_and_are_separated_by_every_input():
    keys = FakeKeyPort()
    flag = keys.flag("i-AAAAAAAAAAAAAAAA", "C03", 1)
    assert re.fullmatch(r"VM\{[A-Z2-7]{24}\}", flag)
    others = {
        keys.flag("i-AAAAAAAAAAAAAAAA", "C03", 2), keys.flag("i-BBBBBBBBBBBBBBBB", "C03", 1), keys.flag("i-AAAAAAAAAAAAAAAA", "C04", 1),
        keys.decoy("i-AAAAAAAAAAAAAAAA", "C03", 1, 0), keys.decoy("i-AAAAAAAAAAAAAAAA", "C03", 1, 1),
    }
    assert flag not in others and len(others) == 5
    assert all(re.fullmatch(r"VM\{[A-Z2-7]{24}\}", f) for f in others)
    assert keys.flag("i-AAAAAAAAAAAAAAAA", "C03", 1) == flag, "deterministic: there is no flag table"
    assert FakeKeyPort(flag_key=b"FAKE-OTHER-KEY").flag("i-AAAAAAAAAAAAAAAA", "C03", 1) != flag


def test_the_flag_input_is_length_prefixed_so_parts_cannot_slide_into_each_other():
    key = b"FAKE"
    # without framing "ab"+"c" and "a"+"bc" would give the same MAC input
    assert derive_flag(key, "i-ab", "C01", 1) != derive_flag(key, "i-a", "bC01", 1)
    framed = b"".join(len(p).to_bytes(4, "big") + p for p in (b"vm-flag-v1", b"i-AAAAAAAAAAAAAAAA", b"C03", b"1"))
    mac = hmac.new(key, framed, hashlib.sha256).digest()
    assert derive_flag(key, "i-AAAAAAAAAAAAAAAA", "C03", 1) == "VM{" + base64.b32encode(mac).decode()[:24] + "}"


def test_the_owner_hash_is_64_hex_and_reveals_nothing_of_the_user_id():
    keys = FakeKeyPort()
    h = keys.owner_hash("u-AAAAAAAAAAAAAAAA")
    assert re.fullmatch(r"[0-9a-f]{64}", h)
    assert h != keys.owner_hash("u-BBBBBBBBBBBBBBBB") and "AAAA" not in h
    assert h == keys.owner_hash("u-AAAAAAAAAAAAAAAA")


def test_sealed_evidence_opens_with_its_attempt_key_and_its_associated_data_only():
    keys = FakeKeyPort()
    k = keys.create_attempt_key("a-AAAAAAAAAAAAAAAA")
    assert keys.create_attempt_key("a-AAAAAAAAAAAAAAAA") == k, "idempotent"
    keys.create_attempt_key("a-BBBBBBBBBBBBBBBB")
    sealed = keys.encrypt("a-AAAAAAAAAAAAAAAA", b"POST /checkout", aad=b"evidence:C03")
    assert b"checkout" not in sealed.ciphertext
    assert "ciphertext" not in repr(sealed), "the sealed bytes never reach a log"
    assert keys.decrypt("a-AAAAAAAAAAAAAAAA", sealed, aad=b"evidence:C03") == b"POST /checkout"
    with pytest.raises(errors.KeyIntegrity):
        keys.decrypt("a-AAAAAAAAAAAAAAAA", sealed, aad=b"evidence:C04")
    with pytest.raises(errors.KeyIntegrity):
        keys.decrypt("a-BBBBBBBBBBBBBBBB", sealed, aad=b"evidence:C03")


def test_a_shredded_key_makes_its_evidence_unreadable_for_good():
    keys = FakeKeyPort()
    keys.create_attempt_key("a-AAAAAAAAAAAAAAAA")
    sealed = keys.encrypt("a-AAAAAAAAAAAAAAAA", b"captured request")
    assert keys.shred("a-AAAAAAAAAAAAAAAA") is True
    with pytest.raises(errors.KeyShredded) as err:
        keys.decrypt("a-AAAAAAAAAAAAAAAA", sealed)
    assert err.value.code.value == "ATT-GONE"
    with pytest.raises(errors.KeyShredded):
        keys.encrypt("a-AAAAAAAAAAAAAAAA", b"more")
    with pytest.raises(errors.KeyShredded):
        keys.create_attempt_key("a-AAAAAAAAAAAAAAAA")  # a shredded attempt never gets a new key
    assert keys.shred("a-AAAAAAAAAAAAAAAA") is False


def test_without_a_key_the_attempt_is_not_found():
    keys = FakeKeyPort()
    with pytest.raises(errors.AttemptNotFound):
        keys.encrypt("a-ZZZZZZZZZZZZZZZZ", b"x")
    assert keys.shred("a-ZZZZZZZZZZZZZZZZ") is False


# ---- scope ----

def test_scope_refuses_a_call_without_a_user_or_an_organisation():
    scope = FakeScopePort()
    with pytest.raises(errors.ScopeMissing) as err:
        scope.current()
    assert err.value.code.value == "REQ-INTERNAL"
    with scope.acting_as(Scope("u-AAAAAAAAAAAAAAAA", roles=frozenset({Role.LEARNER}))):
        assert scope.current().user_id == "u-AAAAAAAAAAAAAAAA"
        with pytest.raises(errors.ScopeMissing):
            scope.require_org()  # a learner has no organisation: an org-scoped query is refused, not answered with everything
    with scope.acting_as(Scope("u-RRRRRRRRRRRRRRRR", org_id="o-1", roles=frozenset({Role.RECRUITER}))):
        assert scope.require_org() == "o-1"
    with pytest.raises(errors.ScopeMissing):
        scope.current()  # the block ended


def test_scope_set_in_one_thread_does_not_leak_into_another():
    scope = FakeScopePort()
    seen = []

    def worker():
        try:
            seen.append(scope.current().user_id)
        except errors.ScopeMissing:
            seen.append("refused")

    with scope.acting_as(Scope("u-main", org_id="o-main")):
        t = threading.Thread(target=worker)
        t.start()
        t.join()
        assert scope.current().user_id == "u-main"
    assert seen == ["refused"]


def test_admin_scope():
    assert Scope("u-A", roles=frozenset({Role.ADMIN})).is_admin
    assert not Scope("u-A").is_admin


# ---- settings and quota ----

def test_settings_are_a_closed_list_with_typed_overrides():
    settings = FakeSettingsPort({"session_idle_minutes": 20})
    assert settings.get("session_idle_minutes") == 20
    assert settings.get("session_absolute_hours") == SETTINGS["session_absolute_hours"] == 12
    with pytest.raises(errors.UnknownSetting):
        settings.get("session_idle_minuets")
    with pytest.raises(errors.UnknownSetting):
        FakeSettingsPort({"no_such": 1})
    with pytest.raises(ValueError):
        FakeSettingsPort({"session_idle_minutes": "20"})
    with pytest.raises(ValueError):
        FakeSettingsPort({"hints_enabled_default": 1})


def test_the_most_specific_quota_wins():
    quota = FakeQuotaPort()
    assert quota.max_instances("u-A") == DEFAULT_MAX_INSTANCES == 1
    quota.orgs["o-1"] = 3
    assert quota.max_instances("u-A", "o-1") == 3
    assert quota.max_instances("u-A") == 1, "the organisation quota applies only inside that organisation"
    quota.users["u-A"] = 2
    assert quota.max_instances("u-A", "o-1") == 2
    quota.global_max = 5
    assert quota.max_instances("u-B") == 5


# ---- found by the review ----

def test_an_invalid_if3_example_without_a_mode_or_carrying_a_flag_is_refused_and_never_reaches_an_org():
    outbox = FakeOutboxPort()
    for name in ("attempt-missing-mode.json", "flag-captured-carries-the-flag.json"):
        example = json.loads((DOMAIN_EVENTS / "examples" / "invalid" / name).read_text(encoding="utf-8"))
        with pytest.raises(errors.EventInvalid):
            outbox.publish(example)
    assert outbox.events == []


def test_audit_keeps_its_own_copy_and_refuses_keys_json_cannot_sort():
    audit = FakeAuditPort()
    details = {"list": [1], "nested": {"a": 1}}
    audit.append(actor="u", action="x", details=details)
    details["list"].append(2)
    details["nested"]["a"] = 2
    assert audit.records[0].details == {"list": [1], "nested": {"a": 1}}
    assert verify_chain(audit.records)
    with pytest.raises(ValueError):
        audit.append(actor="u", action="x", details={1: "a", "b": 2})
    assert len(audit.records) == 1


def test_verify_chain_checks_the_first_sequence_number_and_follows_a_checkpoint():
    audit = FakeAuditPort(now=clock)
    for n in range(5):
        audit.append(actor="u", action=f"a.{n}")
    records = audit.records
    assert verify_chain(records)
    assert not verify_chain(records[2:]), "a chain that does not start at 1 needs its checkpoint"
    assert verify_chain(records[2:], start_seq=3, prev_hash=records[1].row_hash), "the part after a checkpoint verifies"
    assert not verify_chain(records[2:], start_seq=3, prev_hash=GENESIS_HASH)
    renumbered = [replace(records[0], seq=7)]
    assert not verify_chain(renumbered)


def test_a_shred_without_a_key_blocks_nothing():
    keys = FakeKeyPort()
    assert keys.shred("a-NEWNEWNEWNEWNEWN") is False
    assert keys.create_attempt_key("a-NEWNEWNEWNEWNEWN").attempt_id == "a-NEWNEWNEWNEWNEWN"
