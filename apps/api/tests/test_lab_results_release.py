"""Handoff H-355 (OI-15, IF-2 2.1.0): when the invite says `after_release`, the candidate sees no score and no earned progress until the recruiter of the company releases
the results of the finished attempt. The default `after_submit` and a learner's practice stay as they were."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from vulnmart.accounts.http import Authenticated, authenticated, authenticated_with_csrf
from vulnmart.lab.runtime import new_attempt_id
from vulnmart.ports.scope import Role, Scope
from vulnmart_attempts import Rules

from test_lab_api import World, check, client, wait_running  # noqa: F401 - helpers shared with the other lab route tests
from test_password_reset import EMAIL, add_user, clock, sessions  # noqa: F401

CANDIDATE = "u-AAAAAAAAAAAAAAAA"
ORG = "org-1"


def attempt(world: World, visibility: str, *, submit: bool) -> str:
    """A candidate attempt of company ORG under the given rule; running, or already submitted."""
    world.lab.engine.create(CANDIDATE, world.lab.template_id, consent_id="c-1", org_id=ORG, attempt_id=new_attempt_id(), rules=Rules(results_visibility=visibility))
    started = world.lab.start_attempt(CANDIDATE, org_id=ORG)
    wait_running(world, started.attempt_id)
    if submit:
        world.lab.submit(started.attempt_id)
    return started.attempt_id


def act_as(world: World, user_id: str, role: Role, org: str | None):
    scope = Scope(user_id=user_id, org_id=org, roles=frozenset({role}))
    auth = Authenticated("t" * 40, SimpleNamespace(user=SimpleNamespace(id=user_id), roles=frozenset({role}), scope=scope))
    world.app.dependency_overrides[authenticated] = lambda: auth
    world.app.dependency_overrides[authenticated_with_csrf] = lambda: auth
    return client(world.app)


@pytest.fixture
def world(sessions, clock):  # noqa: F811
    add_user(sessions)
    return World(sessions, clock)


def test_the_rule_is_part_of_the_stored_rules_and_an_unknown_value_is_refused():
    assert Rules().results_visibility == "after_submit"
    assert Rules.from_dict(Rules(results_visibility="after_release").to_dict()).results_visibility == "after_release"
    with pytest.raises(ValueError):
        Rules(results_visibility="whenever")


def test_an_after_release_candidate_sees_nothing_earned_until_the_recruiter_releases(world):
    aid = attempt(world, "after_release", submit=True)
    cand = act_as(world, CANDIDATE, Role.CANDIDATE, None)
    assert cand.get(f"/api/v1/attempts/{aid}/score").status_code == 404
    listed = cand.get(f"/api/v1/attempts/{aid}/challenges")
    assert listed.status_code == 200 and listed.json()["items"]
    assert all(i["best_milestone"] == "none" and not i["solved"] and not i["held"] for i in listed.json()["items"])
    view = cand.get(f"/api/v1/attempts/{aid}").json()
    check("Attempt", view)
    assert view["results_released"] is False

    rec = act_as(world, "u-REC", Role.RECRUITER, ORG)
    assert rec.get(f"/api/v1/attempts/{aid}/score").status_code == 200  # the company always sees them
    released = rec.post(f"/api/v1/attempts/{aid}/release")
    assert released.status_code == 200, released.text
    check("Attempt", released.json())
    assert released.json()["results_released"] is True
    assert rec.post(f"/api/v1/attempts/{aid}/release").status_code == 200  # repeating changes nothing
    assert sum(1 for e in world.lab.attempt_log.read(aid) if e["event"] == "results_released") == 1

    cand = act_as(world, CANDIDATE, Role.CANDIDATE, None)
    assert cand.get(f"/api/v1/attempts/{aid}/score").status_code == 200
    assert cand.get(f"/api/v1/attempts/{aid}").json()["results_released"] is True


def test_release_waits_for_the_end_and_is_for_the_recruiter_of_the_company_only(world):
    aid = attempt(world, "after_release", submit=False)
    rec = act_as(world, "u-REC", Role.RECRUITER, ORG)
    still_running = rec.post(f"/api/v1/attempts/{aid}/release")
    assert still_running.status_code == 409 and still_running.json()["code"] == "ATT-INVALID-STATE"
    world.lab.submit(aid)
    assert act_as(world, CANDIDATE, Role.CANDIDATE, None).post(f"/api/v1/attempts/{aid}/release").status_code == 404  # not their own results to release
    assert act_as(world, "u-OTHER", Role.RECRUITER, "org-2").post(f"/api/v1/attempts/{aid}/release").status_code == 404
    assert act_as(world, "u-STRANGER", Role.CANDIDATE, None).post(f"/api/v1/attempts/{aid}/release").status_code == 404
    assert all(e["event"] != "results_released" for e in world.lab.attempt_log.read(aid))


def test_the_default_rule_and_a_learners_practice_are_not_held_back(world):
    aid = attempt(world, "after_submit", submit=True)
    cand = act_as(world, CANDIDATE, Role.CANDIDATE, None)
    assert cand.get(f"/api/v1/attempts/{aid}/score").status_code == 200
    assert "results_released" not in cand.get(f"/api/v1/attempts/{aid}").json()
    started = world.lab.start_attempt("u-BBBBBBBBBBBBBBBB")  # a learner has no company
    rec = world.lab.engine.get(started.attempt_id)
    assert rec.org_id is None and rec.rules.results_visibility == "after_submit"
