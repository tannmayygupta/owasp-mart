"""Health, readiness and version of every entrypoint, the public IF-1 health route and request ids (story P-06).
Checks are injected: no Postgres or Valkey is needed."""
from __future__ import annotations

import asyncio
import importlib
import json
import time

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from support import ROOT
from vulnmart.kernel.service import create_service_app
from vulnmart.kernel.settings import Settings
from vulnmart.main import create_app

SECRET_TEXT = "password=hunter2 host=db.internal.example"
SETTINGS = Settings(version="1.2.3", commit="abc1234")
BUNDLE = json.loads((ROOT / "contracts" / "api" / "bundle" / "openapi.json").read_text(encoding="utf-8"))
SERVICE_HEALTH = Draft202012Validator({**BUNDLE["components"]["schemas"]["ServiceHealth"], "$defs": {}})


async def ok() -> None:
    return None


async def boom() -> None:
    raise RuntimeError(SECRET_TEXT)


async def slow() -> None:
    await asyncio.sleep(30)


def client(checks, timeout=2.0) -> TestClient:
    return TestClient(create_app(checks, timeout=timeout, settings=SETTINGS))


# ---- liveness, readiness, version ----

@pytest.mark.parametrize("checks", [{"postgres": ok, "valkey": ok}, {"postgres": boom, "valkey": boom}])
def test_liveness_answers_whatever_the_stores_do(checks):
    with client(checks) as c:
        r = c.get("/healthz")
    assert (r.status_code, r.json()) == (200, {"status": "ok", "service": "api"})
    assert r.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize(("checks", "status", "body"), [
    ({"postgres": ok, "valkey": ok}, 200, {"status": "ok", "checks": {"postgres": "ok", "valkey": "ok"}}),
    ({"postgres": boom, "valkey": ok}, 503, {"status": "degraded", "checks": {"postgres": "down", "valkey": "ok"}}),
    ({"postgres": ok, "valkey": boom}, 503, {"status": "degraded", "checks": {"postgres": "ok", "valkey": "down"}}),
    ({"postgres": boom, "valkey": boom}, 503, {"status": "degraded", "checks": {"postgres": "down", "valkey": "down"}}),
])
def test_readiness_reports_each_store(checks, status, body):
    with client(checks) as c:
        r = c.get("/readyz")
    assert (r.status_code, r.json()) == (status, body)


def test_a_slow_store_counts_as_down_and_the_request_returns():
    started = time.monotonic()
    with client({"postgres": slow, "valkey": ok}, timeout=0.2) as c:
        r = c.get("/readyz")
    assert r.status_code == 503 and r.json()["checks"]["postgres"] == "down"
    assert time.monotonic() - started < 5


@pytest.mark.parametrize("path", ["/readyz", "/api/v1/health"])
def test_no_error_text_leaks(path):
    with client({"postgres": boom, "valkey": ok}) as c:
        r = c.get(path)
    for leak in ("hunter2", "internal.example", "RuntimeError"):
        assert leak not in r.text


def test_version_names_service_version_and_commit():
    with client({}) as c:
        r = c.get("/version")
    assert r.json() == {"service": "api", "version": "1.2.3", "commit": "abc1234"}


def test_without_configuration_the_real_checks_say_down_not_an_error():
    with TestClient(create_app(settings=Settings(postgres_dsn=None, valkey_url=None))) as c:
        r = c.get("/readyz")
    assert (r.status_code, r.json()) == (503, {"status": "degraded", "checks": {"postgres": "down", "valkey": "down"}})


def test_an_explicit_empty_mapping_means_no_checks():
    with client({}) as c:
        assert c.get("/readyz").json() == {"status": "ok", "checks": {}}


# ---- the public route of IF-1 ----

@pytest.mark.parametrize(("checks", "status", "word"), [({"postgres": ok, "valkey": ok}, 200, "ok"), ({"postgres": ok, "valkey": boom}, 503, "degraded")])
def test_public_health_is_the_if1_service_health_and_names_no_store(checks, status, word):
    with client(checks) as c:
        r = c.get("/api/v1/health")
    assert (r.status_code, r.json()) == (status, {"status": word})
    assert not list(SERVICE_HEALTH.iter_errors(r.json()))
    assert r.headers["cache-control"] == "private, no-store"


def test_public_health_is_get_only_with_an_if8_answer():
    with client({}) as c:
        r = c.post("/api/v1/health")
    assert r.status_code == 405 and r.json()["code"] == "REQ-METHOD-NOT-ALLOWED"


def test_the_operational_routes_are_not_in_any_public_schema():
    app = create_app({}, settings=SETTINGS)
    paths = {getattr(route, "path", "") for route in app.routes if getattr(route, "include_in_schema", False)}
    assert paths == {"/api/v1/health"}


# ---- request ids ----

def test_a_well_formed_request_id_is_echoed_and_used_in_the_error_body():
    with client({}) as c:
        r = c.get("/api/v1/no-such-route", headers={"X-Request-ID": "abcd-1234-efgh"})
    assert r.headers["x-request-id"] == "abcd-1234-efgh"
    assert r.json()["request_id"] == "abcd-1234-efgh"


@pytest.mark.parametrize("supplied", [None, "bad id!", "short", "x" * 65])
def test_a_missing_or_malformed_request_id_is_replaced(supplied):
    headers = {"X-Request-ID": supplied} if supplied else {}
    with client({}) as c:
        r = c.get("/healthz", headers=headers)
        e = c.get("/no-such-route", headers=headers)
    assert r.headers["x-request-id"].startswith("req-") and r.headers["x-request-id"] != supplied
    assert e.json()["request_id"] == e.headers["x-request-id"], "the body and the header carry the same id"


# ---- the other entrypoints ----

@pytest.mark.parametrize("name", ["ingest", "live", "worker", "scheduler"])
def test_every_entrypoint_answers_health_readiness_and_version(name):
    module = importlib.import_module(f"vulnmart.kernel.entrypoints.{name}")
    with TestClient(module.app) as c:
        assert c.get("/healthz").json() == {"status": "ok", "service": name}
        assert c.get("/version").json()["service"] == name
        assert c.get("/readyz").status_code in (200, 503)
        assert c.get("/api/v1/health").status_code == 404, "only the API has browser routes"


def test_a_worker_runs_its_loop_and_stops_cleanly():
    from vulnmart.kernel.service import background_lifespan

    app = create_service_app("worker", checks={}, settings=SETTINGS, lifespan=background_lifespan("worker", interval=0.01))
    with TestClient(app):
        time.sleep(0.05)
        task = app.state.background_task
        assert not task.done()
    assert task.done() and task.exception() is None


def test_ports_are_wired_with_stubs_and_real_scope():
    from vulnmart.kernel.scope import ContextScopePort
    from vulnmart.ports.audit import AuditPort
    from vulnmart.ports.keys import KeyPort
    from vulnmart.ports.outbox import OutboxPort
    from vulnmart.ports.settings import SettingsPort

    ports = create_app({}, settings=Settings(postgres_dsn=None)).state.ports
    assert isinstance(ports.scope, ContextScopePort)
    assert isinstance(ports.settings, SettingsPort) and isinstance(ports.audit, AuditPort)
    assert isinstance(ports.outbox, OutboxPort) and isinstance(ports.keys, KeyPort)
    assert ports.engine is None and ports.sessions is None


# ---- found by the review ----

def test_an_unhandled_error_answers_500_with_the_request_id_in_header_body_and_log():
    import io
    import logging

    from vulnmart.kernel.observability import configure_logging

    stream = io.StringIO()
    handler = configure_logging("api", "INFO", stream=stream)
    try:
        app = create_app({}, settings=SETTINGS)

        @app.get("/_boom")
        async def boom_route() -> dict:
            raise RuntimeError("password=hunter2")

        with TestClient(app, raise_server_exceptions=False) as c:
            r = c.get("/_boom", headers={"X-Request-ID": "abcd-1234-efgh"})
    finally:
        logging.getLogger().removeHandler(handler)
    assert r.status_code == 500 and r.json()["code"] == "REQ-INTERNAL"
    assert r.headers["x-request-id"] == "abcd-1234-efgh" == r.json()["request_id"]
    lines = [json.loads(x) for x in stream.getvalue().splitlines() if x.strip()]
    errors = [x for x in lines if x["logger"] == "vulnmart.problem"]
    assert errors and errors[0]["request_id"] == "abcd-1234-efgh"
    assert "hunter2" not in stream.getvalue() and "hunter2" not in r.text


def test_the_public_health_answer_is_reused_briefly_so_a_burst_costs_one_round_of_checks():
    calls = []

    async def counting() -> None:
        calls.append(1)

    with client({"postgres": counting, "valkey": ok}) as c:
        for _ in range(5):
            assert c.get("/api/v1/health").status_code == 200
        assert len(calls) == 1
        c.get("/readyz")
        assert len(calls) == 2, "readiness (internal) always checks"
