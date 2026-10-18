"""Story edge-3: `GatePort`, the HTTP client of the gate admin API, against a small real HTTP server in the test, and the three new options of
the command line. The key is read from a file on every call, never logged, never in an error text; a push is one call with a 3 s timeout."""
from __future__ import annotations

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from support import IID, OWNER

from vulnmart_orchestrator.gate import GateError, GatePort, NullGate, check_gate_url
from vulnmart_orchestrator.service import build_parser

SECRET = "FAKE-GATE-ADMIN-KEY-NOT-REAL-" + "0" * 16
RECORD = {"hostname": f"{IID.lower()}.instances.example.invalid", "instance_id": IID, "epoch": 1, "owner": OWNER, "access": "closed", "access_epoch": 0}


class Server:
    def __init__(self, status: int = 204, delay: float = 0.0) -> None:
        self.requests: list[dict] = []
        self.status, self.delay = status, delay
        outer = self

        class H(BaseHTTPRequestHandler):
            def _do(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                outer.requests.append({"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": self.rfile.read(length)})
                time.sleep(outer.delay)
                try:
                    self.send_response(outer.status)
                    self.send_header("content-length", "0")
                    self.end_headers()
                except OSError:
                    pass

            do_PUT = do_DELETE = _do

            def log_message(self, *a) -> None:
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def key_file(tmp_path):
    f = tmp_path / "gate.key"
    f.write_text(SECRET + "\n", encoding="utf-8")
    return str(f)


@pytest.fixture
def server():
    s = Server()
    yield s
    s.close()


def test_put_delete_and_sync_use_the_admin_paths_the_header_and_exactly_the_story_1_fields(server, key_file):
    gate = GatePort(server.url, key_file)
    gate.put(RECORD)
    gate.delete(IID)
    gate.sync([RECORD])
    put, delete, sync = server.requests
    assert (put["method"], put["path"]) == ("PUT", f"/internal/v1/gate/instances/{IID}")
    assert json.loads(put["body"]) == RECORD and list(json.loads(put["body"])) == ["hostname", "instance_id", "epoch", "owner", "access", "access_epoch"]
    assert put["headers"]["x-vm-gate-admin"] == SECRET and put["headers"]["content-type"] == "application/json"
    assert (delete["method"], delete["path"], delete["body"]) == ("DELETE", f"/internal/v1/gate/instances/{IID}", b"")
    assert (sync["method"], sync["path"]) == ("PUT", "/internal/v1/gate/sync") and json.loads(sync["body"]) == {"instances": [RECORD]}


def test_a_record_with_a_wrong_field_set_is_refused_before_anything_is_sent(server, key_file):
    gate = GatePort(server.url, key_file)
    with pytest.raises(GateError):
        gate.put({**RECORD, "extra": 1})
    with pytest.raises(GateError):
        gate.put({k: v for k, v in RECORD.items() if k != "owner"})
    assert server.requests == []


@pytest.mark.parametrize("status", [400, 401, 404, 409, 413, 422, 500, 200])
def test_every_answer_but_204_is_a_failure_and_a_409_is_not_taken_as_success(key_file, status):
    s = Server(status)
    try:
        with pytest.raises(GateError) as e:
            GatePort(s.url, key_file).put(RECORD)
        assert f"HTTP {status}" in str(e.value) and SECRET not in str(e.value)
        assert len(s.requests) == 1  # no retry inside the call
    finally:
        s.close()


def test_a_gate_that_is_down_fails_and_the_error_holds_no_secret(key_file):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()  # nothing listens there
    with pytest.raises(GateError) as e:
        GatePort(f"http://127.0.0.1:{port}", key_file).put(RECORD)
    assert SECRET not in str(e.value) and "not reachable" in str(e.value)


def test_a_slow_gate_is_cut_at_the_timeout_and_the_call_is_not_repeated(key_file):
    s = Server(delay=1.5)
    try:
        start = time.monotonic()
        with pytest.raises(GateError):
            GatePort(s.url, key_file, timeout_s=0.3).put(RECORD)
        assert time.monotonic() - start < 1.2 and len(s.requests) == 1
    finally:
        s.close()
    assert GatePort.__init__.__kwdefaults__["timeout_s"] == 3.0  # the default is the plan's 3 s


def test_a_rotated_key_file_takes_effect_on_the_next_call_and_an_unreadable_one_fails_the_call(server, key_file, tmp_path):
    gate = GatePort(server.url, key_file)
    new = "ROTATED-GATE-ADMIN-KEY-NOT-REAL-" + "1" * 16
    (tmp_path / "gate.key").write_text(new, encoding="utf-8")
    gate.put(RECORD)
    assert server.requests[-1]["headers"]["x-vm-gate-admin"] == new
    (tmp_path / "gate.key").write_text("short", encoding="utf-8")
    with pytest.raises(GateError) as e:
        gate.put(RECORD)
    assert "short" not in str(e.value)
    assert len(server.requests) == 1  # the call that could not read its key sent nothing


def test_a_missing_or_short_key_file_is_refused_at_start(tmp_path, server):
    with pytest.raises(OSError):
        GatePort(server.url, str(tmp_path / "none"))
    f = tmp_path / "short.key"
    f.write_text("tooshort", encoding="utf-8")
    with pytest.raises(ValueError):
        GatePort(server.url, str(f))


@pytest.mark.parametrize("url", ["https://edge.example/", "http://127.0.0.1:9090", "http://localhost:9090", "http://[::1]:9090", "http://edge-gate-admin:9090"])
def test_urls_that_are_allowed(url):
    check_gate_url(url)


@pytest.mark.parametrize("url", ["http://gate.example.com", "http://10.0.0.5:9090", "ftp://x", "edge-gate-admin:9090", "http://", ""])
def test_urls_that_are_refused(url):
    with pytest.raises(ValueError):
        check_gate_url(url)


def test_a_redirect_is_not_followed(key_file):
    s = Server(307)
    try:
        with pytest.raises(GateError):
            GatePort(s.url, key_file).put(RECORD)
        assert len(s.requests) == 1
    finally:
        s.close()


def test_the_null_gate_does_nothing_and_is_not_enabled():
    g = NullGate()
    assert g.enabled is False and g.put(RECORD) is None and g.delete(IID) is None and g.sync([RECORD]) is None


def test_the_three_options_exist_and_are_off_by_default():
    a = build_parser().parse_args(["--templates-dir", "t", "--template-schema", "s"])
    assert (a.edge_container, a.gate_url, a.gate_admin_key_file) == (None, None, None)
    a = build_parser().parse_args(["--templates-dir", "t", "--template-schema", "s", "--edge-container", "e", "--gate-url", "http://g:1", "--gate-admin-key-file", "k"])
    assert (a.edge_container, a.gate_url, a.gate_admin_key_file) == ("e", "http://g:1", "k")
