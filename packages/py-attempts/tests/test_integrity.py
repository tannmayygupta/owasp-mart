"""FR-ACH-03, 04, 05, 06 and D-94: detectors give facts, signals never change a score."""
import inspect
from pathlib import Path

import pytest

from vulnmart_attempts import Fact, Milestone, Rules, compute_score
from vulnmart_attempts.integrity import (
    SimilarPair,
    after_long_idle,
    capture_treatment,
    raise_signals,
    shingles,
    similar_across,
    similar_writeups,
    similarity_signals,
    timing_signals,
    too_fast,
)

M2, M3 = Milestone.M2, Milestone.M3
WORDS20 = " ".join(f"w{i}" for i in range(20))


class Sink:
    def __init__(self):
        self.rows = {}

    def add(self, attempt_id, kind, explanation, dedupe_key):
        if (attempt_id, dedupe_key) in self.rows:
            return False
        self.rows[(attempt_id, dedupe_key)] = (kind, explanation)
        return True


def test_too_fast_boundaries():
    assert too_fast(20, 60) and too_fast(59, 60)
    assert not too_fast(60, 60) and not too_fast(61, 60)
    with pytest.raises(ValueError):
        too_fast(-1, 60)


def test_after_long_idle_boundaries():
    # 40 min idle (2400 s) against a 1800 s limit, capture 2 s after resuming, instant means 5 s or less
    assert after_long_idle(2400, 1800, 2, 5)
    assert after_long_idle(1800, 1800, 5, 5)          # both limits are inclusive
    assert not after_long_idle(1799, 1800, 2, 5)       # idle not long enough
    assert not after_long_idle(2400, 1800, 6, 5)       # not instant


def test_timing_signals_have_plain_explanation_and_dedupe_key():
    (sig,) = timing_signals("a1", "C03", 20, 60)
    assert sig.kind == "timing" and sig.dedupe_key == "timing-fast-C03"
    assert "20 s" in sig.explanation and "60 s" in sig.explanation and "not a decision" in sig.explanation
    (idle,) = timing_signals("a1", "C03", 900, 60, idle_s=2400, idle_limit_s=1800, capture_after_resume_s=2, instant_s=5)
    assert idle.dedupe_key == "timing-idle-C03"
    assert timing_signals("a1", "C03", 900, 60) == ()


def test_rules_defaults_for_the_placeholders():
    r = Rules()
    assert (r.min_capture_seconds, r.idle_capture_seconds, r.activity_check_mode) == (60, 1800, "hold")
    assert Rules.from_dict(Rules(min_capture_seconds=90, activity_check_mode="flag").to_dict()).min_capture_seconds == 90
    with pytest.raises(ValueError):
        Rules(activity_check_mode="reject")


def test_shingles_edge_cases():
    assert shingles("") == frozenset()
    assert shingles("one two") == frozenset()              # fewer than 3 words: nothing to compare
    assert len(shingles("a b c d")) == 2                   # (a b c) (b c d)
    assert shingles("A b, C!") == shingles("a b c")        # case and punctuation ignored


def test_similarity_one_changed_word_in_twenty_is_17_over_19():
    other = WORDS20.replace("w19", "zzz")
    # 20 words give 18 shingles; the last one differs, so 17 shared out of 19 in the union = 0.8947
    (pair,) = similar_writeups({"a1": WORDS20, "a2": other})
    assert pair == SimilarPair("a1", "a2", 0.8947)


def test_similarity_exactly_at_threshold_is_not_flagged():
    six = "a b c d e f"          # 4 shingles
    seven = "a b c d e f g"      # 5 shingles, 4 shared: 4/5 = 0.8
    assert similar_writeups({"a1": six, "a2": seven}) == ()
    assert similar_writeups({"a1": six, "a2": seven}, threshold=0.79)[0].score == 0.8


def test_similarity_identical_empty_short_and_different():
    assert similar_writeups({"a1": WORDS20, "a2": WORDS20})[0].score == 1.0
    assert similar_writeups({"a1": "", "a2": ""}) == ()
    assert similar_writeups({"a1": "ok done", "a2": "ok done"}) == ()
    assert similar_writeups({"a1": WORDS20, "a2": " ".join(f"x{i}" for i in range(20))}) == ()


def test_similarity_only_inside_one_assessment():
    rows = [("as1", "a1", WORDS20), ("as2", "a2", WORDS20)]
    assert similar_across(rows) == ()
    rows.append(("as1", "a3", WORDS20))
    (pair,) = similar_across(rows)
    assert (pair.first, pair.second) == ("a1", "a3")


def test_one_flag_per_pair_ids_and_score_only_no_text():
    pairs = similar_writeups({"a1": WORDS20, "a2": WORDS20})
    sink = Sink()
    assert raise_signals(sink, similarity_signals(pairs)) == 2          # one flag on each attempt of the pair
    assert raise_signals(sink, similarity_signals(pairs)) == 0          # repeating adds nothing
    for _, explanation in sink.rows.values():
        assert "w5" not in explanation and "100%" in explanation


def test_activity_check_mode_hold_or_flag():
    assert capture_treatment("hold", True) == "counts"
    assert capture_treatment("hold", False) == "held"
    assert capture_treatment("flag", False) == "flagged"
    with pytest.raises(ValueError):
        capture_treatment("reject", False)


def test_no_signal_changes_a_score_and_nothing_zeroes():
    facts = {"C02": Fact(M3), "C05": Fact(M3, (1,))}
    before = compute_score(facts)
    sink = Sink()
    raise_signals(sink, timing_signals("a1", "C02", 5, 60) + similarity_signals(
        similar_writeups({"a1": WORDS20, "a2": WORDS20})))
    assert sink.rows
    assert compute_score(facts) == before
    # by hand: C02 90 + C05 (60 x 90%) 54 = 144 of 960, 1000 x 144 / 960 = 150
    assert before.shown == 150
    # the score function takes no flag, time or integrity input at all
    assert list(inspect.signature(compute_score).parameters) == ["facts", "catalogue", "rules"]


def test_package_has_no_proctoring_capture_words():
    forbidden = ("webcam", "microphone", "screenshot", "screen recording", "keystroke", "clipboard", "tab switch",
                 "paste event", "id photo", "eye track")
    src = Path(__file__).resolve().parents[1] / "src" / "vulnmart_attempts"
    for path in src.glob("*.py"):
        text = path.read_text(encoding="utf-8").lower()
        for word in forbidden:
            assert word not in text, (path.name, word)
