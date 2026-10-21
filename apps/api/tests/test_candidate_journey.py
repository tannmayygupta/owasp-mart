"""Tracker audit 2026-10-21 (L-30, section 3.1): the end-to-end suite had no invite, assessment or recruiter report. This is one run through the real services (company,
template, invite, accept, consent, startAttempt, the lab runtime on the fake instance host, flag paste, submit, report, release) with the HTTP routes the dashboards call.
It uses the combined world of the privacy-wall tests: Cam is a candidate of Rita's company, and the template says `after_release` with 45 minutes."""
from __future__ import annotations

from support import play
from test_privacy_wall import CAM_EMAIL, RITA, w, wait_running  # noqa: F401 - the combined world and its helpers
from test_assessments import assessments, active_company, basic, mail_rows, token_in  # noqa: F401
from test_companies import audit, clock, companies, ended, sessions  # noqa: F401


def test_a_candidate_goes_from_invite_to_a_released_report(w):  # noqa: F811
    cam, rita = w.browser(CAM_EMAIL), w.browser(RITA)
    attempt = w.cam_attempt
    # the invite is open and consented; the attempt waits in `ready` with the template's rules
    assert cam.get(f"/api/v1/attempts/{attempt}").json()["state"] == "ready"
    rules = w.lab.engine.get(attempt).rules
    assert (rules.time_limit_minutes, rules.results_visibility) == (45, "after_release")

    # Start asks for the instance; the clock starts when it is ready (D-80)
    started = cam.post(f"/api/v1/attempts/{attempt}/start")
    assert started.status_code == 200, started.text
    wait_running(w.lab, attempt)
    view = cam.get(f"/api/v1/attempts/{attempt}").json()
    assert view["state"] == "running" and view["instance_id"] and view["results_released"] is False
    assert (w.lab.engine.get(attempt).deadline_at - w.lab.engine.get(attempt).started_at).total_seconds() == 45 * 60

    # the candidate uses the shop and pastes the flag of C01
    instance = view["instance_id"]
    play(w.lab, instance)
    flag = w.lab.keys.flag(instance, "C01", 1)
    pasted = cam.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": flag})
    assert pasted.status_code == 200 and pasted.json()["result"] == "correct", pasted.text
    assert flag not in pasted.text

    # the candidate submits; the results stay hidden from the candidate until the recruiter releases them
    assert cam.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": True}).json()["state"] == "submitted"
    assert cam.get(f"/api/v1/attempts/{attempt}/score").status_code == 404
    hidden = cam.get(f"/api/v1/attempts/{attempt}/challenges").json()["items"]
    assert hidden and all(i["best_milestone"] == "none" and not i["solved"] for i in hidden)
    assert cam.get(f"/api/v1/attempts/{attempt}/report").status_code == 404  # a candidate has no report route

    # the recruiter of the company sees the report with the capture, and the view is logged
    report = rita.get(f"/api/v1/attempts/{attempt}/report")
    assert report.status_code == 200, report.text
    body = report.json()
    assert body["state"] == "submitted" and body["score"] > 0 and body["mode"] == "candidate"
    assert any(c["challenge_key"] == "C01" and c["best_milestone"] == "M3" for c in body["per_challenge"])
    assert flag not in report.text
    assert any(e["event"] == "recruiter_viewed_report" for e in w.lab.attempt_log.read(attempt))

    # release: the candidate then sees the same score; repeating the release changes nothing
    released = rita.post(f"/api/v1/attempts/{attempt}/release")
    assert released.status_code == 200 and released.json()["results_released"] is True
    assert rita.post(f"/api/v1/attempts/{attempt}/release").status_code == 200
    score = cam.get(f"/api/v1/attempts/{attempt}/score")
    assert score.status_code == 200 and score.json()["score"] == body["score"]
    assert sum(1 for e in w.lab.attempt_log.read(attempt) if e["event"] == "results_released") == 1

    # the timeline tells the story in order, without any flag
    kinds = [e["type"] for e in rita.get(f"/api/v1/attempts/{attempt}/timeline").json()["items"]]
    assert kinds[0] == "attempt.started" and "attempt.submitted" in kinds and "milestone.reached" in kinds
    assert flag not in rita.get(f"/api/v1/attempts/{attempt}/timeline").text
