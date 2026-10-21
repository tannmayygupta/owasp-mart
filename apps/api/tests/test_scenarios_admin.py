"""Work package G, scenario matrix: the admin scenarios A-01 to A-27 of docs/audit/2026-10-21-role-scenarios.md, through the routes of the combined world."""
from __future__ import annotations

import json

from scenario_support import (  # noqa: F401 - fixtures
    ADA, ADA_EMAIL, ALICE, ALICE_EMAIL, BORIS, BORIS_EMAIL, CAM, CAM_EMAIL, EVE, EVE_EMAIL, GOOD, RITA, ROB, anonymous, org_row, user_id, assessments, audit, clock, companies, ended, make_admin, outbox,
    play, sessions, sw, w, wait_running,
)
from vulnmart.accounts.models import UserSession
from vulnmart.ports.instance_host import Access

REASON = "A candidate disputes the score of C01; checking the capture."


def unknown(r) -> bool:
    return (r.status_code, r.json().get("code")) == (404, "REQ-ROUTE-UNKNOWN")


def actions(sw) -> list[str]:
    return [r.action for r in sw.audit.records]


def test_a01_an_admin_session_without_the_second_factor_reaches_no_admin_function(sw):
    carol = make_admin(sw, "u-CAROLADMINCAROLC", "carol@vulnmart.example", proved=False)
    for url in ("/api/v1/admin/users", "/api/v1/admin/companies/pending", "/api/v1/admin/settings", "/api/v1/admin/capacity", "/api/v1/admin/audit"):
        assert unknown(carol.get(url)), url
    assert sw.alice.get("/api/v1/admin/users").status_code == 200


def test_a02_an_admin_session_ends_after_15_idle_minutes_and_after_12_hours_in_all(sw, clock):
    idle = make_admin(sw, "u-IDLEADMINIDLEADMI", "idle@vulnmart.example")
    clock.advance(minutes=14)
    assert idle.get("/api/v1/admin/users").status_code == 200
    clock.advance(minutes=14)
    assert idle.get("/api/v1/admin/users").status_code == 200, "activity keeps it alive"
    clock.advance(minutes=16)
    assert idle.get("/api/v1/admin/users").status_code == 401, "15 idle minutes end it"
    long = make_admin(sw, "u-LONGADMINLONGADMI", "long@vulnmart.example")
    for _ in range(13 * 6):  # a request every ten minutes keeps it idle-fresh; the absolute limit still applies
        clock.advance(minutes=10)
        if long.get("/api/v1/admin/users").status_code == 401:
            break
    else:
        raise AssertionError("an admin session outlived 13 hours")


def test_a03_an_admin_suspends_and_reinstates_a_company_and_a_suspended_company_can_invite_nobody(sw):
    rob = sw.browser(ROB)
    assert rob.get("/api/v1/company").json()["state"] == "active"
    mine = rob.post("/api/v1/company/templates", {"title": "Globex", "challenge_keys": ["C01"]}).json()["template_id"]
    org_id = str(org_row(sw.sessions, ROB).id)
    assert sw.alice.post(f"/api/v1/admin/companies/{org_id}/decision", {"decision": "suspend"}).status_code == 422, "a reason is required"
    assert sw.alice.post(f"/api/v1/admin/companies/{org_id}/decision", {"decision": "suspend", "reason": "Abuse report"}).status_code == 204
    assert sw.browser(ROB).get("/api/v1/company").json()["state"] == "suspended"
    mails = len(outbox(sw.sessions, "candidate.invite"))
    blocked = sw.browser(ROB).post("/api/v1/company/invites", {"template_id": mine, "emails": ["x@y.example"]})
    assert blocked.status_code in (403, 404, 409) and len(outbox(sw.sessions, "candidate.invite")) == mails
    assert sw.alice.post(f"/api/v1/admin/companies/{org_id}/decision", {"decision": "reinstate", "reason": "Resolved"}).status_code == 204
    assert sw.browser(ROB).get("/api/v1/company").json()["state"] == "active"
    assert sw.browser(ROB).post("/api/v1/company/invites", {"template_id": mine, "emails": ["x@y.example"]}).status_code == 201


def test_a05_a06_an_admin_searches_users_locks_unlocks_resets_a_password_and_every_step_is_audited(sw):
    found = sw.alice.get("/api/v1/admin/users", params={"q": "eve"}).json()["items"]
    assert [u["email"] for u in found] == [EVE_EMAIL] or [u["user_id"] for u in found] == [EVE]
    assert sw.alice.post(f"/api/v1/admin/users/{EVE}/actions", {"action": "lock"}).status_code == 422, "a reason is required"
    locked = sw.alice.post(f"/api/v1/admin/users/{EVE}/actions", {"action": "lock", "reason": "Suspected abuse"})
    assert locked.status_code == 200, locked.text
    refused = anonymous(sw).post("/api/v1/session", json={"email": EVE_EMAIL, "password": GOOD})
    assert refused.status_code in (401, 403)
    assert sw.alice.post(f"/api/v1/admin/users/{EVE}/actions", {"action": "unlock", "reason": "Cleared"}).status_code == 200
    assert anonymous(sw).post("/api/v1/session", json={"email": EVE_EMAIL, "password": GOOD}).status_code == 200
    before = len(outbox(sw.sessions, "account.password_reset"))
    assert sw.alice.post(f"/api/v1/admin/users/{EVE}/actions", {"action": "reset_password"}).status_code == 200
    assert len(outbox(sw.sessions, "account.password_reset")) == before + 1
    assert {"account.suspended", "account.reinstated"} <= set(actions(sw)), actions(sw)
    for who in (ROB, EVE_EMAIL):
        assert unknown(sw.browser(who).get("/api/v1/admin/users"))


def test_a05b_an_admin_can_lock_one_recruiter_and_that_person_can_no_longer_sign_in(sw):
    owner = user_id(sw.sessions, ROB)
    assert sw.alice.post(f"/api/v1/admin/users/{owner}/actions", {"action": "lock", "reason": "Suspected misuse"}).status_code == 200
    assert anonymous(sw).post("/api/v1/session", json={"email": ROB, "password": GOOD}).status_code in (401, 403)
    assert sw.browser(RITA).get("/api/v1/company").status_code == 200, "the other company is unaffected"


def test_a07_deleting_a_participant_who_holds_assessment_data_locks_the_account_instead(sw):
    done = sw.alice.post(f"/api/v1/admin/users/{CAM}/actions", {"action": "delete", "reason": "Requested by the person"})
    assert done.status_code == 200, done.text
    assert "locked" in done.text, done.text
    assert anonymous(sw).post("/api/v1/session", json={"email": CAM_EMAIL, "password": GOOD}).status_code in (401, 403)
    assert sw.lab.engine.get(sw.cam_attempt) is not None, "the company's record is untouched"
    plain = sw.alice.post(f"/api/v1/admin/users/{EVE}/actions", {"action": "delete", "reason": "Requested by the person"})
    assert plain.status_code == 200 and "deleted" in plain.text


def test_a09_a10_quotas_and_settings_are_stored_validated_and_audited(sw):
    quota = sw.alice.put("/api/v1/admin/quotas", {"scope": "global", "scope_id": None, "max_instances": 5})
    assert quota.status_code == 200, quota.text
    assert [q["max_instances"] for q in sw.alice.get("/api/v1/admin/quotas").json()["items"] if q["scope"] == "global"] == [5]
    assert sw.alice.put("/api/v1/admin/quotas", {"scope": "global", "scope_id": None, "max_instances": -1}).status_code == 422
    assert sw.alice.delete("/api/v1/admin/quotas?scope=global").status_code == 204
    listed = sw.alice.get("/api/v1/admin/settings").json()["items"]
    name = next(s["name"] for s in listed if s["name"] == "candidate_retention_days")
    assert sw.alice.put(f"/api/v1/admin/settings/{name}", {"value": 99999}).status_code == 422, "outside the range"
    assert sw.alice.put(f"/api/v1/admin/settings/{name}", {"value": 90}).status_code == 200
    assert next(s for s in sw.alice.get("/api/v1/admin/settings").json()["items"] if s["name"] == name)["value"] == 90
    assert sw.alice.delete(f"/api/v1/admin/settings/{name}").status_code == 200
    assert sw.alice.put("/api/v1/admin/settings/no_such_setting", {"value": 1}).status_code in (404, 422)
    assert any("setting" in a for a in actions(sw)) and any("quota" in a for a in actions(sw))


def test_a11_the_capacity_view_shows_the_host_and_the_instances(sw):
    cap = sw.alice.get("/api/v1/admin/capacity")
    assert cap.status_code == 200, cap.text
    body = cap.json()
    assert json.dumps(body).count("memory") >= 1 and unknown(sw.browser(RITA).get("/api/v1/admin/capacity"))


def test_a13_a_force_stop_destroys_the_instance_and_is_audited(sw):
    """The admin operations read the SQL attempt table (the production lab store); this world keeps the lab in memory, so the row is mirrored first."""
    from vulnmart.lab.models import Attempt

    with sw.sessions.begin() as s:
        s.add(Attempt(id=sw.ada_attempt, user_id=ADA, template_id="shop-v0", org_id=None, state="running", version=0, record={}))
    done = sw.alice.post(f"/api/v1/admin/attempts/{sw.ada_attempt}/force-stop")
    assert done.status_code == 200, done.text
    assert sw.lab.host.get(sw.ada_instance).state.value in ("destroyed", "stopping")
    assert any("force" in a or "stop" in a for a in actions(sw))
    assert sw.alice.post("/api/v1/admin/attempts/a-AAAAAAAAAAAAAAAA/force-stop").status_code == 404
    assert unknown(sw.browser(RITA).post(f"/api/v1/admin/attempts/{sw.cam_attempt}/force-stop"))


def test_a14_the_job_view_answers_for_an_admin_only(sw):
    assert sw.alice.get("/api/v1/admin/jobs").status_code == 200
    assert unknown(sw.browser(ADA_EMAIL).get("/api/v1/admin/jobs"))


def test_a15_reading_the_audit_log_is_admin_only_pseudonymised_and_itself_audited(sw):
    sw.alice.post(f"/api/v1/admin/users/{EVE}/actions", {"action": "lock", "reason": "Suspected abuse"})
    log = sw.alice.get("/api/v1/admin/audit")
    assert log.status_code == 200, log.text
    text = log.text
    assert EVE_EMAIL not in text and ADA_EMAIL not in text and CAM_EMAIL not in text, "the log identifies nobody by address"
    assert "admin.audit_read" in actions(sw) or any("audit" in a for a in actions(sw))
    for who in (ADA_EMAIL, RITA):
        assert unknown(sw.browser(who).get("/api/v1/admin/audit"))


def test_a16_a_break_glass_session_needs_a_written_reason_alerts_the_other_admin_and_is_reviewed_by_them(sw, clock):
    assert sw.alice.post("/api/v1/admin/break-glass", {"attempt_id": sw.cam_attempt, "reason": "short"}).status_code == 422
    opened = sw.alice.post("/api/v1/admin/break-glass", {"attempt_id": sw.cam_attempt, "reason": REASON})
    assert opened.status_code == 201, opened.text
    session = opened.json()["session_id"]
    assert BORIS in [m.to_user_id for m in outbox(sw.sessions, "admin.break_glass_opened")]
    assert [m.to_user_id for m in outbox(sw.sessions, "company.break_glass_opened")], "the company's owner is told"
    read = sw.alice.get(f"/api/v1/admin/break-glass/{session}/attempt")
    assert read.status_code == 200 and "VM{" not in read.text.replace("VM{redacted}", "")
    assert sw.alice.post(f"/api/v1/admin/break-glass/{session}/close").status_code == 200
    assert sw.alice.get(f"/api/v1/admin/break-glass/{session}/attempt").status_code in (404, 409), "closed means closed"
    assert sw.alice.post(f"/api/v1/admin/break-glass/{session}/review", {"note": "my own"}).status_code in (403, 404, 409), "never their own review"
    assert sw.boris.post(f"/api/v1/admin/break-glass/{session}/review", {"note": "Checked, reason was valid"}).status_code == 200


def test_a17_without_a_break_glass_session_an_admin_reads_no_candidate_answers_and_no_practice(sw):
    for attempt in (sw.cam_attempt, sw.ada_attempt):
        for url in ("", "/report", "/evidence", "/timeline", "/score", "/challenges", "/integrity-flags"):
            assert sw.alice.get(f"/api/v1/attempts/{attempt}{url}").status_code == 404, (attempt, url)
    assert sw.alice.post("/api/v1/admin/break-glass", {"attempt_id": sw.ada_attempt, "reason": REASON}).status_code == 404, "practice cannot be opened at all"


def test_a22_an_admin_can_lock_a_cheating_learner(sw):
    assert sw.alice.post(f"/api/v1/admin/users/{ADA}/actions", {"action": "lock", "reason": "Shared flags"}).status_code == 200
    assert anonymous(sw).post("/api/v1/session", json={"email": ADA_EMAIL, "password": GOOD}).status_code in (401, 403)


def test_a26_a_running_attempt_whose_instance_was_adopted_closed_is_opened_again_by_the_next_tick(sw):
    before = sw.lab.host.get(sw.ada_instance)
    sw.lab.host.set_access(sw.ada_instance, Access.CLOSED, before.access_epoch + 1)  # the orchestrator restarted and adopted it closed
    assert sw.lab.host.get(sw.ada_instance).access is Access.CLOSED
    sw.lab.tick()
    healed = sw.lab.host.get(sw.ada_instance)
    assert healed.access is Access.OPEN and healed.access_epoch == before.access_epoch + 2
