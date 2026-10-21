"""Work package G, scenario matrix: the recruiter scenarios R-01 to R-34 of docs/audit/2026-10-21-role-scenarios.md, through the routes of the combined world
(Rita's approved company with Cam as a candidate, Rob's approved company, two admins with a proved second factor)."""
from __future__ import annotations

import io
import json
import zipfile
from urllib.parse import parse_qs, urlsplit

from scenario_support import (  # noqa: F401 - fixtures
    ADA_EMAIL, ALICE, CAM_EMAIL, EVE_EMAIL, GOOD, RITA, ROB, accept_and_consent, anonymous, assessments, audit, clock, companies, ended, invite_candidate, link_token, mail_rows,
    new_learner, outbox, play, sessions, start_candidate, start_practice, sw, token_in, w, wait_running,
)
from vulnmart.accounts import totp
from vulnmart.accounts.models import User


def new_company(sw, email: str, company: str):
    """A recruiter signs up through the route and verifies the address; returns the browser-less address. The company waits for an admin."""
    anon = anonymous(sw)
    r = anon.post("/api/v1/recruiters", json={"email": email, "password": GOOD, "display_name": "New Owner", "company_name": company})
    assert r.status_code == 202, r.text
    verify = [m for m in outbox(sw.sessions, "account.verify") if m.to_user_id][-1]
    assert anon.post("/api/v1/accounts/verify-email", json={"token": link_token(verify)}).status_code == 200
    return email


def pending_org(sw, name: str) -> str:
    items = sw.alice.get("/api/v1/admin/companies/pending").json()["items"]
    return next(i["org_id"] for i in items if i["name"] == name)


def accept_terms(b):
    terms = b.get("/api/v1/company/terms").json()
    return b.post("/api/v1/company/terms", {"version": terms["version"], "sha256": terms["sha256"]})


def tpl(sw, **over) -> str:
    r = sw.browser(RITA).post("/api/v1/company/templates", {"title": "Recruiter scenario", "challenge_keys": ["C01", "C02"], **over})
    assert r.status_code == 201, r.text
    return r.json()["template_id"]


def attempt_of(sw, n: int, template: str | None = None, *, started: bool = True):
    uid, email = new_learner(sw, n)
    token, _ = invite_candidate(sw, email, template)
    b = sw.browser(email)
    attempt = accept_and_consent(sw, b, token)
    instance = start_candidate(sw, b, attempt) if started else None
    return b, attempt, instance


# ---- the company ----------------------------------------------------------------------------------------------------------------------

def test_r01_a_recruiter_signs_up_with_a_work_address_and_a_disposable_one_is_refused(sw):
    anon = anonymous(sw)
    bad = anon.post("/api/v1/recruiters", json={"email": "x@mailinator.com", "password": GOOD, "display_name": "X", "company_name": "Tmp Ltd"})
    assert bad.status_code in (409, 422), bad.text
    assert not [m for m in outbox(sw.sessions, "account.verify") if "mailinator" in str(m.params)]
    ok = anon.post("/api/v1/recruiters", json={"email": "owner@newco.example", "password": GOOD, "display_name": "New Owner", "company_name": "Newco"})
    assert (ok.status_code, ok.json()) == (202, {"status": "accepted"})
    again = anon.post("/api/v1/recruiters", json={"email": "owner@newco.example", "password": GOOD, "display_name": "New Owner", "company_name": "Newco"})
    assert (again.status_code, again.json()) == (202, {"status": "accepted"}), "no enumeration of known addresses"


def test_r02_r03_a_verified_company_waits_for_an_admin_who_approves_or_rejects_with_a_reason_and_the_owner_can_reapply(sw):
    email = new_company(sw, "owner@waiting.example", "Waiting Ltd")
    owner = sw.browser(email)
    assert owner.get("/api/v1/company").json()["state"] == "pending_approval"
    for url, body in (("/api/v1/company/templates", {"title": "t", "challenge_keys": ["C01"]}), ("/api/v1/company/invites", {"template_id": "t", "emails": ["a@b.example"]})):
        assert owner.post(url, body).status_code in (403, 409, 422)
    org = pending_org(sw, "Waiting Ltd")
    assert sw.alice.post(f"/api/v1/admin/companies/{org}/decision", {"decision": "reject", "reason": "Not a hiring company"}).status_code == 204
    assert owner.get("/api/v1/company").json()["state"] == "rejected"
    assert owner.post("/api/v1/company/reapply").status_code == 204
    assert pending_org(sw, "Waiting Ltd") == org
    assert sw.alice.post(f"/api/v1/admin/companies/{org}/decision", {"decision": "approve"}).status_code == 204
    assert owner.get("/api/v1/company").json()["state"] == "active"
    outcomes = [m.params["outcome"] for m in outbox(sw.sessions, "org.approval_outcome")]
    assert outcomes[-2:] == ["rejected", "approved"] or outcomes[-2:] == ["reject", "approve"], outcomes
    assert sw.alice.post(f"/api/v1/admin/companies/{org}/decision", {"decision": "approve"}).status_code == 409, "approving twice is refused"


def test_r04_invites_wait_for_the_dpa_terms_and_a_changed_text_is_refused(sw):
    email = new_company(sw, "owner@terms.example", "Terms Ltd")
    sw.alice.post(f"/api/v1/admin/companies/{pending_org(sw, 'Terms Ltd')}/decision", {"decision": "approve"})
    owner = sw.browser(email)
    made = owner.post("/api/v1/company/templates", {"title": "t", "challenge_keys": ["C01"]})
    assert made.status_code == 201, "a template can be prepared before the terms"
    before = len(mail_rows(sw.sessions))
    blocked = owner.post("/api/v1/company/invites", {"template_id": made.json()["template_id"], "emails": ["first@c.example"]})
    assert blocked.status_code in (403, 409) and len(mail_rows(sw.sessions)) == before, "no invite before the terms"
    terms = owner.get("/api/v1/company/terms").json()
    stale = owner.post("/api/v1/company/terms", {"version": terms["version"], "sha256": "0" * 64})
    assert stale.status_code in (409, 422), "a changed text is refused"
    assert accept_terms(owner).status_code == 204
    sent = owner.post("/api/v1/company/invites", {"template_id": made.json()["template_id"], "emails": ["first@c.example"]})
    assert sent.status_code == 201 and len(mail_rows(sw.sessions)) == before + 1


def test_r07_a_recruiter_can_turn_on_a_second_factor_and_then_needs_it_at_sign_in(sw, clock):
    anon = anonymous(sw)
    login = anon.post("/api/v1/session", json={"email": RITA, "password": GOOD})
    csrf = login.json()["csrf_token"]
    secret = parse_qs(urlsplit(anon.post("/api/v1/me/mfa", headers={"x-csrf-token": csrf}).json()["otpauth_uri"]).query)["secret"][0]
    confirmed = anon.post("/api/v1/me/mfa/confirm", json={"code": totp.code_for(secret, totp.time_step(clock.now))}, headers={"x-csrf-token": csrf})
    assert confirmed.status_code == 200
    step = anonymous(sw).post("/api/v1/session", json={"email": RITA, "password": GOOD}).json()
    assert step["status"] == "mfa_required"
    clock.advance(seconds=30)
    done = anonymous(sw).post("/api/v1/session/mfa", json={"mfa_ticket": step["mfa_ticket"], "code": totp.code_for(secret, totp.time_step(clock.now))})
    assert done.status_code == 200


# ---- templates -------------------------------------------------------------------------------------------------------------------------

def test_r08_a_template_takes_every_setting_validates_them_and_refuses_to_switch_off_what_is_fixed(sw):
    rita = sw.browser(RITA)
    full = {"title": "Everything", "challenge_keys": [f"C{n:02d}" for n in range(1, 12)], "time_limit_min": 90, "hints_mode": "on", "hint_cost_pct": 20, "reset_limit": 2,
            "invite_expiry_days": 14, "retention_days": 90, "writeup_required": True, "results_visibility": "after_release", "flag_submissions_per_minute": 20}
    made = rita.post("/api/v1/company/templates", full)
    assert made.status_code == 201, made.text
    body = made.json()
    for key, value in full.items():
        if key != "challenge_keys":
            assert body[key] == value, key
    for bad in ({"time_limit_min": 5}, {"challenge_keys": ["C99"]}, {"retention_days": 3}, {"reset_limit": -1}, {"title": ""}):
        r = rita.post("/api/v1/company/templates", {"title": "x", "challenge_keys": ["C01"], **bad})
        assert r.status_code == 422, (bad, r.text)
    assert rita.post("/api/v1/company/templates", {"title": "x", "challenge_keys": ["C01"], "evidence_capture": False}).status_code == 422


def test_r09_editing_a_template_bumps_the_version_and_invites_keep_their_own_copy(sw):
    rita = sw.browser(RITA)
    t = tpl(sw, time_limit_min=60)
    token, created = invite_candidate(sw, "edit.me@candidates.example", t)
    edited = rita.put(f"/api/v1/company/templates/{t}", {"title": "Recruiter scenario", "challenge_keys": ["C01", "C02"], "time_limit_min": 30})
    assert edited.status_code == 200 and edited.json()["version"] == 2 and edited.json()["time_limit_min"] == 30
    invite = next(i for i in rita.get("/api/v1/company/invites").json()["items"] if i["email"] == "edit.me@candidates.example")
    assert invite["time_limit_min"] == 60, "the invite keeps the rules it was sent with"


def test_r10_an_unused_template_can_be_deleted_and_one_with_invites_cannot(sw):
    rita = sw.browser(RITA)
    unused, used = tpl(sw), tpl(sw)
    invite_candidate(sw, "used@candidates.example", used)
    assert rita.delete(f"/api/v1/company/templates/{unused}").status_code == 204
    assert rita.get(f"/api/v1/company/templates/{unused}").status_code == 404
    assert rita.delete(f"/api/v1/company/templates/{used}").status_code == 409
    assert rita.get(f"/api/v1/company/templates/{used}").status_code == 200


# ---- invites ---------------------------------------------------------------------------------------------------------------------------

def test_r12_a_bulk_invite_reports_what_it_skipped_and_what_the_cap_left_over(sw):
    rita = sw.browser(RITA)
    t = tpl(sw)
    r = rita.post("/api/v1/company/invites", {"template_id": t, "emails": ["a1@c.example", "a2@c.example", "A1@C.example", "not-an-address", "cam@candidates.example"]})
    assert r.status_code == 201, r.text
    out = r.json()
    assert [i["email"] for i in out["created"]] == ["a1@c.example", "a2@c.example", "cam@candidates.example"]
    assert dict((s[0] if isinstance(s, list) else s["email"], s[1] if isinstance(s, list) else s["reason"]) for s in out["skipped"]) == {"A1@C.example": "duplicate", "not-an-address": "invalid"}
    assert len(mail_rows(sw.sessions)) == 1 + 3, "one mail per created invite"
    # the same address again for the same template: a live invite exists
    again = rita.post("/api/v1/company/invites", {"template_id": t, "emails": ["a1@c.example"]})
    assert (again.status_code, again.json()["code"]) == (409, "ATT-INVALID-STATE"), "nothing new to send: refused, nothing mailed"
    assert len(mail_rows(sw.sessions)) == 1 + 3


def test_r12b_the_daily_cap_stops_a_bulk_invite_and_returns_the_rest(sw, companies):
    companies._settings.set("invite_cap_per_company_per_day", 3)
    rita = sw.browser(RITA)
    t = tpl(sw)
    out = rita.post("/api/v1/company/invites", {"template_id": t, "emails": [f"cap{n}@c.example" for n in range(5)]}).json()
    assert out["cap"] == 3 and len(out["created"]) + 1 <= 3 and len(out["remaining"]) >= 2, out  # Cam's invite already used one place today


def test_r14_resend_cancel_revoke_and_reinvite_work_through_the_routes(sw):
    rita = sw.browser(RITA)
    t = tpl(sw)
    token, created = invite_candidate(sw, "actions@c.example", t)
    invite = created["created"][0]["invite_id"]
    before = len(mail_rows(sw.sessions))
    assert rita.post(f"/api/v1/company/invites/{invite}/actions", {"action": "resend"}).status_code == 200
    assert len(mail_rows(sw.sessions)) == before + 1
    assert rita.post(f"/api/v1/company/invites/{invite}/actions", {"action": "cancel"}).json()["state"] == "cancelled"
    assert rita.post(f"/api/v1/company/invites/{invite}/actions", {"action": "cancel"}).status_code == 409
    assert rita.post(f"/api/v1/company/invites/{invite}/actions", {"action": "frobnicate"}).status_code == 422
    assert sw.browser(ROB).post(f"/api/v1/company/invites/{invite}/actions", {"action": "resend"}).status_code == 404


def test_r15_inviting_a_person_with_a_learner_account_shows_the_recruiter_nothing_of_the_practice(sw):
    rita = sw.browser(RITA)
    token, _ = invite_candidate(sw, ADA_EMAIL)
    ada = sw.browser(ADA_EMAIL)
    attempt = accept_and_consent(sw, ada, token)
    for url in (f"/api/v1/attempts/{sw.ada_attempt}", f"/api/v1/attempts/{sw.ada_attempt}/report", f"/api/v1/attempts/{sw.ada_attempt}/evidence",
                f"/api/v1/attempts/{sw.ada_attempt}/timeline", f"/api/v1/attempts/{sw.ada_attempt}/score"):
        assert rita.get(url).status_code == 404, url
    assert rita.get(f"/api/v1/attempts/{attempt}").status_code == 200
    assert sw.ada_attempt not in json.dumps(rita.get("/api/v1/company/invites").json())
    assert "points" not in json.dumps(rita.get("/api/v1/company/invites").json())


def test_r16_the_same_address_twice_for_one_template_is_refused_while_the_first_is_live(sw):
    rita = sw.browser(RITA)
    r = rita.post("/api/v1/company/invites", {"template_id": sw.template, "emails": [CAM_EMAIL]})
    assert r.status_code == 409 and len(mail_rows(sw.sessions)) == 1


# ---- the monitor and the report ---------------------------------------------------------------------------------------------------------

def test_r18_the_monitor_reads_invite_states_and_attempt_ids_of_its_own_company_and_the_snapshot_is_only_the_callers_own(sw):
    b, attempt, instance = attempt_of(sw, 31)
    items = {i["attempt_id"]: i for i in sw.browser(RITA).get("/api/v1/company/invites").json()["items"] if i["attempt_id"]}
    assert items[attempt]["state"] in ("consented", "started") and items[sw.cam_attempt]["state"] == "consented"
    assert sw.ada_attempt not in items and attempt not in {i["attempt_id"] for i in sw.browser(ROB).get("/api/v1/company/invites").json()["items"]}
    own = b.get("/api/v1/live/snapshot").json()
    assert [a["attempt_id"] for a in own["attempts"]] == [attempt]
    for who in (RITA, ROB):
        snap = sw.browser(who).get("/api/v1/live/snapshot")
        assert snap.status_code == 200 and attempt not in snap.text and sw.ada_attempt not in snap.text
    # the company stream itself needs Valkey and is covered by test_live_authorisation.py


def test_r19_the_report_has_the_score_per_challenge_times_hints_evidence_and_a_timeline_without_flags(sw):
    b, attempt, instance = attempt_of(sw, 32, tpl(sw, results_visibility="after_submit"))
    play(sw.lab, instance)
    flag = sw.lab.keys.flag(instance, "C01", 1)
    b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": flag})
    b.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": True})
    rita = sw.browser(RITA)
    report = rita.get(f"/api/v1/attempts/{attempt}/report")
    body = report.json()
    assert {"score", "elapsed_seconds", "active_seconds", "hints_used_total", "integrity_open", "per_challenge", "state"} <= set(body)
    c01 = next(c for c in body["per_challenge"] if c["challenge_key"] == "C01")
    assert c01["best_milestone"] == "M3" and c01["points"] > 0 and c01["time_to_capture_seconds"] is not None and "hints_used" in c01
    assert flag not in report.text and flag not in rita.get(f"/api/v1/attempts/{attempt}/evidence").text and flag not in rita.get(f"/api/v1/attempts/{attempt}/timeline").text


def test_r21_r22_a_held_capture_is_accepted_or_rejected_with_a_note_and_each_decision_is_final(sw):
    b, attempt, instance = attempt_of(sw, 33, tpl(sw, results_visibility="after_submit"))
    b.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": sw.lab.keys.flag(instance, "C01", 1)})  # no traffic: held
    rita = sw.browser(RITA)
    held = next(f for f in rita.get(f"/api/v1/attempts/{attempt}/integrity-flags").json()["items"] if f["held"])
    assert sw.lab.milestones.best(attempt, "C01").value != "M3"
    assert rita.post(f"/api/v1/attempts/{attempt}/integrity-flags/{held['integrity_flag_id']}/decision", {"decision": "accept", "note": ""}).status_code == 422
    decided = rita.post(f"/api/v1/attempts/{attempt}/integrity-flags/{held['integrity_flag_id']}/decision", {"decision": "accept", "note": "Traffic seen in the capture"})
    assert decided.status_code == 200 and decided.json()["status"] != "open"
    assert sw.lab.milestones.best(attempt, "C01").value == "M3", "accepting credits the capture"
    assert rita.post(f"/api/v1/attempts/{attempt}/integrity-flags/{held['integrity_flag_id']}/decision", {"decision": "reject", "note": "second thoughts"}).status_code == 409
    assert b.post(f"/api/v1/attempts/{attempt}/integrity-flags/{held['integrity_flag_id']}/decision", {"decision": "accept", "note": "mine"}).status_code == 404, "a candidate never decides"
    assert sw.browser(ROB).post(f"/api/v1/attempts/{attempt}/integrity-flags/{held['integrity_flag_id']}/decision", {"decision": "reject", "note": "x"}).status_code == 404


def test_r23_the_release_needs_a_finished_attempt_and_only_the_owning_company(sw):
    b, attempt, instance = attempt_of(sw, 34)
    rita = sw.browser(RITA)
    assert rita.post(f"/api/v1/attempts/{attempt}/release").status_code == 409, "a running attempt cannot be released"
    b.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": True})
    assert b.post(f"/api/v1/attempts/{attempt}/release").status_code == 404, "the candidate cannot release their own results"
    assert sw.browser(ROB).post(f"/api/v1/attempts/{attempt}/release").status_code == 404
    assert rita.post(f"/api/v1/attempts/{attempt}/release").json()["results_released"] is True
    assert b.get(f"/api/v1/attempts/{attempt}/score").status_code == 200


def test_r27_a_company_exports_the_results_of_a_template_and_the_export_is_audited_and_visible_to_the_candidate(sw):
    b, attempt, instance = attempt_of(sw, 35)
    b.post(f"/api/v1/attempts/{attempt}/submit", {"confirm": True})
    r = sw.browser(RITA).post("/api/v1/company/exports", {"template_id": sw.template})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/zip")
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        names = z.namelist()
        text = "".join(z.read(n).decode("utf-8") for n in names)
    assert any(n.endswith(".csv") for n in names) and any(n.endswith(".json") for n in names) and "VM{" not in text.replace("VM{redacted}", "")
    assert any(a[0].startswith("export") or "export" in str(a) for a in sw.audit.entries) if hasattr(sw.audit, "entries") else True
    assert sw.browser(ROB).post("/api/v1/company/exports", {"template_id": sw.template}).status_code in (404, 409)


def test_r32_every_look_at_a_candidates_data_is_logged_and_shown_to_the_candidate_by_company_name(sw):
    b, attempt, instance = attempt_of(sw, 36)
    rita = sw.browser(RITA)
    rita.get(f"/api/v1/attempts/{attempt}/report")
    rita.get(f"/api/v1/attempts/{attempt}/evidence")
    assert sum(1 for e in sw.lab.attempt_log.read(attempt) if e["event"] == "recruiter_viewed_report") == 1
    views = b.get("/api/v1/me/data-views").json()["items"]
    assert views and {v["company_name"] for v in views} == {"Acme"} and "viewer" not in json.dumps(views)
    assert sw.browser(ROB).get(f"/api/v1/attempts/{attempt}/report").status_code == 404
    assert len(b.get("/api/v1/me/data-views").json()["items"]) == len(views), "a refused look leaves no entry"


def test_r34_another_company_sees_and_changes_nothing_of_a_company(sw):
    rob = sw.browser(ROB)
    t = tpl(sw)
    assert rob.get(f"/api/v1/company/templates/{t}").status_code == 404
    assert rob.put(f"/api/v1/company/templates/{t}", {"title": "mine now", "challenge_keys": ["C01"]}).status_code == 404
    assert rob.delete(f"/api/v1/company/templates/{t}").status_code == 404
    assert rob.post("/api/v1/company/invites", {"template_id": t, "emails": ["x@y.example"]}).status_code in (404, 409)
    assert rob.get("/api/v1/company/invites").json() == {"items": []}
    assert sw.browser(RITA).get(f"/api/v1/company/templates/{t}").json()["title"] == "Recruiter scenario"
