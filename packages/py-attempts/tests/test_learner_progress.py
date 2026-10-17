"""FR-SCR-06: Learner progress by stars, solved tick and no-hints badge; hints never lower it."""
import pytest

from vulnmart_attempts import Fact, Milestone, learner_overview, learner_progress


@pytest.mark.parametrize(("milestone", "stars"), [(Milestone.NONE, 0), (Milestone.M1, 1), (Milestone.M2, 2), (Milestone.M3, 3)])
def test_stars_follow_milestone(milestone, stars):
    assert learner_progress(Fact(milestone)).stars == stars


def test_m3_with_two_hints_is_three_stars_solved_no_badge():
    p = learner_progress(Fact(Milestone.M3, (1, 2)))
    assert (p.stars, p.solved, p.no_hints_badge) == (3, True, False)


def test_m3_with_zero_hints_gets_badge():
    p = learner_progress(Fact(Milestone.M3))
    assert (p.stars, p.solved, p.no_hints_badge) == (3, True, True)


def test_badge_only_when_solved():
    assert not learner_progress(Fact(Milestone.M2)).no_hints_badge


def test_hints_never_lower_progress():
    for m in Milestone:
        base = learner_progress(Fact(m))
        for levels in ((1,), (1, 2), (1, 2, 3)):
            p = learner_progress(Fact(m, levels))
            assert p.stars == base.stars and p.solved == base.solved


def test_overview_covers_all_eleven_and_refuses_unknown():
    out = learner_overview({"C01": Fact(Milestone.M3)})
    assert len(out) == 11 and out["C01"].solved and not out["C02"].solved
    with pytest.raises(ValueError):
        learner_overview({"C12": Fact(Milestone.M1)})
