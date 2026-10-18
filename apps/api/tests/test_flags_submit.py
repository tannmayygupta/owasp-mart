"""Story 6.3: paste submission (FR-FLG-05): results, the limit of 5 incorrect per challenge per 10 minutes, no oracle, no stored text,
decoys, other instances, the running-state rule. Only tests use the fake KeyPort (D-79)."""
from __future__ import annotations

from datetime import timedelta

import pytest
from ingest_support import A, B, KEYS, T0, World, digest

from vulnmart.flags.submit import FlagSubmissionResult, FlagSubmitService
from vulnmart.ports.attempts import AttemptState
from vulnmart.ports.errors import AttemptNotFound, AttemptStateInvalid, ChallengeNotFound, FlagRateLimited, InstanceMissing
from vulnmart.ports.lab_fakes import FakeAttemptPort
from vulnmart.ports.reports import IntegrityType


class Env:
    def __init__(self, *, gate=None, state=AttemptState.RUNNING):
        self.w = World()
        self.attempts = FakeAttemptPort()
        self.a1 = self.attempts.seed(user_id="u-1", state=state, attempt_id="a-1")
        self.a2 = self.attempts.seed(user_id="u-2", state=AttemptState.RUNNING, attempt_id="a-2")
        self.w.add_instance(A, "a-1")
        self.w.add_instance(B, "a-2")
        self.now = T0
        self.svc = FlagSubmitService(attempts=self.attempts, directory=self.w.directory, checker=self.w.checker,
                                     milestones=self.w.milestones, integrity=self.w.integrity, log=self.w.submissions,
                                     clock=lambda: self.now, gate=gate)

    def paste(self, challenge, text, attempt="a-1"):
        return self.svc.submit_flag(attempt, challenge, text)


def test_correct_paste_credits_m3_and_stores_no_text():
    e = Env()
    flag = KEYS.flag(A, "C04", 1)
    assert e.paste("C04", flag) == FlagSubmissionResult("correct", "credited")
    assert e.w.best("C04") == "M3"
    assert e.w.submissions.rows == [("a-1", "C04", "correct")]
    # nothing the stores or the service hold contains the text or its digest
    blob = repr(vars(e.w.submissions)) + repr(e.w.milestones.items) + repr(e.w.integrity.rows) + repr(vars(e.svc).keys())
    assert flag not in blob and digest(flag) not in blob
    assert flag not in repr(e.svc._misses)


def test_a_paste_after_an_automatic_capture_is_a_no_op_that_still_answers_correct():
    e = Env()
    e.w.send_flag("C04")
    assert e.w.best("C04") == "M3"
    assert e.paste("C04", KEYS.flag(A, "C04", 1)) == FlagSubmissionResult("correct", "credited")
    assert e.w.best("C04") == "M3"


def test_paste_of_a_whitespace_padded_flag_is_correct():
    e = Env()
    assert e.paste("C02", "  " + KEYS.flag(A, "C02", 1) + "\n").result == "correct"


@pytest.mark.parametrize("kind", ["wrong", "decoy", "stale", "other", "other_challenge", "empty", "huge"])
def test_every_wrong_kind_answers_the_same_and_credits_nothing(kind):
    e = Env()
    e.w.reset(A)  # epoch 2, so an epoch 1 flag is stale
    text = {
        "wrong": "VM{AAAAAAAAAAAAAAAAAAAAAAAA}",
        "decoy": KEYS.decoy(A, "C05", 2, 0),
        "stale": KEYS.flag(A, "C05", 1),
        "other": KEYS.flag(B, "C05", 1),
        "other_challenge": KEYS.flag(A, "C06", 2),
        "empty": "   ",
        "huge": "x" * 5000,
    }[kind]
    assert e.paste("C05", text) == FlagSubmissionResult("incorrect", "none")
    assert all(e.w.best(c) == "none" for c in ("C05", "C06"))
    assert e.w.submissions.rows == [("a-1", "C05", "incorrect")]


def test_decoy_and_other_instance_write_integrity_flags_without_the_value():
    e = Env()
    decoy, theirs = KEYS.decoy(A, "C05", 1, 1), KEYS.flag(B, "C05", 1)
    e.paste("C05", decoy)
    e.paste("C05", theirs)
    e.paste("C05", theirs)
    d = e.w.integrity.of("a-1", IntegrityType.DECOY)
    s = e.w.integrity.of("a-1", IntegrityType.SHARING)
    assert len(d) == 1 and len(s) == 1
    assert B in s[0].explanation and A in s[0].explanation and "C05" in s[0].explanation
    for row in d + s:
        for secret in (decoy, theirs, digest(decoy), digest(theirs)):
            assert secret not in row.explanation and secret not in repr(row)


def test_six_wrong_pastes_the_sixth_is_refused_even_for_the_right_value():
    e = Env()
    right = KEYS.flag(A, "C03", 1)
    for i in range(5):
        e.now = T0 + timedelta(seconds=10 * i)
        assert e.paste("C03", f"wrong-{i}").result == "incorrect"
    e.now = T0 + timedelta(seconds=60)
    with pytest.raises(FlagRateLimited) as ei:
        e.paste("C03", right)
    assert ei.value.http_status == 429 and ei.value.code.value == "ATT-FLAG-RATE-LIMITED"
    assert 1 <= ei.value.retry_after <= 600 and ei.value.retry_after == 540  # oldest at 0 s leaves the window at 600 s
    assert right not in str(ei.value) and right not in repr(ei.value)
    assert e.w.best("C03") == "none"
    assert e.w.submissions.rows[-1] == ("a-1", "C03", "rate_limited")
    # a different challenge and a different attempt are not limited
    assert e.paste("C01", KEYS.flag(A, "C01", 1)).result == "correct"
    assert e.paste("C03", KEYS.flag(B, "C03", 1), attempt="a-2").result == "correct"
    # after the window, the right value is accepted again
    e.now = T0 + timedelta(seconds=601)
    assert e.paste("C03", right) == FlagSubmissionResult("correct", "credited")


def test_five_wrong_then_a_correct_one_inside_the_limit_is_still_possible_before_the_sixth():
    e = Env()
    for i in range(4):
        e.paste("C08", f"nope-{i}")
    assert e.paste("C08", KEYS.flag(A, "C08", 1)).result == "correct"


def test_the_attempt_must_be_running():
    for state in (AttemptState.READY, AttemptState.SUBMITTED, AttemptState.EXPIRED):
        e = Env(state=state)
        with pytest.raises(AttemptStateInvalid):
            e.paste("C01", KEYS.flag(A, "C01", 1))
        assert e.w.best("C01") == "none" and e.w.submissions.rows == []


def test_unknown_attempt_challenge_and_instance():
    e = Env()
    with pytest.raises(AttemptNotFound):
        e.paste("C01", "x", attempt="a-nope")
    with pytest.raises(ChallengeNotFound):
        e.paste("C12", "x")
    e.attempts.seed(user_id="u-3", state=AttemptState.RUNNING, attempt_id="a-3")
    with pytest.raises(InstanceMissing):
        e.paste("C01", "x", attempt="a-3")


def test_the_gate_holds_a_paste():
    class Refuse:
        def allows(self, attempt_id, challenge_key, at):
            return False

    e = Env(gate=Refuse())
    assert e.paste("C07", KEYS.flag(A, "C07", 1)) == FlagSubmissionResult("correct", "held")
    assert e.w.best("C07") == "none" and ("a-1", "C07") in e.w.milestones.held


def test_after_a_reset_only_the_new_epoch_flag_is_correct():
    e = Env()
    e.w.reset(A)
    assert e.paste("C09", KEYS.flag(A, "C09", 1)).result == "incorrect"
    assert e.paste("C09", KEYS.flag(A, "C09", 2)).result == "correct"
    assert e.w.best("C09") == "M3"
