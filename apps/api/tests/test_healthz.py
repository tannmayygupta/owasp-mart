"""I/O matrix of story 1.1 for GET /healthz, with injected checks (no Postgres or Valkey needed)."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from vulnmart.main import create_app

SECRET_TEXT = "password=hunter2 host=db.internal.example"


async def ok() -> None:
    return None


async def boom() -> None:
    raise RuntimeError(SECRET_TEXT)


async def slow() -> None:
    await asyncio.sleep(30)


def get(checks, timeout=2.0):
    with TestClient(create_app(checks, timeout=timeout)) as client:
        return client.get("/healthz")


def test_healthy():
    r = get({"postgres": ok, "valkey": ok})
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "postgres": "ok", "valkey": "ok"}


def test_postgres_down():
    r = get({"postgres": boom, "valkey": ok})
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "postgres": "down", "valkey": "ok"}


def test_valkey_down():
    r = get({"postgres": ok, "valkey": boom})
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "postgres": "ok", "valkey": "down"}


def test_both_down():
    r = get({"postgres": boom, "valkey": boom})
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "postgres": "down", "valkey": "down"}


def test_slow_dependency_counts_as_down_and_request_returns():
    loop = asyncio.new_event_loop()
    try:
        started = loop.time()
        r = get({"postgres": slow, "valkey": ok}, timeout=0.2)
        elapsed = loop.time() - started
    finally:
        loop.close()
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "postgres": "down", "valkey": "ok"}
    assert elapsed < 5


def test_empty_checks_mapping_is_respected_not_replaced_by_real_checks(monkeypatch):
    # An explicit empty mapping means "no checks"; it must not fall back to the real Postgres and Valkey.
    monkeypatch.delenv("VULNMART_POSTGRES_DSN", raising=False)
    monkeypatch.delenv("VULNMART_VALKEY_URL", raising=False)
    r = get({})
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_default_timeout_is_two_seconds():
    from vulnmart.main import CHECK_TIMEOUT_SECONDS

    assert CHECK_TIMEOUT_SECONDS == 2.0


@pytest.mark.parametrize("failing", ["postgres", "valkey"])
def test_no_error_text_leaks(failing):
    checks = {"postgres": ok, "valkey": ok, failing: boom}
    r = get(checks)
    assert "hunter2" not in r.text
    assert "internal.example" not in r.text
    assert "RuntimeError" not in r.text
    assert set(r.json()) == {"status", "postgres", "valkey"}
    assert set(r.json().values()) <= {"ok", "down", "degraded"}


def test_real_checks_without_configuration_are_down_not_errors(monkeypatch):
    # No DSN or URL set: the real checks raise inside the app and must still give a clean 503.
    monkeypatch.delenv("VULNMART_POSTGRES_DSN", raising=False)
    monkeypatch.delenv("VULNMART_VALKEY_URL", raising=False)
    with TestClient(create_app()) as client:
        r = client.get("/healthz")
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "postgres": "down", "valkey": "down"}
