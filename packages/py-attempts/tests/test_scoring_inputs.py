"""The scoring function takes no time and no submission input; bad input is refused with ValueError."""
import inspect

import pytest

from vulnmart_attempts import Catalogue, Fact, Milestone, ScoringRules, compute_score, scoring


def test_signature_has_only_facts_catalogue_and_rules():
    assert list(inspect.signature(compute_score).parameters) == ["facts", "catalogue", "rules"]


def test_fact_has_only_three_facts_and_the_held_fallback():
    names = set(Fact.__slots__)
    assert names == {"milestone", "hint_levels", "held", "fallback"}
    for forbidden in ("time", "seconds", "wrong", "decoy", "submissions", "label", "technique", "rank", "peers"):
        assert not any(forbidden in n for n in names)


def test_scoring_source_reads_no_clock_or_log():
    text = inspect.getsource(scoring)
    for token in ("datetime", "time.", "import time", "float(", "round("):
        assert token not in text


def test_a_fact_with_extra_keys_is_refused():
    for extra in ("time_spent", "wrong_submissions", "decoy_submissions", "technique"):
        with pytest.raises(ValueError):
            Fact.from_mapping({"milestone": "M3", extra: 5})
    assert Fact.from_mapping({"milestone": "M2", "hint_levels": [1]}) == Fact(Milestone.M2, (1,))


def test_equal_captures_with_any_other_circumstance_give_equal_scores():
    # time, wrong or decoy submissions cannot be passed, so the same facts always give the same result
    facts = {"C01": Fact(Milestone.M3, (1,)), "C06": Fact(Milestone.M2)}
    assert compute_score(facts) == compute_score(dict(facts))


def test_same_milestone_reached_by_two_paths_counts_once():
    # the platform sends the best milestone only; two exploit paths are the same fact
    once = compute_score({"C02": Fact(Milestone.M2)})
    twice = compute_score({"C02": Fact(Milestone.M2)})
    assert once.per_challenge[1].points == twice.per_challenge[1].points == 36


@pytest.mark.parametrize("levels", [(4,), (0,), (-1,), (1, 4)])
def test_hint_level_outside_range_is_refused(levels):
    with pytest.raises(ValueError):
        compute_score({"C01": Fact(Milestone.M1, levels)})


def test_duplicate_hint_level_is_refused():
    with pytest.raises(ValueError):
        Fact(Milestone.M1, (1, 1))


def test_unknown_challenge_key_is_refused():
    with pytest.raises(ValueError):
        compute_score({"C12": Fact(Milestone.M1)})


@pytest.mark.parametrize("bad", ["M0", "M4", "none ", -1, 4, None])
def test_milestone_below_none_or_unknown_is_refused(bad):
    with pytest.raises(ValueError):
        Fact(bad)  # type: ignore[arg-type]


def test_non_fact_value_is_refused():
    with pytest.raises(ValueError):
        compute_score({"C01": {"milestone": "M3"}})  # type: ignore[dict-item]


def test_bad_catalogue_and_rules_are_refused():
    for weights in ({}, {"A": 0}, {"A": -5}, {"A": 1.5}):
        with pytest.raises(ValueError):
            Catalogue(weights)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        ScoringRules(milestone_pct=(40, 20, 100))
    with pytest.raises(ValueError):
        ScoringRules(hint_cost_pct=(10, 200))


def test_milestone_names_match_the_platform_names():
    assert [m.label for m in Milestone] == ["none", "M1", "M2", "M3"]


def test_missing_challenges_count_as_none():
    result = compute_score({})
    assert result.shown == 0
    assert len(result.per_challenge) == 11
