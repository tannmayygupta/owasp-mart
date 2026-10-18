"""Story 8.1: the token-guarded demo routes and the entrypoint switch."""
from __future__ import annotations

import importlib
import sys

import pytest
from fastapi.testclient import TestClient

from support import play
from vulnmart.ingest.route import install_event_route
from vulnmart.kernel.service import create_service_app
from vulnmart.lab.demo_routes import PREFIX, install_demo_routes
from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.ports.fake_instance_host import FakeInstanceHost

TOKEN = "demo-token-for-tests-only-0000"
H = {"X-Lab-Demo-Token": TOKEN}


def make(*, mount: bool = True, token: str = TOKEN):
    runtime = build_lab_runtime({}, host=FakeInstanceHost())
    app = create_service_app("ingest", configure_logs=False)
    install_event_route(app, runtime.handler)
    mounted = install_demo_routes(app, runtime, token) if mount else None
    return TestClient(app, raise_server_exceptions=False), runtime, mounted


def test_routes_do_not_exist_when_not_mounted():
    client, _, _ = make(mount=False)
    assert client.post(f"{PREFIX}/attempts", json={"user_id": "u-1"}, headers=H).status_code == 404


def test_an_empty_token_mounts_nothing():
    client, _, mounted = make(token="")
    assert mounted is False
    assert client.post(f"{PREFIX}/attempts", json={"user_id": "u-1"}, headers={"X-Lab-Demo-Token": ""}).status_code == 404


@pytest.mark.parametrize("headers", [{}, {"X-Lab-Demo-Token": "wrong"}, {"X-Lab-Demo-Token": TOKEN + "x"}])
def test_a_missing_or_wrong_token_is_401_with_a_problem_body(headers):
    client, _, _ = make()
    r = client.post(f"{PREFIX}/attempts", json={"user_id": "u-1"}, headers=headers)
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert TOKEN not in r.text


def test_the_whole_loop_over_http():
    client, runtime, _ = make()
    started = client.post(f"{PREFIX}/attempts", json={"user_id": "u-1"}, headers=H)
    assert started.status_code == 200
    body = started.json()
    aid, iid = body["attempt_id"], body["instance_id"]
    assert body["state"] == "running"
    play(runtime, iid)
    flag = runtime.keys.flag(iid, "C01", 1)
    wrong = client.post(f"{PREFIX}/attempts/{aid}/flags", json={"challenge_key": "C01", "text": "VM{AAAAAAAAAAAAAAAAAAAAAAAA}"}, headers=H)
    assert wrong.json() == {"result": "incorrect", "credit": "none"}
    right = client.post(f"{PREFIX}/attempts/{aid}/flags", json={"challenge_key": "C01", "text": flag}, headers=H)
    assert right.json() == {"result": "correct", "credit": "credited"}
    score = client.get(f"{PREFIX}/attempts/{aid}/score", headers=H).json()
    assert score["score"] == 63  # 1000 x 60 / 960 = 62.5, half up
    assert flag not in client.get(f"{PREFIX}/attempts/{aid}/score", headers=H).text  # answers never hold a flag
    assert client.post(f"{PREFIX}/attempts/{aid}/hints", json={"challenge_key": "C02", "level": 1}, headers=H).json() == {"levels_unlocked": 1}
    assert client.post(f"{PREFIX}/advance", json={"seconds": 7200}, headers=H).json() == {"offset_seconds": 7200}
    assert client.post(f"{PREFIX}/advance", json={"seconds": 600}, headers=H).json() == {"offset_seconds": 7800}
    changed = client.post(f"{PREFIX}/tick", headers=H).json()["changed"]
    assert aid in changed
    state = client.get(f"{PREFIX}/attempts/{aid}", headers=H).json()
    assert state["state"] in ("submitted", "reported") and state["access"] == "frozen"


@pytest.mark.parametrize("seconds", [0, -5, 7201, "10", 1.5, None])
def test_the_clock_only_moves_forward_by_a_bounded_whole_number(seconds):
    client, runtime, _ = make()
    r = client.post(f"{PREFIX}/advance", json={"seconds": seconds}, headers=H)
    assert r.status_code == 422
    assert runtime.clock.offset_seconds == 0


@pytest.mark.parametrize("body", [{}, {"user_id": ""}, {"user_id": "u-1", "extra": 1}])
def test_a_bad_start_body_is_422(body):
    client, _, _ = make()
    assert client.post(f"{PREFIX}/attempts", json=body, headers=H).status_code == 422


def test_an_unknown_attempt_is_404_and_a_bad_challenge_is_422_or_404():
    client, _, _ = make()
    assert client.get(f"{PREFIX}/attempts/nope", headers=H).status_code == 404
    aid = client.post(f"{PREFIX}/attempts", json={"user_id": "u-1"}, headers=H).json()["attempt_id"]
    r = client.post(f"{PREFIX}/attempts/{aid}/flags", json={"challenge_key": "C99", "text": "x"}, headers=H)
    assert r.status_code == 404 and r.json()["code"] == "ATT-CHALLENGE-NOT-FOUND"


def test_the_sixth_wrong_paste_is_rate_limited_with_retry_after():
    client, _, _ = make()
    aid = client.post(f"{PREFIX}/attempts", json={"user_id": "u-1"}, headers=H).json()["attempt_id"]
    for _ in range(5):
        client.post(f"{PREFIX}/attempts/{aid}/flags", json={"challenge_key": "C01", "text": "nope"}, headers=H)
    r = client.post(f"{PREFIX}/attempts/{aid}/flags", json={"challenge_key": "C01", "text": "nope"}, headers=H)
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0


# ---- the entrypoint switch ----

def _load_entrypoint(monkeypatch, **env):
    for name in ("VULNMART_LAB_RUNTIME", "VULNMART_LAB_DEMO", "VULNMART_LAB_DEMO_TOKEN", "VULNMART_ORCH_URL"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    sys.modules.pop("vulnmart.kernel.entrypoints.ingest", None)
    return importlib.import_module("vulnmart.kernel.entrypoints.ingest").app


def test_with_the_variables_unset_the_entrypoint_is_as_before(monkeypatch):
    app = _load_entrypoint(monkeypatch)
    assert not hasattr(app.state, "lab") and not hasattr(app.state, "ingest_handler")
    assert TestClient(app).post(f"{PREFIX}/attempts", json={"user_id": "u"}, headers=H).status_code == 404


def test_runtime_on_demo_off_serves_events_but_no_demo_routes(monkeypatch):
    app = _load_entrypoint(monkeypatch, VULNMART_LAB_RUNTIME="1")
    assert app.state.lab is not None and app.state.ingest_handler is app.state.lab.handler
    assert TestClient(app).post(f"{PREFIX}/attempts", json={"user_id": "u"}, headers=H).status_code == 404


def test_runtime_and_demo_on_with_a_token_mounts_the_routes(monkeypatch):
    app = _load_entrypoint(monkeypatch, VULNMART_LAB_RUNTIME="1", VULNMART_LAB_DEMO="1", VULNMART_LAB_DEMO_TOKEN=TOKEN)
    client = TestClient(app)
    assert client.post(f"{PREFIX}/attempts", json={"user_id": "u"}).status_code == 401
    assert client.post(f"{PREFIX}/attempts", json={"user_id": "u"}, headers=H).status_code == 200


def test_demo_on_without_a_token_mounts_nothing(monkeypatch):
    app = _load_entrypoint(monkeypatch, VULNMART_LAB_RUNTIME="1", VULNMART_LAB_DEMO="1")
    assert TestClient(app).post(f"{PREFIX}/attempts", json={"user_id": "u"}, headers=H).status_code == 404
