"""Every worked example of PRD Appendix A (docs/prd/PRD.md lines 1885-1892), alone and through the real catalogue."""
import pytest

from vulnmart_attempts import Catalogue, Fact, Milestone, compute_score

M1, M2, M3 = Milestone.M1, Milestone.M2, Milestone.M3

# (PRD line, case, challenge key in the real catalogue, weight, fact, expected points)
ROWS = [
    (1887, "Full capture of a Medium, no hints: 90 x 100% = 90", "C02", 90, Fact(M3), 90),
    (1888, "Medium: exploit evidence but no flag: 90 x 40% = 36", "C02", 90, Fact(M2), 36),
    (1889, "Hard: flag captured, two hints (10% + 20%): 120 - 0.30 x 120 = 84", "C06", 120, Fact(M3, (1, 2)), 84),
    (1890, "Easy: found the weakness (20%), then 1 hint (10%): 12 - 6 = 6", "C01", 60, Fact(M1, (1,)), 6),
    (1891, "Easy: found the weakness (20%), then 3 hints (60%): 12 - 36 floored, 0 not -24", "C01", 60,
     Fact(M1, (1, 2, 3)), 0),
]


@pytest.mark.parametrize(("line", "case", "key", "weight", "fact", "expected"), ROWS)
def test_row_alone(line, case, key, weight, fact, expected):
    result = compute_score({"X": fact}, Catalogue({"X": weight}))
    assert result.per_challenge[0].points == expected, (line, case)


@pytest.mark.parametrize(("line", "case", "key", "weight", "fact", "expected"), ROWS)
def test_row_in_real_catalogue(line, case, key, weight, fact, expected):
    cat = Catalogue()
    assert cat.weights[key] == weight
    result = compute_score({key: fact}, cat)
    by_key = {row.challenge_key: row for row in result.per_challenge}
    assert by_key[key].points == expected, (line, case)
    assert sum(r.points for r in result.per_challenge if r.challenge_key != key) == 0


def test_row_6_all_eleven_captured_no_hints_shows_1000():
    """PRD line 1892: all 11 captured with no hints: sum(W_c), 1000 shown."""
    cat = Catalogue()
    assert len(cat.weights) == 11
    result = compute_score({key: Fact(M3) for key in cat.weights}, cat)
    assert result.shown == 1000
    assert sum(r.points for r in result.per_challenge) == cat.total == 960


def test_row_6_with_any_other_weights_still_1000():
    result = compute_score({"A": Fact(M3), "B": Fact(M3), "C": Fact(M3)}, Catalogue({"A": 7, "B": 13, "C": 101}))
    assert result.shown == 1000


def test_default_catalogue_matches_challenge_specs_6_2():
    """docs/design/challenge-specs.md 6.2 with C03 as Medium: 3 Easy x 60, 6 Medium x 90, 2 Hard x 120 = 960."""
    w = Catalogue().weights
    assert [k for k, v in w.items() if v == 60] == ["C01", "C05", "C07"]
    assert [k for k, v in w.items() if v == 90] == ["C02", "C03", "C04", "C08", "C09", "C11"]
    assert [k for k, v in w.items() if v == 120] == ["C06", "C10"]
    assert Catalogue().total == 960


@pytest.mark.parametrize(("key", "shown"), [("C02", 94), ("C06", 125), ("C01", 63)])
def test_challenge_specs_scaled_examples(key, shown):
    """challenge-specs 6.2: one full Medium 94, one full Hard 125, one full Easy 63 of 1000."""
    assert compute_score({key: Fact(M3)}).shown == shown
