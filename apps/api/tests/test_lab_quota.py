"""WP-A (wiring audit F-08, section 5; role scenarios L-21, L-22, A-09, A-12, X-04, X-11): the admin's quotas and the rate limits reach the real lab.

The quota is the real `DbQuotaPort` over the `quotas` table and the settings (an admin's change is read by the next request, no restart); the requests are the real lab routes;
the attempts are made by the real invite path. Only the orchestrator is the fake host. A full platform is a 503 with Retry-After, a limit of the user or company is a 409,
one account asking too often is a 429."""
from __future__ import annotations

import pytest

import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
from lifecycle_support import CAND_ID, Stack
from test_assessments import assessments  # noqa: F401
from test_companies import audit, clock, companies, ended, sessions  # noqa: F401
from test_lab_api import Session, problem
from test_password_reset import add_user
from vulnmart.kernel.quota import DbQuotaPort
from vulnmart.ports.fakes import FakeSettingsPort

SECOND = ("u-SECONDSECONDSEC", "second@example.org")
THIRD = ("u-THIRDTHIRDTHIRDT", "third@example.org")


def make(sessions, companies, assessments, audit, clock, **settings) -> Stack:
    cfg = FakeSettingsPort(settings)
    stack = Stack(sessions, companies, assessments, audit, clock, quota=DbQuotaPort(sessions, cfg), settings=cfg)
    for uid, email in (SECOND, THIRD):
        add_user(sessions, uid=uid, email=email, name="Another Person")
    return stack


@pytest.fixture
def stack(sessions, companies, assessments, audit, clock):  # noqa: F811
    return make(sessions, companies, assessments, audit, clock)


def start_candidate(stack: Stack, who: tuple[str, str], *, template=None):
    uid, email = who
    _, aid = stack.consented_attempt(template, email=email, user_id=uid)
    cand = Session(stack, email)
    return cand, aid, cand.post(f"/api/v1/attempts/{aid}/start")


def test_the_users_quota_is_enforced_per_mode_and_an_admins_change_applies_to_the_next_request(stack):
    cand_user = CAND_ID
    first, aid1 = stack.consented_attempt()
    other = stack.new_template()
    _, aid2 = stack.consented_attempt(other)
    cand = stack.candidate()
    assert cand.post(f"/api/v1/attempts/{aid1}/start").status_code == 200
    stack.running(aid1)
    blocked = cand.post(f"/api/v1/attempts/{aid2}/start")
    problem(blocked, 409, "INST-QUOTA-REACHED")  # the default is one instance per account and mode
    assert stack.lab.engine.get(aid2).state.value == "ready" and stack.lab.directory.for_attempt(aid2) is None, "nothing was asked of the orchestrator"
    practice = cand.post("/api/v1/instances", {"kind": "learner"})
    assert practice.status_code == 202, "practice and assessment are counted apart, so a candidate can practise while an assessment runs"
    stack.lab.quota.set("user", cand_user, 2)  # the admin raises this account's limit: the next request sees it
    assert cand.post(f"/api/v1/attempts/{aid2}/start").status_code == 200
    stack.running(aid2)
    stack.lab.quota.set("user", cand_user, 0)  # and a limit of 0 stops the account at once
    third = stack.new_template()
    _, aid3 = stack.consented_attempt(third)
    problem(cand.post(f"/api/v1/attempts/{aid3}/start"), 409, "INST-QUOTA-REACHED")


def test_the_companys_cap_is_enforced_across_its_candidates(sessions, companies, assessments, audit, clock):  # noqa: F811
    stack = make(sessions, companies, assessments, audit, clock, instance_company_cap=1)
    _, _, one = start_candidate(stack, (CAND_ID, "candidate@example.org"))
    assert one.status_code == 200, one.text
    _, aid, two = start_candidate(stack, SECOND)
    problem(two, 409, "INST-QUOTA-REACHED")
    assert stack.lab.engine.get(aid).state.value == "ready"


def test_a_full_platform_is_a_503_for_a_learner_but_keeps_places_for_assessments(sessions, companies, assessments, audit, clock):  # noqa: F811
    stack = make(sessions, companies, assessments, audit, clock, instance_total_cap=3, instance_assessment_reserve=2)
    learner_a = Session(stack, SECOND[1])
    learner_b = Session(stack, THIRD[1])
    assert learner_a.post("/api/v1/instances", {"kind": "learner"}).status_code == 202  # the one place a learner may take: 3 - 2 reserved
    full = learner_b.post("/api/v1/instances", {"kind": "learner"})
    problem(full, 503, "INST-NO-CAPACITY")
    assert full.headers["retry-after"] == "15"
    assert not [a for a in stack.lab.engine.for_user(THIRD[0])], "a refused learner start leaves no empty attempt behind"
    _, _, c1 = start_candidate(stack, (CAND_ID, "candidate@example.org"))
    assert c1.status_code == 200, "an assessment can still start: the reserved places are for it (X-11)"
    _, aid, c2 = start_candidate(stack, THIRD)
    assert c2.status_code == 200
    # three live now (one practice, two assessments): the platform is full for everyone
    _, aid4, c3 = start_candidate(stack, SECOND, template=stack.new_template())
    problem(c3, 503, "INST-NO-CAPACITY")
    assert stack.lab.engine.get(aid4).state.value == "ready"


def test_a_busy_orchestrator_is_a_503_with_a_retry_for_the_learner_and_the_candidate_and_a_later_start_works(stack):
    from vulnmart.ports.instance_host import Busy

    _, aid = stack.consented_attempt()
    cand = stack.candidate()
    real = stack.host.create

    def full(request):
        raise Busy("no capacity")

    stack.host.create = full
    r = cand.post(f"/api/v1/attempts/{aid}/start")
    problem(r, 503, "INST-NO-CAPACITY")
    assert r.headers["retry-after"] == "15"
    problem(cand.post("/api/v1/instances", {"kind": "learner"}), 503, "INST-NO-CAPACITY")
    stack.host.create = real
    assert cand.post(f"/api/v1/attempts/{aid}/start").status_code == 200
    stack.running(aid)


def test_costly_routes_have_a_per_account_hourly_limit_that_is_an_admin_setting(sessions, companies, assessments, audit, clock):  # noqa: F811
    stack = make(sessions, companies, assessments, audit, clock, rate_instance_start_per_user_per_hour=2, rate_instance_stop_per_user_per_hour=1,
                 rate_review_action_per_user_per_hour=1)
    cand = stack.candidate()
    codes = [cand.post("/api/v1/instances", {"kind": "learner"}).status_code for _ in range(3)]
    assert codes == [202, 409, 429], codes  # the third call of the hour is refused before anything else is looked at
    limited = cand.post("/api/v1/instances", {"kind": "learner"})
    problem(limited, 429, "REQ-RATE-LIMITED")
    assert int(limited.headers["retry-after"]) >= 1
    practice = stack.lab.engine.for_user(CAND_ID)[0]
    stack.running(practice.id)
    assert cand.post(f"/api/v1/instances/{practice.instance_id}/stop").status_code in (200, 202)
    problem(cand.post(f"/api/v1/instances/{practice.instance_id}/stop"), 429, "REQ-RATE-LIMITED")
    # the recruiter's review actions: one cancel an hour here
    _, aid = stack.consented_attempt(stack.new_template(), email=SECOND[1], user_id=SECOND[0])
    _, aid_b = stack.consented_attempt(stack.new_template(), email=THIRD[1], user_id=THIRD[0])
    with stack.recruiter() as rec:
        assert rec.post(f"/api/v1/attempts/{aid}/cancel").status_code == 200
        problem(rec.post(f"/api/v1/attempts/{aid_b}/cancel"), 429, "REQ-RATE-LIMITED")
    assert stack.lab.engine.get(aid_b).state.value == "ready"
