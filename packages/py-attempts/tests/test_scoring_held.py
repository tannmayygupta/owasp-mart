"""FR-SCR-10 and D-87: a held capture is excluded until reviewed, never zeroed."""
import pytest

from vulnmart_attempts import Fact, Milestone, compute_score

M1, M2, M3 = Milestone.M1, Milestone.M2, Milestone.M3


def row(result, key):
    return next(r for r in result.per_challenge if r.challenge_key == key)


def test_held_m3_counts_at_earlier_m2_and_is_flagged():
    r = compute_score({"C05": Fact(M3, held=True, fallback=M2)})
    c05 = row(r, "C05")
    assert c05.milestone is M2 and c05.held and c05.points == 24  # Easy 60 x 40%


def test_held_with_no_earlier_milestone_counts_zero_but_is_not_dropped():
    c05 = row(compute_score({"C05": Fact(M3, held=True)}), "C05")
    assert c05.points == 0 and c05.held and c05.milestone is Milestone.NONE


def test_accepting_the_capture_restores_credit_on_recompute():
    held = compute_score({"C05": Fact(M3, held=True, fallback=M2)})
    accepted = compute_score({"C05": Fact(M3)})
    assert row(accepted, "C05").points == 60 and not row(accepted, "C05").held
    assert accepted.shown > held.shown


def test_held_capture_is_not_a_full_capture_for_tie_break():
    assert compute_score({"C05": Fact(M3, held=True, fallback=M2)}).tie_break.full_captures == 0
    assert compute_score({"C05": Fact(M3)}).tie_break.full_captures == 1


def test_held_hints_still_cost_on_the_fallback_milestone():
    assert row(compute_score({"C05": Fact(M3, (1,), held=True, fallback=M2)}), "C05").points == 18  # 60 x (40-10)%


def test_held_does_not_touch_other_challenges():
    r = compute_score({"C05": Fact(M3, held=True, fallback=M1), "C02": Fact(M3)})
    assert row(r, "C02").points == 90 and not row(r, "C02").held


@pytest.mark.parametrize("kwargs", [
    {"held": True, "fallback": M3},      # fallback not below the held milestone
    {"held": True, "fallback": M2},      # held milestone is M2, fallback not below
    {"held": False, "fallback": M1},     # fallback without a hold
])
def test_inconsistent_hold_is_refused(kwargs):
    with pytest.raises(ValueError):
        Fact(M2 if kwargs["fallback"] is M2 else M3, **kwargs)
