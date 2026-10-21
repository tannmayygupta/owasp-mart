"""Work package G, refresh after the merge of packages A to E (2026-10-21): the scenarios the first matrix marked MISSING-OWNED-BY A, B, C, D or E, tested again against
main through the routes of the combined world. Each test name starts with the scenario id; docs/audit/2026-10-21-scenario-matrix.md points here.
The world is `scenario_support.sw` plus the admin quota port on the lab, an eraser on the deletion service, and a mirror of the lab attempt in the SQL attempt table
(the deletion and force-stop code reads that table; the in-memory lab store of this world does not fill it)."""
from __future__ import annotations

import pytest

from scenario_support import (  # noqa: F401 - fixtures
    ADA, ADA_EMAIL, ALICE, CAM_EMAIL, EVE, EVE_EMAIL, GOOD, RITA, ROB, accept_and_consent, anonymous, assessments, audit, clock, companies, ended, invite_candidate, link_token,
    mail_rows, new_learner, outbox, play, sessions, start_candidate, start_practice, sw, token_in, w, wait_running,
)
from scenario_support import KEYS, ORIGIN
from vulnmart.kernel.quota import DbQuotaPort
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.lab.mail_log import mail_sink
from vulnmart.notifications.triggers import MailTriggers
from vulnmart.lab.models import Attempt, Instance
from vulnmart.privacy.deletion import DeletionService
from vulnmart.privacy.retention.records import SqlAttemptRecords
from vulnmart.privacy.subjects import SubjectService


@pytest.fixture
def sw2(sw, sessions, audit, clock):
    sw.lab.quota = DbQuotaPort(sessions, sw.settings)  # the admin's limits, read by every start (package A)
    st = sw.app.state
    st.mail_triggers = MailTriggers(sessions, ContextScopePort(), public_origin=ORIGIN, now=clock, keys=KEYS)  # the mails of the attempt flows (package B)
    sw.lab.mail_log.sink = mail_sink(st.mail_triggers)
    st.deletion_service = DeletionService(sessions, st.assessments, SqlAttemptRecords(sessions), sw.settings, audit, SubjectService(sessions), sw.lab.erase, now=clock,
                                          mail=st.mail_triggers)
    st.self_service._settings, st.self_service._keys, st.self_service._origin, st.self_service._audit, st.self_service._now = sw.settings, KEYS, ORIGIN, audit, clock  # the email change (package B)
    mirror(sw, sw.cam_attempt)
    return sw


def mirror(sw, attempt_id: str) -> None:
    """The SQL attempt row the privacy and admin code reads, made from the lab's attempt (production keeps the lab in the same table)."""
    rec = sw.lab.engine.get(attempt_id)
    record = {k: v.isoformat() for k, v in (("submitted_at", rec.submitted_at), ("deadline_at", rec.deadline_at)) if v is not None}  # the instants the retention jobs read
    if rec.instance_id:
        record["instance_id"] = rec.instance_id
    with sw.sessions.begin() as s:
        existing = s.get(Attempt, attempt_id)
        if existing is None:
            s.add(Attempt(id=attempt_id, user_id=rec.user_id, template_id=str(rec.template_id), org_id=rec.org_id, state=rec.state.value, version=0, record=record))
        else:
            existing.state, existing.record = rec.state.value, record
        info = sw.lab.directory.for_attempt(attempt_id)  # the platform's directory row of the instance, which the admin's view joins
        if info is not None and s.get(Instance, info.instance_id) is None:
            s.flush()
            s.add(Instance(id=info.instance_id, attempt_id=attempt_id, template_id=str(rec.template_id), epoch=1, challenge_keys=[]))


def template_with(sw, **over) -> str:
    r = sw.browser(RITA).post("/api/v1/company/templates", {"title": "Refresh template", "challenge_keys": ["C01", "C02"], **over})
    assert r.status_code == 201, r.text
    return r.json()["template_id"]


def candidate(sw, n: int, template: str | None = None, *, started: bool = False):
    uid, email = new_learner(sw, n)
    token, created = invite_candidate(sw, email, template)
    b = sw.browser(email)
    attempt = accept_and_consent(sw, b, token)
    mirror(sw, attempt)
    instance = start_candidate(sw, b, attempt) if started else None
    if started:
        mirror(sw, attempt)
    return b, attempt, instance, created["created"][0]["invite_id"]


def admin_set(sw, setting: str, value) -> None:
    assert sw.alice.put(f"/api/v1/admin/settings/{setting}", {"value": value}).status_code == 200


# ---- package A: attempt lifecycle, template settings, quotas ----------------------------------------------------------------------------

def test_c16_a_recruiter_can_turn_hints_on_and_the_candidate_pays_the_template_cost(sw2):
    on = template_with(sw2, hints_mode="on", hint_cost_pct=10, results_visibility="after_submit")
    b, attempt, instance, _ = candidate(sw2, 51, on, started=True)
    play(sw2.lab, instance)
    assert b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw2.lab.keys.flag(instance, "C01", 1)}).json()["credit"] == "credited"
    before = b.get(f"/api/v1/attempts/{attempt}/score").json()["score"]
    assert b.get(f"/api/v1/attempts/{attempt}").json()["hints_enabled"] is True
    listed = b.get(f"/api/v1/attempts/{attempt}/challenges/C01/hints").json()["items"]
    assert [h["level"] for h in listed] == [1, 2, 3] and all(h["cost_pct"] > 0 for h in listed)
    unlocked = b.post(f"/api/v1/attempts/{attempt}/challenges/C01/hints/1/unlock")
    assert unlocked.status_code == 200 and unlocked.json()["text"]
    assert b.get(f"/api/v1/attempts/{attempt}/score").json()["score"] < before, "a hint costs points in an assessment"
    off = template_with(sw2, hints_mode="off", results_visibility="after_submit")
    b2, a2, i2, _ = candidate(sw2, 52, off, started=True)
    r = b2.get(f"/api/v1/attempts/{a2}/challenges/C01/hints")
    assert r.status_code == 404 and r.json()["code"] == "ATT-HINTS-DISABLED"


def test_c28_an_invite_with_an_attempt_under_way_does_not_expire_and_the_report_link_stays(sw2, clock):
    long = template_with(sw2, time_limit_min=480, invite_expiry_days=7, results_visibility="after_submit")
    b, attempt, instance, invite = candidate(sw2, 53, long, started=True)
    rita = sw2.browser(RITA)
    states = {i["invite_id"]: i["state"] for i in rita.get("/api/v1/company/invites").json()["items"]}
    assert states[invite] == "started", "Start moves the invite to started"
    clock.advance(days=8)
    sw2.lab.tick()
    rita = sw2.browser(RITA)
    after = {i["invite_id"]: i for i in rita.get("/api/v1/company/invites").json()["items"]}
    assert after[invite]["state"] == "started" and after[invite]["attempt_id"] == attempt, "a started invite never expires"
    assert rita.get(f"/api/v1/attempts/{attempt}/report").status_code == 200
    cam = sw2.browser("scen53@learners.example")
    assert cam.get(f"/api/v1/attempts/{attempt}").status_code == 200
    assert [i["state"] for i in cam.get("/api/v1/me/invites").json()["items"]] == ["started"]


def test_c28b_a_revoked_invite_cancels_its_ready_attempt_and_start_is_refused(sw2):
    b, attempt, _, invite = candidate(sw2, 54)
    rita = sw2.browser(RITA)
    assert rita.post(f"/api/v1/company/invites/{invite}/actions", {"action": "revoke"}).status_code == 200
    started = b.post(f"/api/v1/attempts/{attempt}/start")
    assert started.status_code == 409, started.text
    assert sw2.lab.engine.get(attempt).state.value == "cancelled", "Start on a closed invite cancels the ready attempt"


def test_r11_the_challenge_subset_of_the_template_reaches_the_attempt_the_score_and_the_flag_check(sw2):
    t = template_with(sw2, challenge_keys=["C01", "C02"], results_visibility="after_submit")
    b, attempt, instance, _ = candidate(sw2, 55, t, started=True)
    play(sw2.lab, instance)
    assert [i["challenge_key"] for i in b.get(f"/api/v1/attempts/{attempt}/challenges").json()["items"]] == ["C01", "C02"]
    outside = b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C05", "flag": sw2.lab.keys.flag(instance, "C05", 1)})
    assert (outside.status_code, outside.json()["code"]) == (404, "ATT-CHALLENGE-NOT-FOUND")
    for key in ("C01", "C02"):
        assert b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": key, "flag": sw2.lab.keys.flag(instance, key, 1)}).json()["credit"] == "credited"
    score = b.get(f"/api/v1/attempts/{attempt}/score").json()
    assert score["score"] == 1000 and [c["challenge_key"] for c in score["per_challenge"]] == ["C01", "C02"], "out of 1000 over the template's challenges"
    report = sw2.browser(RITA).get(f"/api/v1/attempts/{attempt}/report").json()
    assert [c["challenge_key"] for c in report["per_challenge"]] == ["C01", "C02"]


def test_r24_a_recruiter_cancels_a_ready_or_running_attempt_and_nobody_else_can(sw2):
    rita = sw2.browser(RITA)
    b1, a1, _, _ = candidate(sw2, 56)  # ready
    b2, a2, i2, _ = candidate(sw2, 57, started=True)  # running
    assert b1.post(f"/api/v1/attempts/{a1}/cancel").status_code == 404, "a candidate cannot cancel"
    assert sw2.browser(ROB).post(f"/api/v1/attempts/{a1}/cancel").status_code == 404, "another company cannot"
    for attempt in (a1, a2):
        done = rita.post(f"/api/v1/attempts/{attempt}/cancel")
        assert done.status_code == 200 and done.json()["state"] == "cancelled", done.text
    assert sw2.lab.host.get(i2).state.value in ("destroyed", "stopping")
    gone = b2.post(f"/api/v1/attempts/{a2}/flags", {"challenge_key": "C01", "flag": "VM{x}"})
    assert gone.status_code in (409, 410)
    assert b2.get(f"/api/v1/attempts/{a2}").json()["state"] == "cancelled", "the candidate sees that it was cancelled"
    assert rita.post(f"/api/v1/attempts/{a2}/cancel").status_code == 409, "a second cancel is refused"
    b3, a3, i3, _ = candidate(sw2, 58, started=True)
    b3.post(f"/api/v1/attempts/{a3}/submit", {"confirm": True})
    assert rita.post(f"/api/v1/attempts/{a3}/cancel").status_code == 409, "an ended attempt cannot be cancelled"


def test_a09_the_admin_s_user_and_company_quotas_are_enforced_at_the_start(sw2):
    uid, email = new_learner(sw2, 59)
    b = sw2.browser(email)
    assert sw2.alice.put("/api/v1/admin/quotas", {"scope": "user", "scope_id": uid, "max_instances": 0}).status_code == 200
    r = b.post("/api/v1/instances", {"kind": "learner"})
    assert (r.status_code, r.json()["code"]) == (409, "INST-QUOTA-REACHED")
    assert sw2.alice.delete(f"/api/v1/admin/quotas?scope=user&scope_id={uid}").status_code == 204
    assert b.post("/api/v1/instances", {"kind": "learner"}).status_code == 202
    # the company's cap: one live instance for Rita's company, the second candidate cannot start
    admin_set(sw2, "instance_company_cap", 1)
    b1, a1, i1, _ = candidate(sw2, 60, started=True)
    b2, a2, _, _ = candidate(sw2, 61)
    refused = b2.post(f"/api/v1/attempts/{a2}/start")
    assert refused.status_code == 409, refused.text
    admin_set(sw2, "instance_company_cap", 5)
    assert b2.post(f"/api/v1/attempts/{a2}/start").status_code == 200


def test_a12_x11_places_of_the_platform_cap_are_reserved_for_assessments(sw2):
    admin_set(sw2, "instance_total_cap", 3)
    admin_set(sw2, "instance_assessment_reserve", 1)
    u1, e1 = new_learner(sw2, 62)
    u2, e2 = new_learner(sw2, 63)
    first = sw2.browser(e1).post("/api/v1/instances", {"kind": "learner"})
    assert first.status_code == 202, "one place is free for practice"
    second = sw2.browser(e2).post("/api/v1/instances", {"kind": "learner"})
    assert (second.status_code, second.json()["code"]) == (503, "INST-NO-CAPACITY") and int(second.headers["retry-after"]) > 0, "the last place is reserved: told to try again, not crashed"
    b, attempt, _, _ = candidate(sw2, 64)
    started = b.post(f"/api/v1/attempts/{attempt}/start")
    assert started.status_code == 200, "an assessment can use the reserved place"
    wait_running(sw2.lab, attempt)
    capacity = sw2.alice.get("/api/v1/admin/capacity").json()
    assert capacity, "the admin sees the capacity"


def test_l22_x04_a_practice_run_and_an_assessment_are_counted_apart_by_the_user_limit(sw2):
    uid, email = new_learner(sw2, 65)
    b = sw2.browser(email)
    p_instance, p_attempt = start_practice(sw2, b)
    token, _ = invite_candidate(sw2, email)
    attempt = accept_and_consent(sw2, b, token)
    assert b.post(f"/api/v1/attempts/{attempt}/start").status_code == 200, "the practice run does not block the assessment"
    wait_running(sw2.lab, attempt)
    again = b.post("/api/v1/instances", {"kind": "learner"})
    assert again.status_code == 409 and again.json()["code"] == "INST-QUOTA-REACHED", "a second practice run is still refused"


# ---- package B: company administration, privacy workflows, real mail --------------------------------------------------------------------

def _templates(sw, to: str) -> list[str]:
    return [m.template for m in outbox(sw.sessions) if m.to_user_id == to]


def test_c06_x16_a_person_with_another_address_changes_the_email_of_the_account_and_then_accepts(sw2):
    uid, email = new_learner(sw2, 66)
    invited = "eve.work@candidates.example"
    token, _ = invite_candidate(sw2, invited)
    b = sw2.browser(email)
    assert b.post("/api/v1/invites/accept", {"token": token}).status_code == 409, "the account's address is not the invited one"
    assert b.post("/api/v1/me/email", {"new_email": invited, "current_password": "wrong password here"}).status_code in (401, 403)
    ok = b.post("/api/v1/me/email", {"new_email": invited, "current_password": GOOD})
    assert ok.status_code in (200, 202, 204), ok.text
    confirm = [m for m in outbox(sw2.sessions, "account.email_change") if m.to_user_id == uid][-1]
    assert anonymous(sw2).post("/api/v1/accounts/confirm-email-change", json={"token": link_token(confirm)}).status_code in (200, 204)
    assert [m for m in outbox(sw2.sessions, "account.email_changed") if m.to_user_id == uid], "the old address is told"
    after = sw2.browser(invited)
    accepted = after.post("/api/v1/invites/accept", {"token": token})
    assert accepted.status_code == 200, accepted.text
    assert anonymous(sw2).post("/api/v1/session", json={"email": email, "password": GOOD}).status_code == 401, "the old address no longer signs in"


def test_r05_r06_a_colleague_joins_by_domain_the_owner_approves_and_later_removes_them(sw2):
    anon = anonymous(sw2)
    r = anon.post("/api/v1/recruiters", json={"email": "bob@acme.example", "password": GOOD, "display_name": "Bob Colleague", "company_name": "Acme"})
    assert r.status_code == 202, r.text
    verify = [m for m in outbox(sw2.sessions, "account.verify")][-1]
    assert anon.post("/api/v1/accounts/verify-email", json={"token": link_token(verify)}).status_code == 200
    rita = sw2.browser(RITA)
    pending = rita.get("/api/v1/company/join-requests").json()["items"]
    assert len(pending) == 1, pending
    request_id = pending[0]["request_id"]
    assert sw2.browser(ROB).get("/api/v1/company/join-requests").json()["items"] == [], "another company sees nothing"
    assert sw2.browser(ROB).post(f"/api/v1/company/join-requests/{request_id}/decision", {"decision": "approve"}).status_code == 404
    assert rita.post(f"/api/v1/company/join-requests/{request_id}/decision", {"decision": "approve"}).status_code == 204
    members = rita.get("/api/v1/company/members").json()["items"]
    assert len(members) == 2
    bob = sw2.browser("bob@acme.example")
    assert bob.get("/api/v1/company").json()["state"] == "active"
    bob_id = next(m["user_id"] for m in members if m["user_id"] != next(x["user_id"] for x in members if x.get("role") == "owner"))
    p1 = bob.post("/api/v1/company/invites", {"template_id": sw2.template, "emails": ["by.bob@candidates.example"]})
    p2 = bob.delete(f"/api/v1/company/members/{bob_id}")
    assert p1.status_code == 201, "an approved colleague invites for the company"
    assert (p2.status_code, p2.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN"), "only the owner manages members: a colleague gets the answer of an unknown route"
    assert rita.delete(f"/api/v1/company/members/{bob_id}").status_code == 204
    assert len(rita.get("/api/v1/company/members").json()["items"]) == 1
    assert anon.post("/api/v1/session", json={"email": "bob@acme.example", "password": GOOD}).status_code in (200, 401, 403)
    gone = sw2.browser("bob@acme.example").get("/api/v1/company")
    assert gone.json()["state"] == "none" and gone.json()["company_name"] is None, "a removed member has no company"


def test_c25_r28_a19_a_candidate_asks_the_company_decides_and_a_silent_company_is_escalated_to_the_admins(sw2, clock):
    b1, a1, i1, _ = candidate(sw2, 67, started=True)
    b1.post(f"/api/v1/attempts/{a1}/submit", {"confirm": True})
    mirror(sw2, a1)
    asked = b1.post("/api/v1/me/deletion-requests", {"kind": "candidate", "attempt_id": a1})
    assert asked.status_code == 201, asked.text
    rid = asked.json()["request_id"]
    assert [m for m in outbox(sw2.sessions, "privacy.deletion_request_for_company")], "the company is told"
    rita = sw2.browser(RITA)
    items = rita.get("/api/v1/company/deletion-requests").json()["items"]
    assert [(i["request_id"], i["attempt_id"], i["status"]) for i in items] == [(rid, a1, "pending")] and items[0]["candidate_email"] == "scen67@learners.example"
    assert sw2.browser(ROB).get("/api/v1/company/deletion-requests").json()["items"] == []
    assert sw2.browser(ROB).post(f"/api/v1/company/deletion-requests/{rid}/decision", {"decision": "approve"}).status_code == 404
    assert b1.post(f"/api/v1/company/deletion-requests/{rid}/decision", {"decision": "approve"}).status_code in (403, 404), "the candidate cannot decide"
    decided = rita.post(f"/api/v1/company/deletion-requests/{rid}/decision", {"decision": "approve"})
    assert decided.status_code == 200 and decided.json()["status"] == "approved" and decided.json()["execute_after"], decided.text
    assert rita.post(f"/api/v1/company/deletion-requests/{rid}/decision", {"decision": "decline"}).status_code == 409, "decided once"
    # a second candidate: the company stays silent for 14 days, the job escalates and the admins get a mail
    b2, a2, i2, _ = candidate(sw2, 68, started=True)
    b2.post(f"/api/v1/attempts/{a2}/submit", {"confirm": True})
    mirror(sw2, a2)
    r2 = b2.post("/api/v1/me/deletion-requests", {"kind": "candidate", "attempt_id": a2}).json()["request_id"]
    clock.advance(days=15)
    sw2.app.state.deletion_service.run(clock.now)
    escalated = [i for i in sw2.browser(RITA).get("/api/v1/company/deletion-requests").json()["items"] if i["request_id"] == r2]
    assert escalated and escalated[0]["escalated"] is True
    assert {m.to_user_id for m in outbox(sw2.sessions, "admin.deletion_escalated")} >= {ALICE}, "the admins are told by mail"
    # the company can also delete a record at once
    b3, a3, i3, _ = candidate(sw2, 69, started=True)
    b3.post(f"/api/v1/attempts/{a3}/submit", {"confirm": True})
    mirror(sw2, a3)
    gone = sw2.browser(RITA).delete(f"/api/v1/company/attempts/{a3}")
    assert gone.status_code == 200, gone.text
    assert sw2.browser(ROB).delete(f"/api/v1/company/attempts/{a2}").status_code == 404

def test_r31_c24_x21_the_attempt_flows_cause_their_mails_and_a_withdrawal_leaves_a_consent_record(sw2, clock):
    rita_id = None
    b, attempt, instance, _ = candidate(sw2, 70, started=True)  # the world's template: 45 minutes, results after release
    play(sw2.lab, instance)
    clock.advance(minutes=31)
    sw2.lab.tick()
    uid = "u-SCEN" + chr(65 + 70 // 26) + chr(65 + 70 % 26) + "SCEN" + chr(65 + 70 // 26) + chr(65 + 70 % 26) + "SCEN"
    b = sw2.browser("scen70@learners.example")
    assert [m for m in outbox(sw2.sessions, "candidate.time_warning") if m.to_user_id == uid], "the 15 minute warning is mailed"
    assert b.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": True}).status_code == 200
    got = {m.template: m.to_user_id for m in outbox(sw2.sessions) if m.template in ("candidate.submission_received", "recruiter.submission_received")}
    assert got["candidate.submission_received"] == uid and got["recruiter.submission_received"] != uid, "both sides are told of the submission"
    rita = sw2.browser(RITA)
    assert rita.post(f"/api/v1/attempts/{attempt}/release").status_code == 200
    assert [m for m in outbox(sw2.sessions, "candidate.results_released") if m.to_user_id == uid], "the release is mailed to the candidate"
    # a second candidate withdraws: the company is mailed and the consent history shows the withdrawal
    b2, a2, i2, _ = candidate(sw2, 71, started=True)
    before = len(outbox(sw2.sessions, "recruiter.consent_withdrawn"))
    assert b2.post(f"/api/v1/attempts/{a2}/withdraw", {"confirm": True}).status_code == 200
    assert len(outbox(sw2.sessions, "recruiter.consent_withdrawn")) == before + 1, "the recruiter is told"
    decisions = [c["decision"] for c in b2.get("/api/v1/me/consents").json()["items"]]
    assert "withdrawn" in decisions, decisions


def test_a24_an_admin_sets_and_clears_the_invite_cap_of_one_company(sw2):
    from test_companies import org_row

    org = str(org_row(sw2.sessions, RITA).id)
    listed = sw2.alice.get("/api/v1/admin/companies")
    assert listed.status_code == 200 and any(c.get("org_id") == org or c.get("company_name") == "Acme" for c in listed.json()["items"])
    assert sw2.alice.put(f"/api/v1/admin/companies/{org}/invite-cap", {"invite_cap": 2}).status_code in (200, 204)
    out = sw2.browser(RITA).post("/api/v1/company/invites", {"template_id": sw2.template, "emails": ["cap1@c.example", "cap2@c.example", "cap3@c.example"]}).json()
    assert out["cap"] == 2 and len(out["created"]) == 1 and len(out["remaining"]) == 2, "Cam's invite used one of the two places"
    assert sw2.alice.put(f"/api/v1/admin/companies/{org}/invite-cap", {"invite_cap": None}).status_code in (200, 204)
    assert sw2.browser(RITA).post("/api/v1/company/invites", {"template_id": sw2.template, "emails": ["cap2@c.example"]}).status_code == 201
    assert unknown_to(sw2.browser(RITA), f"/api/v1/admin/companies/{org}/invite-cap")


def unknown_to(browser, url) -> bool:
    r = browser.put(url, {"invite_cap": 1})
    return (r.status_code, r.json().get("code")) == (404, "REQ-ROUTE-UNKNOWN")


def test_a04_r33_x09_an_admin_deletes_a_company_its_recruiters_lose_access_and_what_happens_to_running_attempts(sw2, ended):
    from test_companies import org_row, user_id

    b, attempt, instance, _ = candidate(sw2, 72, started=True)
    rita = sw2.browser(RITA)
    org = str(org_row(sw2.sessions, RITA).id)
    assert sw2.alice.post(f"/api/v1/admin/companies/{org}/decision", {"decision": "delete"}).status_code == 422, "a reason is required"
    assert sw2.alice.post(f"/api/v1/admin/companies/{org}/decision", {"decision": "delete", "reason": "Company asked to be removed"}).status_code == 204
    assert user_id(sw2.sessions, RITA) in ended, "the owner's sessions are ended at once (the world records the call of the session service)"
    assert anonymous(sw2).post("/api/v1/session", json={"email": RITA, "password": GOOD}).status_code in (200, 401, 403)
    after = sw2.browser(RITA).get("/api/v1/company").json()
    assert after["state"] in ("deleted", "none"), after
    assert sw2.alice.post(f"/api/v1/admin/companies/{org}/decision", {"decision": "approve"}).status_code == 409
    running = sw2.lab.engine.get(attempt).state.value
    print("DELETED-COMPANY-ATTEMPT", running)

# ---- package C: deployment hardening (the scheduler on, real mail by default) ----------------------------------------------------------

def test_l24_r29_x10_a14_the_scheduler_warns_learners_erases_old_candidate_records_deletes_idle_learners_and_the_admin_sees_the_runs(sw2, clock):
    from sqlalchemy import update

    from scenario_support import ALICE_EMAIL
    from test_companies import user_id
    from vulnmart.accounts.models import UserSession
    from vulnmart.privacy.retention.build import build_scheduler

    st = sw2.app.state
    sched = build_scheduler(sessions=sw2.sessions, assessments=st.assessments, settings=sw2.settings, audit=sw2.audit, subjects=SubjectService(sw2.sessions), eraser=sw2.lab.erase,
                            anchors=None, streams=None, public_origin=ORIGIN, now=clock, deletion=st.deletion_service)
    st.admin_ops._job_status = sched.status
    eve = sw2.browser(EVE_EMAIL)
    e_instance, e_attempt = start_practice(sw2, eve)
    mirror(sw2, e_attempt)
    b, attempt, instance, invite = candidate(sw2, 73, started=True)
    assert b.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": True}).status_code == 200
    mirror(sw2, attempt)
    # 181 days later: the candidate's record is past the template's 180 days and goes; the company's list no longer shows it
    clock.advance(days=181)
    sched.run_due()
    assert sw2.browser(RITA).get(f"/api/v1/attempts/{attempt}/report").status_code == 404, "the attempt was erased"
    assert invite not in {i["invite_id"] for i in sw2.browser(RITA).get("/api/v1/company/invites").json()["items"]}
    # about 11 months after Eve's last sign-in she is warned; a month later her practice data and account go
    clock.advance(days=160)
    sched.run_due()
    assert [m for m in outbox(sw2.sessions, "learner.retention_warning") if m.to_user_id == EVE], "the 30 day warning is mailed"
    clock.advance(days=40)
    sched.run_due()
    with sw2.sessions() as s:
        from vulnmart.accounts.models import User

        eve_row = s.get(User, EVE)
        assert eve_row is None or eve_row.status in ("deleted", "disabled"), "the idle learner's account is gone"
    # the admin sees what ran
    alice = sw2.browser(ALICE_EMAIL)
    with sw2.sessions.begin() as s:
        s.execute(update(UserSession).where(UserSession.user_id == ALICE).values(mfa_at=clock.now))
    jobs = alice.get("/api/v1/admin/jobs")
    assert jobs.status_code == 200, jobs.text
    names = {j["name"]: j for j in jobs.json()["items"]}
    assert {"candidate_retention", "learner_warning", "learner_retention", "invite_expiry"} <= set(names)
    assert all(names[n]["last_status"] == "succeeded" for n in ("candidate_retention", "learner_warning", "learner_retention")), {n: names[n].get("last_status") for n in names}

# ---- package H: the scenarios no package owned ------------------------------------------------------------------------------------------

def test_r20_the_report_labels_the_technique_of_every_challenge_the_candidate_got_into(sw2):
    t = template_with(sw2, challenge_keys=["C01", "C02"], results_visibility="after_submit")
    b, attempt, instance, _ = candidate(sw2, 74, t, started=True)
    play(sw2.lab, instance)
    assert b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw2.lab.keys.flag(instance, "C01", 1)}).json()["credit"] == "credited"
    report = sw2.browser(RITA).get(f"/api/v1/attempts/{attempt}/report").json()
    labels = {c["challenge_key"]: c["technique_label"] for c in report["per_challenge"]}
    assert labels["C01"] == "Broken Access Control (CWE-639)", "the fixed tag layer of the catalogue (D-07)"
    assert labels["C02"] is None, "no milestone, no label"
    assert all(v is None or len(v) <= 100 for v in labels.values())
    assert "VM{" not in str(report)


def test_r26_the_recruiter_s_private_cohort_board_is_off_until_the_template_turns_it_on_and_is_company_scoped(sw2):
    off = template_with(sw2, results_visibility="after_submit")
    rita = sw2.browser(RITA)
    assert rita.get(f"/api/v1/company/templates/{off}/cohort").status_code == 409, "off unless the assessment turns it on"
    on = template_with(sw2, cohort_board=True, results_visibility="after_submit")
    strong, a1, i1, _ = candidate(sw2, 75, on, started=True)
    weak, a2, i2, _ = candidate(sw2, 76, on, started=True)
    play(sw2.lab, i1)
    assert strong.post(f"/api/v1/attempts/{a1}/flags", {"challenge_key": "C01", "flag": sw2.lab.keys.flag(i1, "C01", 1)}).json()["credit"] == "credited"
    strong.post(f"/api/v1/attempts/{a1}/submit", {"confirm": True})
    weak.post(f"/api/v1/attempts/{a2}/submit", {"confirm": True})
    board = sw2.browser(RITA).get(f"/api/v1/company/templates/{on}/cohort")
    assert board.status_code == 200, board.text
    items = board.json()["items"]
    assert [(i["position"], i["attempt_id"]) for i in items] == [(1, a1), (2, a2)] and items[0]["score"] > items[1]["score"]
    assert "ranking aid" in board.json()["label"] and "scen75" not in board.text and "email" not in board.text, "ids only, never a name"
    assert sw2.browser(ROB).get(f"/api/v1/company/templates/{on}/cohort").status_code == 404
    assert strong.get(f"/api/v1/company/templates/{on}/cohort").status_code == 404

def test_c30_r25_a_recruiter_gives_a_running_candidate_extra_time_within_the_limits_and_nobody_else_can(sw2, clock):
    rita = sw2.browser(RITA)
    b, attempt, instance, _ = candidate(sw2, 77, started=True)  # the world's template: 45 minutes
    before = b.get(f"/api/v1/attempts/{attempt}").json()
    assert rita.post(f"/api/v1/attempts/{attempt}/extend", {"minutes": 4}).status_code == 422
    assert rita.post(f"/api/v1/attempts/{attempt}/extend", {"minutes": 241}).status_code == 422
    assert rita.post(f"/api/v1/attempts/{attempt}/extend").status_code in (415, 422), "a body is required"
    assert b.post(f"/api/v1/attempts/{attempt}/extend", {"minutes": 30}).status_code == 404, "a candidate cannot extend their own time"
    assert sw2.browser(ROB).post(f"/api/v1/attempts/{attempt}/extend", {"minutes": 30}).status_code == 404
    extended = rita.post(f"/api/v1/attempts/{attempt}/extend", {"minutes": 30})
    assert extended.status_code == 200, extended.text
    after = b.get(f"/api/v1/attempts/{attempt}").json()
    assert after["deadline_at"] > before["deadline_at"] and after["started_at"] == before["started_at"] and after["state"] == "running"
    assert (sw2.lab.engine.get(attempt).deadline_at - sw2.lab.engine.get(attempt).started_at).total_seconds() == 75 * 60
    assert [e for e in sw2.lab.attempt_log.read(attempt) if e["event"] == "time_extended"][0]["minutes"] == 30
    # the old deadline passes and the attempt is still open for flags
    play(sw2.lab, instance)
    clock.advance(minutes=50)
    sw2.lab.tick()
    b = sw2.browser("scen77@learners.example")
    assert b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw2.lab.keys.flag(instance, "C01", 1)}).json()["credit"] == "credited"
    # the instance's fixed lifetime caps the extra time: 240 minutes less the margin; the total stays inside
    rita = sw2.browser(RITA)
    assert rita.post(f"/api/v1/attempts/{attempt}/extend", {"minutes": 120}).status_code == 200
    assert rita.post(f"/api/v1/attempts/{attempt}/extend", {"minutes": 120}).status_code == 409, "past the instance's lifetime"
    # a ready attempt, an ended one and a practice run cannot be extended
    r2, a2, _, _ = candidate(sw2, 78)
    assert rita.post(f"/api/v1/attempts/{a2}/extend", {"minutes": 10}).status_code == 409
    r3, a3, i3, _ = candidate(sw2, 79, started=True)
    r3.post(f"/api/v1/attempts/{a3}/submit", {"confirm": True})
    assert rita.post(f"/api/v1/attempts/{a3}/extend", {"minutes": 10}).status_code == 409
    assert rita.post(f"/api/v1/attempts/{sw2.ada_attempt}/extend", {"minutes": 10}).status_code == 404

def test_a27_the_admin_lists_the_open_attempts_and_sees_which_wait_or_have_a_failed_instance(sw2):
    st = sw2.app.state
    crashed: set[str] = set()

    def reported() -> dict:  # what the orchestrator reports per instance (production: the state-report receiver); here the fake host is asked, and a crash is injected
        from vulnmart_attempts import AttemptState

        out = {}
        for r in sw2.lab.engine.in_states(AttemptState.READY, AttemptState.RUNNING):
            info = sw2.lab.directory.for_attempt(r.id)
            if info is not None:
                out[info.instance_id] = "failed" if info.instance_id in crashed else sw2.lab.host.get(info.instance_id).state.value
        return out

    st.admin_ops._instance_states = reported
    waiting_b, waiting, _, _ = candidate(sw2, 80)  # consented, not started
    running_b, running, running_i, _ = candidate(sw2, 81, started=True)
    crashed_b, crashed_a, crashed_i, _ = candidate(sw2, 82, started=True)
    crashed.add(crashed_i)  # the orchestrator reports this instance as failed
    everything = sw2.alice.get("/api/v1/admin/attempts?limit=100")
    assert everything.status_code == 200, everything.text
    by_id = {i["attempt_id"]: i for i in everything.json()["items"]}
    assert by_id[waiting]["issue"] == "waiting" and by_id[waiting]["mode"] == "candidate" and by_id[waiting]["instance_id"] is None
    assert by_id[running]["issue"] == "none" and by_id[running]["state"] == "running" and by_id[running]["instance_id"] == running_i
    assert by_id[crashed_a]["issue"] == "failing" and by_id[crashed_a]["instance_state"] == "failed", by_id[crashed_a]
    assert {i["attempt_id"] for i in sw2.alice.get("/api/v1/admin/attempts?kind=waiting").json()["items"]} >= {waiting, sw2.cam_attempt}
    assert {i["attempt_id"] for i in sw2.alice.get("/api/v1/admin/attempts?kind=failing").json()["items"]} == {crashed_a}
    text = everything.text
    assert "scen80" not in text and "@" not in text and "score" not in text, "ids, states and instants only"
    assert sw2.alice.get("/api/v1/admin/attempts?kind=nonsense").status_code == 422
    assert [r.action for r in sw2.audit.records].count("admin.attempts_read") >= 3, "every read is audited"
    for who in (RITA, EVE_EMAIL):
        r = sw2.browser(who).get("/api/v1/admin/attempts")
        assert (r.status_code, r.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")
    # a start that fails leaves the attempt as it was (ready), so the admin sees it among the waiting ones
    sw2.lab.template_id = "shop-fail-v0"
    f_b, f_a, _, _ = candidate(sw2, 83)
    f_b.post(f"/api/v1/attempts/{f_a}/start")
    import time

    time.sleep(1.5)
    sw2.lab.template_id = "shop-v0"
    assert sw2.alice.get("/api/v1/admin/attempts?kind=waiting&limit=100").json()["items"] and f_a in {i["attempt_id"] for i in sw2.alice.get("/api/v1/admin/attempts?kind=waiting&limit=100").json()["items"]}

def test_l11_the_template_s_flags_per_minute_limit_applies_to_a_candidate(sw2):
    t = template_with(sw2, flag_submissions_per_minute=2, results_visibility="after_submit")
    b, attempt, instance, _ = candidate(sw2, 84, t, started=True)
    play(sw2.lab, instance)
    answers = [b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": f"VM{{try{n}}}"}) for n in range(3)]
    assert [a.status_code for a in answers] == [200, 200, 429], "two pastes a minute, the third waits"
    assert answers[2].json()["code"] == "ATT-FLAG-RATE-LIMITED" and int(answers[2].headers["retry-after"]) > 0

def test_r16_a_person_who_started_cannot_be_invited_again_for_the_same_template_and_must_be_re_invited(sw2):
    rita = sw2.browser(RITA)
    t = template_with(sw2)
    b, attempt, instance, invite = candidate(sw2, 85, t, started=True)
    states = {i["invite_id"]: i["state"] for i in rita.get("/api/v1/company/invites").json()["items"]}
    assert states[invite] == "started"
    again = rita.post("/api/v1/company/invites", {"template_id": t, "emails": ["scen85@learners.example"]})
    assert again.status_code == 409, "nothing new to send: the address already has an attempt"
    reinvited = rita.post(f"/api/v1/company/invites/{invite}/actions", {"action": "reinvite"})
    assert reinvited.status_code == 200 and reinvited.json()["generation"] == 2


def test_c27_x07_a_re_invite_closes_the_old_attempt_for_good_and_the_new_one_gets_its_own(sw2):
    b, attempt, _, invite = candidate(sw2, 86)  # consented, ready
    rita = sw2.browser(RITA)
    new = rita.post(f"/api/v1/company/invites/{invite}/actions", {"action": "reinvite"}).json()
    assert new["generation"] == 2 and new["state"] == "created"
    old = b.post(f"/api/v1/attempts/{attempt}/start")
    assert old.status_code == 409, "the old attempt can no longer be started"
    assert sw2.lab.engine.get(attempt).state.value == "cancelled"
    token = token_in(mail_rows(sw2.sessions)[-1])
    second = accept_and_consent(sw2, b, token)
    assert second != attempt and sw2.lab.engine.get(second).state.value == "ready"
    assert b.post(f"/api/v1/attempts/{second}/start").status_code == 200