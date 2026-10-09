"""Tests that only make sense over HTTP: authentication and replay, forbidden fields, size, the answer shapes
checked against the OpenAPI schemas, and the signed state reports."""
from __future__ import annotations

import json
import ssl
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from support import (
    CONTRACT_DIR, ORCH_KEY, PLATFORM_KEY, ROOT, WRONG_KEY, ServiceProcess, create_request, material, new_id, raw_call,
    reset_request,
)
from vulnmart.ports.http_instance_host import HttpInstanceHost, NonceCache, utc_timestamp, verify_request
from vulnmart.ports.instance_host import (
    Access, BadSignature, Busy, InstanceNotFound, InstanceState, OrchestratorUnavailable, RateLimited, ValidationFailed,
)

sys.path.insert(0, str(ROOT / "scripts"))
import check_orchestrator_contract as contract  # noqa: E402

import yaml  # noqa: E402

SPEC = yaml.safe_load((CONTRACT_DIR / "orchestrator.openapi.yaml").read_text(encoding="utf-8"))


def conforms(schema: str, data) -> None:
    errors = [f"{contract.error_path(e)} {e.message}" for e in contract.schema_validator(SPEC, schema).iter_errors(data)]
    assert not errors, errors


@pytest.fixture
def svc():
    s = ServiceProcess()
    yield s
    s.stop()


def body_of(req) -> bytes:
    return json.dumps(req.to_json(), separators=(",", ":")).encode()


def problem(status_body: tuple[int, bytes, dict]) -> dict:
    status, body, headers = status_body
    data = json.loads(body)
    assert headers["content-type"].startswith("application/problem+json")
    conforms("Problem", data)
    return data


# ---- authentication ----
def test_a_wrong_key_is_refused_and_nothing_is_created(svc):
    req = create_request()
    res = raw_call(svc.url, "POST", "/v1/instances", body_of(req), key=WRONG_KEY)
    assert res[0] == 401 and problem(res)["code"] == "ORCH-BAD-SIGNATURE"
    with pytest.raises(InstanceNotFound):
        HttpInstanceHost(svc.url, PLATFORM_KEY).get(req.instance_id)


def test_a_body_changed_after_signing_is_refused(svc):
    req = create_request()
    signed_for = body_of(req)
    from vulnmart.ports.http_instance_host import signed_headers
    headers = signed_headers(PLATFORM_KEY, "POST", "/v1/instances", signed_for)
    other = body_of(create_request(req.instance_id, tag="E"))
    res = raw_call(svc.url, "POST", "/v1/instances", other, headers=headers)
    assert res[0] == 401


def test_a_changed_query_string_is_refused(svc):
    from vulnmart.ports.http_instance_host import signed_headers
    headers = signed_headers(PLATFORM_KEY, "GET", "/v1/instances?template=shop-v0", b"")
    res = raw_call(svc.url, "GET", "/v1/instances?template=other-v0", headers=headers)
    assert res[0] == 401


@pytest.mark.parametrize("delta", [timedelta(seconds=-120), timedelta(seconds=120)])
def test_a_stale_or_future_timestamp_is_refused(svc, delta):
    from vulnmart.ports.http_instance_host import signed_headers
    ts = utc_timestamp(datetime.now(UTC) + delta)
    headers = signed_headers(PLATFORM_KEY, "GET", "/v1/host", b"", timestamp=ts)
    res = raw_call(svc.url, "GET", "/v1/host", headers=headers)
    assert res[0] == 401 and problem(res)["code"] == "ORCH-BAD-SIGNATURE"


def test_a_timestamp_inside_the_skew_is_accepted(svc):
    from vulnmart.ports.http_instance_host import signed_headers
    ts = utc_timestamp(datetime.now(UTC) - timedelta(seconds=30))
    res = raw_call(svc.url, "GET", "/v1/host", headers=signed_headers(PLATFORM_KEY, "GET", "/v1/host", b"", timestamp=ts))
    assert res[0] == 200


def test_a_replayed_nonce_is_refused(svc):
    from vulnmart.ports.http_instance_host import signed_headers
    headers = signed_headers(PLATFORM_KEY, "GET", "/v1/host", b"")
    assert raw_call(svc.url, "GET", "/v1/host", headers=headers)[0] == 200
    again = raw_call(svc.url, "GET", "/v1/host", headers=headers)
    assert again[0] == 401 and problem(again)["code"] == "ORCH-BAD-SIGNATURE"


@pytest.mark.parametrize("drop", ["X-VM-Timestamp", "X-VM-Nonce", "X-VM-Signature"])
def test_a_missing_signing_header_is_refused(svc, drop):
    from vulnmart.ports.http_instance_host import signed_headers
    headers = signed_headers(PLATFORM_KEY, "GET", "/v1/host", b"")
    del headers[drop]
    assert raw_call(svc.url, "GET", "/v1/host", headers=headers, sign=False)[0] == 401


def test_an_unsigned_request_is_refused(svc):
    assert raw_call(svc.url, "GET", "/v1/host", sign=False)[0] == 401


def test_the_error_does_not_say_which_check_failed(svc):
    from vulnmart.ports.http_instance_host import signed_headers
    stale = signed_headers(PLATFORM_KEY, "GET", "/v1/host", b"", timestamp=utc_timestamp(datetime.now(UTC) - timedelta(hours=1)))
    wrong = signed_headers(WRONG_KEY, "GET", "/v1/host", b"")
    a = problem(raw_call(svc.url, "GET", "/v1/host", headers=stale))
    b = problem(raw_call(svc.url, "GET", "/v1/host", headers=wrong))
    assert a["message"] == b["message"]


# ---- what the orchestrator accepts (NFR-SEC-04) ----
@pytest.mark.parametrize("name,value", [
    ("image", "registry.invalid/shop:latest"), ("command", ["sh", "-c", "id"]), ("entrypoint", ["/bin/sh"]),
    ("volume", "/:/host"), ("volumes", ["/:/host"]), ("mounts", [{"source": "/"}]), ("port", 22), ("ports", [22]),
    ("network", "host"), ("networks", ["host"]), ("env", {"A": "b"}), ("environment", ["A=b"]),
])
def test_a_forbidden_field_is_refused_and_nothing_is_created(svc, name, value):
    req = create_request()
    body = req.to_json()
    body[name] = value
    res = raw_call(svc.url, "POST", "/v1/instances", json.dumps(body).encode())
    assert res[0] == 422
    p = problem(res)
    assert p["code"] == "ORCH-FIELD-FORBIDDEN" and p["field"] == name
    host = HttpInstanceHost(svc.url, PLATFORM_KEY)
    with pytest.raises(InstanceNotFound):
        host.get(req.instance_id)
    assert host.host_status().instances == 0


def test_a_forbidden_field_is_refused_on_reset_too(svc):
    host = HttpInstanceHost(svc.url, PLATFORM_KEY)
    req = create_request()
    host.create(req)
    deadline = time.monotonic() + 5
    while host.get(req.instance_id).state is not InstanceState.READY and time.monotonic() < deadline:
        time.sleep(0.01)
    body = reset_request(2).to_json()
    body["image"] = "x"
    res = raw_call(svc.url, "POST", f"/v1/instances/{req.instance_id}/reset", json.dumps(body).encode())
    assert res[0] == 422 and problem(res)["code"] == "ORCH-FIELD-FORBIDDEN"
    assert host.get(req.instance_id).epoch == 1


@pytest.mark.parametrize("mutate,field", [
    (lambda b: b.update(surprise=1), "/surprise"),
    (lambda b: b.update(instance_id="i-bad"), "/instance_id"),
    (lambda b: b.pop("seed"), "/seed"),
    (lambda b: b["limits"].update(memory_mb=1), "/limits/memory_mb"),
    (lambda b: b.update(epoch=0), "/epoch"),
])
def test_other_malformed_bodies_are_validation_errors(svc, mutate, field):
    body = create_request().to_json()
    mutate(body)
    res = raw_call(svc.url, "POST", "/v1/instances", json.dumps(body).encode())
    assert res[0] == 422
    p = problem(res)
    assert p["code"] == "ORCH-VALIDATION" and p["field"] == field


def test_a_body_that_is_not_json_is_refused(svc):
    res = raw_call(svc.url, "POST", "/v1/instances", b"{not json")
    assert res[0] == 422 and problem(res)["code"] == "ORCH-VALIDATION"


def test_an_oversize_body_is_refused(svc):
    body = json.dumps({"pad": "x" * (70 * 1024)}).encode()
    res = raw_call(svc.url, "POST", "/v1/instances", body)
    assert res[0] == 413 and problem(res)["code"] == "ORCH-BODY-TOO-LARGE"
    # an oversize body is refused before the signature is looked at (it is never hashed), so also with a wrong key
    res = raw_call(svc.url, "POST", "/v1/instances", body, key=WRONG_KEY)
    assert res[0] == 413
    # the service is still alive afterwards
    assert raw_call(svc.url, "GET", "/v1/host")[0] == 200


def test_a_malformed_instance_id_in_the_path_is_refused(svc):
    res = raw_call(svc.url, "GET", "/v1/instances/not-an-id")
    assert res[0] == 422 and problem(res)["code"] == "ORCH-VALIDATION"


# ---- answers match the OpenAPI schemas and hold no secret ----
def test_answers_match_the_schemas_and_hold_no_secret(svc):
    req = create_request(tag="Q")
    secrets = [f.flag for f in req.material.flags] + [d.value for d in req.material.decoys] + [
        d.sha256 for d in req.material.flag_digests] + [req.material.event_key, req.material.seed]
    status, body, _ = raw_call(svc.url, "POST", "/v1/instances", body_of(req))
    assert status == 202
    conforms("InstanceStatus", json.loads(body))
    answers = [body]
    host = HttpInstanceHost(svc.url, PLATFORM_KEY)
    deadline = time.monotonic() + 5
    while host.get(req.instance_id).state is not InstanceState.READY and time.monotonic() < deadline:
        time.sleep(0.01)
    for method, target in [("GET", f"/v1/instances/{req.instance_id}"), ("GET", "/v1/instances"), ("GET", "/v1/host")]:
        st, b, _ = raw_call(svc.url, method, target)
        assert st == 200
        answers.append(b)
    conforms("InstanceStatus", json.loads(answers[1]))
    conforms("InstancePage", json.loads(answers[2]))
    conforms("HostStatus", json.loads(answers[3]))
    for access_body, target in [({"access": "open", "access_epoch": 1}, "access")]:
        st, b, _ = raw_call(svc.url, "POST", f"/v1/instances/{req.instance_id}/{target}", json.dumps(access_body).encode())
        assert st == 200
        conforms("InstanceStatus", json.loads(b))
        answers.append(b)
    st, b, _ = raw_call(svc.url, "POST", f"/v1/instances/{req.instance_id}/reset", body=json.dumps(reset_request(2, tag="R").to_json()).encode())
    assert st == 202
    answers.append(b)
    st, b, _ = raw_call(svc.url, "POST", f"/v1/instances/{req.instance_id}/destroy")
    assert st == 202
    answers.append(b)
    blob = b"\n".join(answers).decode()
    for s in secrets + [d.sha256 for d in material("R").flag_digests] + [material("R").event_key, material("R").seed]:
        assert s not in blob
    assert "VM{" not in blob


def test_error_answers_match_the_problem_schema(svc):
    for res in [
        raw_call(svc.url, "GET", f"/v1/instances/{new_id()}"),
        raw_call(svc.url, "GET", "/v1/instances?colour=red"),
        raw_call(svc.url, "POST", "/v1/instances", json.dumps({**create_request(template="not-listed").to_json()}).encode()),
    ]:
        assert res[0] in (404, 422)
        problem(res)
    assert problem(raw_call(svc.url, "GET", "/v1/instances?colour=red"))["code"] == "ORCH-LABEL-UNKNOWN"


# ---- the client ----
def test_the_client_reports_an_unreachable_orchestrator():
    host = HttpInstanceHost("http://127.0.0.1:1", PLATFORM_KEY, timeout=2)
    with pytest.raises(OrchestratorUnavailable):
        host.host_status()


def test_the_client_with_the_wrong_key_gets_bad_signature(svc):
    host = HttpInstanceHost(svc.url, WRONG_KEY)
    with pytest.raises(BadSignature):
        host.host_status()


def test_the_client_never_reuses_a_nonce(svc):
    host = HttpInstanceHost(svc.url, PLATFORM_KEY)
    for _ in range(5):
        host.host_status()  # a repeated nonce would be refused by the service


def test_the_python_signer_reproduces_the_fixed_vector():
    vec = json.loads((CONTRACT_DIR / "examples" / "signing-vector.json").read_text(encoding="utf-8"))
    from vulnmart.ports.http_instance_host import sign_request
    assert sign_request(vec["key"].encode(), vec["method"], vec["target"], vec["timestamp"], vec["nonce"], vec["body"].encode()) == vec["signature"]


# ---- state reports ----
class _Receiver:
    """A stand-in for the platform API: checks every state report's signature and keeps the bodies."""

    def __init__(self):
        self.reports: list[dict] = []
        self.refused = 0
        nonces = NonceCache()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                try:
                    verify_request(ORCH_KEY, "POST", self.path, dict(self.headers), body, nonces=nonces)
                except BadSignature:
                    outer.refused += 1
                    self.send_response(401)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                outer.reports.append(json.loads(body))
                self.send_response(204)
                self.end_headers()

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def test_state_reports_are_signed_and_follow_the_state_machine():
    rx = _Receiver()
    svc = ServiceProcess(report_url=rx.url)
    try:
        host = HttpInstanceHost(svc.url, PLATFORM_KEY)
        req = create_request()
        host.create(req)
        _wait(host, req.instance_id, InstanceState.READY)
        host.reset(req.instance_id, reset_request(2))
        _wait(host, req.instance_id, InstanceState.READY)
        host.destroy(req.instance_id)
        _wait(host, req.instance_id, InstanceState.DESTROYED)
        _wait_for(lambda: len(rx.reports) >= 10)
    finally:
        svc.stop()
        rx.stop()
    assert rx.refused == 0
    steps = [(r["from_state"], r["to_state"], r["epoch"]) for r in rx.reports]
    assert steps == [
        (None, "requested", 1), ("requested", "provisioning", 1), ("provisioning", "starting", 1), ("starting", "ready", 1),
        ("ready", "resetting", 2), ("resetting", "provisioning", 2), ("provisioning", "starting", 2), ("starting", "ready", 2),
        ("ready", "stopping", 2), ("stopping", "destroyed", 2),
    ]
    for r in rx.reports:
        conforms("StateReport", r)


def test_a_failed_instance_is_reported_with_its_error_code():
    rx = _Receiver()
    svc = ServiceProcess(report_url=rx.url)
    try:
        host = HttpInstanceHost(svc.url, PLATFORM_KEY)
        req = create_request(template="shop-fail-v0")
        host.create(req)
        _wait(host, req.instance_id, InstanceState.FAILED)
        _wait_for(lambda: len(rx.reports) >= 4)
    finally:
        svc.stop()
        rx.stop()
    last = rx.reports[-1]
    assert last["to_state"] == "failed" and last["error_code"] == "INST-HEALTH-TIMEOUT" and last["health"] == "unhealthy"


class _Stub:
    """A stand-in orchestrator that answers every request the way `behave(handler)` says."""

    def __init__(self, behave):
        class Handler(BaseHTTPRequestHandler):
            def _go(self):
                length = int(self.headers.get("Content-Length", 0))
                if length:
                    self.rfile.read(length)
                behave(self)

            do_GET = do_POST = _go  # noqa: N815

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def _reply(h, status, body=b"", headers=None, content_type="application/json"):
    h.send_response(status)
    h.send_header("Content-Type", content_type)
    h.send_header("Content-Length", str(len(body)))
    for k, v in (headers or {}).items():
        h.send_header(k, v)
    h.end_headers()
    h.wfile.write(body)


def _truncated(h):
    h.send_response(200)
    h.send_header("Content-Type", "application/json")
    h.send_header("Content-Length", "1000")
    h.end_headers()
    h.wfile.write(b'{"host_id": "fa')
    h.wfile.flush()
    h.close_connection = True


GOOD_STATUS = json.dumps({
    "instance_id": "i-AAAAAAAAAAAAAAAA", "template_id": "shop-v0", "epoch": 1, "state": "ready", "access": "closed",
    "access_epoch": 0, "health": "healthy", "error_code": None, "host_id": "fake-host-1",
    "hostname": "x.example.invalid", "created_at": "2026-10-09T12:00:00Z", "updated_at": "2026-10-09T12:00:00Z",
}).encode()
ID = "i-AAAAAAAAAAAAAAAA"


@pytest.mark.parametrize("name,behave,call", [
    ("html", lambda h: _reply(h, 200, b"<html>hi</html>", content_type="text/html"), lambda c: c.host_status()),
    ("empty", lambda h: _reply(h, 200), lambda c: c.get(ID)),
    ("empty-create", lambda h: _reply(h, 200), lambda c: c.create(create_request(ID))),
    ("unlisted-code", lambda h: _reply(h, 500, b'{"code":"ORCH-MYSTERY","message":"x","request_id":"req-00000001"}', content_type="application/problem+json"), lambda c: c.host_status()),
    ("redirect", lambda h: _reply(h, 302, b"", {"Location": "http://127.0.0.1:1/"}), lambda c: c.host_status()),
    ("wrong-success-status", lambda h: _reply(h, 202, GOOD_STATUS), lambda c: c.get(ID)),
    ("not-an-object", lambda h: _reply(h, 200, b"[1,2]"), lambda c: c.host_status()),
    ("truncated", _truncated, lambda c: c.host_status()),
    ("oversize", lambda h: _reply(h, 200, b'{"pad":"' + b"x" * (2 * 1024 * 1024) + b'"}'), lambda c: c.host_status()),
    ("oversize-error", lambda h: _reply(h, 500, b"x" * (2 * 1024 * 1024)), lambda c: c.host_status()),
])
def test_a_bad_answer_is_orchestrator_unavailable(name, behave, call):
    stub = _Stub(behave)
    try:
        with pytest.raises(OrchestratorUnavailable) as err:
            call(HttpInstanceHost(stub.url, PLATFORM_KEY, timeout=5))
        assert err.value.code == "ORCH-UNAVAILABLE"
    finally:
        stub.stop()


def test_busy_and_rate_limited_carry_retry_after():
    for code, cls in [("ORCH-BUSY", Busy), ("ORCH-RATE-LIMITED", RateLimited)]:
        body = json.dumps({"code": code, "message": "slow down", "request_id": "req-00000001"}).encode()
        stub = _Stub(lambda h, body=body: _reply(h, 429, body, {"Retry-After": "7"}, "application/problem+json"))
        try:
            with pytest.raises(cls) as err:
                HttpInstanceHost(stub.url, PLATFORM_KEY).host_status()
            assert err.value.retry_after == 7.0
        finally:
            stub.stop()
    stub = _Stub(lambda h: _reply(h, 429, json.dumps({"code": "ORCH-BUSY", "message": "x", "request_id": "req-00000001"}).encode()))
    try:
        with pytest.raises(Busy) as err:
            HttpInstanceHost(stub.url, PLATFORM_KEY).host_status()
        assert err.value.retry_after is None
    finally:
        stub.stop()


def test_an_instance_id_is_checked_and_quoted_before_it_reaches_the_path():
    seen = []
    stub = _Stub(lambda h: (seen.append(h.path), _reply(h, 200, GOOD_STATUS)))
    try:
        host = HttpInstanceHost(stub.url, PLATFORM_KEY)
        for bad in ["../v1/host", "i-aaaaaaaaaaaaaaaa", "i-AAAAAAAAAAAAAAAA/destroy", "", "i-AAAAAAAAAAAAAAAA?x=1"]:
            with pytest.raises(ValidationFailed) as err:
                host.get(bad)
            assert err.value.field == "/instance_id"
        assert seen == []  # nothing was sent
        host.get(ID)
        assert seen == [f"/v1/instances/{ID}"]
    finally:
        stub.stop()


def test_a_plain_access_string_that_is_not_an_access_value_is_a_validation_error():
    host = HttpInstanceHost("http://127.0.0.1:1", PLATFORM_KEY)
    with pytest.raises(ValidationFailed) as err:
        host.set_access(ID, "ajar", 1)
    assert err.value.field == "/access"


@pytest.mark.parametrize("url,key,ctx", [
    ("https://orchestrator.example.invalid", PLATFORM_KEY, False),  # https without an ssl context
    ("http://orchestrator.example.invalid", PLATFORM_KEY, False),  # plain http, not loopback
    ("http://10.0.0.5:8443", PLATFORM_KEY, False),
    ("ftp://127.0.0.1", PLATFORM_KEY, False),
    ("http://127.0.0.1:1", b"too short", False),  # key under 32 characters
])
def test_the_client_refuses_an_unsafe_setup(url, key, ctx):
    with pytest.raises(ValueError):
        HttpInstanceHost(url, key)


def test_the_client_accepts_https_with_a_context_and_loopback_variants():
    HttpInstanceHost("https://orchestrator.example.invalid", PLATFORM_KEY, ssl_context=ssl.create_default_context())
    for url in ["http://127.0.0.1:1", "http://localhost:1", "http://[::1]:1"]:
        HttpInstanceHost(url, PLATFORM_KEY)


def test_a_step_delay_makes_the_states_observable():
    svc = ServiceProcess(step_delay_ms=60)
    try:
        host = HttpInstanceHost(svc.url, PLATFORM_KEY)
        req = create_request()
        host.create(req)
        seen: list[str] = []
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            s = host.get(req.instance_id).state.value
            if not seen or seen[-1] != s:
                seen.append(s)
            if s == "ready":
                break
            time.sleep(0.005)
        assert seen == ["requested", "provisioning", "starting", "ready"]
    finally:
        svc.stop()


# ---- fake service hardening ----
def test_an_impossible_calendar_timestamp_fails_the_skew_check(svc):
    from vulnmart.ports.http_instance_host import signed_headers
    for ts in ["2026-13-45T99:99:99Z", "0000-00-00T00:00:00Z"]:
        headers = signed_headers(PLATFORM_KEY, "GET", "/v1/host", b"", timestamp=ts)  # correctly signed, still refused
        assert raw_call(svc.url, "GET", "/v1/host", headers=headers, sign=False)[0] == 401


def test_an_unknown_key_is_truncated_when_echoed(svc):
    body = create_request().to_json()
    body["k" * 500] = 1
    res = raw_call(svc.url, "POST", "/v1/instances", json.dumps(body).encode())
    p = problem(res)
    assert res[0] == 422 and p["code"] == "ORCH-VALIDATION"
    assert len(p["field"]) <= 65 and len(p["message"]) < 100


@pytest.mark.parametrize("limit", ["0", "501", "1e2", "0x10", "-1", "5000", "1.5", "", "01", " 5"])
def test_a_bad_limit_is_refused(svc, limit):
    res = raw_call(svc.url, "GET", f"/v1/instances?limit={limit.replace(' ', '%20')}")
    assert res[0] == 422
    p = problem(res)
    assert p["code"] == "ORCH-VALIDATION" and p["field"] == "limit"


def test_the_largest_limit_is_accepted(svc):
    assert raw_call(svc.url, "GET", "/v1/instances?limit=500")[0] == 200


@pytest.mark.parametrize("query,name", [("epoch=1&epoch=2", "epoch"), ("template=shop-v0&template=shop-v0", "template"), ("limit=1&limit=2", "limit")])
def test_a_repeated_query_parameter_is_refused(svc, query, name):
    res = raw_call(svc.url, "GET", f"/v1/instances?{query}")
    p = problem(res)
    assert res[0] == 422 and p["code"] == "ORCH-VALIDATION" and p["field"] == name


@pytest.mark.parametrize("method,target,allow", [
    ("PUT", "/v1/instances", "GET, POST"), ("DELETE", "/v1/instances", "GET, POST"), ("POST", "/v1/host", "GET"),
    ("DELETE", f"/v1/instances/{ID}", "GET"), ("GET", f"/v1/instances/{ID}/reset", "POST"),
    ("GET", f"/v1/instances/{ID}/destroy", "POST"),
])
def test_a_known_path_with_a_wrong_method_is_405(svc, method, target, allow):
    res = raw_call(svc.url, method, target, b"" if method in ("POST", "PUT") else None)
    assert res[0] == 405 and problem(res)["code"] == "ORCH-METHOD-NOT-ALLOWED"
    assert res[2]["allow"] == allow


def test_an_unknown_path_is_still_404(svc):
    res = raw_call(svc.url, "GET", "/v1/nothing")
    assert res[0] == 404 and problem(res)["code"] == "ORCH-ROUTE-UNKNOWN"


@pytest.mark.parametrize("args", [
    ["--port", "abc"], ["--port", "Infinity"], ["--capacity-mb", "NaN"], ["--capacity-mb", ""], ["--step-delay-ms", "-1"],
    ["--step-delay-ms", "1e999"], ["--report-timeout-ms", "x"], ["--nope", "1"], ["--port"],
])
def test_bad_command_line_options_exit_2(args):
    import shutil
    import subprocess
    from support import SERVER
    r = subprocess.run([shutil.which("node"), str(SERVER), *args], capture_output=True, text=True, timeout=20)
    assert r.returncode == 2, r.stdout + r.stderr
    assert r.stdout == ""


def test_activity_that_changes_nothing_makes_no_report():
    rx = _Receiver()
    svc = ServiceProcess(report_url=rx.url)
    try:
        host = HttpInstanceHost(svc.url, PLATFORM_KEY)
        req = create_request()
        host.create(req)
        _wait(host, req.instance_id, InstanceState.READY)
        _wait_for(lambda: len(rx.reports) >= 4)
        for state in ["ready", "ready", "active", "active"]:
            st, _, _ = raw_call(svc.url, "POST", f"/_fake/v1/instances/{req.instance_id}/activity", json.dumps({"state": state}).encode(), sign=False)
            assert st == 200
        _wait_for(lambda: len(rx.reports) >= 5)
        time.sleep(0.3)
    finally:
        svc.stop()
        rx.stop()
    assert [r["to_state"] for r in rx.reports[4:]] == ["active"]
    assert all(r["from_state"] != r["to_state"] for r in rx.reports)


def test_a_refused_state_report_is_written_to_stderr():
    stub = _Stub(lambda h: _reply(h, 500, b"{}"))
    svc = ServiceProcess(report_url=stub.url)
    try:
        HttpInstanceHost(svc.url, PLATFORM_KEY).create(create_request())
        _wait_for(lambda: "state report refused: HTTP 500" in svc.stderr_text())
    finally:
        svc.stop()
        stub.stop()


def test_a_state_report_that_hangs_is_given_up_on():
    def hang(h):
        time.sleep(1.5)
        _reply(h, 204)
    stub = _Stub(hang)
    svc = ServiceProcess(report_url=stub.url, extra_args=("--report-timeout-ms", "200"))
    try:
        host = HttpInstanceHost(svc.url, PLATFORM_KEY)
        req = create_request()
        host.create(req)
        _wait(host, req.instance_id, InstanceState.READY)  # the service itself is not held up by the report
        _wait_for(lambda: "state report failed" in svc.stderr_text())
    finally:
        svc.stop()
        stub.stop()


def test_a_service_that_never_prints_its_port_fails_the_test_instead_of_hanging(tmp_path, monkeypatch):
    import support
    script = tmp_path / "silent.mjs"
    script.write_text("setInterval(() => {}, 1000);\n", encoding="utf-8")
    monkeypatch.setattr(support, "SERVER", script)
    monkeypatch.setattr(support, "START_TIMEOUT_SECONDS", 1)
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="printed no port"):
        support.ServiceProcess()
    assert time.monotonic() - started < 10


def _wait(host, instance_id, state, timeout=10.0):
    _wait_for(lambda: host.get(instance_id).state is state, timeout)


def _wait_for(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        time.sleep(0.01)


def test_access_values_are_the_enum():
    assert {a.value for a in Access} == {"open", "frozen", "closed"}
