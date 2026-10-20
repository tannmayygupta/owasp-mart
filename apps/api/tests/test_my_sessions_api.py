"""Story 3.6: the caller's own sessions over HTTP (FR-ACC-04, IF-1 1.7.0): listMySessions, revokeMySession and logOutEverywhere, with the cookie, CSRF and audit
behaviour the contract describes. The service functions underneath are tested in test_sessions_service.py."""
from __future__ import annotations

from fastapi.testclient import TestClient

from test_session_api import EMAIL, ORIGIN, PASSWORD, add_user, clock, cookie_value, sessions  # noqa: F401 - fixtures
from vulnmart.accounts.http import SESSION_COOKIE
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.settings import Settings
from vulnmart.main import create_app
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort

OTHER_ID, OTHER_EMAIL = "u-BBBBBBBBBBBBBBBB", "bob@example.com"


def make_app(sessions, clock, audit):
    settings = FakeSettingsPort({})
    app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(), accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock),
                     sessions=SessionService(sessions, settings, b"k" * 32, now=clock, audit=audit))
    app.state.ports.settings = settings
    return app


def client(app, agent="Mozilla/5.0") -> TestClient:
    return TestClient(app, headers={"origin": ORIGIN, "user-agent": agent}, base_url="https://testserver", raise_server_exceptions=False)


def log_in(c, email=EMAIL):
    r = c.post("/api/v1/session", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"x-csrf-token": r.json()["csrf_token"]}


def test_the_list_shows_only_my_live_sessions_and_marks_the_current_one(sessions, clock):
    add_user(sessions)
    add_user(sessions, OTHER_ID, OTHER_EMAIL)
    app = make_app(sessions, clock, FakeAuditPort())
    with client(app) as laptop, client(app, "Mozilla/5.0 (iPhone) Mobile") as phone, client(app) as bob:
        log_in(laptop)
        clock.now = clock.now.replace(minute=5)
        log_in(phone)
        log_in(bob, OTHER_EMAIL)
        r = laptop.get("/api/v1/me/sessions")
    assert r.status_code == 200 and r.headers["cache-control"] == "private, no-store"
    items = r.json()["items"]
    assert [(i["ua_class"], i["current"]) for i in items] == [("mobile", False), ("browser", True)], "newest first, mine only"
    assert set(items[0]) == {"ref", "created_at", "last_seen_at", "ip_trunc", "ua_class", "current"}
    assert all(len(i["ref"]) == 16 and int(i["ref"], 16) >= 0 for i in items)


def test_revoking_another_of_my_sessions_ends_it_and_keeps_mine(sessions, clock):
    add_user(sessions)
    audit = FakeAuditPort()
    app = make_app(sessions, clock, audit)
    with client(app) as laptop, client(app) as phone:
        csrf = log_in(laptop)
        log_in(phone)
        ref = next(i["ref"] for i in laptop.get("/api/v1/me/sessions").json()["items"] if not i["current"])
        out = laptop.delete(f"/api/v1/me/sessions/{ref}", headers=csrf)
        again = laptop.delete(f"/api/v1/me/sessions/{ref}", headers=csrf)
        phone_after, laptop_after = phone.get("/api/v1/session"), laptop.get("/api/v1/me/sessions")
    assert (out.status_code, again.status_code) == (204, 204), "ending a session that already ended is the same answer"
    assert "set-cookie" not in out.headers, "the caller's own cookie stays"
    assert (phone_after.status_code, phone_after.json()["code"]) == (401, "AUTH-SESSION-REQUIRED")
    assert [i["current"] for i in laptop_after.json()["items"]] == [True]
    assert [r.action for r in audit.records if r.action.startswith("auth.session")] == ["auth.session_revoked"], "only the real ending is audited"


def test_another_users_ref_ends_nothing(sessions, clock):
    add_user(sessions)
    add_user(sessions, OTHER_ID, OTHER_EMAIL)
    app = make_app(sessions, clock, FakeAuditPort())
    with client(app) as mine, client(app) as bob:
        csrf = log_in(mine)
        log_in(bob, OTHER_EMAIL)
        bobs_ref = bob.get("/api/v1/me/sessions").json()["items"][0]["ref"]
        r = mine.delete(f"/api/v1/me/sessions/{bobs_ref}", headers=csrf)
        bob_after = bob.get("/api/v1/session")
    assert r.status_code == 204 and bob_after.status_code == 200


def test_a_malformed_or_wildcard_ref_is_422_and_ends_nothing(sessions, clock):
    add_user(sessions)
    app = make_app(sessions, clock, FakeAuditPort())
    with client(app) as laptop, client(app) as phone:
        csrf = log_in(laptop)
        log_in(phone)
        answers = [laptop.delete(f"/api/v1/me/sessions/{ref}", headers=csrf) for ref in ("%25" * 16, "_" * 16, "ABCDEF0123456789", "abc")]
        phone_after = phone.get("/api/v1/session")
    assert [r.status_code for r in answers] == [422] * 4
    assert phone_after.status_code == 200


def test_revoking_the_current_session_clears_the_cookie(sessions, clock):
    add_user(sessions)
    app = make_app(sessions, clock, FakeAuditPort())
    with client(app) as c:
        csrf = log_in(c)
        ref = c.get("/api/v1/me/sessions").json()["items"][0]["ref"]
        out = c.delete(f"/api/v1/me/sessions/{ref}", headers=csrf)
        after = c.get("/api/v1/session")
    assert out.status_code == 204 and f"{SESSION_COOKIE}=" in out.headers["set-cookie"] and "max-age=0" in out.headers["set-cookie"].lower()
    assert after.status_code == 401


def test_log_out_everywhere_ends_every_session_clears_the_cookie_and_is_audited(sessions, clock):
    add_user(sessions)
    audit = FakeAuditPort()
    app = make_app(sessions, clock, audit)
    with client(app) as laptop, client(app) as phone:
        login = laptop.post("/api/v1/session", json={"email": EMAIL, "password": PASSWORD})
        stolen = cookie_value(login)
        log_in(phone)
        out = laptop.delete("/api/v1/me/sessions", headers={"x-csrf-token": login.json()["csrf_token"]})
        phone_after = phone.get("/api/v1/session")
        replay = TestClient(app, headers={"origin": ORIGIN, "cookie": f"{SESSION_COOKIE}={stolen}"}, base_url="https://testserver").get("/api/v1/session")
    assert out.status_code == 204 and out.headers["cache-control"] == "private, no-store" and "max-age=0" in out.headers["set-cookie"].lower()
    assert (phone_after.status_code, replay.status_code) == (401, 401)
    entry = next(r for r in audit.records if r.action == "auth.logout_all")
    assert dict(entry.details) == {"sessions": 2}


def test_the_routes_need_a_session_and_the_endings_need_csrf(sessions, clock):
    add_user(sessions)
    app = make_app(sessions, clock, FakeAuditPort())
    with client(app) as anonymous:
        assert anonymous.get("/api/v1/me/sessions").status_code == 401
    with client(app) as c:
        log_in(c)
        ref = c.get("/api/v1/me/sessions").json()["items"][0]["ref"]
        refused = [c.delete("/api/v1/me/sessions"), c.delete(f"/api/v1/me/sessions/{ref}"),
                   c.delete("/api/v1/me/sessions", headers={"x-csrf-token": "A" * 43, "origin": "https://evil.example"})]
        still = c.get("/api/v1/session")
    assert [r.status_code for r in refused] == [403, 403, 403]
    assert still.status_code == 200, "none of the refused calls ended anything"
