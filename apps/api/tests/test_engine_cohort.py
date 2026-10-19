"""The platform adapter of the private cohort view (story L-28, D-93): one company, one assessment, only attempts that ended, the aid order, nothing across companies."""
from __future__ import annotations

import pytest

from support import play
from test_lab_runtime import make_runtime
from vulnmart.ports.engine_cohort import CohortDisabled, CohortForbidden, EngineCohortPort, base_template


def finished(rt, user: str, org: str, keys: tuple[str, ...]) -> str:
    started = rt.start_attempt(user, org_id=org)
    play(rt, started.instance_id)
    for key in keys:
        assert rt.submit_flag(started.attempt_id, key, rt.keys.flag(started.instance_id, key, 1)).result == "correct"
    rt.submit(started.attempt_id)
    return started.attempt_id


def test_the_board_lists_only_ended_attempts_of_the_scoped_company_in_the_aid_order():
    rt, _, _ = make_runtime()
    low = finished(rt, "u-1", "o-1", ("C02",))
    high = finished(rt, "u-2", "o-1", ("C02", "C01"))
    nothing = finished(rt, "u-3", "o-1", ())
    other_company = finished(rt, "u-4", "o-2", ("C02", "C01", "C05"))
    still_running = rt.start_attempt("u-5", org_id="o-1").attempt_id
    withdrawn = rt.start_attempt("u-6", org_id="o-1").attempt_id
    rt.withdraw(withdrawn)

    view = rt.cohort.cohort("o-1", "o-1", "shop-v0", True)
    assert [r.attempt_id for r in view.rows] == [high, low, nothing]
    assert [r.position for r in view.rows] == [1, 2, 3]
    assert view.rows[0].shown > view.rows[1].shown > view.rows[2].shown == 0
    assert all(r.label == "ranking aid, the recruiter decides" for r in view.rows)
    listed = {r.attempt_id for r in view.rows}
    assert not listed & {other_company, still_running, withdrawn}, "another company, a running and a withdrawn attempt are not on the board"
    assert [r.attempt_id for r in rt.cohort.cohort("o-2", "o-2", "shop-v0", True).rows] == [other_company]


def test_a_foreign_or_missing_company_and_a_board_that_is_off_are_refused_before_any_row_is_read():
    rt, _, _ = make_runtime()
    finished(rt, "u-1", "o-1", ("C02",))
    for scope in ("o-2", None, ""):
        with pytest.raises(CohortForbidden):
            rt.cohort.cohort(scope, "o-1", "shop-v0", True)
    with pytest.raises(CohortDisabled):
        rt.cohort.cohort("o-1", "o-1", "shop-v0", False)

    class Boom:
        def in_states(self, *_a):
            raise AssertionError("a row was read before the scope was checked")

    port = EngineCohortPort(engine=Boom(), facts=None, milestones=None, active_seconds_of=lambda _a: None)
    with pytest.raises(CohortForbidden):
        port.cohort("o-2", "o-1", "shop-v0", True)
    with pytest.raises(CohortDisabled):
        port.cohort("o-1", "o-1", "shop-v0", False)


def test_a_re_invite_key_is_the_same_assessment_and_the_port_has_no_cross_company_call():
    assert base_template("shop-v0~2") == "shop-v0" and base_template("shop-v0") == "shop-v0" and base_template(None) is None
    public = {n for n in dir(EngineCohortPort) if not n.startswith("_")}
    assert public == {"cohort"}, "the only way in is one company and one assessment (FR-SCR-07: no global ranking)"