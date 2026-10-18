"""Story edge-7 (H-347 point 1, H-16, decision F-3): `POST /internal/v1/orch/state` in the lab runtime.

Checks, row by row: the route is absent without the key file; signature (every failure is the same 401 problem body); the 64 KiB limit;
media type; strict body; new / repeat / mismatch; an impossible transition (204, history, state not moved, one warning); order and
lower-numbered reports; the recorded state shown to the lab runtime and the demo route; the real orchestrator pusher against the receiver."""
from __future__ import annotations

import json
import logging
import os
import stat
import sys
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from support import ORCH_KEY, ORCH_SRC
from vulnmart.ingest.route import install_event_route
from vulnmart.kernel.service import create_service_app
from vulnmart.lab.demo_routes import PREFIX, install_demo_routes
from vulnmart.lab.runtime import build_lab_runtime
from vulnmart.lab.state_reports import (
    KEY_FILE_VAR, MAX_BODY_BYTES, ROUTE, TRANSITIONS, install_state_reports, read_report_key,
)
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.http_instance_host import signed_headers
from vulnmart.ports.instance_host import InstanceState

S = InstanceState
IID = "i-AAAAAAAAAAAAAAAA"
JSON_H = {"Content-Type": "application/json"}
DEMO = "demo-token-for-tests-only-0000"


def body(epoch=1, transition=1, frm=None, to="requested", iid=IID, reason="create accepted", **over) -> bytes:
    doc = {"instance_id": iid, "epoch": epoch, "transition": transition, "from_state": frm, "to_state": to,
           "at": "2026-10-17T12:00:00Z", "reason": reason, "error_code": None, "health": "unknown", **over}
    return json.dumps(doc, separators=(",", ":")).encode()


def post(client, raw: bytes, *, key: bytes = ORCH_KEY, headers=None, ctype=JSON_H, **sign_kw):
    hdrs = {**signed_headers(key, "POST", ROUTE, raw, **sign_kw), **(ctype or {}), **(headers or {})}
    return client.post(ROUTE, content=raw, headers=hdrs)


@pytest.fixture
def key_file(tmp_path):
    p = tmp_path / "report_key"
    p.write_bytes(ORCH_KEY + b"\n")
    if os.name != "nt":
        p.chmod(0o600)
    return p


@pytest.fixture
def lab(key_file):
    runtime = build_lab_runtime({}, host=FakeInstanceHost())
    app = create_service_app("ingest", configure_logs=False)
    install_event_route(app, runtime.handler)
    mounted = install_state_reports(app, runtime, {KEY_FILE_VAR: str(key_file)})
    assert mounted is True
    install_demo_routes(app, runtime, DEMO)
    return TestClient(app, raise_server_exceptions=False), runtime


@pytest.fixture
def client(lab):
    return lab[0]


# ---- mounting ----
def test_without_the_key_file_the_route_is_absent():
    runtime = build_lab_runtime({}, host=FakeInstanceHost())
    app = create_service_app("ingest", configure_logs=False)
    assert install_state_reports(app, runtime, {}) is False
    assert install_state_reports(app, runtime, {KEY_FILE_VAR: ""}) is False
    r = post(TestClient(app, raise_server_exceptions=False), body())
    assert r.status_code == 404 and r.json()["code"] == "REQ-ROUTE-UNKNOWN"


def test_the_entrypoint_mounts_it_only_with_runtime_on_and_the_key_file_set(monkeypatch, key_file):
    import importlib

    def load(env: dict[str, str]):
        for name in ("VULNMART_LAB_RUNTIME", "VULNMART_LAB_DEMO", KEY_FILE_VAR):
            monkeypatch.delenv(name, raising=False)
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        sys.modules.pop("vulnmart.kernel.entrypoints.ingest", None)
        return importlib.import_module("vulnmart.kernel.entrypoints.ingest").app

    paths = lambda app: {r.path for r in app.routes}  # noqa: E731
    try:
        assert ROUTE not in paths(load({}))
        assert ROUTE not in paths(load({KEY_FILE_VAR: str(key_file)}))  # runtime off: the key file alone mounts nothing
        assert ROUTE not in paths(load({"VULNMART_LAB_RUNTIME": "1"}))  # runtime on, no key file
        assert ROUTE in paths(load({"VULNMART_LAB_RUNTIME": "1", KEY_FILE_VAR: str(key_file)}))
    finally:
        sys.modules.pop("vulnmart.kernel.entrypoints.ingest", None)


@pytest.mark.skipif(os.name == "nt", reason="Windows has no mode bits; the orchestrator skips this check there too")
def test_a_key_file_readable_by_others_is_refused(key_file):
    key_file.chmod(0o644)
    with pytest.raises(ValueError, match="0600"):
        read_report_key(str(key_file))
    key_file.chmod(stat.S_IRUSR)
    assert read_report_key(str(key_file)) == ORCH_KEY


def test_a_short_key_is_refused(tmp_path):
    p = tmp_path / "k"
    p.write_text("short", encoding="utf-8")
    if os.name != "nt":
        p.chmod(0o600)
    with pytest.raises(ValueError, match="at least 32"):
        read_report_key(str(p))


# ---- signature: one answer for every failure ----
def _bad_signature_cases():
    raw = body()
    good = signed_headers(ORCH_KEY, "POST", ROUTE, raw)
    old = (datetime.now(UTC) - timedelta(seconds=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "wrong key": dict(key=b"WRONG-KEY-NOT-REAL-0000000000000000000"),
        "no headers": dict(ctype=JSON_H, headers=None, _strip=True),
        "malformed signature": dict(headers={"X-VM-Signature": "v1=zz"}),
        "signature of another body": dict(headers={"X-VM-Signature": signed_headers(ORCH_KEY, "POST", ROUTE, b"{}")["X-VM-Signature"]}),
        "stale timestamp": dict(timestamp=old),
        "future timestamp": dict(timestamp=(datetime.now(UTC) + timedelta(seconds=120)).strftime("%Y-%m-%dT%H:%M:%SZ")),
        "bad nonce shape": dict(nonce="ABC"),
        "wrong method in the signing string": dict(headers={"X-VM-Signature": signed_headers(ORCH_KEY, "GET", ROUTE, raw, timestamp=good["X-VM-Timestamp"], nonce=good["X-VM-Nonce"])["X-VM-Signature"],
                                                            "X-VM-Timestamp": good["X-VM-Timestamp"], "X-VM-Nonce": good["X-VM-Nonce"]}),
    }


@pytest.mark.parametrize("case", list(_bad_signature_cases()))
def test_every_signature_failure_is_the_same_401_problem(client, case, lab):
    spec = dict(_bad_signature_cases()[case])
    raw = body()
    if spec.pop("_strip", False):
        r = client.post(ROUTE, content=raw, headers=JSON_H)
    else:
        r = post(client, raw, **spec)
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    problem = r.json()
    assert problem["code"] == "ORCH-BAD-SIGNATURE" and problem["status"] == 401
    assert set(problem) == {"type", "title", "status", "code", "request_id"}  # no hint which check failed, no detail
    assert lab[1].instance_states == {}  # nothing changed


def test_all_signature_failures_look_alike(client):
    answers = set()
    for case, spec in _bad_signature_cases().items():
        spec = dict(spec)
        raw = body()
        r = client.post(ROUTE, content=raw, headers=JSON_H) if spec.pop("_strip", False) else post(client, raw, **spec)
        p = r.json()
        answers.add((r.status_code, p["code"], p["title"], p["type"]))
    assert len(answers) == 1


def test_a_replayed_nonce_is_refused_even_with_a_valid_signature(client):
    raw = body()
    nonce = "0123456789abcdef0123456789abcdef"
    assert post(client, raw, nonce=nonce).status_code == 204
    again = post(client, raw, nonce=nonce)  # same nonce: a replay, whatever the body
    assert again.status_code == 401 and again.json()["code"] == "ORCH-BAD-SIGNATURE"


def test_a_fresh_nonce_for_the_same_report_is_a_repeat_not_a_replay(client):
    raw = body()
    assert post(client, raw).status_code == 204
    assert post(client, raw).status_code == 200


def test_the_signature_covers_the_target_with_a_query_string(client):
    raw = body()
    headers = {**signed_headers(ORCH_KEY, "POST", ROUTE, raw), **JSON_H}
    assert client.post(ROUTE + "?x=1", content=raw, headers=headers).status_code == 401  # signed for another target


# ---- size, media type, shape ----
def test_a_body_over_64_kib_is_413_before_anything_else(client):
    r = client.post(ROUTE, content=b"x" * (MAX_BODY_BYTES + 1), headers=JSON_H)  # unsigned on purpose: size comes first
    assert r.status_code == 413 and r.json()["code"] == "ORCH-BODY-TOO-LARGE"
    ok = post(client, body(reason="r" * 1000))
    assert ok.status_code == 204


def test_a_chunked_body_over_the_limit_is_413_too(client):
    def chunks():
        for _ in range(3):
            yield b"x" * (MAX_BODY_BYTES // 2 + 1)

    r = client.post(ROUTE, content=chunks(), headers=JSON_H)
    assert r.status_code == 413


def test_a_signed_body_that_is_not_json_content_type_is_415(client):
    r = post(client, body(), ctype={"Content-Type": "text/plain"})
    assert r.status_code == 415 and r.json()["code"] == "ORCH-UNSUPPORTED-MEDIA-TYPE"
    assert post(client, body(transition=1), ctype={"Content-Type": "application/json; charset=utf-8"}).status_code == 204


@pytest.mark.parametrize("raw", [
    b"not json",
    b"[]",
    body(transition=0),
    body(transition="1"),
    json.dumps({"instance_id": IID}).encode(),
    body(extra="x"),
    b'{"instance_id":"i-AAAAAAAAAAAAAAAA","epoch":1,"transition":1.0,"from_state":null,"to_state":"requested","at":"x","reason":"r","error_code":null,"health":"unknown"}',
    body(to="exploded"),
    body(health="great"),
])
def test_a_malformed_body_is_422_and_stores_nothing(client, lab, raw):
    r = post(client, raw)
    assert r.status_code == 422 and r.json()["code"] == "ORCH-VALIDATION"
    assert lab[1].instance_states == {} and lab[1].state_reports.history(IID) == []


# ---- identity: new, repeat, mismatch ----
def test_new_is_204_identical_repeat_is_200_another_body_is_409(client, lab):
    raw = body()
    assert post(client, raw).status_code == 204
    assert post(client, raw).status_code == 200
    other = post(client, body(reason="a different reason"))
    assert other.status_code == 409 and other.json()["code"] == "ORCH-REQUEST-MISMATCH"
    assert len(lab[1].state_reports.history(IID)) == 1
    assert lab[1].instance_states == {IID: "requested"}


def test_a_repeat_does_not_change_the_recorded_state(client, lab):
    assert post(client, body()).status_code == 204
    assert post(client, body(transition=2, frm="requested", to="provisioning")).status_code == 204
    assert post(client, body()).status_code == 200  # the old report again, after a newer one
    assert lab[1].instance_states == {IID: "provisioning"}


# ---- the state machine ----
def test_an_ordered_lifecycle_is_recorded_in_order(client, lab):
    steps = [(None, "requested"), ("requested", "provisioning"), ("provisioning", "starting"), ("starting", "ready"),
             ("ready", "stopping"), ("stopping", "destroyed")]
    for n, (frm, to) in enumerate(steps, start=1):
        assert post(client, body(transition=n, frm=frm, to=to)).status_code == 204
        assert lab[1].instance_states == {IID: to}
    assert [(r.transition, r.to_state.value) for r in lab[1].state_reports.history(IID)] == [(n, to) for n, (_, to) in enumerate(steps, start=1)]


def test_an_impossible_transition_is_204_history_only_and_logs_a_warning(client, lab, caplog):
    assert post(client, body()).status_code == 204
    with caplog.at_level(logging.WARNING, logger="vulnmart.lab.state_reports"):
        r = post(client, body(transition=2, frm="requested", to="destroyed"))  # not in the table
    assert r.status_code == 204
    assert lab[1].instance_states == {IID: "requested"}  # not moved
    assert [x.transition for x in lab[1].state_reports.history(IID)] == [1, 2]  # stored as history
    warnings = [m for m in caplog.messages if "impossible state transition" in m]
    assert len(warnings) == 1 and IID in warnings[0] and "create accepted" not in warnings[0]
    # a repeat of the impossible report is 200 and logs nothing more
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="vulnmart.lab.state_reports"):
        assert post(client, body(transition=2, frm="requested", to="destroyed")).status_code == 200
    assert not [m for m in caplog.messages if "impossible" in m]
    # the next valid report still moves the state
    assert post(client, body(transition=3, frm="requested", to="provisioning")).status_code == 204
    assert lab[1].instance_states == {IID: "provisioning"}


def test_a_first_report_that_is_not_requested_is_impossible_too(client, lab):
    assert post(client, body(frm=None, to="ready")).status_code == 204
    assert lab[1].instance_states == {}


def test_a_late_lower_numbered_report_is_history_and_the_state_does_not_move_back(client, lab):
    assert post(client, body(transition=3, frm="provisioning", to="starting")).status_code == 204
    assert lab[1].instance_states == {IID: "starting"}
    assert post(client, body(transition=2, frm="requested", to="provisioning")).status_code == 204
    assert lab[1].instance_states == {IID: "starting"}
    assert [x.transition for x in lab[1].state_reports.history(IID)] == [2, 3]


def test_a_new_epoch_restarts_the_numbers(client, lab):
    for n, (frm, to) in enumerate([(None, "requested"), ("requested", "provisioning"), ("provisioning", "starting"), ("starting", "ready")], 1):
        assert post(client, body(transition=n, frm=frm, to=to)).status_code == 204
    assert post(client, body(epoch=2, transition=1, frm="ready", to="resetting")).status_code == 204
    assert lab[1].instance_states == {IID: "resetting"}
    assert post(client, body(epoch=2, transition=2, frm="resetting", to="provisioning")).status_code == 204
    assert lab[1].instance_states == {IID: "provisioning"}


def test_two_instances_are_kept_apart(client, lab):
    other = "i-BBBBBBBBBBBBBBBB"
    assert post(client, body()).status_code == 204
    assert post(client, body(iid=other, transition=1, to="requested")).status_code == 204
    assert post(client, body(iid=other, transition=2, frm="requested", to="provisioning")).status_code == 204
    assert lab[1].instance_states == {IID: "requested", other: "provisioning"}


# ---- no secret anywhere ----
def test_no_key_or_signature_reaches_an_answer_or_the_log(client, caplog):
    with caplog.at_level(logging.DEBUG):
        r1 = post(client, body(), key=b"WRONG-KEY-NOT-REAL-0000000000000000000")
        raw = body(reason="SECRET-REASON-TEXT")
        r2 = post(client, raw)
        r3 = post(client, body(reason="another SECRET-REASON-TEXT"))
        r4 = post(client, body(transition=2, frm="requested", to="destroyed", reason="SECRET-REASON-TEXT"))
    seen = "\n".join(caplog.messages) + r1.text + r2.text + r3.text + r4.text
    assert ORCH_KEY.decode() not in seen and "SECRET-REASON-TEXT" not in seen and "v1=" not in seen


# ---- the demo route shows it ----
def test_the_demo_route_shows_the_recorded_state_and_history(client, lab):
    h = {"X-Lab-Demo-Token": DEMO}
    assert client.get(f"{PREFIX}/instances/{IID}", headers=h).status_code == 404
    post(client, body())
    post(client, body(transition=2, frm="requested", to="provisioning"))
    r = client.get(f"{PREFIX}/instances/{IID}", headers=h)
    assert r.status_code == 200
    assert r.json() == {"instance_id": IID, "state": "provisioning", "transitions": [
        {"epoch": 1, "transition": 1, "from_state": None, "to_state": "requested"},
        {"epoch": 1, "transition": 2, "from_state": "requested", "to_state": "provisioning"}]}
    assert client.get(f"{PREFIX}/instances/{IID}").status_code == 401  # the token guard applies


# ---- conformance with the real orchestrator ----
def _orch():
    if str(ORCH_SRC) not in sys.path:
        sys.path.insert(0, str(ORCH_SRC))
    from vulnmart_orchestrator import reports, states

    return reports, states


def test_the_state_table_equals_the_orchestrators_table():
    _, states = _orch()
    mine = {(a.value if a else None, b.value) for a, b in TRANSITIONS}
    theirs = {(a.value if a else None, b.value) for a, b in states.TRANSITIONS}
    assert mine == theirs
    assert {s.value for s in InstanceState} == {s.value for s in states.InstanceState}


def test_the_real_pusher_is_accepted_over_http_and_repeats_are_200(client, lab):
    """The orchestrator's own ReportPusher (its signing, its body, its retry rules) against the receiver, through the ASGI app."""
    reports, states = _orch()
    seen: list[int] = []

    def post_via_app(url, raw, headers, timeout):
        target = url[url.index("/internal"):]
        r = client.post(target, content=raw, headers=headers)
        seen.append(r.status_code)
        return r.status_code

    pusher = reports.ReportPusher("http://127.0.0.1:1", ORCH_KEY, post=post_via_app, log=lambda line: None)
    pusher.start()
    try:
        T = states.Transition
        S_ = states.InstanceState
        chain = [(None, S_.REQUESTED), (S_.REQUESTED, S_.PROVISIONING), (S_.PROVISIONING, S_.STARTING), (S_.STARTING, S_.READY),
                 (S_.READY, S_.STOPPING), (S_.STOPPING, S_.DESTROYED)]
        for n, (frm, to) in enumerate(chain, start=1):
            pusher.submit(T(IID, 1, n, frm, to, "2026-10-17T12:00:00Z", "r", None, "unknown"))
        assert pusher.flush(10)
    finally:
        pusher.stop()
    assert seen == [204] * 6
    assert lab[1].instance_states == {IID: "destroyed"}
    # the same reports again (at least once delivery after a restart of the receiver's peer): every answer is 200
    pusher2 = reports.ReportPusher("http://127.0.0.1:1", ORCH_KEY, post=post_via_app, log=lambda line: None)
    pusher2.start()
    try:
        for n, (frm, to) in enumerate(chain, start=1):
            pusher2.submit(T(IID, 1, n, frm, to, "2026-10-17T12:00:00Z", "r", None, "unknown"))
        assert pusher2.flush(10)
    finally:
        pusher2.stop()
    assert seen[6:] == [200] * 6
    assert [r.transition for r in lab[1].state_reports.history(IID)] == [1, 2, 3, 4, 5, 6]


def test_a_destroyed_instance_is_never_resurrected_by_a_later_report(client, lab):
    # review finding A7: `ready` to `active` is a legal pair, but not after the instance is gone
    steps = [(None, "requested"), ("requested", "provisioning"), ("provisioning", "starting"), ("starting", "ready"),
             ("ready", "stopping"), ("stopping", "destroyed")]
    for n, (frm, to) in enumerate(steps, start=1):
        assert post(client, body(transition=n, frm=frm, to=to)).status_code == 204
    assert post(client, body(transition=9, frm="ready", to="active")).status_code == 204  # valid IF-5, stored as history
    assert lab[1].instance_states == {IID: "destroyed"}
    assert [x.transition for x in lab[1].state_reports.history(IID)][-1] == 9
