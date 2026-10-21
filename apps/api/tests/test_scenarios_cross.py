"""Work package G, scenario matrix: the cross-role scenarios X-01 to X-21 and the concurrency cases the audit lists (two Start presses, a flag pasted twice at once,
two accepts of one invite, a duplicate invite sent twice at once), through the routes of the combined world, with threads."""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor

import pytest

from scenario_support import (  # noqa: F401 - fixtures
    ADA, ADA_EMAIL, CAM_EMAIL, EVE_EMAIL, RITA, ROB, accept_and_consent, anonymous, assessments, audit, clock, companies, ended, invite_candidate, mail_rows, new_learner, outbox, play,
    sessions, start_candidate, start_practice, sw, token_in, w, wait_running,
)


def test_x01_a_learner_practises_is_invited_and_goes_through_accept_consent_start_and_submit(sw):
    uid, email = new_learner(sw, 41)
    b = sw.browser(email)
    p_instance, p_attempt = start_practice(sw, b)
    play(sw.lab, p_instance)
    assert b.post(f"/api/v1/attempts/{p_attempt}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(p_instance, "C01", 1)}).json()["credit"] == "credited"
    points = b.get("/api/v1/me/progress").json()["total_points"]
    token, _ = invite_candidate(sw, email)
    attempt = accept_and_consent(sw, b, token)
    instance = start_candidate(sw, b, attempt)
    assert b.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": True}).json()["state"] == "submitted"
    assert b.get("/api/v1/me/progress").json()["total_points"] == points, "the assessment never counts as practice"
    assert sw.lab.engine.get(p_attempt).state.value == "running", "the practice run was left alone"


def test_x02_x03_a_recruiter_never_sees_practice_and_the_two_modes_are_separated_by_org_template_instance_and_flags(sw):
    rita = sw.browser(RITA)
    uid, email = new_learner(sw, 42)
    b = sw.browser(email)
    p_instance, p_attempt = start_practice(sw, b)
    token, _ = invite_candidate(sw, email)
    a_attempt = accept_and_consent(sw, b, token)
    a_instance = start_candidate(sw, b, a_attempt)
    practice, assessment = sw.lab.engine.get(p_attempt), sw.lab.engine.get(a_attempt)
    assert practice.org_id is None and assessment.org_id is not None and practice.template_id != assessment.template_id and p_instance != a_instance
    assert sw.lab.keys.flag(p_instance, "C01", 1) != sw.lab.keys.flag(a_instance, "C01", 1)
    for url in (f"/api/v1/attempts/{p_attempt}", f"/api/v1/attempts/{p_attempt}/report", f"/api/v1/attempts/{p_attempt}/timeline", f"/api/v1/attempts/{p_attempt}/evidence"):
        assert rita.get(url).status_code == 404
    assert rita.get(f"/api/v1/attempts/{a_attempt}").status_code == 200
    modes = {a["attempt_id"]: a["mode"] for a in b.get("/api/v1/me/attempts").json()["items"]}
    assert modes == {p_attempt: "learner", a_attempt: "candidate"}


def test_x06_a_withdrawal_from_an_assessment_leaves_the_practice_data_alone(sw):
    uid, email = new_learner(sw, 43)
    b = sw.browser(email)
    p_instance, p_attempt = start_practice(sw, b)
    play(sw.lab, p_instance)
    b.post(f"/api/v1/attempts/{p_attempt}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(p_instance, "C01", 1)})
    before = b.get("/api/v1/me/progress").json()
    token, _ = invite_candidate(sw, email)
    attempt = accept_and_consent(sw, b, token)
    start_candidate(sw, b, attempt)
    assert b.post(f"/api/v1/attempts/{attempt}/withdraw", {"confirm": True}).json()["state"] == "withdrawn"
    assert b.get("/api/v1/me/progress").json() == before
    assert sw.lab.engine.get(p_attempt).state.value == "running"


def test_x08_a_second_invite_after_a_re_invite_gets_an_attempt_of_its_own(sw):
    rita = sw.browser(RITA)
    reinvited = rita.post(f"/api/v1/company/invites/{sw.cam_invite}/actions", {"action": "reinvite"}).json()
    token = token_in(mail_rows(sw.sessions)[-1])
    cam = sw.browser(CAM_EMAIL)
    again = cam.post("/api/v1/invites/accept", {"token": token})
    assert again.status_code == 200, again.text
    assert again.json()["attempt_id"] != sw.cam_attempt, "the second generation is a new attempt"


def test_x15_two_sessions_of_one_account_work_side_by_side_and_each_can_be_listed(sw):
    laptop, phone = sw.browser(EVE_EMAIL), sw.browser(EVE_EMAIL)
    assert laptop.get("/api/v1/me").status_code == 200 and phone.get("/api/v1/me").status_code == 200
    assert len(laptop.get("/api/v1/me/sessions").json()["items"]) == 2


def test_x18_all_instants_are_utc_with_a_z_in_every_view(sw):
    cam = sw.browser(CAM_EMAIL)
    text = json.dumps([cam.get(f"/api/v1/attempts/{sw.cam_attempt}").json(), cam.get("/api/v1/me/attempts").json(), cam.get("/api/v1/me/invites").json()])
    stamps = re.findall(r'"\d{4}-\d\d-\d\dT[0-9:.+Z-]+"', text)
    assert stamps and all(s.endswith('Z"') for s in stamps), stamps


# ---- concurrency ----------------------------------------------------------------------------------------------------------------------
# The HTTP layer of this world runs on one shared SQLite connection (the test database), which is not a model of concurrent requests (it answers `InterfaceError` when two
# threads use it at once). The threads therefore call the lab runtime, whose stores are in memory and locked, the same object the routes call. The races of the invite and
# company tables (two accepts of one invite, one invite sent twice at once) are proved on Postgres by test_assessments_postgres.py and test_invite_acceptance_postgres.py.

def test_xc1_four_start_presses_at_once_make_one_run_not_four(sw):
    uid, email = new_learner(sw, 44)
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: _try(lambda: sw.lab.start_attempt(uid)), range(4)))
    started = [r for r in results if not isinstance(r, Exception)]
    assert started, results
    assert len({r.attempt_id for r in started}) == 1 and len({r.instance_id for r in started}) == 1, "one attempt and one instance"
    assert len(sw.lab.engine.for_user(uid)) == 1


def _try(fn):
    try:
        return fn()
    except Exception as exc:  # the refusal of a repeat is an answer, not a crash
        return exc


def test_xc2_the_same_correct_flag_pasted_at_once_is_credited_once_in_the_score(sw):
    uid, email = new_learner(sw, 45)
    b = sw.browser(email)
    instance, attempt = start_practice(sw, b)
    play(sw.lab, instance)
    flag = sw.lab.keys.flag(instance, "C01", 1)
    with ThreadPoolExecutor(5) as pool:
        results = list(pool.map(lambda _: sw.lab.submit_flag(attempt, "C01", flag), range(5)))
    assert all((r.result, r.credit) == ("correct", "credited") for r in results)
    total, rows = sw.lab.score_rows(attempt)
    assert sum(1 for r in rows if r["best_milestone"] == "M3") == 1 and total == sw.lab.score_rows(attempt)[0] > 0


@pytest.mark.xfail(strict=False, reason="FOUND by work package G: five identical pastes at once each write a `milestone_reached` line to the attempt log, so the timeline shows the "
                                         "capture five times (the score is right). Owner: the flag path (package A touches flags/submit.py); passes silently once fixed.")
def test_xc2b_the_milestone_is_journalled_once_when_the_same_flag_is_pasted_at_once(sw):
    uid, email = new_learner(sw, 48)
    b = sw.browser(email)
    instance, attempt = start_practice(sw, b)
    play(sw.lab, instance)
    flag = sw.lab.keys.flag(instance, "C01", 1)
    with ThreadPoolExecutor(5) as pool:
        list(pool.map(lambda _: sw.lab.submit_flag(attempt, "C01", flag), range(5)))
    assert sum(1 for e in sw.lab.attempt_log.read(attempt) if e.get("event") == "milestone_reached" and e.get("level") == "M3") == 1


def test_xc5_a_submit_racing_a_flag_paste_leaves_one_consistent_attempt(sw):
    uid, email = new_learner(sw, 47)
    token, _ = invite_candidate(sw, email)
    b = sw.browser(email)
    attempt = accept_and_consent(sw, b, token)
    instance = start_candidate(sw, b, attempt)
    play(sw.lab, instance)
    flag = sw.lab.keys.flag(instance, "C01", 1)
    with ThreadPoolExecutor(2) as pool:
        paste = pool.submit(lambda: _try(lambda: sw.lab.submit_flag(attempt, "C01", flag)))
        submit = pool.submit(lambda: _try(lambda: sw.lab.submit(attempt)))
    paste, submit = paste.result(), submit.result()
    assert not isinstance(submit, Exception), submit
    assert sw.lab.engine.get(attempt).state.value in ("submitted", "reported")
    best = sw.lab.milestones.best(attempt, "C01").value
    if isinstance(paste, Exception):
        assert best == "none", "a refused paste leaves nothing behind"
    else:
        assert best == "M3", "an answered paste is recorded"
