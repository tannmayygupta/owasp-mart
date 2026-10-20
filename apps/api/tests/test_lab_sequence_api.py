"""The lab routes of a sequenced learner run (contract 1.3.0): one challenge at a time, the countdown of each, a new run after a finished one, and the points on the account.
Every answer is checked against the schemas of contracts/api/lab/lab.openapi.yaml."""
from __future__ import annotations

import pytest

from support import play
from test_lab_api import ada, check, problem, start, world  # noqa: F401 - fixtures and helpers shared with the other lab route tests
from test_password_reset import clock, sessions  # noqa: F401


@pytest.fixture
def seq(world):  # noqa: F811
    world.lab.sequenced = True  # the runtime of the deployed learner mode (VULNMART_LAB_SEQUENCE=1)
    return world


def keys(body):
    return [i["challenge_key"] for i in body["items"]]


def test_a_new_run_shows_only_the_first_challenge_with_its_time_and_nothing_ahead(seq, ada):
    iid, aid = start(seq, ada)
    body = ada.get(f"/api/v1/attempts/{aid}/challenges").json()
    check("ChallengeProgressList", body)
    assert keys(body) == ["C01"] and body["total"] == 11 and body["current_key"] == "C01"
    item = body["items"][0]
    assert (item["state"], item["tier"], item["time_limit_seconds"], item["opened_at"], item["expires_at"], item["seconds_left"]) == ("ready", "Easy", 1200, None, None, None)
    assert item["title"] == "Broken Access Control" and "brief" in item and "start" not in item  # how to begin comes with the countdown
    assert item["hints_available"] is False


def test_a_challenge_that_is_not_reached_does_not_exist_for_the_learner(seq, ada):
    iid, aid = start(seq, ada)
    play(seq.lab, iid)
    for url, call in ((f"/api/v1/attempts/{aid}/challenges/C02/begin", ada.post), (f"/api/v1/attempts/{aid}/challenges/C02/hints", ada.get),
                      (f"/api/v1/attempts/{aid}/challenges/C02/hints/1/unlock", ada.post)):
        problem(call(url), 404, "ATT-CHALLENGE-NOT-FOUND")
    problem(ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C02", "flag": seq.lab.keys.flag(iid, "C02", 1)}), 404, "ATT-CHALLENGE-NOT-FOUND")
    assert seq.lab.milestones.best(aid, "C02").value == "none"


def test_nothing_counts_before_the_challenge_is_begun(seq, ada):
    iid, aid = start(seq, ada)
    play(seq.lab, iid)
    problem(ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": seq.lab.keys.flag(iid, "C01", 1)}), 409, "ATT-INVALID-STATE")
    problem(ada.post(f"/api/v1/attempts/{aid}/challenges/C01/hints/1/unlock"), 409, "ATT-INVALID-STATE")


def test_begin_starts_the_countdown_once_and_the_flag_then_solves_the_challenge_and_brings_the_next(seq, ada, clock):  # noqa: F811
    iid, aid = start(seq, ada)
    play(seq.lab, iid)
    b = ada.post(f"/api/v1/attempts/{aid}/challenges/C01/begin")
    assert b.status_code == 200, b.text
    check("ChallengeProgress", b.json())
    first = b.json()
    assert first["state"] == "active" and first["seconds_left"] == 1200 and first["hints_available"] is True and "start" in first
    clock.advance(minutes=5)
    again = ada.post(f"/api/v1/attempts/{aid}/challenges/C01/begin").json()
    assert again["opened_at"] == first["opened_at"] and again["seconds_left"] == 900  # the first instant stays
    h = ada.post(f"/api/v1/attempts/{aid}/challenges/C01/hints/1/unlock")
    assert h.status_code == 200 and h.json()["unlocked"] is True
    right = ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": seq.lab.keys.flag(iid, "C01", 1)})
    assert right.json() == {"challenge_key": "C01", "result": "correct", "credit": "credited"}
    body = ada.get(f"/api/v1/attempts/{aid}/challenges").json()
    check("ChallengeProgressList", body)
    assert keys(body) == ["C01", "C02"] and body["current_key"] == "C02"
    c1, c2 = body["items"]
    assert (c1["state"], c1["solved"]) == ("solved", True) and "write_up" in c1
    assert (c2["state"], c2["tier"], c2["time_limit_seconds"]) == ("ready", "Medium", 2400)


def test_when_the_time_is_over_the_challenge_closes_and_the_next_one_comes_up(seq, ada, clock):  # noqa: F811
    iid, aid = start(seq, ada)
    play(seq.lab, iid)
    ada.post(f"/api/v1/attempts/{aid}/challenges/C01/begin")
    clock.advance(minutes=20)
    body = ada.get(f"/api/v1/attempts/{aid}/challenges").json()
    check("ChallengeProgressList", body)
    assert [(i["challenge_key"], i["state"]) for i in body["items"]] == [("C01", "expired"), ("C02", "ready")]
    assert body["items"][0]["seconds_left"] is None and "write_up" in body["items"][0]
    problem(ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": seq.lab.keys.flag(iid, "C01", 1)}), 409, "ATT-INVALID-STATE")
    problem(ada.post(f"/api/v1/attempts/{aid}/challenges/C01/begin"), 409, "ATT-INVALID-STATE")
    assert ada.post(f"/api/v1/attempts/{aid}/challenges/C02/begin").status_code == 200


def test_the_account_points_keep_the_best_result_per_challenge_over_runs_and_a_finished_run_can_be_followed_by_a_new_one(seq, ada):
    iid, aid = start(seq, ada)
    play(seq.lab, iid)
    ada.post(f"/api/v1/attempts/{aid}/challenges/C01/begin")
    ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": seq.lab.keys.flag(iid, "C01", 1)})
    acc = ada.get("/api/v1/me/progress")
    check("AccountProgress", acc.json())
    assert acc.json()["total_points"] == 63 and acc.json()["runs"] == 1
    assert ada.post(f"/api/v1/attempts/{aid}/submit", {"confirm": True}).status_code == 200
    r = ada.post("/api/v1/instances", {"kind": "learner"})  # the finished run no longer blocks a new one
    assert r.status_code == 202, r.text
    new_aid = r.json()["attempt_id"]
    assert new_aid != aid
    mine = ada.get("/api/v1/me/attempts").json()["items"]
    assert {a["attempt_id"] for a in mine[:2]} == {new_aid, aid}  # newest first by creation time; the test clock stands still, so the two tie and the id breaks it
    assert ada.get("/api/v1/me/progress").json()["runs"] == 2 and ada.get("/api/v1/me/progress").json()["total_points"] == 63


def test_an_attempt_that_is_not_sequenced_lists_every_challenge_and_has_no_begin(world, ada):  # noqa: F811
    iid, aid = start(world, ada)  # the plain runtime of the older tests: sequenced is off
    body = ada.get(f"/api/v1/attempts/{aid}/challenges").json()
    check("ChallengeProgressList", body)
    assert len(body["items"]) == 11 and "total" not in body and "state" not in body["items"][0]
    problem(ada.post(f"/api/v1/attempts/{aid}/challenges/C01/begin"), 404, "ATT-CHALLENGE-NOT-FOUND")


def test_the_begin_route_needs_a_session_and_the_csrf_token(seq, ada):
    iid, aid = start(seq, ada)
    problem(ada.post(f"/api/v1/attempts/{aid}/challenges/C01/begin", csrf=False), 403, "AUTH-CSRF-FAILED")
    from fastapi.testclient import TestClient  # noqa: F401
    from test_password_reset import client
    problem(client(seq.app).get("/api/v1/me/progress"), 401, "AUTH-SESSION-REQUIRED")
