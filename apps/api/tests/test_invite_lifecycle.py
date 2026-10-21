"""WP-A (wiring audit F-05, F-06, role scenarios C-24, C-27, C-28, C-29, R-24, R-16, X-02, X-07, X-08): the invite and the attempt move together.

Everything here goes through the real assessment service, the real consent service, the real lab runtime and the real lab routes (sessions, CSRF, Origin); only the orchestrator
and the mail provider are fakes. The candidate's Start moves the invite to `started`; a started invite never expires; a revoked or expired invite leaves no startable attempt;
a repeat invite gets an attempt of its own; the recruiter can cancel an attempt; a withdrawal leaves its consent record; a practice run and an assessment stay apart."""
from __future__ import annotations

import pytest
from sqlalchemy import select

import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
from lifecycle_support import CAND_ID, Stack
from test_assessments import assessments  # noqa: F401
from test_companies import audit, clock, companies, ended, sessions  # noqa: F401
from test_lab_api import check, problem
from vulnmart.privacy.models import ConsentRecord


@pytest.fixture
def stack(sessions, companies, assessments, audit, clock):  # noqa: F811
    return Stack(sessions, companies, assessments, audit, clock)


def start(cand, aid):
    return cand.post(f"/api/v1/attempts/{aid}/start")


def consent_actions(stack: Stack, aid: str) -> list[str]:
    with stack.sessions() as s:
        return sorted(s.scalars(select(ConsentRecord.action).where(ConsentRecord.attempt_id == aid)))


# ---- the invite reaches `started`, and a started invite never expires ----

def test_the_candidates_start_moves_the_invite_to_started_and_it_never_expires_while_the_attempt_runs_or_after_it_ended(stack):
    view, aid = stack.consented_attempt()
    assert stack.invite_state(view.invite_id) == "consented" and stack.lab.engine.get(aid).rules.time_limit_minutes == 120
    cand = stack.candidate()
    r = start(cand, aid)
    assert r.status_code == 200, r.text
    check("Attempt", r.json())
    stack.running(aid)
    assert stack.invite_state(view.invite_id) == "started"
    stack.clock.advance(minutes=5)
    assert start(cand, aid).status_code == 200, "a second press is fine"
    stack.clock.advance(days=30)  # far past the invite's expiry (7 days) and past the attempt's own deadline
    assert stack.assessments.expire_all() == 0
    assert stack.invite_state(view.invite_id) == "started", "a started invite is not closed by its expiry date (it was, before: wiring audit F-05)"
    stack.lab.tick()  # the engine submits the attempt at its deadline
    assert stack.lab.engine.get(aid).state.value in ("submitted", "reported")
    assert stack.invite_state(view.invite_id) == "started", "nor after the attempt ended"
    with stack.recruiter() as rec:  # the recruiter still reads the report of the ended attempt
        assert rec.get(f"/api/v1/attempts/{aid}/report").status_code == 200


# ---- a closed invite leaves nothing startable ----

def test_a_revoked_invite_cancels_its_ready_attempt_and_the_attempt_cannot_be_started(stack):
    view, aid = stack.consented_attempt()
    assert stack.lab.engine.get(aid).state.value == "ready"
    stack.assessments.revoke(stack.owner, view.invite_id)
    assert stack.lab.engine.get(aid).state.value == "cancelled"
    cand = stack.candidate()
    problem(start(cand, aid), 409, "ATT-INVALID-STATE")
    assert stack.lab.directory.for_attempt(aid) is None, "no instance was asked of the orchestrator"
    assert cand.get(f"/api/v1/attempts/{aid}").json()["state"] == "cancelled", "the candidate sees it"


def test_an_expired_invite_cancels_its_ready_attempt_when_the_scheduler_runs(stack):
    view, aid = stack.consented_attempt()
    stack.clock.advance(days=8)
    assert stack.assessments.expire_all() == 1
    assert stack.invite_state(view.invite_id) == "expired"
    assert stack.lab.engine.get(aid).state.value == "cancelled", "a candidate who never started no longer holds a ready attempt"
    problem(start(stack.candidate(), aid), 409, "ATT-INVALID-STATE")


def test_start_refuses_an_invite_that_is_past_its_expiry_even_before_the_scheduler_closed_it(stack):
    view, aid = stack.consented_attempt()
    stack.clock.advance(days=8)
    cand = stack.candidate()
    problem(start(cand, aid), 409, "ATT-INVALID-STATE")
    assert stack.lab.engine.get(aid).state.value == "cancelled" and stack.lab.directory.for_attempt(aid) is None


# ---- a repeat invite ----

def test_a_repeat_invite_after_a_closed_one_gets_the_next_generation_and_an_attempt_of_its_own(stack):
    first, aid1 = stack.consented_attempt()
    stack.assessments.revoke(stack.owner, first.invite_id)
    second, token = stack.invite()
    assert second.generation == 2 and second.invite_id != first.invite_id
    accepted = stack.rig.accept.accept(CAND_ID, token)
    assert accepted.attempt_id != aid1
    stack.rig.decide(CAND_ID, accepted.attempt_id)
    fresh = stack.lab.engine.get(accepted.attempt_id)
    assert fresh.state.value == "ready" and fresh.id == accepted.attempt_id, "the attempt id the invite gave out is the attempt that exists (no dangling id)"
    assert stack.lab.engine.get(aid1).state.value == "cancelled", "the old attempt stays as history"
    cand = stack.candidate()
    assert start(cand, accepted.attempt_id).status_code == 200
    stack.running(accepted.attempt_id)
    assert stack.invite_state(second.invite_id) == "started"
    problem(start(cand, aid1), 409, "ATT-INVALID-STATE")


def test_a_repeat_invite_after_a_declined_one_also_gets_its_own_attempt(stack):
    view, token = stack.invite()
    accepted = stack.rig.accept.accept(CAND_ID, token)
    stack.rig.decide(CAND_ID, accepted.attempt_id, "declined")
    assert stack.invite_state(view.invite_id) == "declined"
    again, token2 = stack.invite()
    assert again.generation == 2
    second = stack.rig.accept.accept(CAND_ID, token2)
    stack.rig.decide(CAND_ID, second.attempt_id)
    assert stack.lab.engine.get(second.attempt_id).state.value == "ready"


# ---- the recruiter cancels an attempt (FR-SES-07) ----

def test_the_recruiter_cancels_a_running_attempt_the_instance_goes_and_the_candidate_sees_it(stack):
    view, aid = stack.consented_attempt()
    cand = stack.candidate()
    assert start(cand, aid).status_code == 200
    stack.running(aid)
    instance = stack.lab.engine.get(aid).instance_id
    assert stack.lab.instance_alive(instance)
    with stack.recruiter() as rec:
        r = rec.post(f"/api/v1/attempts/{aid}/cancel")
        assert r.status_code == 200, r.text
        check("Attempt", r.json())
        assert r.json()["state"] == "cancelled"
        again = rec.post(f"/api/v1/attempts/{aid}/cancel")
        problem(again, 409, "ATT-INVALID-STATE")
    rec_after = stack.lab.engine.get(aid)
    assert rec_after.cancelled_by == "u-RECRUITERRECRUIT" and rec_after.cancelled_reason == "recruiter"
    assert not stack.lab.instance_alive(instance), "the instance was destroyed at once"
    assert cand.get(f"/api/v1/attempts/{aid}").json()["state"] == "cancelled"
    problem(cand.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": "x"}), 409, "ATT-INVALID-STATE")


def test_the_recruiter_cancels_a_ready_attempt_and_it_cannot_be_started_afterwards(stack):
    view, aid = stack.consented_attempt()
    with stack.recruiter() as rec:
        assert rec.post(f"/api/v1/attempts/{aid}/cancel").status_code == 200
    problem(start(stack.candidate(), aid), 409, "ATT-INVALID-STATE")


def test_only_the_recruiter_of_the_owning_company_can_cancel_everyone_else_gets_the_404(stack):
    view, aid = stack.consented_attempt()
    cand = stack.candidate()
    problem(cand.post(f"/api/v1/attempts/{aid}/cancel"), 404, "ATT-NOT-FOUND")  # the candidate is not a reviewer
    with stack.recruiter(org_id="another-company") as other:
        problem(other.post(f"/api/v1/attempts/{aid}/cancel"), 404, "ATT-NOT-FOUND")
    assert stack.lab.engine.get(aid).state.value == "ready", "nothing happened"
    learner = cand.post("/api/v1/instances", {"kind": "learner"})
    assert learner.status_code == 202
    practice = learner.json()["attempt_id"]
    with stack.recruiter() as rec:
        problem(rec.post(f"/api/v1/attempts/{practice}/cancel"), 404, "ATT-NOT-FOUND")  # a recruiter has no access to practice at all


# ---- the withdrawal leaves its consent record ----

def test_a_withdrawal_writes_the_withdrawn_consent_record_once_and_a_reinvite_gives_a_fresh_attempt(stack):
    view, aid = stack.consented_attempt()
    cand = stack.candidate()
    assert start(cand, aid).status_code == 200
    stack.running(aid)
    assert consent_actions(stack, aid) == ["granted"]
    w = cand.post(f"/api/v1/attempts/{aid}/withdraw", {"confirm": True})
    assert w.status_code == 200 and w.json()["state"] == "withdrawn"
    assert consent_actions(stack, aid) == ["granted", "withdrawn"], "the proof of the withdrawal is kept (FR-SES-10)"
    assert cand.post(f"/api/v1/attempts/{aid}/withdraw", {"confirm": True}).status_code == 200
    assert consent_actions(stack, aid) == ["granted", "withdrawn"], "repeating adds no second record"
    undone = cand.post(f"/api/v1/attempts/{aid}/withdraw/undo")
    assert undone.status_code == 200 and undone.json()["state"] == "withdrawn", "an undo cancels the deletion; the attempt stays withdrawn (D-91)"
    assert consent_actions(stack, aid) == ["granted", "withdrawn"]
    # to take the assessment after all, the recruiter re-invites: a new attempt, the withdrawn one stays apart
    fresh_invite = stack.assessments.reinvite(stack.owner, view.invite_id)
    from test_assessments import mail_rows, token_in

    accepted = stack.rig.accept.accept(CAND_ID, token_in(mail_rows(stack.sessions)[-1]))
    stack.rig.decide(CAND_ID, accepted.attempt_id)
    assert accepted.attempt_id != aid and fresh_invite.generation == 2
    assert start(cand, accepted.attempt_id).status_code == 200
    stack.running(accepted.attempt_id)
    assert stack.lab.engine.get(aid).state.value == "withdrawn"


# ---- a learner who is mid-practice when invited keeps two separate runs ----

def test_a_practice_run_and_an_assessment_of_the_same_person_stay_separate_and_the_recruiter_never_sees_the_practice(stack):
    cand = stack.candidate()
    learner = cand.post("/api/v1/instances", {"kind": "learner"})
    assert learner.status_code == 202, learner.text
    practice = learner.json()["attempt_id"]
    stack.running(practice)
    view, aid = stack.consented_attempt()  # invited while the practice run is going
    assert start(cand, aid).status_code == 200
    stack.running(aid)
    one, two = stack.lab.engine.get(practice), stack.lab.engine.get(aid)
    assert one.org_id is None and two.org_id == stack.owner.org_id and one.instance_id != two.instance_id
    assert one.state.value == two.state.value == "running"
    mine = {i["attempt_id"]: i["mode"] for i in cand.get("/api/v1/me/attempts").json()["items"]}
    assert mine == {practice: "learner", aid: "candidate"}
    # the practice run has free hints, the assessment (template default: hints off) has none
    assert cand.get(f"/api/v1/attempts/{practice}").json()["hints_enabled"] is True
    assert cand.get(f"/api/v1/attempts/{aid}").json()["hints_enabled"] is False
    # the recruiter of the inviting company reads the assessment and nothing of the practice
    with stack.recruiter() as rec:
        assert rec.get(f"/api/v1/attempts/{aid}/report").status_code == 200
        for path in ("", "/score", "/report", "/timeline", "/challenges", "/evidence", "/integrity-flags"):
            problem(rec.get(f"/api/v1/attempts/{practice}{path}"), 404, "ATT-NOT-FOUND")
    # stopping the practice instance does not touch the assessment
    iid = one.instance_id
    assert cand.post(f"/api/v1/instances/{iid}/stop").status_code in (200, 202)
    assert stack.lab.instance_alive(two.instance_id) and stack.lab.engine.get(aid).state.value == "running"
