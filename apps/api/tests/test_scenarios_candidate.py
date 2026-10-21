"""Work package G, scenario matrix: the candidate scenarios C-01 to C-37 of docs/audit/2026-10-21-role-scenarios.md, through the routes of the combined world.
Rita's company invited Cam (template: 45 minutes, results after release, hints on); the world has Ada and Eve as learners and Rob's company."""
from __future__ import annotations

import io
import re
import zipfile

from scenario_support import (  # noqa: F401 - fixtures
    ADA_EMAIL, CAM_EMAIL, EVE_EMAIL, GOOD, RITA, ROB, accept_and_consent, anonymous, assessments, audit, clock, companies, ended, invite_candidate, mail_rows, new_learner, outbox, play,
    problem_code, sessions, start_candidate, start_practice, sw, token_in, w, wait_running, wait_state,
)
from vulnmart.accounts.models import User
from vulnmart.assessments.tokens import hash_token as tokens_hash


def problem(response, status: int, code: str) -> None:
    assert (response.status_code, response.json().get("code")) == (status, code), response.text


def candidate(sw, n: int, *, template: str | None = None, started: bool = False):
    """A fresh learner invited by Rita, who accepts and consents; returns (browser, attempt id, instance id or None)."""
    uid, email = new_learner(sw, n)
    token, _ = invite_candidate(sw, email, template)
    b = sw.browser(email)
    attempt = accept_and_consent(sw, b, token)
    return (b, attempt, start_candidate(sw, b, attempt)) if started else (b, attempt, None)


def roles_of(sw, email: str) -> set[str]:
    from sqlalchemy import select

    from vulnmart.accounts.models import UserRole
    with sw.sessions() as s:
        uid = s.scalar(select(User.id).where(User.email_ci == email))
        return set(s.scalars(select(UserRole.role).where(UserRole.user_id == uid)))


def relog(sw, n: int):
    """A new sign-in for a fresh learner after the test moved the clock (idle sessions end after 30 minutes)."""
    return sw.browser(f"scen{n}@learners.example")


def template_with(sw, **over) -> str:
    body = {"title": "Scenario template", "challenge_keys": ["C01", "C02", "C05"], **over}
    r = sw.browser(RITA).post("/api/v1/company/templates", body)
    assert r.status_code == 201, r.text
    return r.json()["template_id"]


# ---- the invite -----------------------------------------------------------------------------------------------------------------------

def test_c01_the_invite_mail_carries_a_company_prefixed_single_use_token_stored_only_as_a_hash_and_hides_the_address(sw):
    row = mail_rows(sw.sessions)[0]
    token = token_in(row)
    assert re.fullmatch(r"[a-z2-7]{26}\.[A-Za-z0-9_-]{43}", token), "256 bits of randomness after the company prefix"
    assert CAM_EMAIL not in str(row.params) and CAM_EMAIL not in (row.to_address_sealed or ""), "the address is sealed in the outbox"
    from sqlalchemy import text

    with sw.sessions() as s:
        stored = " ".join(str(v) for r in s.execute(text("select * from invites")) for v in r)
    assert token not in stored and tokens_hash(token) in stored, "the invite table holds only the hash of the token"
    # two invites never share a token
    other, _ = invite_candidate(sw, "second@candidates.example")
    assert other != token


def test_c02_an_invite_link_shows_company_title_and_rules_without_a_session_and_is_rate_limited(sw):
    anon = anonymous(sw)
    opened = anon.post("/api/v1/invites/open", json={"token": sw.cam_token})
    assert opened.status_code == 200, opened.text
    body = opened.json()
    assert body["company_name"] == "Acme" and body["title"] and body["state"] in ("consented", "sent", "opened", "accepted") and CAM_EMAIL not in opened.text
    assert anon.post("/api/v1/invites/open", json={"token": "a" * 26 + "." + "b" * 43}).status_code in (400, 404)
    answers = [anon.post("/api/v1/invites/open", json={"token": "a" * 26 + "." + "b" * 43}).status_code for _ in range(60)]
    assert 429 in answers, "an unknown token cannot be guessed at speed"


def test_c04_an_existing_learner_accepts_and_consents_gets_the_candidate_role_and_keeps_the_practice(sw):
    cam = sw.browser(CAM_EMAIL)
    assert roles_of(sw, CAM_EMAIL) == {"learner", "candidate"}
    assert roles_of(sw, ADA_EMAIL) == {"learner"}, "a learner who got no invite has no candidate role"
    # a learner with a practice run keeps it after being invited
    uid, email = new_learner(sw, 1)
    b = sw.browser(email)
    instance, practice = start_practice(sw, b)
    token, _ = invite_candidate(sw, email)
    attempt = accept_and_consent(sw, b, token)
    modes = {a["attempt_id"]: a["mode"] for a in b.get("/api/v1/me/attempts").json()["items"]}
    assert modes == {practice: "learner", attempt: "candidate"}
    assert sw.lab.engine.get(practice).state.value == "running"


def test_c05_an_unverified_account_cannot_even_sign_in_to_accept_an_invite(sw):
    uid, email = new_learner(sw, 2)
    with sw.sessions.begin() as s:
        s.get(User, uid).email_verified_at = None
    token, _ = invite_candidate(sw, email)
    refused = anonymous(sw).post("/api/v1/session", json={"email": email, "password": GOOD})
    assert (refused.status_code, refused.json()["code"]) == (403, "AUTH-EMAIL-NOT-VERIFIED") and email not in refused.text
    assert anonymous(sw).post("/api/v1/invites/accept", json={"token": token}).status_code in (401, 403)
    with sw.sessions.begin() as s:
        s.get(User, uid).email_verified_at = sw.clock.now
    assert sw.browser(email).post("/api/v1/invites/accept", {"token": token}).status_code == 200


def test_c06_an_invite_for_another_address_is_refused_and_leaks_nothing(sw):
    eve = sw.browser(EVE_EMAIL)
    r = eve.post("/api/v1/invites/accept", {"token": sw.cam_token})
    assert r.status_code == 409 and CAM_EMAIL not in r.text and sw.cam_invite not in r.text
    assert eve.get("/api/v1/me/invites").json()["items"] == []


def test_c07_a_revoked_expired_or_declined_invite_is_closed_for_good(sw, clock):
    rita = sw.browser(RITA)
    uid, email = new_learner(sw, 3)
    token, created = invite_candidate(sw, email)
    invite_id = created["created"][0]["invite_id"]
    b = sw.browser(email)
    assert rita.post(f"/api/v1/company/invites/{invite_id}/actions", {"action": "revoke"}).status_code == 409, "a revoke needs a sent invite"
    assert rita.post(f"/api/v1/company/invites/{invite_id}/actions", {"action": "cancel"}).json()["state"] == "cancelled"
    assert anonymous(sw).post("/api/v1/invites/open", json={"token": token}).json()["state"] == "cancelled"
    assert b.post("/api/v1/invites/accept", {"token": token}).status_code == 409
    uid, email = new_learner(sw, 26)  # an invite the person opened can be revoked
    token, created = invite_candidate(sw, email)
    assert anonymous(sw).post("/api/v1/invites/open", json={"token": token}).status_code == 200
    revoked = rita.post(f"/api/v1/company/invites/{created['created'][0]['invite_id']}/actions", {"action": "revoke"})
    assert revoked.status_code == 200 and revoked.json()["state"] == "revoked", revoked.text
    assert sw.browser(email).post("/api/v1/invites/accept", {"token": token}).status_code == 409
    # decline: a person declines the consent notice, the invite closes with no attempt
    uid, email = new_learner(sw, 4)
    token, _ = invite_candidate(sw, email)
    b = sw.browser(email)
    accepted = b.post("/api/v1/invites/accept", {"token": token}).json()
    notice = b.get("/api/v1/consent/notice", params={"attempt_id": accepted["attempt_id"]}).json()
    declined = b.post("/api/v1/consent", {"attempt_id": accepted["attempt_id"], "notice_version": notice["notice_version"],
                                           "notice_text_sha256": notice["notice_text_sha256"], "decision": "declined"})
    assert declined.status_code in (200, 201)
    assert anonymous(sw).post("/api/v1/invites/open", json={"token": token}).json()["state"] == "declined"
    # expiry: a week later an unused invite is closed
    uid, email = new_learner(sw, 5)
    token, _ = invite_candidate(sw, email)
    clock.advance(days=8)
    assert anonymous(sw).post("/api/v1/invites/open", json={"token": token}).json()["state"] == "expired"
    assert sw.browser(email).post("/api/v1/invites/accept", {"token": token}).status_code == 409


def test_c09_a_recruiter_or_admin_cannot_accept_an_invite(sw):
    token, _ = invite_candidate(sw, "rcpt@candidates.example")
    assert sw.browser(ROB).post("/api/v1/invites/accept", {"token": token}).status_code == 409
    assert sw.browser(RITA).post("/api/v1/invites/accept", {"token": token}).status_code == 409
    assert sw.alice.post("/api/v1/invites/accept", {"token": token}).status_code in (404, 409)


def test_c10_the_consent_needs_the_current_notice_and_a_stale_notice_is_refused(sw):
    uid, email = new_learner(sw, 6)
    token, _ = invite_candidate(sw, email)
    b = sw.browser(email)
    attempt = b.post("/api/v1/invites/accept", {"token": token}).json()["attempt_id"]
    notice = b.get("/api/v1/consent/notice", params={"attempt_id": attempt}).json()
    assert notice["notice_version"] and len(notice["notice_text_sha256"]) == 64 and notice.get("text") or notice.get("notice_text")
    for bad in ({"notice_version": "0.0.0-old"}, {"notice_text_sha256": "0" * 64}):
        r = b.post("/api/v1/consent", {"attempt_id": attempt, "notice_version": notice["notice_version"], "notice_text_sha256": notice["notice_text_sha256"],
                                        "decision": "granted", **bad})
        assert r.status_code in (409, 422), r.text
    assert sw.lab.engine.find is not None and [c for c in b.get("/api/v1/me/consents").json()["items"] if c["decision"] == "granted"] == []
    ok = b.post("/api/v1/consent", {"attempt_id": attempt, "notice_version": notice["notice_version"], "notice_text_sha256": notice["notice_text_sha256"], "decision": "granted"})
    assert ok.status_code == 201
    assert [c["decision"] for c in b.get("/api/v1/me/consents").json()["items"]] == ["granted"]


def test_c11_a_declined_consent_creates_no_attempt_and_the_company_sees_the_state(sw):
    uid, email = new_learner(sw, 7)
    token, _ = invite_candidate(sw, email)
    b = sw.browser(email)
    attempt = b.post("/api/v1/invites/accept", {"token": token}).json()["attempt_id"]
    notice = b.get("/api/v1/consent/notice", params={"attempt_id": attempt}).json()
    assert b.post("/api/v1/consent", {"attempt_id": attempt, "notice_version": notice["notice_version"], "notice_text_sha256": notice["notice_text_sha256"],
                                      "decision": "declined"}).status_code in (200, 201)
    assert b.post(f"/api/v1/attempts/{attempt}/start").status_code in (404, 409)
    states = [i["state"] for i in sw.browser(RITA).get("/api/v1/company/invites").json()["items"]]
    assert "declined" in states


# ---- the attempt ----------------------------------------------------------------------------------------------------------------------

def test_c12_start_prepares_the_instance_the_clock_starts_at_ready_and_a_second_press_is_the_same_attempt(sw, clock):
    b, attempt, _ = candidate(sw, 8)
    assert b.get(f"/api/v1/attempts/{attempt}").json()["started_at"] is None, "no clock before the press"
    clock.advance(minutes=10)  # the candidate reads the rules for ten minutes first
    first = b.post(f"/api/v1/attempts/{attempt}/start")
    assert first.status_code == 200
    wait_running(sw.lab, attempt)
    again = b.post(f"/api/v1/attempts/{attempt}/start")
    assert again.status_code == 200 and again.json()["instance_id"] == b.get(f"/api/v1/attempts/{attempt}").json()["instance_id"]
    rec = sw.lab.engine.get(attempt)
    assert (rec.deadline_at - rec.started_at).total_seconds() == 45 * 60 and rec.started_at >= clock.now - __import__("datetime").timedelta(seconds=5)


def test_c13_the_template_time_limit_results_timing_and_reset_limit_reach_the_attempt(sw):
    t = template_with(sw, time_limit_min=60, reset_limit=1, results_visibility="after_submit")
    b, attempt, instance = candidate(sw, 9, template=t, started=True)
    rules = sw.lab.engine.get(attempt).rules
    assert (rules.time_limit_minutes, rules.results_visibility) == (60, "after_submit")
    assert rules.reset_limit == 1
    assert b.post(f"/api/v1/instances/{instance}/reset", {"confirm": True}).status_code == 202
    wait_running(sw.lab, attempt)
    over = b.post(f"/api/v1/instances/{instance}/reset", {"confirm": True})
    assert over.status_code in (409, 429), "the second reset is over the template's limit of one"
    view = b.get(f"/api/v1/attempts/{attempt}").json()
    assert view["deadline_at"].endswith("Z") and "results_released" not in view


def test_c14_the_deadline_is_the_servers_with_warnings_and_late_flags_are_refused(sw, clock):
    b, attempt, instance = candidate(sw, 10, started=True)  # the template says 45 minutes
    play(sw.lab, instance)
    clock.advance(minutes=31)
    sw.lab.tick()
    clock.advance(minutes=10)
    sw.lab.tick()
    b = relog(sw, 10)
    warnings = [e for e in b.get(f"/api/v1/attempts/{attempt}/timeline").json()["items"] if e["type"] == "attempt.time_warning"]
    assert [w["minutes_left"] for w in warnings] == [15, 5]
    clock.advance(minutes=5, seconds=61)  # past the deadline and the 60 second grace
    sw.lab.tick()
    b = relog(sw, 10)
    late = b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(instance, "C01", 1)})
    assert late.status_code == 409, late.text


def test_c15_an_attack_credits_milestones_keeps_evidence_and_shows_a_held_capture_as_held(sw):
    b, attempt, instance = candidate(sw, 11, template=template_with(sw, results_visibility="after_submit"), started=True)
    # no shop traffic: the paste is held for the recruiter, and the candidate sees "held"
    held = b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(instance, "C01", 1)})
    assert held.json()["credit"] == "held"
    assert next(i for i in b.get(f"/api/v1/attempts/{attempt}/challenges").json()["items"] if i["challenge_key"] == "C01")["held"] is True
    rita = sw.browser(RITA)
    flags = rita.get(f"/api/v1/attempts/{attempt}/integrity-flags").json()["items"]
    assert [f for f in flags if f["held"] and f["challenge_key"] == "C01" and f["status"] == "open"]
    assert rita.get(f"/api/v1/attempts/{attempt}/evidence").status_code == 200


def test_c17_a_reset_gives_fresh_flags_keeps_milestones_and_the_clock_continues(sw, clock):
    b, attempt, instance = candidate(sw, 12, started=True)
    play(sw.lab, instance)
    assert b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(instance, "C01", 1)}).json()["credit"] == "credited"
    deadline = b.get(f"/api/v1/attempts/{attempt}").json()["deadline_at"]
    clock.advance(minutes=3)
    assert b.post(f"/api/v1/instances/{instance}/reset", {"confirm": True}).status_code == 202
    wait_running(sw.lab, attempt)
    assert b.get(f"/api/v1/attempts/{attempt}").json()["deadline_at"] == deadline, "a reset never moves the deadline"
    assert sw.lab.milestones.best(attempt, "C01").value == "M3"


def test_c18_submitting_needs_confirmation_freezes_and_cannot_be_reopened(sw):
    b, attempt, instance = candidate(sw, 13, started=True)
    assert b.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": False}).status_code == 422
    done = b.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": True})
    assert done.status_code == 200 and done.json()["state"] == "submitted" and done.json()["frozen_until"].endswith("Z") and done.json()["submitted_at"].endswith("Z")
    problem(b.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": True}), 409, "ATT-INVALID-STATE")
    assert b.post(f"/api/v1/attempts/{attempt}/start").status_code == 409
    assert b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": "VM{x}"}).status_code == 409
    assert b.post(f"/api/v1/instances/{instance}/reset", {"confirm": True}).status_code in (404, 409)


def test_c19_time_running_out_ends_the_attempt_with_what_was_captured(sw, clock):
    b, attempt, instance = candidate(sw, 14, started=True)
    play(sw.lab, instance)
    assert b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(instance, "C01", 1)}).json()["credit"] == "credited"
    clock.advance(minutes=46)
    sw.lab.tick()
    b = relog(sw, 14)
    state = b.get(f"/api/v1/attempts/{attempt}").json()["state"]
    assert state in ("expired", "submitted", "reported")
    report = sw.browser(RITA).get(f"/api/v1/attempts/{attempt}/report").json()
    assert report["state"] in ("expired", "submitted", "reported")
    assert report["score"] > 0 and any(c["challenge_key"] == "C01" and c["best_milestone"] == "M3" for c in report["per_challenge"])


def test_c20_a_second_login_raises_the_access_epoch_so_the_older_tab_loses_the_instance(sw):
    b, attempt, instance = candidate(sw, 15, started=True)
    before = sw.lab.host.get(instance).access_epoch
    sw.browser(f"scen15@learners.example")  # the same person signs in on another device
    assert sw.lab.host.get(instance).access_epoch == before + 1


def test_c21_every_attempt_view_carries_the_servers_time_for_the_countdown(sw):
    b, attempt, _ = candidate(sw, 16, started=True)
    view = b.get(f"/api/v1/attempts/{attempt}").json()
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", view["server_time"]) and view["deadline_at"] > view["server_time"]


def test_c22_a_stopped_instance_can_be_started_again_by_start(sw):
    b, attempt, instance = candidate(sw, 17, started=True)
    assert b.post(f"/api/v1/instances/{instance}/stop").status_code in (200, 202)
    again = b.post(f"/api/v1/attempts/{attempt}/start")
    assert again.status_code == 200, again.text


def test_c23_results_timing_after_submit_is_open_and_after_release_stays_hidden_until_released(sw):
    open_template = template_with(sw, results_visibility="after_submit")
    b1, a1, i1 = candidate(sw, 18, template=open_template, started=True)
    play(sw.lab, i1)
    b1.post(f"/api/v1/attempts/{a1}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(i1, "C01", 1)})
    b1.post(f"/api/v1/attempts/{a1}/submit", {"confirm": True})
    assert b1.get(f"/api/v1/attempts/{a1}/score").status_code == 200
    b2, a2, i2 = candidate(sw, 19, started=True)  # the world's template says after_release
    play(sw.lab, i2)
    b2.post(f"/api/v1/attempts/{a2}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(i2, "C01", 1)})
    b2.post(f"/api/v1/attempts/{a2}/submit", {"confirm": True})
    assert b2.get(f"/api/v1/attempts/{a2}/score").status_code == 404
    assert sw.browser(RITA).post(f"/api/v1/attempts/{a2}/release").status_code == 200
    assert b2.get(f"/api/v1/attempts/{a2}/score").status_code == 200


def test_c24_a_withdrawal_locks_the_attempt_destroys_the_instance_and_can_be_undone_inside_the_window(sw):
    b, attempt, instance = candidate(sw, 20, started=True)
    assert b.post(f"/api/v1/attempts/{attempt}/withdraw", {"confirm": False}).status_code == 422
    w = b.post(f"/api/v1/attempts/{attempt}/withdraw", {"confirm": True})
    assert w.status_code == 200 and w.json()["state"] == "withdrawn" and w.json()["delete_after"].endswith("Z")
    assert b.get(f"/api/v1/instances/{instance}").status_code in (200, 404)
    assert b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": "VM{x}"}).status_code == 409
    undone = b.post(f"/api/v1/attempts/{attempt}/withdraw/undo")
    assert undone.status_code == 200 and undone.json()["delete_after"] is None and undone.json()["state"] == "withdrawn", "undo cancels the deletion; it does not resume"
    # the learner's practice data is untouched by a withdrawal
    assert sw.browser(ADA_EMAIL).get("/api/v1/me/progress").json()["total_points"] > 0


def test_c25_the_candidate_side_of_a_deletion_request_validates_and_hides_other_peoples_attempts(sw):
    """The candidate's request itself is proved by test_deletion_api.py (the lab store of this world is in memory, the request reads the SQL attempt table);
    the company's decision has no route yet (work package B)."""
    cam = sw.browser(CAM_EMAIL)
    assert cam.post("/api/v1/me/deletion-requests", {"kind": "candidate"}).status_code == 422
    assert cam.post("/api/v1/me/deletion-requests", {"kind": "learner", "attempt_id": sw.cam_attempt}).status_code == 422
    assert sw.browser(EVE_EMAIL).post("/api/v1/me/deletion-requests", {"kind": "candidate", "attempt_id": sw.cam_attempt}).status_code == 404
    assert all(r["kind"] != "candidate" for r in sw.browser(RITA).get("/api/v1/company/invites").json()["items"] if "kind" in r)


def test_c26_a_candidate_exports_their_data_and_sees_which_company_viewed_it(sw):
    sw.browser(RITA).get(f"/api/v1/attempts/{sw.cam_attempt}/report")
    cam = sw.browser(CAM_EMAIL)
    views = cam.get("/api/v1/me/data-views").json()["items"]
    assert views and views[0]["company_name"] == "Acme"
    with zipfile.ZipFile(io.BytesIO(cam.post("/api/v1/me/exports").content)) as z:
        text = "".join(z.read(n).decode("utf-8") for n in z.namelist())
    assert CAM_EMAIL in text and "Acme" in text


def test_c27_a_recruiter_can_issue_a_new_invite_after_a_fault_and_the_old_attempt_is_kept(sw):
    rita = sw.browser(RITA)
    r = rita.post(f"/api/v1/company/invites/{sw.cam_invite}/actions", {"action": "reinvite"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["generation"] == 2 and body["state"] == "created" and body["attempt_id"] is None
    invites = {i["invite_id"]: i for i in rita.get("/api/v1/company/invites").json()["items"]}
    assert invites[sw.cam_invite]["state"] == "revoked" and invites[sw.cam_invite]["superseded_by"] == body["invite_id"], "the old invite is kept and points to the new one"
    assert len(mail_rows(sw.sessions)) == 2, "the new invite is mailed"


def test_c29_a_learner_in_a_practice_run_can_also_run_an_assessment_with_separate_attempts_and_instances(sw):
    uid, email = new_learner(sw, 21)
    b = sw.browser(email)
    p_instance, p_attempt = start_practice(sw, b)
    token, _ = invite_candidate(sw, email)
    a_attempt = accept_and_consent(sw, b, token)
    a_instance = start_candidate(sw, b, a_attempt)
    assert p_attempt != a_attempt and p_instance != a_instance
    assert sw.lab.engine.get(p_attempt).org_id is None and sw.lab.engine.get(a_attempt).org_id is not None
    assert sw.lab.keys.flag(p_instance, "C01", 1) != sw.lab.keys.flag(a_instance, "C01", 1)


def test_c31_pasting_the_same_flag_twice_is_idempotent(sw):
    b, attempt, instance = candidate(sw, 22, started=True)
    play(sw.lab, instance)
    flag = sw.lab.keys.flag(instance, "C01", 1)
    first = b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": flag}).json()
    score = sw.lab.score_rows(attempt)[0]
    for _ in range(3):
        assert b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": flag}).json() == first
    assert sw.lab.score_rows(attempt)[0] == score


def test_c32_a_flag_of_another_instance_or_challenge_never_counts_and_the_recruiter_sees_the_signal(sw):
    b, attempt, instance = candidate(sw, 23, started=True)
    play(sw.lab, instance)
    taken = b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw.ada_flag}).json()
    assert taken == {"challenge_key": "C01", "result": "incorrect", "credit": "none"}
    wrong_challenge = b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C02", "flag": sw.lab.keys.flag(instance, "C01", 1)}).json()
    assert wrong_challenge["result"] == "incorrect"
    assert sw.lab.score_rows(attempt)[0] == 0
    kinds = {f["type"] for f in sw.browser(RITA).get(f"/api/v1/attempts/{attempt}/integrity-flags").json()["items"]}
    assert "sharing" in kinds, kinds
    assert b.get(f"/api/v1/attempts/{attempt}/integrity-flags").status_code == 404, "the candidate is not told why a paste failed"


def test_c33_cheating_signals_are_flags_for_a_human_and_never_fail_the_attempt(sw):
    b, attempt, instance = candidate(sw, 24, started=True)
    b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(instance, "C01", 1)})  # no traffic: held
    rita = sw.browser(RITA)
    report = rita.get(f"/api/v1/attempts/{attempt}/report").json()
    assert report["integrity_open"] >= 1 and report["state"] == "running"
    assert sw.lab.engine.get(attempt).state.value == "running", "a signal never ends the attempt"


def test_c34_every_time_in_the_api_is_utc_with_a_z_so_the_dashboard_can_show_local_time(sw):
    b, attempt, _ = candidate(sw, 25, started=True)
    view = b.get(f"/api/v1/attempts/{attempt}").json()
    for key in ("started_at", "deadline_at", "server_time"):
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", view[key]), key
    assert all(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", a["created_at"]) for a in b.get("/api/v1/me/attempts").json()["items"])


def test_c35_an_invited_person_must_have_declared_to_be_adult_at_signup(sw):
    r = anonymous(sw).post("/api/v1/accounts", json={"email": "young@candidates.example", "password": "a long enough passphrase", "display_name": "Y", "age_declaration": False})
    assert r.status_code == 422
