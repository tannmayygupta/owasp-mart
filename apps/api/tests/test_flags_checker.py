"""Story 6.1: the flag checker (FR-FLG-02, 03, 08). Only tests may use the fake KeyPort (D-79)."""
from __future__ import annotations

import random
import string

import pytest

from vulnmart.flags import checker as checker_module
from vulnmart.flags.checker import FlagChecker, FlagClass, candidate_digest
from vulnmart.flags.material import build_material
from vulnmart.ports.fakes import FakeKeyPort

KEYS = FakeKeyPort()
A, B = "i-AAAAAAAAAAAAAAAA", "i-BBBBBBBBBBBBBBBB"
CK = ("C01", "C05", "C09")
checker = FlagChecker(KEYS)


def mat(iid, epoch):
    return build_material(KEYS, iid, epoch, CK)


def flag_of(m, c):
    return next(f.flag for f in m.flags if f.challenge_key == c)


def test_correct_flag():
    r = checker.classify(flag_of(mat(A, 1), "C05"), instance_id=A, epoch=1, challenge_keys=CK)
    assert r.flag_class is FlagClass.CORRECT and r.challenge_key == "C05"


def test_a_flag_of_one_challenge_is_correct_for_that_challenge_only():
    m = mat(A, 1)
    assert checker.classify(flag_of(m, "C01"), instance_id=A, epoch=1, challenge_keys=CK).challenge_key == "C01"


def test_decoy_never_correct():
    m = mat(A, 1)
    d = next(x for x in m.decoys if x.challenge_key == "C05" and x.index == 1)
    r = checker.classify(d.value, instance_id=A, epoch=1, challenge_keys=CK)
    assert r.flag_class is FlagClass.DECOY and r.challenge_key == "C05"


def test_two_instances_other_instance_names_the_owner():
    fb = flag_of(mat(B, 1), "C01")
    r = checker.classify(fb, instance_id=A, epoch=1, challenge_keys=CK, other_instances=[B])
    assert r.flag_class is FlagClass.OTHER_INSTANCE and r.other_instance_id == B
    # without B in the list it is just wrong
    assert checker.classify(fb, instance_id=A, epoch=1, challenge_keys=CK).flag_class is FlagClass.WRONG
    # a mapping of instance to epoch works too
    r2 = checker.classify(fb, instance_id=A, epoch=1, challenge_keys=CK, other_instances={B: 1})
    assert r2.other_instance_id == B


def test_reset_makes_old_flags_stale_and_new_ones_correct():
    old, new = mat(A, 1), mat(A, 2)
    for c in CK:
        r_old = checker.classify(flag_of(old, c), instance_id=A, epoch=2, challenge_keys=CK)
        assert r_old.flag_class is FlagClass.STALE_EPOCH and r_old.epoch == 1 and r_old.challenge_key == c
        assert checker.classify(flag_of(new, c), instance_id=A, epoch=2, challenge_keys=CK).flag_class is FlagClass.CORRECT
    assert old.event_key != new.event_key
    # an old decoy is stale too
    r = checker.classify(old.decoys[0].value, instance_id=A, epoch=2, challenge_keys=CK)
    assert r.flag_class is FlagClass.STALE_EPOCH


def test_epoch_walk_reaches_back_up_to_fifty_epochs():
    f = flag_of(mat(A, 1), "C01")
    assert checker.classify(f, instance_id=A, epoch=51, challenge_keys=CK).flag_class is FlagClass.STALE_EPOCH
    assert checker.classify(f, instance_id=A, epoch=52, challenge_keys=CK).flag_class is FlagClass.WRONG


def test_wrong_for_random_flag_shaped_text():
    assert checker.classify("VM{ABCDEFGHIJKLMNOPQRSTUVWX}", instance_id=A, epoch=1, challenge_keys=CK).flag_class is FlagClass.WRONG
    assert checker.classify("", instance_id=A, epoch=1, challenge_keys=CK).flag_class is FlagClass.WRONG


def test_hash_only_entry_gives_the_same_classes():
    m = mat(A, 1)
    f = flag_of(m, "C09")
    r = checker.classify(None, instance_id=A, epoch=1, challenge_keys=CK, candidate_sha256=candidate_digest(f))
    assert r.flag_class is FlagClass.CORRECT and r.challenge_key == "C09"
    d = checker.classify(None, instance_id=A, epoch=1, challenge_keys=CK, candidate_sha256=candidate_digest(m.decoys[0].value).upper())
    assert d.flag_class is FlagClass.DECOY
    assert checker.classify(None, instance_id=A, epoch=2, challenge_keys=CK, candidate_sha256=candidate_digest(f)).flag_class is FlagClass.STALE_EPOCH


def test_fuzz_random_candidates_are_never_correct():
    rng = random.Random(6101)
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    for _ in range(200):
        c = "VM{" + "".join(rng.choice(alphabet) for _ in range(24)) + "}"
        assert checker.classify(c, instance_id=A, epoch=1, challenge_keys=CK).flag_class is FlagClass.WRONG
    for _ in range(50):
        c = "".join(rng.choice(string.printable) for _ in range(rng.randint(0, 60)))
        assert checker.classify(c, instance_id=A, epoch=1, challenge_keys=CK).flag_class is FlagClass.WRONG


def test_only_compare_digest_compares(monkeypatch):
    calls = []
    real = checker_module.hmac.compare_digest

    def spy(a, b):
        calls.append((type(a), type(b)))
        return real(a, b)

    monkeypatch.setattr(checker_module.hmac, "compare_digest", spy)
    f = flag_of(mat(A, 1), "C01")
    assert checker.classify(f, instance_id=A, epoch=1, challenge_keys=CK).flag_class is FlagClass.CORRECT
    # 3 challenges x (1 flag + 2 decoys) values, all compared as str digests, none skipped
    assert len(calls) == 9 and all(c == (str, str) for c in calls)


def test_the_checker_source_compares_nothing_with_equals_on_digests():
    import inspect

    src = inspect.getsource(checker_module)
    assert "compare_digest" in src
    for line in src.splitlines():
        if "digest" in line and "==" in line and not line.strip().startswith(("#", '"""')):
            pytest.fail("a digest is compared with ==")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"epoch": 0},
        {"instance_id": ""},
        {"candidate_sha256": "not-hex"},
        {"candidate": None},
    ],
)
def test_bad_input_raises_a_fixed_message(kwargs):
    args = {"candidate": "VM{AAAAAAAAAAAAAAAAAAAAAAAA}", "instance_id": A, "epoch": 1} | kwargs
    cand = args.pop("candidate")
    with pytest.raises(ValueError) as e:
        checker.classify(cand, **args)
    assert "VM{" not in str(e.value)


def test_no_flag_in_repr_of_checker_result_or_in_logs(caplog):
    f = flag_of(mat(A, 1), "C01")
    with caplog.at_level("DEBUG"):
        r = checker.classify(f, instance_id=A, epoch=1, challenge_keys=CK)
    shown = repr(r) + str(r) + repr(checker)
    assert f not in shown and candidate_digest(f) not in shown
    assert f not in caplog.text and candidate_digest(f) not in caplog.text
    assert "FAKE" not in repr(checker)


def test_bad_decoy_count_for_the_checker():
    with pytest.raises(ValueError):
        FlagChecker(KEYS, decoys_per_challenge=5)
