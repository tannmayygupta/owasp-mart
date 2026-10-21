"""WP-A (wiring audit F-01, F-07; role scenarios C-13, C-14, C-16, R-08, R-11): what the recruiter's template says reaches the stored attempt and the lab.

The path is the real one: template -> invite -> accept -> consent (the attempt is created in the lab engine under the invite's rules) -> the candidate's routes. The challenge subset,
the hints mode, the hint cost, the flags per minute, the time limit and the reset limit are checked on the stored attempt and on the routes' answers."""
from __future__ import annotations

import pytest

import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
from lifecycle_support import Stack
from support import play
from test_assessments import assessments  # noqa: F401
from test_companies import audit, clock, companies, ended, sessions  # noqa: F401
from test_lab_api import check, problem


@pytest.fixture
def stack(sessions, companies, assessments, audit, clock):  # noqa: F811
    return Stack(sessions, companies, assessments, audit, clock)


def started(stack: Stack, **rules):
    """A running candidate attempt under a template with these settings (the subset is C01, C02 and C05 unless `challenge_keys` is given)."""
    template = stack.new_template(**rules)
    _, aid = stack.consented_attempt(template)
    cand = stack.candidate()
    assert cand.post(f"/api/v1/attempts/{aid}/start").status_code == 200
    stack.running(aid)
    instance = stack.lab.engine.get(aid).instance_id
    play(stack.lab, instance)  # real use of the shop, so a pasted flag is credited and not held
    return cand, aid, instance


def paste(stack: Stack, cand, aid: str, instance: str, key: str):
    return cand.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": key, "flag": stack.lab.keys.flag(instance, key, 1)})


def test_the_template_settings_are_the_rules_of_the_stored_attempt_after_the_real_consent_path(stack):
    template = stack.new_template(hints_mode="on", hint_cost_pct=10, flag_submissions_per_minute=2, writeup_required=True, time_limit_min=60, reset_limit=1,
                                  results_visibility="after_release", challenge_keys=["C05", "C01", "C02"])
    _, aid = stack.consented_attempt(template)
    rules = stack.lab.engine.get(aid).rules
    assert (rules.hints_mode, rules.hint_cost_pct, rules.flag_submissions_per_minute, rules.writeup_required) == ("on", 10, 2, True)
    assert (rules.time_limit_minutes, rules.reset_limit, rules.results_visibility) == (60, 1, "after_release")
    assert rules.challenge_keys == ("C01", "C02", "C05")


def test_the_candidate_lists_scores_and_reports_only_the_templates_challenges_and_cannot_paste_or_hint_outside_them(stack):
    cand, aid, instance = started(stack, hints_mode="on", hint_cost_pct=10)
    listed = cand.get(f"/api/v1/attempts/{aid}/challenges").json()
    assert [i["challenge_key"] for i in listed["items"]] == ["C01", "C02", "C05"]
    problem(paste(stack, cand, aid, instance, "C03"), 404, "ATT-CHALLENGE-NOT-FOUND")
    problem(cand.get(f"/api/v1/attempts/{aid}/challenges/C03/hints"), 404, "ATT-CHALLENGE-NOT-FOUND")
    problem(cand.post(f"/api/v1/attempts/{aid}/challenges/C03/hints/1/unlock"), 404, "ATT-CHALLENGE-NOT-FOUND")
    score = cand.get(f"/api/v1/attempts/{aid}/score").json()
    assert [r["challenge_key"] for r in score["per_challenge"]] == ["C01", "C02", "C05"] and score["score"] == 0
    for key in ("C01", "C02", "C05"):
        r = paste(stack, cand, aid, instance, key)
        assert r.status_code == 200 and r.json()["credit"] == "credited", r.text
    score = cand.get(f"/api/v1/attempts/{aid}/score").json()
    assert score["score"] == 1000, "the score is out of 1000 over the challenges of the assessment"
    check("Score", score)
    with stack.recruiter() as rec:
        report = rec.get(f"/api/v1/attempts/{aid}/report").json()
    assert [r["challenge_key"] for r in report["per_challenge"]] == ["C01", "C02", "C05"] and report["score"] == 1000
    # a learner's practice is not narrowed: every challenge
    learner = cand.post("/api/v1/instances", {"kind": "learner"}).json()["attempt_id"]
    assert len(cand.get(f"/api/v1/attempts/{learner}/challenges").json()["items"]) == 11


def test_hints_are_off_for_a_candidate_unless_the_template_turned_them_on(stack):
    cand, aid, _ = started(stack)  # the template default: hints off
    assert cand.get(f"/api/v1/attempts/{aid}").json()["hints_enabled"] is False
    problem(cand.get(f"/api/v1/attempts/{aid}/challenges/C01/hints"), 404, "ATT-HINTS-DISABLED")
    problem(cand.post(f"/api/v1/attempts/{aid}/challenges/C01/hints/1/unlock"), 404, "ATT-HINTS-DISABLED")
    assert all(i["hints_available"] is False for i in cand.get(f"/api/v1/attempts/{aid}/challenges").json()["items"])
    with pytest.raises(Exception):  # and the runtime itself refuses, whatever the route did
        stack.lab.unlock_hint(aid, "C01", 1)


@pytest.mark.parametrize("pct", [10, 20])
def test_hints_on_cost_the_templates_percentage_times_the_level_and_the_cost_is_taken_from_the_score(stack, pct):
    cand, aid, instance = started(stack, hints_mode="on", hint_cost_pct=pct)
    assert cand.get(f"/api/v1/attempts/{aid}").json()["hints_enabled"] is True
    listed = cand.get(f"/api/v1/attempts/{aid}/challenges/C01/hints").json()["items"]
    assert [h["cost_pct"] for h in listed] == [pct, 2 * pct, 3 * pct]
    assert cand.post(f"/api/v1/attempts/{aid}/challenges/C01/hints/1/unlock").status_code == 200
    assert paste(stack, cand, aid, instance, "C01").status_code == 200
    # C01 is worth 60 of the 210 points of C01, C02 and C05; by hand: 1000 x 60 x (100 - pct) / (100 x 210), rounded half up (257 for 10 percent, 229 for 20; 286 with no hint)
    assert cand.get(f"/api/v1/attempts/{aid}/score").json()["score"] == {10: 257, 20: 229}[pct]

def test_the_flags_per_minute_of_the_template_limit_the_pastes_of_that_attempt(stack):
    cand, aid, instance = started(stack, flag_submissions_per_minute=2)
    wrong = {"challenge_key": "C01", "flag": "not-the-flag"}
    assert cand.post(f"/api/v1/attempts/{aid}/flags", wrong).json()["result"] == "incorrect"
    assert cand.post(f"/api/v1/attempts/{aid}/flags", wrong).json()["result"] == "incorrect"
    limited = cand.post(f"/api/v1/attempts/{aid}/flags", wrong)
    problem(limited, 429, "ATT-FLAG-RATE-LIMITED")
    assert int(limited.headers["retry-after"]) >= 1
    stack.clock.advance(seconds=61)
    cand = stack.candidate()
    r = paste(stack, cand, aid, instance, "C01")
    assert r.status_code == 200 and r.json()["result"] == "correct", "the next minute is free again"


def test_the_time_limit_and_the_reset_limit_of_the_template_are_the_attempts(stack):
    cand, aid, _ = started(stack, time_limit_min=60, reset_limit=1)
    rec = stack.lab.engine.get(aid)
    assert int((rec.deadline_at - rec.started_at).total_seconds()) == 60 * 60
    instance_id = rec.instance_id
    assert cand.post(f"/api/v1/instances/{instance_id}/reset", {"confirm": True}).status_code == 202
    for _ in range(300):
        if stack.lab.engine.get(aid).reset_count == 1:
            break
        import time

        time.sleep(0.01)
    assert stack.lab.engine.get(aid).reset_count == 1
    problem(cand.post(f"/api/v1/instances/{instance_id}/reset", {"confirm": True}), 409, "ATT-INVALID-STATE")  # no reset left


def test_results_visibility_still_holds_the_candidates_score_until_the_release(stack):
    cand, aid, instance = started(stack, results_visibility="after_release")
    assert paste(stack, cand, aid, instance, "C01").status_code == 200
    stack.lab.submit(aid)
    assert cand.get(f"/api/v1/attempts/{aid}/score").status_code == 404, "the rule reaches the attempt through the real consent path (F-01)"
    with stack.recruiter() as rec:
        assert rec.post(f"/api/v1/attempts/{aid}/release").status_code == 200
    assert cand.get(f"/api/v1/attempts/{aid}/score").status_code == 200
