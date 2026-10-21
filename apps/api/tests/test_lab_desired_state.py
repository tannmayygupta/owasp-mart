"""Handoff H-123 (IF-5 section 8a): `GET /internal/v1/orch/desired` lists the instances the platform wants, signed with the report key."""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from support import ORCH_KEY
from vulnmart.kernel.service import create_service_app
from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.lab.state_reports import DESIRED_ROUTE, KEY_FILE_VAR, install_state_reports
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.http_instance_host import signed_headers


@pytest.fixture
def lab(tmp_path):
    key_file = tmp_path / "report_key"
    key_file.write_bytes(ORCH_KEY + b"\n")
    if os.name != "nt":
        key_file.chmod(0o600)
    runtime = build_lab_runtime({}, host=FakeInstanceHost())
    app = create_service_app("ingest", configure_logs=False)
    assert install_state_reports(app, runtime, {KEY_FILE_VAR: str(key_file)}) is True
    return TestClient(app, raise_server_exceptions=False), runtime


def get(client, *, key=ORCH_KEY, **kw):
    return client.get(DESIRED_ROUTE, headers=signed_headers(key, "GET", DESIRED_ROUTE, b"", **kw))


def test_nothing_started_means_an_empty_list_which_is_a_valid_answer(lab):
    client, _ = lab
    r = get(client)
    assert r.status_code == 200 and r.json() == {"instance_ids": []} and r.headers["cache-control"] == "private, no-store"


def test_a_running_attempts_instance_is_wanted_and_an_ended_attempts_is_not(lab):
    client, runtime = lab
    a = runtime.start_attempt("u-one")
    b = runtime.start_attempt("u-two")
    assert sorted(get(client).json()["instance_ids"]) == sorted([a.instance_id, b.instance_id])
    runtime.engine.submit(b.attempt_id)
    assert get(client).json()["instance_ids"] == [a.instance_id]


def test_an_instance_whose_start_is_under_way_is_wanted(lab):
    client, runtime = lab
    runtime._starting["a-FAKEATTEMPT"] = "i-ZZZZZZZZZZZZZZZZ"
    assert get(client).json()["instance_ids"] == ["i-ZZZZZZZZZZZZZZZZ"]


def test_a_wrong_key_and_a_replayed_nonce_are_the_same_401(lab):
    client, _ = lab
    assert get(client, key=b"another-key-0123456789abcdef-0123456789").status_code == 401
    headers = signed_headers(ORCH_KEY, "GET", DESIRED_ROUTE, b"")
    assert client.get(DESIRED_ROUTE, headers=headers).status_code == 200
    again = client.get(DESIRED_ROUTE, headers=headers)
    assert again.status_code == 401 and again.json()["code"] == "ORCH-BAD-SIGNATURE"
    assert client.get(DESIRED_ROUTE).status_code == 401  # no signature at all


def test_when_the_attempts_cannot_be_read_the_answer_is_503_so_the_orchestrator_stays_in_safe_mode(lab, monkeypatch):
    client, runtime = lab

    def boom(*states):
        raise RuntimeError("database down")

    monkeypatch.setattr(runtime.engine, "in_states", boom)
    assert get(client).status_code == 503
