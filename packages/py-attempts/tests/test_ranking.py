"""FR-SCR-08 and D-93 (OI-26): the order is an aid, every key on its own, nobody dropped."""
import random
from datetime import timedelta

from conftest_engine import T0

from vulnmart_attempts import ScoreResult, TieBreak
from vulnmart_attempts.ranking import RANKING_LABEL, RankRow, ranking_key, suggest_order


def row(attempt_id, shown=500, full=3, hint=0, last=60, active=1000):
    return RankRow(attempt_id, ScoreResult(shown, (), TieBreak(full, hint)),
                   None if last is None else T0 + timedelta(seconds=last), active)


def order(*rows):
    return [r.attempt_id for r in suggest_order(rows)]


def test_higher_score_first_640_before_590():
    out = suggest_order([row("b", 590), row("a", 640)])
    assert [r.attempt_id for r in out] == ["a", "b"] and out[0].reason == "higher score"


def test_tie_on_score_more_full_captures_wins_and_says_so():
    out = suggest_order([row("a", full=2), row("b", full=4)])
    assert [r.attempt_id for r in out] == ["b", "a"] and out[0].reason == "same score; more full captures"


def test_then_lower_hint_cost():
    out = suggest_order([row("a", hint=900), row("b", hint=300)])
    assert [r.attempt_id for r in out] == ["b", "a"] and out[0].reason == "same score, full captures; lower hint cost"


def test_then_lower_active_time():
    out = suggest_order([row("a", active=2000), row("b", active=1500)])
    assert [r.attempt_id for r in out] == ["b", "a"]
    assert out[0].reason == "same score, full captures, hint cost; lower active time"


def test_then_earlier_last_capture():
    out = suggest_order([row("a", last=900), row("b", last=100)])
    assert [r.attempt_id for r in out] == ["b", "a"]
    assert out[0].reason == "same score, full captures, hint cost, active time; earlier last capture"


def test_no_capture_sorts_last_on_that_key():
    assert order(row("a", last=None), row("b", last=999999)) == ["b", "a"]


def test_missing_active_time_sorts_after_a_known_one():
    assert order(row("a", active=None), row("b", active=5000)) == ["b", "a"]


def test_full_tie_orders_by_attempt_id_with_no_difference():
    out = suggest_order([row("z"), row("m"), row("a")])
    assert [r.attempt_id for r in out] == ["a", "m", "z"]
    assert out[0].reason == "no difference" and out[1].reason == "no difference"
    assert out[2].reason == "last in the suggested order"


def test_every_row_kept_positioned_and_labelled():
    rows = [row(f"a{i}", shown=i * 10) for i in range(7)]
    out = suggest_order(rows)
    assert len(out) == 7 and [r.position for r in out] == list(range(1, 8))
    assert all(r.label == RANKING_LABEL == "ranking aid, the recruiter decides" for r in out)
    assert suggest_order([]) == ()


def test_shuffled_input_gives_the_same_output():
    rows = [row("a", 640, 5, 100, 50, 900), row("b", 640, 5, 100, 50, 900), row("c", 640, 5, 100, 20, 900),
            row("d", 640, 4, 0, 10, 100), row("e", 700), row("f", 100, last=None), row("g", 640, 5, 50, 90, 10)]
    expected = suggest_order(rows)
    rng = random.Random(7)
    for _ in range(25):
        shuffled = rows[:]
        rng.shuffle(shuffled)
        assert suggest_order(shuffled) == expected
    assert [r.attempt_id for r in expected] == ["e", "g", "c", "a", "b", "d", "f"]


def test_ranking_key_is_a_pure_tuple():
    k = ranking_key(ScoreResult(640, (), TieBreak(5, 100)), T0, 900)
    assert k == (-640, -5, 100, 900, T0.timestamp())


def test_duplicate_attempt_is_refused():
    import pytest
    with pytest.raises(ValueError):
        suggest_order([row("a"), row("a")])
