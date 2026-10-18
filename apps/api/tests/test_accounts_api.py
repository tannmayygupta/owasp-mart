"""Story P-11: the account routes over HTTP (createAccount, verifyEmail, resendVerification): contract answers, validation that never echoes a
value, rate limits (429 with Retry-After), the client address rule, and failing closed."""
from __future__ import annotations

import logging
import re
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

import vulnmart.accounts.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from vulnmart.accounts.api import MAX_BODY_BYTES, client_ip
from vulnmart.accounts.models import User
from vulnmart.accounts.service import AccountService
from vulnmart.kernel.db import Base
from vulnmart.kernel.ratelimit import InMemoryRateLimiter, RateDecision, RateLimiterUnavailable
from vulnmart.kernel.settings import Settings
from vulnmart.main import create_app
from vulnmart.notifications.models import EmailOutbox
from vulnmart.ports.fakes import FakeSettingsPort

GOOD = "correct horse battery staple"
SIGNUP = {"email": "ada@example.com", "password": GOOD, "display_name": "Ada", "age_declaration": True}
SECRET = "dev-origin-secret-0123456789"
ORIGIN = "http://127.0.0.1:3000"  # the dashboard origin (Settings.public_origin by default): every state-changing call must come from it
T = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


def make_client(sessions, *, settings=None, limiter=None, overrides=None, service=True, **headers):
    settings = settings or Settings()
    svc = AccountService(sessions, FakeSettingsPort(), public_origin="https://vulnmart.example", now=lambda: T) if service else None
    app = create_app({}, settings=settings, accounts=svc, rate_limiter=limiter or InMemoryRateLimiter())
    app.state.ports.settings = FakeSettingsPort(overrides or {})
    return TestClient(app, headers={"origin": ORIGIN, **headers}, base_url="https://testserver", raise_server_exceptions=False)


def mails(sessions):
    with sessions() as s:
        return [(r.template, dict(r.params)) for r in s.scalars(select(EmailOutbox).order_by(EmailOutbox.id))]


def users(sessions):
    with sessions() as s:
        return s.scalars(select(User)).all()


def token_in(mail_params) -> str:
    return re.search(r"token=([A-Za-z0-9_-]+)", mail_params["link"]).group(1)


# ---- createAccount ---------------------------------------------------------------------------------------------------

def test_signup_answers_202_accepted_and_queues_the_mail(sessions):
    with make_client(sessions) as c:
        r = c.post("/api/v1/accounts", json=SIGNUP)
    assert (r.status_code, r.json()) == (202, {"status": "accepted"})
    assert r.headers["cache-control"] == "private, no-store" and r.headers["x-request-id"]
    assert [t for t, _ in mails(sessions)] == ["account.verify"] and len(users(sessions)) == 1


def test_the_answer_is_the_same_for_a_known_address(sessions):
    with make_client(sessions) as c:
        first = c.post("/api/v1/accounts", json=SIGNUP)
        second = c.post("/api/v1/accounts", json={**SIGNUP, "email": "ADA@example.com", "display_name": "Other"})
    assert (first.status_code, first.json(), first.headers["cache-control"]) == (second.status_code, second.json(), second.headers["cache-control"])
    assert [t for t, _ in mails(sessions)] == ["account.verify", "account.already_registered"] and len(users(sessions)) == 1


@pytest.mark.parametrize("change,pointer", [
    ({"age_declaration": False}, "/age_declaration"),
    ({"age_declaration": "true"}, "/age_declaration"),
    ({"age_declaration": 1}, "/age_declaration"),
    ({"password": "short"}, "/password"),
    ({"password": "x" * 129}, "/password"),
    ({"email": "not-an-address"}, "/email"),
    ({"email": 5}, "/email"),
    ({"display_name": ""}, "/display_name"),
    ({"display_name": "x" * 61}, "/display_name"),
    ({"unexpected": "field"}, "/unexpected"),
    ({"captcha_token": "x" * 2049}, "/captcha_token"),
])
def test_a_body_that_does_not_fit_is_422_and_names_only_where(sessions, change, pointer):
    body = {**SIGNUP, **change}
    with make_client(sessions) as c:
        r = c.post("/api/v1/accounts", json=body)
    assert r.status_code == 422 and r.headers["content-type"].startswith("application/problem+json")
    problem = r.json()
    assert problem["code"] == "REQ-VALIDATION" and {"pointer": pointer, "detail": "This value is not valid."} in problem["errors"]
    assert GOOD not in r.text and "x" * 20 not in r.text, "a submitted value is never echoed"
    assert users(sessions) == []


def test_missing_members_and_bad_json_are_422(sessions):
    with make_client(sessions) as c:
        missing = c.post("/api/v1/accounts", json={"email": "a@example.com"})
        broken = c.post("/api/v1/accounts", content=b"{not json", headers={"content-type": "application/json"})
        listy = c.post("/api/v1/accounts", json=["a"])
    assert missing.status_code == broken.status_code == listy.status_code == 422
    assert {e["pointer"] for e in missing.json()["errors"]} == {"/password", "/display_name", "/age_declaration"}
    assert broken.json()["errors"] == [{"pointer": "", "detail": "The request body is not valid JSON."}]


def test_the_captcha_field_is_accepted_and_ignored(sessions):
    with make_client(sessions) as c:
        assert c.post("/api/v1/accounts", json={**SIGNUP, "captcha_token": "anything"}).status_code == 202


def test_only_json_is_accepted_and_the_body_is_bounded(sessions):
    with make_client(sessions) as c:
        text = c.post("/api/v1/accounts", content=b"x", headers={"content-type": "text/plain"})
        big = c.post("/api/v1/accounts", content=b"{" + b" " * MAX_BODY_BYTES + b"}", headers={"content-type": "application/json"})
        streamed = c.post("/api/v1/accounts", content=(b" " * 4096 for _ in range(5)), headers={"content-type": "application/json"})
    assert (text.status_code, text.json()["code"]) == (415, "REQ-UNSUPPORTED-MEDIA-TYPE")
    assert (big.status_code, big.json()["code"]) == (413, "REQ-TOO-LARGE")
    assert (streamed.status_code, streamed.json()["code"]) == (413, "REQ-TOO-LARGE")


def test_the_password_is_never_logged(sessions, caplog):
    caplog.set_level(logging.DEBUG)
    with make_client(sessions) as c:
        c.post("/api/v1/accounts", json=SIGNUP)
        c.post("/api/v1/accounts", json={**SIGNUP, "password": "wrong shape", "display_name": ""})
    assert GOOD not in caplog.text and "wrong shape" not in caplog.text


@pytest.mark.parametrize("path,body", [
    ("/api/v1/accounts", SIGNUP), ("/api/v1/accounts/verify-email", {"token": "A" * 43}),
    ("/api/v1/accounts/verify-email/resend", {"email": "a@example.com"}),
])
@pytest.mark.parametrize("headers", [
    {"origin": None}, {"origin": "https://evil.example"}, {"origin": "http://127.0.0.1:3001"}, {"origin": "null"},
    {"sec-fetch-site": "cross-site"}, {"sec-fetch-site": "same-site"},
])
def test_a_public_post_from_another_origin_is_forbidden(sessions, path, body, headers):
    with make_client(sessions) as c:
        sent = {k: v for k, v in headers.items() if v is not None}
        r = c.post(path, json=body, headers=sent) if "origin" not in headers or headers["origin"] else c.post(path, json=body, headers={"origin": ""})
    assert (r.status_code, r.json()["code"]) == (403, "AUTH-ORIGIN-FORBIDDEN")
    assert users(sessions) == [] and mails(sessions) == []


def test_the_dashboard_origin_with_a_trailing_slash_or_same_origin_fetch_metadata_is_fine(sessions):
    with make_client(sessions) as c:
        r = c.post("/api/v1/accounts", json=SIGNUP, headers={"origin": ORIGIN + "/", "sec-fetch-site": "same-origin"})
    assert r.status_code == 202


# ---- verifyEmail and resend ------------------------------------------------------------------------------------------

def test_the_link_verifies_once_and_a_second_use_is_400(sessions):
    with make_client(sessions) as c:
        c.post("/api/v1/accounts", json=SIGNUP)
        token = token_in(mails(sessions)[0][1])
        ok = c.post("/api/v1/accounts/verify-email", json={"token": token})
        again = c.post("/api/v1/accounts/verify-email", json={"token": token})
    assert (ok.status_code, ok.json()) == (200, {"status": "verified"}) and ok.headers["cache-control"] == "private, no-store"
    assert again.status_code == 400 and again.json()["code"] == "AUTH-TOKEN-INVALID" and again.json()["title"] == "This link is no longer valid."
    assert users(sessions)[0].email_verified_at is not None


def test_an_unknown_token_and_a_malformed_token_differ_only_as_the_contract_says(sessions):
    with make_client(sessions) as c:
        unknown = c.post("/api/v1/accounts/verify-email", json={"token": "A" * 43})
        malformed = c.post("/api/v1/accounts/verify-email", json={"token": "short"})
    assert (unknown.status_code, unknown.json()["code"]) == (400, "AUTH-TOKEN-INVALID")
    assert (malformed.status_code, malformed.json()["code"]) == (422, "REQ-VALIDATION")


def test_resend_is_202_whatever_the_address_is(sessions):
    with make_client(sessions) as c:
        c.post("/api/v1/accounts", json=SIGNUP)
        first_token = token_in(mails(sessions)[0][1])
        known = c.post("/api/v1/accounts/verify-email/resend", json={"email": "ada@example.com"})
        unknown = c.post("/api/v1/accounts/verify-email/resend", json={"email": "nobody@example.com"})
        old = c.post("/api/v1/accounts/verify-email", json={"token": first_token})
        malformed = c.post("/api/v1/accounts/verify-email/resend", json={"email": "nope"})
    assert (known.status_code, known.json()) == (unknown.status_code, unknown.json()) == (202, {"status": "accepted"})
    assert [t for t, _ in mails(sessions)] == ["account.verify", "account.verify"]
    assert old.status_code == 400, "the first link no longer works"
    assert malformed.status_code == 422


# ---- rate limits -----------------------------------------------------------------------------------------------------

def test_the_third_signup_for_one_address_is_fine_the_fourth_is_429_with_retry_after(sessions):
    with make_client(sessions) as c:
        codes = [c.post("/api/v1/accounts", json=SIGNUP).status_code for _ in range(4)]
        refused = c.post("/api/v1/accounts", json=SIGNUP)
    assert codes == [202, 202, 202, 429]
    assert refused.status_code == 429 and refused.json()["code"] == "REQ-RATE-LIMITED"
    assert refused.headers["content-type"].startswith("application/problem+json") and 1 <= int(refused.headers["retry-after"]) <= 3600
    assert len(mails(sessions)) == 3, "the refused request queued nothing"


def test_the_per_address_limit_does_not_depend_on_the_case_of_the_address(sessions):
    with make_client(sessions) as c:
        codes = [c.post("/api/v1/accounts", json={**SIGNUP, "email": email}).status_code for email in
                 ("ada@example.com", "ADA@example.com", " Ada@Example.com", "aDa@EXAMPLE.com")]
    assert codes == [202, 202, 202, 429]


def test_the_per_ip_limit_applies_across_addresses(sessions):
    with make_client(sessions, overrides={"rate_signup_per_ip_per_hour": 2}) as c:
        codes = [c.post("/api/v1/accounts", json={**SIGNUP, "email": f"user{i}@example.com"}).status_code for i in range(3)]
    assert codes == [202, 202, 429]


def test_the_ip_limit_is_checked_before_the_body_is_read(sessions):
    with make_client(sessions, overrides={"rate_signup_per_ip_per_hour": 1}) as c:
        assert c.post("/api/v1/accounts", json=SIGNUP).status_code == 202
        assert c.post("/api/v1/accounts", content=b"garbage", headers={"content-type": "text/plain"}).status_code == 429


def test_verify_attempts_and_resends_are_limited(sessions):
    with make_client(sessions, overrides={"rate_verify_per_ip_per_hour": 2, "rate_resend_per_email_per_hour": 1}) as c:
        codes = [c.post("/api/v1/accounts/verify-email", json={"token": "A" * 43}).status_code for _ in range(3)]
        resend = [c.post("/api/v1/accounts/verify-email/resend", json={"email": "ada@example.com"}).status_code for _ in range(2)]
    assert codes == [400, 400, 429] and resend == [202, 429]


def test_forwarded_for_counts_only_when_the_origin_secret_protects_the_api(sessions):
    limits = {"rate_signup_per_ip_per_hour": 1}
    with make_client(sessions, overrides=limits) as c:  # no secret: the header is ignored, both requests are one address
        a = c.post("/api/v1/accounts", json={**SIGNUP, "email": "a@example.com"}, headers={"x-forwarded-for": "198.51.100.1"})
        b = c.post("/api/v1/accounts", json={**SIGNUP, "email": "b@example.com"}, headers={"x-forwarded-for": "198.51.100.2"})
    assert (a.status_code, b.status_code) == (202, 429)
    with make_client(sessions, settings=Settings(origin_secret=SECRET), overrides=limits, **{"x-origin-secret": SECRET}) as c:
        a = c.post("/api/v1/accounts", json={**SIGNUP, "email": "c@example.com"}, headers={"x-forwarded-for": "198.51.100.1"})
        b = c.post("/api/v1/accounts", json={**SIGNUP, "email": "d@example.com"}, headers={"x-forwarded-for": "198.51.100.2"})
        c2 = c.post("/api/v1/accounts", json={**SIGNUP, "email": "e@example.com"}, headers={"x-forwarded-for": "198.51.100.1"})
    assert (a.status_code, b.status_code, c2.status_code) == (202, 202, 429)


def request_with(headers=None, host="10.0.0.9") -> Request:
    return Request({"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()], "client": (host, 1234)})


def test_client_address_rules():
    xff = {"x-forwarded-for": "203.0.113.7, 198.51.100.4"}
    assert client_ip(request_with(xff), trust_forwarded=False, hops=1) == "10.0.0.9"
    assert client_ip(request_with(xff), trust_forwarded=True, hops=1) == "198.51.100.4"
    assert client_ip(request_with(xff), trust_forwarded=True, hops=2) == "203.0.113.7"
    assert client_ip(request_with(xff), trust_forwarded=True, hops=3) == "10.0.0.9", "fewer entries than hops: the peer"
    assert client_ip(request_with({"x-forwarded-for": "not-an-ip"}), trust_forwarded=True, hops=1) == "unknown"
    assert client_ip(request_with(xff), trust_forwarded=True, hops=0) == "10.0.0.9"
    one, two = (client_ip(request_with({"x-forwarded-for": f"2001:db8:1:2:{i}::1"}), trust_forwarded=True, hops=1) for i in (1, 9))
    assert one == two == "2001:db8:1:2::/64", "an IPv6 address counts as its /64"


# ---- failing safe ----------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("env", ["staging", "production"])
def test_a_strict_environment_will_not_start_without_valkey_for_the_rate_limits(env):
    with pytest.raises(RuntimeError, match="VULNMART_VALKEY_URL"):
        create_app({}, settings=Settings(env=env, origin_secret=SECRET, csrf_secret="k" * 32, field_secret="f" * 32))


@pytest.mark.parametrize("env", ["staging", "production"])
def test_a_strict_environment_will_not_send_links_over_plain_http(env):
    settings = Settings(env=env, origin_secret=SECRET, valkey_url="valkey://valkey.invalid:6379/0", csrf_secret="k" * 32, field_secret="f" * 32,
                        postgres_dsn="postgresql://app@db.invalid/vulnmart", public_origin="http://vulnmart.example")
    with pytest.raises(RuntimeError, match="https://"):
        create_app({}, settings=settings)
    https = settings.model_copy(update={"public_origin": "https://vulnmart.example"})
    create_app({}, settings=https)  # builds (nothing connects until a request needs the database)


def test_without_a_configured_service_the_routes_answer_an_internal_error(sessions):
    with make_client(sessions, service=False) as c:
        r = c.post("/api/v1/accounts", json=SIGNUP)
    assert (r.status_code, r.json()["code"]) == (500, "REQ-INTERNAL")


def test_when_the_limiter_store_is_down_the_request_is_refused_not_let_through(sessions):
    class Down:
        def hit(self, key, limit, window_seconds):
            raise RateLimiterUnavailable("ConnectionError")

        def peek(self, key, limit):
            raise RateLimiterUnavailable("ConnectionError")

        def reset(self, key):
            raise RateLimiterUnavailable("ConnectionError")

    with make_client(sessions, limiter=Down()) as c:
        r = c.post("/api/v1/accounts", json=SIGNUP)
    assert (r.status_code, r.json()["code"]) == (500, "REQ-INTERNAL") and users(sessions) == []


def test_a_denied_decision_carries_its_wait():
    assert RateDecision(False, 30).retry_after == 30

@pytest.mark.parametrize("env", ["staging", "production"])
def test_a_strict_environment_will_not_start_without_a_field_key_for_the_second_factor(env):
    settings = Settings(env=env, origin_secret=SECRET, csrf_secret="k" * 32, valkey_url="valkey://valkey.invalid:6379/0")
    with pytest.raises(RuntimeError, match="FIELD_SECRET"):
        create_app({}, settings=settings)
    create_app({}, settings=settings.model_copy(update={"field_secret": "f" * 32}))  # starts with one


def test_a_field_key_secret_that_is_too_short_stops_the_start():
    with pytest.raises(ValueError):
        create_app({}, settings=Settings(field_secret="too short"))
