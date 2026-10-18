"""Exhaustive loops (no hypothesis): bounds, monotonicity, independence, permutation, rounding."""
from itertools import chain, combinations
import random

from vulnmart_attempts import Catalogue, Fact, Milestone, ScoringRules, compute_score

MILESTONES = list(Milestone)
WEIGHTS = (60, 90, 120)


def subsets(levels=(1, 2, 3)):
    return chain.from_iterable(combinations(levels, n) for n in range(len(levels) + 1))


def points(weight, milestone, hints):
    return compute_score({"X": Fact(milestone, hints)}, Catalogue({"X": weight})).per_challenge[0].points


def test_points_always_between_zero_and_weight():
    for w in WEIGHTS:
        for m in MILESTONES:
            for h in subsets():
                assert 0 <= points(w, m, h) <= w


def test_milestone_never_lowers_points():
    for w in WEIGHTS:
        for h in subsets():
            seq = [points(w, m, h) for m in MILESTONES]
            assert seq == sorted(seq)


def test_a_hint_never_raises_points():
    for w in WEIGHTS:
        for m in MILESTONES:
            for h in subsets():
                for extra in (1, 2, 3):
                    if extra not in h:
                        assert points(w, m, (*h, extra)) <= points(w, m, h)


def test_floor_at_zero_without_progress():
    for w in WEIGHTS:
        assert points(w, Milestone.NONE, (1, 2, 3)) == 0
    result = compute_score({"C01": Fact(Milestone.NONE, (1, 2, 3))})
    assert result.shown == 0


def test_floor_only_on_its_own_challenge():
    alone = compute_score({"C02": Fact(Milestone.M3)})
    both = compute_score({"C01": Fact(Milestone.M1, (1, 2, 3)), "C02": Fact(Milestone.M3)})
    by_key = {r.challenge_key: r.points for r in both.per_challenge}
    assert by_key["C01"] == 0
    assert by_key["C02"] == 90
    assert both.shown == alone.shown


def test_shown_between_zero_and_1000_for_every_single_challenge_state():
    for key in Catalogue().keys():
        for m in MILESTONES:
            for h in subsets():
                assert 0 <= compute_score({key: Fact(m, h)}).shown <= 1000


def test_each_challenge_is_independent():
    """Changing one challenge's fact changes only that row."""
    base = {k: Fact(Milestone.M2, (1,)) for k in Catalogue().keys()}
    ref = {r.challenge_key: r for r in compute_score(base).per_challenge}
    for key in base:
        for m in MILESTONES:
            for h in subsets():
                changed = dict(base)
                changed[key] = Fact(m, h)
                for r in compute_score(changed).per_challenge:
                    if r.challenge_key != key:
                        assert r == ref[r.challenge_key]


def test_permutation_of_challenges_does_not_change_total():
    rnd = random.Random(7)
    keys = list(Catalogue().keys())
    for _ in range(200):
        facts = {k: Fact(rnd.choice(MILESTONES), rnd.choice(list(subsets()))) for k in keys}
        shuffled = list(facts.items())
        rnd.shuffle(shuffled)
        assert compute_score(dict(shuffled)).shown == compute_score(facts).shown


def test_sweep_from_none_to_m3_is_non_decreasing():
    keys = list(Catalogue().keys())
    facts = {k: Fact() for k in keys}
    last = compute_score(facts).shown
    assert last == 0
    for step in (Milestone.M1, Milestone.M2, Milestone.M3):
        for k in keys:
            facts[k] = Fact(step)
            now = compute_score(facts).shown
            assert now >= last
            last = now
    assert last == 1000


def test_hint_cost_is_cumulative_per_level():
    assert points(120, Milestone.M3, (1, 2)) == 84
    assert points(120, Milestone.M3, (3,)) == 84
    assert points(120, Milestone.M3, (1, 2, 3)) == 48


def test_rounding_is_half_up_not_half_to_even():
    # S=1, T=400: 1000 x 1 / 400 = 2.5 -> 3 (Python round() would give 2)
    rules = ScoringRules(milestone_pct=(1, 2, 100))
    cat = Catalogue({"A": 1, "B": 3})
    assert compute_score({"A": Fact(Milestone.M1)}, cat, rules).shown == 3
    # per-challenge points: 10 x 25% = 2.5 -> 3 ; 10 x 75% (M3 with 25% hint) = 7.5 -> 8
    rules2 = ScoringRules(milestone_pct=(25, 50, 100), hint_cost_pct=(25,))
    cat2 = Catalogue({"A": 10})
    assert compute_score({"A": Fact(Milestone.M1)}, cat2, rules2).per_challenge[0].points == 3
    assert compute_score({"A": Fact(Milestone.M3, (1,))}, cat2, rules2).per_challenge[0].points == 8
    # exactly half (10 / 20 = 0.5) rounds up, just below half (10 / 21) rounds down
    assert compute_score({"A": Fact(Milestone.M1)}, Catalogue({"A": 1, "B": 19}), rules).shown == 1
    assert compute_score({"A": Fact(Milestone.M1)}, Catalogue({"A": 1, "B": 20}), rules).shown == 0


def test_tie_break_facts():
    result = compute_score({"C01": Fact(Milestone.M3, (1,)), "C02": Fact(Milestone.M3), "C03": Fact(Milestone.M2)})
    assert result.tie_break.full_captures == 2
    assert result.tie_break.hint_cost_units == 60 * 10
