"""Story 6.1: flag material (FR-FLG-01, 02, 03, 07). Only tests may use the fake KeyPort (D-79)."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from vulnmart.flags import material as material_module
from vulnmart.flags.material import CHALLENGE_KEYS, DECOY_PLACEMENT, build_material, sha256_hex
from vulnmart.ports.fakes import FakeKeyPort
from vulnmart.ports.keys import KeyPort

FLAG_RE = re.compile(r"^VM\{[A-Z2-7]{24}\}$")
KEYS = FakeKeyPort()
TWO = ("C01", "C05")


def all_values(m):
    return [f.flag for f in m.flags] + [d.value for d in m.decoys]


def test_the_fake_is_a_keyport():
    assert isinstance(KEYS, KeyPort)


def test_shape_of_a_create_with_default_decoys():
    m = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 1, CHALLENGE_KEYS)
    assert [f.challenge_key for f in m.flags] == list(CHALLENGE_KEYS)
    assert len(m.decoys) == 22  # 2 per challenge
    assert {(d.challenge_key, d.index) for d in m.decoys} == {(c, i) for c in CHALLENGE_KEYS for i in range(2)}
    assert all(FLAG_RE.match(v) for v in all_values(m))
    assert len(m.flag_digests) == 11  # real flags only
    assert [d.sha256 for d in m.flag_digests] == [sha256_hex(f.flag) for f in m.flags]
    assert m.event_key == KEYS.event_key("i-AAAAAAAAAAAAAAAA", 1)
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", m.seed)


def test_decoys_are_never_a_real_flag_and_all_values_are_distinct():
    m = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 1, CHALLENGE_KEYS, decoys_per_challenge=4)
    values = all_values(m)
    assert len(set(values)) == len(values) == 11 + 44


def test_two_instances_of_the_same_challenges_differ_in_everything():
    a = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 1, TWO)
    b = build_material(KEYS, "i-BBBBBBBBBBBBBBBB", 1, TWO)
    assert not set(all_values(a)) & set(all_values(b))
    assert not {d.sha256 for d in a.flag_digests} & {d.sha256 for d in b.flag_digests}
    assert a.event_key != b.event_key


def test_a_reset_changes_flags_decoys_event_key_and_seed():
    a = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 1, TWO)
    b = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 2, TWO)
    assert not set(all_values(a)) & set(all_values(b))
    assert a.event_key != b.event_key
    assert a.seed != b.seed


def test_the_derivation_is_stable_and_only_the_seed_is_random():
    a = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 3, TWO)
    b = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 3, TWO)
    assert all_values(a) == all_values(b) and a.event_key == b.event_key
    assert a.seed != b.seed
    assert build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 3, TWO, seed="s" * 43).seed == "s" * 43


def test_zero_decoys_and_one_challenge_are_allowed():
    m = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 1, ["C03"], decoys_per_challenge=0)
    assert len(m.flags) == 1 and m.decoys == ()


@pytest.mark.parametrize(
    ("kwargs"),
    [
        {"challenge_keys": ["C12"]},
        {"challenge_keys": ["c01"]},
        {"challenge_keys": ["C00"]},
        {"challenge_keys": []},
        {"challenge_keys": [f"C{n:02d}" for n in range(1, 12)] + ["C01"]},
        {"challenge_keys": ["C01", "C01"]},
        {"epoch": 0},
        {"epoch": True},
        {"decoys_per_challenge": 5},
        {"decoys_per_challenge": -1},
        {"instance_id": ""},
    ],
)
def test_bad_input_raises_a_fixed_message_without_secrets(kwargs):
    args = {"instance_id": "i-AAAAAAAAAAAAAAAA", "epoch": 1, "challenge_keys": ["C01"], "decoys_per_challenge": 2} | kwargs
    with pytest.raises(ValueError) as e:
        build_material(KEYS, **args)
    assert "VM{" not in str(e.value) and "FAKE" not in str(e.value)


def test_a_flag_never_appears_in_the_repr_or_str_of_material_objects():
    m = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 1, TWO)
    shown = " ".join([repr(m), str(m), *(repr(f) for f in m.flags), *(repr(d) for d in m.decoys), *(repr(x) for x in m.flag_digests)])
    for v in all_values(m):
        assert v not in shown
    assert m.event_key not in shown and m.seed not in shown
    assert all(d.sha256 not in shown for d in m.flag_digests)


def test_no_flag_in_the_log_output_of_a_build(caplog):
    with caplog.at_level("DEBUG"):
        m = build_material(KEYS, "i-AAAAAAAAAAAAAAAA", 1, TWO)
    assert not any(v in caplog.text for v in all_values(m))


def test_the_package_never_imports_the_fake_or_names_a_fake_key():
    root = Path(material_module.__file__).parent
    for py in root.glob("*.py"):
        text = py.read_text(encoding="utf-8")
        assert "fakes" not in text, py.name
        assert "FAKE_" not in text, py.name
        assert "K_flag" not in text and "_flag_key" not in text, py.name


def test_the_placement_table_covers_every_challenge_and_holds_no_flag():
    assert set(DECOY_PLACEMENT) == set(CHALLENGE_KEYS)
    assert all(t and "VM{" not in t for t in DECOY_PLACEMENT.values())
