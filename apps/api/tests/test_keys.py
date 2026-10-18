"""Story P-17 (FR-PRV-12, IF-9 KeyPort): the key service on a database: the KEK ring, per-attempt keys, sealing, shredding, rotation, and that it behaves
as the in-memory fake the other stream already uses. Runs on in-memory SQLite; the separate database, its role and the races are in test_keys_postgres.py."""
from __future__ import annotations

import base64
import logging
import re

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from vulnmart.kernel import keystore
from vulnmart.kernel.keys import DbKeyPort, KekRing, KekUnavailable, decode_key
from vulnmart.kernel.keystore import deks, shredded
from vulnmart.kernel.services import build_ports, key_port_from
from vulnmart.kernel.settings import Settings
from vulnmart.ports.errors import AttemptNotFound, KeyIntegrity, KeyShredded
from vulnmart.ports.fakes import FakeKeyPort
from vulnmart.ports.keys import KeyPort, Sealed, derive_event_key, derive_flag, derive_owner_hash

K1, K2 = bytes(range(32)), bytes(range(32, 64))
EVT, FLG, OWN = b"e" * 32, b"f" * 32, b"o" * 32


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode()


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    keystore.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def port(sessions):
    return DbKeyPort(sessions, KekRing.parse(f"1:{b64(K1)}"), event_master=EVT, flag_key=FLG, owner_key=OWN)


# ---- the KEK ring ----------------------------------------------------------------------------------------------------------------------

def test_a_kek_ring_reads_versions_and_the_highest_wraps():
    ring = KekRing.parse(f"# comment\n\n1:{b64(K1)}\n2: {b64(K2)}\n")
    assert ring.current == 2 and set(ring.keys) == {1, 2}
    assert "K1" not in repr(ring) and b64(K1) not in repr(ring), "key values are not in repr"


@pytest.mark.parametrize("text", ["", "# only a comment", "1", "x:abc", "0:" + "A" * 43, "1:short", f"1:{base64.urlsafe_b64encode(bytes(33)).decode()}",
                                  f"1:{b64(K1)}\n1:{b64(K2)}", "1:!!!notbase64!!!"])
def test_a_bad_kek_ring_is_refused_without_echoing_a_key(text):
    with pytest.raises(ValueError) as e:
        KekRing.parse(text)
    assert b64(K1) not in str(e.value)


def test_wrap_and_unwrap_bind_the_attempt_and_the_key_id():
    ring = KekRing.parse(f"1:{b64(K1)}")
    version, nonce, wrapped = ring.wrap(b"d" * 32, "att-1", "dek-1")
    assert version == 1 and len(wrapped) == 48 and ring.unwrap(version, nonce, wrapped, "att-1", "dek-1") == b"d" * 32
    for attempt, dek in (("att-2", "dek-1"), ("att-1", "dek-2")):
        with pytest.raises(KeyIntegrity):
            ring.unwrap(version, nonce, wrapped, attempt, dek)
    with pytest.raises(KekUnavailable):
        ring.unwrap(9, nonce, wrapped, "att-1", "dek-1")


def test_decode_key_accepts_both_base64_alphabets_and_needs_32_bytes():
    raw = bytes(range(250, 218, -1))
    assert decode_key(base64.b64encode(raw).decode(), what="k") == raw and decode_key(b64(raw).rstrip("="), what="k") == raw
    with pytest.raises(ValueError):
        decode_key(b64(b"x" * 31), what="k")


def test_the_three_masters_must_be_long_enough_and_different(sessions):
    ring = KekRing.parse(f"1:{b64(K1)}")
    with pytest.raises(ValueError):
        DbKeyPort(sessions, ring, event_master=b"short", flag_key=FLG, owner_key=OWN)
    with pytest.raises(ValueError, match="differ"):
        DbKeyPort(sessions, ring, event_master=EVT, flag_key=EVT, owner_key=OWN)


# ---- the per-attempt key -----------------------------------------------------------------------------------------------------------------

def test_an_attempt_key_is_created_once_and_stored_only_wrapped(port, sessions):
    first = port.create_attempt_key("att-1")
    again = port.create_attempt_key("att-1")
    assert first == again and re.fullmatch(r"dek-[0-9a-f]{16}", first.dek_id) and first.kek_version == 1 and port.create_attempt_key("att-2").dek_id != first.dek_id
    with sessions() as s:
        row = s.execute(select(deks).where(deks.c.attempt_id == "att-1")).one()
    assert len(row.wrapped) == 48 and len(row.nonce) == 12 and b"d" * 4 not in row.wrapped


def test_encrypt_then_decrypt_round_trips_and_every_seal_is_different(port):
    port.create_attempt_key("att-1")
    a, b = port.encrypt("att-1", b"the evidence", b"row-7"), port.encrypt("att-1", b"the evidence", b"row-7")
    assert isinstance(a, Sealed) and a.nonce != b.nonce and a.ciphertext != b.ciphertext and b"the evidence" not in a.ciphertext
    assert re.fullmatch(r"[0-9a-f]{24}", a.nonce) and a.dek_id == port.create_attempt_key("att-1").dek_id
    assert port.decrypt("att-1", a, b"row-7") == b"the evidence" == port.decrypt("att-1", b, b"row-7")
    assert port.decrypt("att-1", port.encrypt("att-1", b""), b"") == b"" and "ciphertext" not in repr(a)


def test_a_sealed_value_is_bound_to_its_attempt_and_its_associated_data(port):
    port.create_attempt_key("att-1")
    port.create_attempt_key("att-2")
    sealed = port.encrypt("att-1", b"secret", b"aad")
    with pytest.raises(KeyIntegrity):
        port.decrypt("att-1", sealed, b"other")
    with pytest.raises(KeyIntegrity):
        port.decrypt("att-2", sealed, b"aad")
    with pytest.raises(KeyIntegrity):
        port.decrypt("att-1", Sealed(sealed.dek_id, 1, sealed.nonce, sealed.ciphertext[:-1] + bytes([sealed.ciphertext[-1] ^ 1])), b"aad")
    with pytest.raises(KeyIntegrity):
        port.decrypt("att-1", Sealed(sealed.dek_id, 1, "zz", sealed.ciphertext), b"aad")
    with pytest.raises(KeyIntegrity):
        port.decrypt("att-1", Sealed("dek-0000000000000000", 1, sealed.nonce, sealed.ciphertext), b"aad")


def test_without_a_key_it_is_not_found_and_after_a_shred_it_is_shredded(port):
    with pytest.raises(AttemptNotFound):
        port.encrypt("att-9", b"x")
    port.create_attempt_key("att-1")
    sealed = port.encrypt("att-1", b"data")
    assert port.shred("att-1") is True
    for call in (lambda: port.encrypt("att-1", b"x"), lambda: port.decrypt("att-1", sealed), lambda: port.create_attempt_key("att-1")):
        with pytest.raises(KeyShredded):
            call()
    assert port.shred("att-1") is False, "already gone"
    assert port.shred("att-never") is False
    with pytest.raises(AttemptNotFound):
        port.decrypt("att-never", sealed), "shredding a key that never existed does not mark it shredded"


def test_shred_removes_the_wrapped_key_for_good_and_leaves_only_the_id(port, sessions):
    port.create_attempt_key("att-1")
    port.create_attempt_key("att-2")
    port.shred("att-1")
    with sessions() as s:
        assert s.scalar(select(func.count()).select_from(deks).where(deks.c.attempt_id == "att-1")) == 0
        assert s.scalar(select(func.count()).select_from(deks)) == 1
        assert [r.attempt_id for r in s.execute(select(shredded))] == ["att-1"]
    assert port.decrypt("att-2", port.encrypt("att-2", b"still readable")) == b"still readable"


def test_the_shred_hook_runs_after_the_commit_and_only_when_a_key_was_deleted(sessions):
    seen = []
    p = DbKeyPort(sessions, KekRing.parse(f"1:{b64(K1)}"), event_master=EVT, flag_key=FLG, owner_key=OWN, after_shred=seen.append)
    p.create_attempt_key("att-1")
    p.shred("att-1")
    p.shred("att-1")
    p.shred("att-x")
    assert seen == ["att-1"]


def test_a_shred_is_not_logged_with_the_attempt_id(port, caplog):
    port.create_attempt_key("att-secret-id")
    with caplog.at_level(logging.INFO, logger="vulnmart.keys"):
        port.shred("att-secret-id")
    assert caplog.records and "att-secret-id" not in caplog.text


@pytest.mark.parametrize("bad", ["", "a b", "x" * 65, "att/1", "att\n1", "é"])
def test_a_malformed_attempt_id_is_refused(port, bad):
    for call in (lambda: port.create_attempt_key(bad), lambda: port.encrypt(bad, b"x"), lambda: port.shred(bad)):
        with pytest.raises(ValueError):
            call()


# ---- rotation ----------------------------------------------------------------------------------------------------------------------------

def test_a_kek_rotation_rewraps_the_keys_and_the_data_stays_readable(sessions):
    old = DbKeyPort(sessions, KekRing.parse(f"1:{b64(K1)}"), event_master=EVT, flag_key=FLG, owner_key=OWN)
    for i in range(5):
        old.create_attempt_key(f"att-{i}")
    sealed = old.encrypt("att-3", b"before the rotation", b"a")
    both = KekRing.parse(f"1:{b64(K1)}\n2:{b64(K2)}")
    new = DbKeyPort(sessions, both, event_master=EVT, flag_key=FLG, owner_key=OWN)
    assert new.create_attempt_key("att-new").kek_version == 2, "new keys use the highest version"
    assert new.decrypt("att-3", sealed, b"a") == b"before the rotation", "old keys still open"
    assert new.rewrap(batch=2) == 2 and new.rewrap(batch=100) == 3 and new.rewrap() == 0
    only_new = DbKeyPort(sessions, KekRing.parse(f"2:{b64(K2)}"), event_master=EVT, flag_key=FLG, owner_key=OWN)  # version 1 retired
    assert only_new.decrypt("att-3", sealed, b"a") == b"before the rotation"
    assert only_new.create_attempt_key("att-3").kek_version == 2
    with pytest.raises(KekUnavailable):
        old.decrypt("att-3", sealed, b"a")


# ---- the derived keys --------------------------------------------------------------------------------------------------------------------

def test_the_derived_keys_are_the_shared_functions_over_the_masters(port):
    assert port.event_key("inst-1", 2) == derive_event_key(EVT, "inst-1", 2)
    assert port.flag("inst-1", "sqli", 1) == derive_flag(FLG, "inst-1", "sqli", 1)
    assert port.decoy("inst-1", "sqli", 1, 3) == derive_flag(FLG, "inst-1", "sqli", 1, decoy_index=3)
    assert port.owner_hash("u-X") == derive_owner_hash(OWN, "u-X")
    assert port.flag("inst-1", "sqli", 1) != port.decoy("inst-1", "sqli", 1, 0) and re.fullmatch(r"VM\{[A-Z2-7]{24}\}", port.flag("i", "c", 1))


def test_the_three_masters_give_unrelated_values(port):
    assert port.event_key("i", 1) != port.flag("i", "c", 1) and port.owner_hash("u") != port.event_key("u", 1)


# ---- it is a KeyPort, and it behaves like the fake ---------------------------------------------------------------------------------------

def test_it_satisfies_the_port(port):
    assert isinstance(port, KeyPort) and isinstance(FakeKeyPort(), KeyPort)


def behaviour(p: KeyPort) -> list:
    """The same sequence of calls and what each one raised or returned, for the conformance comparison."""
    out: list = []

    def attempt(label, fn):
        try:
            r = fn()
            out.append((label, "ok", type(r).__name__ if not isinstance(r, (bool, bytes)) else r))
        except Exception as exc:  # noqa: BLE001
            out.append((label, type(exc).__name__))

    attempt("encrypt without key", lambda: p.encrypt("att-1", b"x"))
    attempt("create", lambda: p.create_attempt_key("att-1"))
    attempt("create again", lambda: p.create_attempt_key("att-1"))
    sealed = p.encrypt("att-1", b"data", b"aad")
    attempt("decrypt", lambda: p.decrypt("att-1", sealed, b"aad"))
    attempt("decrypt wrong aad", lambda: p.decrypt("att-1", sealed, b"x"))
    p.create_attempt_key("att-2")
    attempt("decrypt other attempt", lambda: p.decrypt("att-2", sealed, b"aad"))
    attempt("shred", lambda: p.shred("att-1"))
    attempt("shred again", lambda: p.shred("att-1"))
    attempt("shred never", lambda: p.shred("att-3"))
    attempt("encrypt shredded", lambda: p.encrypt("att-1", b"x"))
    attempt("decrypt shredded", lambda: p.decrypt("att-1", sealed, b"aad"))
    attempt("create shredded", lambda: p.create_attempt_key("att-1"))
    attempt("decrypt unknown", lambda: p.decrypt("att-3", sealed, b"aad"))
    return out


def test_the_real_service_and_the_fake_agree_on_every_error_and_result(port):
    assert behaviour(port) == behaviour(FakeKeyPort())


# ---- wiring ------------------------------------------------------------------------------------------------------------------------------

def test_the_key_port_needs_a_kek_outside_tests_and_the_masters_in_strict_environments():
    with pytest.raises(RuntimeError, match="KEK"):
        key_port_from(Settings(env="dev", keystore_dsn="postgresql://u:p@h/vm_keystore"))
    ring = f"1:{b64(K1)}"
    with pytest.raises(RuntimeError, match="event master key"):
        key_port_from(Settings(env="production", keystore_dsn="postgresql://u:p@h/vm_keystore", kek=ring))
    ok = key_port_from(Settings(env="dev", keystore_dsn="postgresql://u:p@h/vm_keystore", kek=ring))
    assert isinstance(ok, DbKeyPort) and ok.flag("i", "c", 1).startswith("VM{")
    full = Settings(env="production", keystore_dsn="postgresql://u:p@h/vm_keystore", kek=ring, event_master=b64(EVT), flag_key=b64(FLG), owner_key=b64(OWN))
    assert key_port_from(full).event_key("i", 1) == derive_event_key(EVT, "i", 1)


def test_a_file_secret_wins_over_the_environment(tmp_path):
    f = tmp_path / "kek"
    f.write_text(f"3:{b64(K2)}\n", encoding="utf-8")
    s = Settings(kek=f"1:{b64(K1)}", kek_file=str(f))
    assert KekRing.parse(s.kek_text()).current == 3


def test_without_addresses_the_ports_are_the_in_memory_fakes():
    ports = build_ports(Settings())
    assert isinstance(ports.keys, FakeKeyPort) and ports.audit_db is None and ports.audit_sessions is None
