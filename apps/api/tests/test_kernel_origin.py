"""The origin-secret check (story P-07, decision 1): with a secret configured, a browser route reached without it is 403
AUTH-ORIGIN-FORBIDDEN; probes are never checked; several values are accepted for a rotation."""
from __future__ import annotations

import pytest
from fastapi import WebSocket
from fastapi.testclient import TestClient

from vulnmart.kernel.origin import matches, parse_secrets
from vulnmart.kernel.settings import Settings
from vulnmart.main import create_app

SECRET = "dev-origin-secret-0123456789"
OLD = "old-origin-secret-9876543210"


def client(secret: str | None) -> TestClient:
    return TestClient(create_app({}, settings=Settings(origin_secret=secret)))


@pytest.mark.parametrize("header", [None, "", "wrong-secret-value-000000", SECRET[:-1], SECRET + "x", SECRET.upper()])
def test_without_the_exact_secret_a_browser_route_is_forbidden(header):
    headers = {"X-Request-ID": "abcd-1234-efgh"}
    if header is not None:
        headers["x-origin-secret"] = header
    with client(SECRET) as c:
        r = c.get("/api/v1/health", headers=headers)
    assert r.status_code == 403
    assert r.json() == {
        "type": "urn:vulnmart:error:AUTH-ORIGIN-FORBIDDEN", "title": "The request origin is not allowed.", "status": 403,
        "code": "AUTH-ORIGIN-FORBIDDEN", "request_id": "abcd-1234-efgh",
    }
    assert r.headers["x-request-id"] == "abcd-1234-efgh"
    assert r.headers["cache-control"] == "private, no-store"
    assert SECRET not in r.text


def test_with_the_secret_the_route_answers():
    with client(SECRET) as c:
        r = c.get("/api/v1/health", headers={"x-origin-secret": SECRET})
    assert (r.status_code, r.json()) == (200, {"status": "ok"})


def test_an_unknown_api_route_is_also_forbidden_first_so_nothing_is_learnt_about_routes():
    with client(SECRET) as c:
        assert c.get("/api/v1/no-such-route").status_code == 403
        assert c.get("/api/v1/no-such-route", headers={"x-origin-secret": SECRET}).status_code == 404


@pytest.mark.parametrize("path", ["/healthz", "/readyz", "/version"])
def test_probes_are_never_checked(path):
    with client(SECRET) as c:
        assert c.get(path).status_code == 200


def test_old_and_new_values_are_both_accepted_during_a_rotation():
    with client(f"{SECRET}, {OLD}") as c:
        assert c.get("/api/v1/health", headers={"x-origin-secret": SECRET}).status_code == 200
        assert c.get("/api/v1/health", headers={"x-origin-secret": OLD}).status_code == 200
        assert c.get("/api/v1/health", headers={"x-origin-secret": "neither-of-them-0000000"}).status_code == 403


def test_without_a_configured_secret_the_check_is_off():
    with client(None) as c:
        assert c.get("/api/v1/health").status_code == 200


def test_a_short_secret_is_refused_at_start():
    with pytest.raises(ValueError, match="16 characters"):
        create_app({}, settings=Settings(origin_secret="short"))
    assert parse_secrets(" a-long-enough-secret-1 , ,b-long-enough-secret-2 ") == (b"a-long-enough-secret-1", b"b-long-enough-secret-2")
    assert parse_secrets(None) == () and parse_secrets("") == ()


def test_the_secret_can_come_from_a_file_which_wins_over_the_environment(tmp_path):
    f = tmp_path / "origin_secret"
    f.write_text(f"{SECRET}\n", encoding="utf-8")
    with TestClient(create_app({}, settings=Settings(origin_secret="ignored-env-value-000000", origin_secret_file=str(f)))) as c:
        assert c.get("/api/v1/health", headers={"x-origin-secret": SECRET}).status_code == 200
        assert c.get("/api/v1/health", headers={"x-origin-secret": "ignored-env-value-000000"}).status_code == 403


def test_a_websocket_to_the_api_without_the_secret_is_closed():
    from starlette.testclient import WebSocketDenialResponse
    from starlette.websockets import WebSocketDisconnect

    app = create_app({}, settings=Settings(origin_secret=SECRET))

    @app.websocket("/api/v1/_ws")
    async def ws(socket: WebSocket):  # a route only for this test
        await socket.accept()
        await socket.send_text("hello")
        await socket.close()

    # one client per connection: a refused handshake leaves the test client's session unusable
    with TestClient(app) as c, pytest.raises((WebSocketDisconnect, WebSocketDenialResponse)):
        with c.websocket_connect("/api/v1/_ws") as s:
            s.receive_text()
    with TestClient(app) as c, c.websocket_connect("/api/v1/_ws", headers={"x-origin-secret": SECRET}) as s:
        assert s.receive_text() == "hello"


def test_matches_compares_every_value():
    secrets = (b"first-secret-value-0001", b"second-secret-value-002")
    assert matches(b"second-secret-value-002", secrets)
    assert not matches(b"", secrets)
    assert not matches(b"first-secret-value-000", secrets)


def test_the_secret_is_never_in_a_log_line_or_the_settings_repr():
    import io
    import json
    import logging

    from vulnmart.kernel.observability import configure_logging

    assert SECRET not in repr(Settings(origin_secret=SECRET))
    stream = io.StringIO()
    handler = configure_logging("api", "DEBUG", stream=stream)
    try:
        logging.getLogger("vulnmart.test").info("forwarded with x-origin-secret: %s", SECRET, extra={"x_origin_secret": SECRET})
    finally:
        logging.getLogger().removeHandler(handler)
    text = stream.getvalue()
    assert SECRET not in text and json.loads(text.splitlines()[-1])["x_origin_secret"] == "[REDACTED]"


# ---- M11: staging and production never start with the origin check switched off ----
@pytest.mark.parametrize("env", ["staging", "production"])
def test_a_strict_environment_without_an_origin_secret_fails_at_startup(env, tmp_path):
    with pytest.raises(RuntimeError, match="needs an origin secret"):
        create_app({}, settings=Settings(env=env))
    empty = tmp_path / "origin_secret"
    empty.write_text("\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="needs an origin secret"):  # an empty file is no secret either
        create_app({}, settings=Settings(env=env, origin_secret_file=str(empty)))


@pytest.mark.parametrize("env", ["staging", "production"])
def test_a_strict_environment_with_a_secret_starts_and_checks_it(env):
    # a strict environment also needs the Valkey address for the rate limits (story P-11); the client connects only when first used
    settings = Settings(env=env, origin_secret=SECRET, valkey_url="valkey://valkey.invalid:6379/0", csrf_secret="k" * 32, field_secret="f" * 32)
    with TestClient(create_app({}, settings=settings)) as c:
        assert c.get("/api/v1/health").status_code == 403
        assert c.get("/api/v1/health", headers={"x-origin-secret": SECRET}).status_code == 200


@pytest.mark.parametrize("env", ["dev", "test"])
def test_dev_and_test_keep_the_check_optional(env):
    with TestClient(create_app({}, settings=Settings(env=env))) as c:
        assert c.get("/api/v1/health").status_code == 200


def test_the_default_environment_is_dev_and_the_variable_is_vulnmart_env(monkeypatch):
    monkeypatch.delenv("VULNMART_ENV", raising=False)
    assert Settings().env == "dev"
    monkeypatch.setenv("VULNMART_ENV", "production")
    assert Settings().env == "production"
