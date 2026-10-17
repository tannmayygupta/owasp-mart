"""Story P-14, the signed-in user's own account (FR-ACC-09): getMe, updateMe and changePassword, with the CSRF and Origin checks, the failed-guess
throttle on the current password, the new session value and the other sessions that end."""
from __future__ import annotations

import re

import pytest
from sqlalchemy import select

from test_password_reset import (  # noqa: F401 - fixtures and helpers shared with the reset tests
    COMMON, EMAIL, NEW, OLD, ORIGIN, Clock, add_user, client, clock, log_in, make_app, sessions, stored_hash,
)
from vulnmart.accounts import security
from vulnmart.accounts.http import SESSION_COOKIE
from vulnmart.accounts.models import User, UserSession

URL = "/api/v1/me/password"


def cookie_value(response) -> str:
    return re.search(rf"{SESSION_COOKIE}=([^;]+)", response.headers["set-cookie"]).group(1)


def sign_in(c):
    login = log_in(c)
    assert login.status_code == 200
    return login.json()["csrf_token"]


# ---- getMe -----------------------------------------------------------------------------------------------------------

def test_get_me_returns_the_user_and_needs_a_session(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        assert c.get("/api/v1/me").json()["code"] == "AUTH-SESSION-REQUIRED"
        login = log_in(c)
        me = c.get("/api/v1/me")
    assert me.status_code == 200 and me.json() == login.json()["user"] and me.headers["cache-control"] == "private, no-store"
    assert set(me.json()) == {"user_id", "email", "display_name", "account_type", "email_verified", "mfa_enabled", "created_at"}


# ---- updateMe --------------------------------------------------------------------------------------------------------

def test_update_me_changes_the_display_name_and_shows_it_everywhere(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        csrf = sign_in(c)
        r = c.patch("/api/v1/me", json={"display_name": "  Ada   King \t Lovelace "}, headers={"x-csrf-token": csrf})
        again = c.get("/api/v1/me")
        session = c.get("/api/v1/session")
    assert r.status_code == 200 and r.json()["display_name"] == "Ada King Lovelace" and r.json()["email"] == EMAIL
    assert again.json()["display_name"] == session.json()["user"]["display_name"] == "Ada King Lovelace"


def test_update_me_needs_the_csrf_token_and_the_dashboard_origin(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        csrf = sign_in(c)
        no_token = c.patch("/api/v1/me", json={"display_name": "Mallory"})
        other_site = c.patch("/api/v1/me", json={"display_name": "Mallory"}, headers={"x-csrf-token": csrf, "origin": "https://evil.example"})
        anonymous = client(c.app).patch("/api/v1/me", json={"display_name": "Mallory"})
    assert (no_token.status_code, no_token.json()["code"]) == (403, "AUTH-CSRF-FAILED")
    assert (other_site.status_code, other_site.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN")
    assert (anonymous.status_code, anonymous.json()["code"]) == (401, "AUTH-SESSION-REQUIRED"), "no session at all is 401, whatever the headers"
    with sessions() as s:
        assert s.scalar(select(User.display_name)) == "Ada Learner"


@pytest.mark.parametrize("body", [{}, {"display_name": ""}, {"display_name": "   "}, {"display_name": "x" * 61}, {"display_name": None},
                                  {"email": "other@example.com"}, {"display_name": "Ada", "account_type": "admin"}, {"display_name": 5}])
def test_update_me_refuses_anything_else_than_a_good_display_name(sessions, clock, body):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        csrf = sign_in(c)
        r = c.patch("/api/v1/me", json=body, headers={"x-csrf-token": csrf})
    assert r.status_code == 422
    with sessions() as s:
        user = s.scalar(select(User))
        assert (user.display_name, user.email, user.account_type) == ("Ada Learner", EMAIL, "participant")


# ---- changePassword --------------------------------------------------------------------------------------------------

def test_a_password_change_gives_a_new_session_value_and_ends_every_other_session(sessions, clock):
    add_user(sessions)
    app = make_app(sessions, clock)
    with client(app) as c, client(app) as other:
        sign_in(other)
        csrf = sign_in(c)
        old_cookie = c.cookies.get(SESSION_COOKIE)
        r = c.post(URL, json={"current_password": OLD, "new_password": NEW}, headers={"x-csrf-token": csrf})
        new_cookie = cookie_value(r)
        stolen = client(app)
        stolen.cookies.set(SESSION_COOKIE, old_cookie)
        replay = stolen.get("/api/v1/session")
        elsewhere = other.get("/api/v1/session")
        here = c.get("/api/v1/session")
        old_login = log_in(c, OLD)
        new_login = log_in(c, NEW)
    assert r.status_code == 204 and r.content == b"" and r.headers["cache-control"] == "private, no-store"
    assert new_cookie != old_cookie and "samesite=lax" in r.headers["set-cookie"].lower() and "secure" in r.headers["set-cookie"].lower()
    assert replay.status_code == 401, "the old value of this very session stopped working"
    assert elsewhere.status_code == 401, "every other session ended"
    assert here.status_code == 200, "this browser stays signed in with the new value"
    assert here.json()["csrf_token"] != csrf, "the CSRF token belongs to the new session value"
    assert old_login.status_code == 401 and new_login.status_code == 200
    assert security.verify_password(stored_hash(sessions), NEW)


def test_a_wrong_current_password_is_401_the_session_stays_and_nothing_changes(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        csrf = sign_in(c)
        r = c.post(URL, json={"current_password": "not the password at all", "new_password": NEW}, headers={"x-csrf-token": csrf})
        still = c.get("/api/v1/session")
    assert (r.status_code, r.json()["code"]) == (401, "AUTH-INVALID-CREDENTIALS") and "set-cookie" not in r.headers
    assert still.status_code == 200 and security.verify_password(stored_hash(sessions), OLD)


def test_guessing_the_current_password_from_a_session_is_throttled_and_a_right_one_clears_the_count(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        csrf = sign_in(c)
        headers = {"x-csrf-token": csrf}
        wrong = [c.post(URL, json={"current_password": f"wrong guess number {i}", "new_password": NEW}, headers=headers).status_code for i in range(10)]
        blocked = c.post(URL, json={"current_password": OLD, "new_password": NEW}, headers=headers)
    assert wrong == [401] * 10
    assert (blocked.status_code, blocked.json()["code"]) == (429, "REQ-RATE-LIMITED") and int(blocked.headers["retry-after"]) >= 1
    assert security.verify_password(stored_hash(sessions), OLD), "not even the right password gets through while the account waits"
    clock.advance(minutes=16)
    with client(make_app(sessions, clock)) as c2:
        csrf = sign_in(c2)
        assert c2.post(URL, json={"current_password": OLD, "new_password": NEW}, headers={"x-csrf-token": csrf}).status_code == 204


@pytest.mark.parametrize("bad,pointer,detail", [
    (COMMON, "/new_password", "This password is too easy to guess. Choose another one."),
    ("ada.learner forever", "/new_password", "The password must not contain your email address or your name."),
    (OLD, "/new_password", "The new password must be different from the current one."),
])
def test_a_new_password_that_breaks_a_rule_is_422_with_a_fixed_sentence_and_nothing_changes(sessions, clock, bad, pointer, detail):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        csrf = sign_in(c)
        r = c.post(URL, json={"current_password": OLD, "new_password": bad}, headers={"x-csrf-token": csrf})
        still = c.get("/api/v1/session")
    assert r.status_code == 422 and r.json()["errors"] == [{"pointer": pointer, "detail": detail}]
    assert bad not in r.text and still.status_code == 200 and security.verify_password(stored_hash(sessions), OLD)


def test_change_password_needs_csrf_origin_and_valid_bodies(sessions, clock):
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        csrf = sign_in(c)
        body = {"current_password": OLD, "new_password": NEW}
        no_token = c.post(URL, json=body)
        other_site = c.post(URL, json=body, headers={"x-csrf-token": csrf, "origin": "https://evil.example"})
        short = c.post(URL, json={**body, "new_password": "short"}, headers={"x-csrf-token": csrf})
        missing = c.post(URL, json={"new_password": NEW}, headers={"x-csrf-token": csrf})
        extra = c.post(URL, json={**body, "email": "x@example.com"}, headers={"x-csrf-token": csrf})
    assert (no_token.status_code, no_token.json()["code"]) == (403, "AUTH-CSRF-FAILED")
    assert (other_site.status_code, other_site.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN")
    assert short.status_code == missing.status_code == extra.status_code == 422
    assert security.verify_password(stored_hash(sessions), OLD)


def test_neither_password_is_ever_logged_or_echoed(sessions, clock, caplog):
    import logging

    caplog.set_level(logging.DEBUG)
    add_user(sessions)
    with client(make_app(sessions, clock)) as c:
        csrf = sign_in(c)
        r = c.post(URL, json={"current_password": OLD, "new_password": COMMON}, headers={"x-csrf-token": csrf})
        c.post(URL, json={"current_password": OLD, "new_password": NEW}, headers={"x-csrf-token": csrf})
    for secret in (OLD, NEW, COMMON):
        assert secret not in caplog.text and secret not in r.text


def test_the_session_survives_in_the_database_as_one_live_row_after_a_change(sessions, clock):
    add_user(sessions)
    app = make_app(sessions, clock)
    with client(app) as c, client(app) as other:
        sign_in(other)
        csrf = sign_in(c)
        c.post(URL, json={"current_password": OLD, "new_password": NEW}, headers={"x-csrf-token": csrf})
    with sessions() as s:
        live = [row for row in s.scalars(select(UserSession)) if row.revoked_at is None]
    assert len(live) == 1, "only the new session of the browser that changed the password is alive"
