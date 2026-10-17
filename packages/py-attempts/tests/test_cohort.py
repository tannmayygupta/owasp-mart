"""FR-SCR-07 and D-93 (OI-26): the cohort view is private, scoped, off by default; no cross-organisation function."""
import inspect

import pytest
from conftest_engine import T0

import vulnmart_attempts.cohort as cohort_module
from vulnmart_attempts import AttemptState as S
from vulnmart_attempts import ScoreResult, TieBreak
from vulnmart_attempts.cohort import CohortCandidate, CohortDisabled, CohortForbidden, build_cohort
from vulnmart_attempts.ranking import RankRow


def cand(attempt_id, state=S.REPORTED, shown=500, held_open=0):
    return CohortCandidate(RankRow(attempt_id, ScoreResult(shown, (), TieBreak(1, 0)), T0, 100), state, held_open)


def test_orders_by_the_aid_and_returns_ids_only():
    view = build_cohort("org1", "org1", "as1", True, [cand("a", shown=590), cand("b", shown=640)])
    assert (view.org_id, view.assessment_id) == ("org1", "as1")
    assert [r.attempt_id for r in view.rows] == ["b", "a"]
    assert all(r.label == "ranking aid, the recruiter decides" for r in view.rows)


def test_board_off_is_refused():
    with pytest.raises(CohortDisabled):
        build_cohort("org1", "org1", "as1", False, [cand("a")])


@pytest.mark.parametrize("scope", ["org2", "", None])
def test_foreign_or_missing_org_is_refused_before_anything_is_returned(scope):
    with pytest.raises(CohortForbidden):
        build_cohort(scope, "org1", "as1", True, [cand("a")])


def test_foreign_scope_is_refused_even_when_the_board_is_off():
    with pytest.raises(CohortForbidden):
        build_cohort("org2", "org1", "as1", False, [cand("a")])


def test_held_open_withdrawn_and_unfinished_are_not_listed_but_submitted_clean_is():
    rows = [cand("rep"), cand("sub", S.SUBMITTED), cand("held", S.SUBMITTED, held_open=1),
            cand("wd", S.WITHDRAWN), cand("run", S.RUNNING), cand("del", S.DELETED)]
    view = build_cohort("org1", "org1", "as1", True, rows)
    assert sorted(r.attempt_id for r in view.rows) == ["rep", "sub"]


def test_no_function_lists_across_organisations():
    # FR-SCR-07: every public function takes the organisation scope as its first argument or is a pure helper
    public = [f for n, f in inspect.getmembers(cohort_module, inspect.isfunction) if f.__module__ == cohort_module.__name__]
    assert {f.__name__ for f in public} == {"on_board", "build_cohort"}
    assert next(iter(inspect.signature(cohort_module.build_cohort).parameters)) == "scope_org_id"
