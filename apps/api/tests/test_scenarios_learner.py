"""Work package G, scenario matrix: the learner scenarios L-01 to L-26 of docs/audit/2026-10-21-role-scenarios.md, exercised through the routes of the combined world.
Each test name starts with the scenario id; docs/audit/2026-10-21-scenario-matrix.md points here and `test_scenario_matrix.py` checks that every pointer exists."""
from __future__ import annotations

import io
from datetime import timedelta
import re
import zipfile
from urllib.parse import parse_qs, urlsplit

import pytest

from scenario_support import (  # noqa: F401 - fixtures
    ADA_EMAIL, EVE_EMAIL, GOOD, ORIGIN, T0, ALL_KEYS, anonymous, assessments, audit, clock, companies, ended, link_token, new_learner, outbox, play, sessions, start_practice,
    sw, w, wait_running, wait_state,
)
from vulnmart.accounts import totp

SIGNUP = {"email": "new.learner@learners.example", "password": GOOD, "display_name": "New Learner", "age_declaration": True}


def problem(response, status: int, code: str) -> None:
    assert (response.status_code, response.json().get("code")) == (status, code), response.text


# ---- accounts -------------------------------------------------------------------------------------------------------------------------------

def test_l01_signup_queues_the_verification_mail_refuses_weak_and_underage_and_is_rate_limited(sw):
    anon = anonymous(sw)
    ok = anon.post("/api/v1/accounts", json=SIGNUP)
    assert (ok.status_code, ok.json()) == (202, {"status": "accepted"})
    assert [r.template for r in outbox(sw.sessions, "account.verify")][-1] == "account.verify"
    queued = len(outbox(sw.sessions, "account.verify"))
    # a breached or too short password, and a missing 18+ declaration, are refused without echoing the value
    for body in ({**SIGNUP, "email": "w1@learners.example", "password": "contortionist"}, {**SIGNUP, "email": "w2@learners.example", "password": "short"},
                 {**SIGNUP, "email": "w3@learners.example", "age_declaration": False}):
        r = anon.post("/api/v1/accounts", json=body)
        assert r.status_code == 422, (body["email"], r.text)
        assert body["password"] not in r.text, "the refusal never echoes the password"
    assert len(outbox(sw.sessions, "account.verify")) == queued, "refused sign-ups queue no mail"
    # a disposable address is allowed for a learner (D-98 blocks it for companies only)
    assert anon.post("/api/v1/accounts", json={**SIGNUP, "email": "tmp@mailinator.com"}).status_code == 202
    # many sign-ups from one address end in 429 with Retry-After
    answers = [anon.post("/api/v1/accounts", json={**SIGNUP, "email": f"burst{n}@learners.example"}) for n in range(40)]
    limited = [r for r in answers if r.status_code == 429]
    assert limited and limited[0].headers["retry-after"].isdigit()


def test_l02_a_verification_link_works_once_expires_and_can_be_sent_again(sw, clock):
    anon = anonymous(sw)
    assert anon.post("/api/v1/accounts", json=SIGNUP).status_code == 202
    token = link_token(outbox(sw.sessions, "account.verify")[-1])
    assert anon.post("/api/v1/accounts/verify-email", json={"token": token}).json() == {"status": "verified"}
    problem(anon.post("/api/v1/accounts/verify-email", json={"token": token}), 400, "AUTH-TOKEN-INVALID")  # single use
    # a second person: the link is dead after 24 hours, a resend gives a new one
    other = {**SIGNUP, "email": "late@learners.example"}
    anon.post("/api/v1/accounts", json=other)
    stale = link_token(outbox(sw.sessions, "account.verify")[-1])
    clock.advance(hours=25)
    problem(anon.post("/api/v1/accounts/verify-email", json={"token": stale}), 400, "AUTH-TOKEN-INVALID")
    assert anon.post("/api/v1/accounts/verify-email/resend", json={"email": other["email"]}).status_code == 202
    fresh = link_token(outbox(sw.sessions, "account.verify")[-1])
    assert fresh != stale and anon.post("/api/v1/accounts/verify-email", json={"token": fresh}).status_code == 200


def test_l03_sign_in_sessions_password_reset_and_second_factor(sw, clock):
    anon = anonymous(sw)
    problem(anon.post("/api/v1/session", json={"email": EVE_EMAIL, "password": "wrong wrong wrong"}), 401, "AUTH-INVALID-CREDENTIALS")
    eve, phone = sw.browser(EVE_EMAIL), sw.browser(EVE_EMAIL)
    sessions_now = eve.get("/api/v1/me/sessions").json()["items"]
    assert len(sessions_now) == 2 and sum(1 for s in sessions_now if s["current"]) == 1
    other = next(s["ref"] for s in sessions_now if not s["current"])
    assert eve.delete(f"/api/v1/me/sessions/{other}").status_code == 204
    assert [s["current"] for s in eve.get("/api/v1/me/sessions").json()["items"]] == [True]
    # password reset: the mailed link sets a new password once and ends every session
    assert anon.post("/api/v1/password-reset/request", json={"email": EVE_EMAIL}).status_code == 202
    token = link_token(outbox(sw.sessions, "account.password_reset")[-1])
    new = "another long passphrase 2026"
    assert anon.post("/api/v1/password-reset/confirm", json={"token": token, "new_password": new}).status_code == 204
    assert anon.post("/api/v1/password-reset/confirm", json={"token": token, "new_password": new + "x"}).status_code in (400, 401)
    assert eve.get("/api/v1/me").status_code == 401, "the reset ended the old session"
    assert anon.post("/api/v1/session", json={"email": EVE_EMAIL, "password": new}).status_code == 200
    # second factor (optional for a learner): enrol, then the next sign-in asks for the code
    login = anon.post("/api/v1/session", json={"email": EVE_EMAIL, "password": new})
    csrf = login.json()["csrf_token"]
    started = anon.post("/api/v1/me/mfa", headers={"x-csrf-token": csrf})
    secret = parse_qs(urlsplit(started.json()["otpauth_uri"]).query)["secret"][0]
    confirmed = anon.post("/api/v1/me/mfa/confirm", json={"code": totp.code_for(secret, totp.time_step(clock.now))}, headers={"x-csrf-token": csrf})
    assert confirmed.status_code == 200 and len(confirmed.json()["recovery_codes"]) >= 8
    again = anonymous(sw).post("/api/v1/session", json={"email": EVE_EMAIL, "password": new}).json()
    assert again["status"] == "mfa_required"
    clock.advance(seconds=30)
    done = anonymous(sw).post("/api/v1/session/mfa", json={"mfa_ticket": again["mfa_ticket"], "code": totp.code_for(secret, totp.time_step(clock.now))})
    assert done.status_code == 200 and "csrf_token" in done.json()


def test_l04_signing_up_with_a_known_address_looks_the_same_and_mails_the_owner(sw):
    anon = anonymous(sw)
    first = anon.post("/api/v1/accounts", json={**SIGNUP, "email": ADA_EMAIL.upper(), "display_name": "Mallory"})
    unknown = anon.post("/api/v1/accounts", json={**SIGNUP, "email": "brand.new@learners.example"})
    assert (first.status_code, first.json(), first.headers["cache-control"]) == (unknown.status_code, unknown.json(), unknown.headers["cache-control"])
    assert outbox(sw.sessions, "account.already_registered") and outbox(sw.sessions, "account.already_registered")[-1].to_user_id
    # Ada's account is untouched: still her name, password still works
    assert sw.browser(ADA_EMAIL).get("/api/v1/me").json()["display_name"] == "ada"


# ---- the practice lab ----------------------------------------------------------------------------------------------------------------------

def test_l05_the_catalogue_lists_eleven_challenges_with_both_owasp_tags_difficulty_and_tier(sw):
    items = sw.browser(EVE_EMAIL).get("/api/v1/challenges").json()["items"]
    assert [i["challenge_key"] for i in items] == ALL_KEYS
    for i in items:
        assert (i["owasp_2021"] or i["owasp_2025"]) and i["difficulty"] and i["tier"] and i["title"]
    assert {i["tier"] for i in items} >= {"Easy", "Medium", "Hard"}
    assert sw.browser(EVE_EMAIL).get("/api/v1/challenges/C99").status_code == 404
    assert anonymous(sw).get("/api/v1/challenges").status_code == 401


def test_l06_start_becomes_ready_the_shop_opens_through_a_ticket_and_a_second_press_is_refused(sw):
    eve = sw.browser(EVE_EMAIL)
    r = eve.post("/api/v1/instances", {"kind": "learner"})
    assert r.status_code == 202 and r.json()["state"] in ("requested", "starting", "ready")
    instance, attempt = r.json()["instance_id"], r.json()["attempt_id"]
    wait_running(sw.lab, attempt)
    view = eve.get(f"/api/v1/instances/{instance}").json()
    assert view["state"] in ("ready", "active") and view["ready_at"]
    ticket = eve.post(f"/api/v1/instances/{instance}/open")
    assert ticket.status_code == 200 and ticket.json()["url"].startswith("https://") and "VM{" not in ticket.text
    problem(eve.post("/api/v1/instances", {"kind": "learner"}), 409, "INST-QUOTA-REACHED")  # a second press while one runs
    assert len(eve.get("/api/v1/me/attempts").json()["items"]) == 1
    assert anonymous(sw).post("/api/v1/instances", json={"kind": "learner"}).status_code in (401, 403)


@pytest.fixture
def seq(sw):
    sw.lab.sequenced = True  # the runtime of the deployed learner mode (VULNMART_LAB_SEQUENCE=1)
    return sw


def test_l07_a_sequenced_run_shows_one_challenge_with_the_tier_countdown_and_begin_starts_it(seq, clock):
    eve = seq.browser(EVE_EMAIL)
    instance, attempt = start_practice(seq, eve)
    body = eve.get(f"/api/v1/attempts/{attempt}/challenges").json()
    assert [i["challenge_key"] for i in body["items"]] == ["C01"] and body["total"] == 11 and body["current_key"] == "C01"
    first = body["items"][0]
    assert (first["state"], first["tier"], first["time_limit_seconds"], first["seconds_left"]) == ("ready", "Easy", 1200, None)
    problem(eve.post(f"/api/v1/attempts/{attempt}/challenges/C02/begin"), 404, "ATT-CHALLENGE-NOT-FOUND")  # not reached
    begun = eve.post(f"/api/v1/attempts/{attempt}/challenges/C01/begin").json()
    assert begun["state"] == "active" and begun["seconds_left"] == 1200
    clock.advance(minutes=5)
    again = eve.post(f"/api/v1/attempts/{attempt}/challenges/C01/begin").json()
    assert again["opened_at"] == begun["opened_at"] and again["seconds_left"] == 900


def test_l09_an_expired_countdown_moves_on_and_keeps_earned_points(seq, clock):
    eve = seq.browser(EVE_EMAIL)
    instance, attempt = start_practice(seq, eve)
    play(seq.lab, instance)
    eve.post(f"/api/v1/attempts/{attempt}/challenges/C01/begin")
    clock.advance(minutes=21)  # the Easy countdown is 20 minutes
    seq.lab.tick()
    items = {i["challenge_key"]: i for i in eve.get(f"/api/v1/attempts/{attempt}/challenges").json()["items"]}
    assert items["C01"]["state"] == "expired" and "C02" in items and items["C02"]["state"] == "ready"
    assert eve.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": seq.lab.keys.flag(instance, "C01", 1)}).status_code in (409, 200)
    assert eve.get(f"/api/v1/attempts/{attempt}/score").json()["score"] == 0


def test_l10_a_learner_flag_is_credited_even_without_shop_traffic_and_nothing_echoes_the_flag(sw):
    # ADR 0071: learner practice never holds a capture (nobody could release it); the activity hold is for company assessments only
    eve = sw.browser(EVE_EMAIL)
    instance, attempt = start_practice(sw, eve)
    flag = sw.lab.keys.flag(instance, "C01", 1)
    credited = eve.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": flag})
    assert credited.status_code == 200 and credited.json() == {"challenge_key": "C01", "result": "correct", "credit": "credited"}
    assert flag not in credited.text
    c01 = next(i for i in eve.get(f"/api/v1/attempts/{attempt}/challenges").json()["items"] if i["challenge_key"] == "C01")
    assert c01["held"] is False and c01["solved"] is True
    assert eve.get(f"/api/v1/attempts/{attempt}/score").json()["score"] > 0

def test_l11_five_wrong_flags_in_ten_minutes_end_in_429_without_a_score_penalty(sw, clock):
    eve = sw.browser(EVE_EMAIL)
    instance, attempt = start_practice(sw, eve)
    play(sw.lab, instance)
    for n in range(5):
        r = eve.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C03", "flag": f"VM{{wrong{n}}}"})
        assert r.json() == {"challenge_key": "C03", "result": "incorrect", "credit": "none"}
    limited = eve.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C03", "flag": sw.lab.keys.flag(instance, "C03", 1)})
    problem(limited, 429, "ATT-FLAG-RATE-LIMITED")
    assert int(limited.headers["retry-after"]) > 0
    assert eve.get(f"/api/v1/attempts/{attempt}/score").json()["score"] == 0
    clock.advance(minutes=11)  # the window passes: the right flag is accepted again
    assert eve.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C03", "flag": sw.lab.keys.flag(instance, "C03", 1)}).json()["result"] == "correct"
    # the other challenges were never limited
    assert eve.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C04", "flag": "VM{nope}"}).status_code == 200


def test_l12_three_hints_in_order_are_free_for_a_learner_and_never_show_a_flag(sw):
    eve = sw.browser(EVE_EMAIL)
    instance, attempt = start_practice(sw, eve)
    flag = sw.lab.keys.flag(instance, "C01", 1)
    listed = eve.get(f"/api/v1/attempts/{attempt}/challenges/C01/hints").json()["items"]
    assert [(h["level"], h["unlocked"], h["cost_pct"], h["text"]) for h in listed] == [(1, False, 0, None), (2, False, 0, None), (3, False, 0, None)]
    for level in (1, 2, 3):
        r = eve.post(f"/api/v1/attempts/{attempt}/challenges/C01/hints/{level}/unlock")
        assert r.status_code == 200 and r.json()["unlocked"] and r.json()["text"] and flag not in r.text
    assert eve.post(f"/api/v1/attempts/{attempt}/challenges/C01/hints/4/unlock").status_code == 404
    assert next(i for i in eve.get(f"/api/v1/attempts/{attempt}/challenges").json()["items"] if i["challenge_key"] == "C01")["hints_used"] == 3
    assert eve.get(f"/api/v1/attempts/{attempt}/score").json()["score"] == 0, "hints cost a learner nothing"


def test_l13_account_points_count_the_best_result_per_challenge_once_out_of_1000(sw):
    ada = sw.browser(ADA_EMAIL)
    before = ada.get("/api/v1/me/progress").json()
    assert before["total_points"] > 0 and before["runs"] == 1, before  # Ada captured C01 in the world
    assert next(r for r in before["per_challenge"] if r["challenge_key"] == "C01")["best_points"] > 0
    # a second run that solves the same challenge again never counts it twice
    ada = sw.browser(ADA_EMAIL)
    assert ada.get("/api/v1/me/progress").json() == before


def test_l14_solving_every_challenge_of_a_sequenced_run_submits_it_frees_the_instance_and_shows_report_and_write_up(seq):
    eve = seq.browser(EVE_EMAIL)
    instance, attempt = start_practice(seq, eve)
    play(seq.lab, instance)
    for key in ALL_KEYS:
        assert eve.post(f"/api/v1/attempts/{attempt}/challenges/{key}/begin").status_code == 200, key
        r = eve.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": key, "flag": seq.lab.keys.flag(instance, key, 1)})
        assert r.json()["result"] == "correct", (key, r.text)
        seq.clock.now = seq.clock.now + timedelta(seconds=10)  # the per-minute flag limit of the template (10) is enforced: a learner does not solve eleven challenges in one minute
    seq.lab.tick()
    assert eve.get(f"/api/v1/attempts/{attempt}").json()["state"] in ("submitted", "reported")
    items = eve.get(f"/api/v1/attempts/{attempt}/challenges").json()["items"]
    assert all(i["solved"] for i in items) and all("write_up" in i for i in items), "a write-up shows after a solve"
    assert eve.get(f"/api/v1/attempts/{attempt}/report").status_code == 200
    assert eve.get(f"/api/v1/attempts/{attempt}/score").json()["score"] == 1000


def test_l16_reset_gives_fresh_flags_keeps_milestones_needs_confirmation_and_a_second_reset_is_refused_while_one_runs(sw):
    eve = sw.browser(EVE_EMAIL)
    instance, attempt = start_practice(sw, eve)
    play(sw.lab, instance)
    old = sw.lab.keys.flag(instance, "C01", 1)
    assert eve.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C01", "flag": old}).json()["credit"] == "credited"
    assert eve.post(f"/api/v1/instances/{instance}/reset", {"confirm": False}).status_code == 422
    r = eve.post(f"/api/v1/instances/{instance}/reset", {"confirm": True})
    assert r.status_code == 202 and r.json()["epoch"] == 2
    again = eve.post(f"/api/v1/instances/{instance}/reset", {"confirm": True})
    assert again.status_code in (202, 409)  # while it resets, a second one is refused or repeats the same reset
    wait_running(sw.lab, attempt)
    play(sw.lab, instance, epoch=2)
    assert next(i for i in eve.get(f"/api/v1/attempts/{attempt}/challenges").json()["items"] if i["challenge_key"] == "C01")["solved"], "milestones are kept"
    stale = eve.post(f"/api/v1/attempts/{attempt}/flags", {"challenge_key": "C02", "flag": sw.lab.keys.flag(instance, "C02", 1)})
    assert stale.json()["result"] == "incorrect", "a flag of the earlier epoch no longer counts"


def test_l17_stop_then_start_again_keeps_the_same_run(sw):
    eve = sw.browser(EVE_EMAIL)
    instance, attempt = start_practice(sw, eve)
    stopped = eve.post(f"/api/v1/instances/{instance}/stop")
    assert stopped.status_code in (200, 202)
    started = eve.post("/api/v1/instances", {"kind": "learner"})
    assert started.status_code == 202, started.text
    assert started.json()["attempt_id"] == attempt, "the same attempt continues"
    assert len(eve.get("/api/v1/me/attempts").json()["items"]) == 1


def test_l18_the_server_keeps_the_clock_and_a_returning_browser_sees_the_time_left(seq, clock):
    eve = seq.browser(EVE_EMAIL)
    instance, attempt = start_practice(seq, eve)
    eve.post(f"/api/v1/attempts/{attempt}/challenges/C01/begin")
    clock.advance(minutes=7)
    back = seq.browser(EVE_EMAIL)  # a new browser after closing the old one
    view = back.get(f"/api/v1/attempts/{attempt}/challenges").json()
    assert view["items"][0]["seconds_left"] == 1200 - 7 * 60 and view["server_time"].endswith("Z")
    assert back.get(f"/api/v1/attempts/{attempt}").json()["server_time"].endswith("Z")


def test_l20_a_failed_start_is_a_clean_error_without_internals_and_the_learner_can_start_again(sw):
    eve = sw.browser(EVE_EMAIL)
    sw.lab.template_id = "shop-fail-v0"  # the fake host fails this template at its health check
    failed = eve.post("/api/v1/instances", {"kind": "learner"})
    assert failed.status_code >= 400 and failed.json()["code"] and "traceback" not in failed.text.lower() and "InstanceNotReady" not in failed.text, failed.text
    sw.lab.template_id = "shop-v0"
    again = eve.post("/api/v1/instances", {"kind": "learner"})
    assert again.status_code == 202, again.text
    wait_running(sw.lab, again.json()["attempt_id"])


def test_l21_a_full_platform_answers_503_no_capacity_not_a_crash(sw):
    host = sw.lab.host
    host.capacity_memory_mb = 1  # nothing fits
    eve = sw.browser(EVE_EMAIL)
    r = eve.post("/api/v1/instances", {"kind": "learner"})
    assert r.status_code == 503 and r.json()["code"] == "INST-NO-CAPACITY", r.text  # IF-2 2.2.0: a full lab is 503, not a misleading 429
    assert "traceback" not in r.text.lower()


def test_l22_one_running_instance_per_learner_across_requests(sw):
    eve = sw.browser(EVE_EMAIL)
    start_practice(sw, eve)
    for _ in range(3):
        problem(eve.post("/api/v1/instances", {"kind": "learner"}), 409, "INST-QUOTA-REACHED")
    assert len(eve.get("/api/v1/me/attempts").json()["items"]) == 1


def test_l23_a_learner_exports_the_data_and_asks_for_deletion_with_a_cancel(sw):
    eve = sw.browser(EVE_EMAIL)
    start_practice(sw, eve)
    exported = eve.post("/api/v1/me/exports")
    assert exported.status_code == 200 and exported.headers["content-type"].startswith("application/zip")
    with zipfile.ZipFile(io.BytesIO(exported.content)) as z:
        names = z.namelist()
        text = "".join(z.read(n).decode("utf-8") for n in names)
    assert any(n.endswith(".json") for n in names) and any(n.endswith(".csv") for n in names) and EVE_EMAIL in text and "VM{" not in text.replace("VM{redacted}", "")
    created = eve.post("/api/v1/me/deletion-requests", {"kind": "learner"})
    assert created.status_code in (200, 201, 202), created.text
    request = created.json()["request_id"]
    assert [r["status"] for r in eve.get("/api/v1/me/deletion-requests").json()["items"]] == ["pending"]
    assert eve.delete(f"/api/v1/me/deletion-requests/{request}").status_code in (200, 204)
    assert eve.get("/api/v1/me/deletion-requests").json()["items"][0]["status"] in ("cancelled", "withdrawn")


def test_l26_a_registration_without_the_age_declaration_is_refused(sw):
    before = len(outbox(sw.sessions, "account.verify"))
    r = anonymous(sw).post("/api/v1/accounts", json={**SIGNUP, "age_declaration": False})
    assert r.status_code == 422
    r = anonymous(sw).post("/api/v1/accounts", json={k: v for k, v in SIGNUP.items() if k != "age_declaration"})
    assert r.status_code == 422 and len(outbox(sw.sessions, "account.verify")) == before
