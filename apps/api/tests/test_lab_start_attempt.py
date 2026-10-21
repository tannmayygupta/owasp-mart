"""Handoff H-356 (D-80, OI-22): a candidate presses Start; the lab asks for the instance of the attempt the consent created, and the clock starts when the
instance is ready. A learner starts through requestInstance, a stranger sees 404."""
from __future__ import annotations

from vulnmart.lab.runtime import new_attempt_id

from test_lab_api import Session, ada, check, eve, wait_running, world  # noqa: F401 - fixtures and helpers shared with the other lab route tests
from test_password_reset import clock, sessions  # noqa: F401

ADA_ID = "u-AAAAAAAAAAAAAAAA"


def candidate_attempt(world, user_id: str = ADA_ID) -> str:
    rec = world.lab.engine.create(user_id, world.lab.template_id, consent_id="c-1", org_id="o-BBBBBBBBBBBBBBBB", attempt_id=new_attempt_id())
    assert rec.state.value == "ready" and rec.instance_id is None
    return rec.id


def test_start_asks_for_the_instance_and_the_clock_starts_when_it_is_ready(world, ada):  # noqa: F811
    aid = candidate_attempt(world)
    r = ada.post(f"/api/v1/attempts/{aid}/start")
    assert r.status_code == 200, r.text
    check("Attempt", r.json())
    wait_running(world, aid)
    rec = world.lab.engine.get(aid)
    assert rec.state.value == "running" and rec.started_at is not None and rec.deadline_at > rec.started_at
    again = ada.post(f"/api/v1/attempts/{aid}/start")  # a second press answers the same attempt and starts nothing more
    assert again.status_code == 200 and again.json()["attempt_id"] == aid


def test_a_learner_attempt_and_a_finished_attempt_cannot_be_started_again(world, ada, eve):  # noqa: F811
    r = ada.post("/api/v1/instances", {"kind": "learner"})
    assert r.status_code == 202, r.text
    learner = r.json()["attempt_id"]
    wait_running(world, learner)
    blocked = ada.post(f"/api/v1/attempts/{learner}/start")
    assert blocked.status_code == 409 and blocked.json()["code"] == "ATT-INVALID-STATE"
    aid = candidate_attempt(world, "u-BBBBBBBBBBBBBBBB")  # one attempt per person and template: the finished candidate attempt is Eve's
    eve.post(f"/api/v1/attempts/{aid}/start")
    wait_running(world, aid)
    assert eve.post(f"/api/v1/attempts/{aid}/submit", {"confirm": True}).status_code == 200
    late = eve.post(f"/api/v1/attempts/{aid}/start")
    assert late.status_code == 409 and late.json()["code"] == "ATT-INVALID-STATE"


def test_a_stranger_cannot_start_my_attempt(world, ada, eve):  # noqa: F811
    aid = candidate_attempt(world)
    assert eve.post(f"/api/v1/attempts/{aid}/start").status_code == 404
    assert world.lab.engine.get(aid).state.value == "ready"
