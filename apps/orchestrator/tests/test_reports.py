"""State reports (D5): ordered per instance, signed with the orchestrator key, retried until the platform says 204 or 200."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from vulnmart_orchestrator.auth import NonceMemory, Verifier, body_sha256
from vulnmart_orchestrator.reports import TARGET, ReportPusher, check_report_url, report_body
from vulnmart_orchestrator.states import InstanceState, Transition

S = InstanceState
KEY = b"FAKE-ORCHESTRATOR-KEY-NOT-REAL-0000000"
A, B = "i-AAAAAAAAAAAAAAAA", "i-BBBBBBBBBBBBBBBB"


def t(instance, n, to=S.PROVISIONING, frm=S.REQUESTED, reason="r", code=None, health="unknown"):
    return Transition(instance, 1, n, frm, to, "2026-10-12T12:00:00Z", reason, code, health)


class Platform:
    """A stand-in platform: records every attempt, answers with `answer(instance, transition, attempt)`."""

    def __init__(self, answer=lambda i, n, attempt: 204):
        self.answer, self.attempts, self.lock = answer, [], threading.Lock()
        self.verifier = Verifier(KEY)

    def post(self, url, body, headers, timeout):
        data = json.loads(body)
        assert url.endswith(TARGET)
        lower = {k.lower(): v for k, v in headers.items()}
        ok = self.verifier.verify("POST", TARGET, lower, body_sha256(body))
        with self.lock:
            attempt = sum(1 for a in self.attempts if a[:2] == (data["instance_id"], data["transition"])) + 1
            self.attempts.append((data["instance_id"], data["transition"], ok))
        return self.answer(data["instance_id"], data["transition"], attempt)

    def delivered(self, instance):
        return [n for i, n, _ in self.attempts if i == instance]


def pusher(platform, **kw):
    log = kw.pop("log_lines", [])
    p = ReportPusher("http://127.0.0.1:1", KEY, post=platform.post, log=log.append, **kw)
    p.start()
    return p, log


def test_reports_are_sent_in_order_signed_and_each_attempt_has_a_fresh_nonce():
    platform = Platform()
    p, _ = pusher(platform)
    try:
        for n in range(1, 6):
            p.submit(t(A, n))
        assert p.flush(5)
    finally:
        p.stop()
    assert platform.delivered(A) == [1, 2, 3, 4, 5]
    assert all(ok for _, _, ok in platform.attempts)  # every signature verified, and no nonce was used twice (the verifier refuses a replay)


def test_a_report_that_is_not_accepted_is_tried_again_before_the_next_one_of_the_same_instance():
    platform = Platform(lambda i, n, attempt: 500 if (n == 1 and attempt < 3) else 204)
    p, log = pusher(platform)
    try:
        p.submit(t(A, 1))
        p.submit(t(A, 2))
        assert p.flush(10)
    finally:
        p.stop()
    assert platform.delivered(A) == [1, 1, 1, 2]
    assert log.count("state report refused: HTTP 500") == 2


@pytest.mark.parametrize("status,done", [(204, True), (200, True), (409, False), (422, False), (401, False), (302, False)])
def test_only_204_and_200_mean_delivered(status, done):
    platform = Platform(lambda i, n, attempt: status if attempt == 1 else 204)
    p, _ = pusher(platform)
    try:
        p.submit(t(A, 1))
        assert p.flush(5)
    finally:
        p.stop()
    assert platform.delivered(A) == ([1] if done else [1, 1])


def test_a_network_error_is_tried_again_and_logged_by_class_name_only():
    state = {"n": 0}

    def post(url, body, headers, timeout):
        state["n"] += 1
        if state["n"] < 2:
            raise ConnectionRefusedError("secret-looking text http://user:pw@host")
        return 204

    log = []
    p = ReportPusher("http://127.0.0.1:1", KEY, post=post, log=log.append)
    p.start()
    try:
        p.submit(t(A, 1))
        assert p.flush(5)
    finally:
        p.stop()
    assert log == ["state report failed: ConnectionRefusedError"]


def test_a_stuck_instance_does_not_hold_up_another_one():
    platform = Platform(lambda i, n, attempt: 500 if i == A else 204)
    p, _ = pusher(platform)
    try:
        p.submit(t(A, 1))
        p.submit(t(B, 1))
        p.submit(t(B, 2))
        deadline = time.monotonic() + 5
        while platform.delivered(B) != [1, 2] and time.monotonic() < deadline:
            time.sleep(0.01)
        assert platform.delivered(B) == [1, 2]
        assert p.pending() == 1  # A is still waiting for the platform
    finally:
        p.stop()


def test_the_queue_is_bounded_and_drops_the_oldest_report_with_a_line():
    gate = threading.Event()
    seen = []

    def post(url, body, headers, timeout):
        gate.wait(5)
        seen.append(json.loads(body)["transition"])
        return 204

    log = []
    p = ReportPusher("http://127.0.0.1:1", KEY, post=post, log=log.append, max_pending=3)
    p.start()
    try:
        p.submit(t(A, 1))  # goes on the wire and waits for the gate
        time.sleep(0.1)
        for n in range(2, 8):
            p.submit(t(B, n))
        assert p.pending() <= 3
        gate.set()
        assert p.flush(5)
    finally:
        gate.set()
        p.stop()
    assert "state report queue is full: the oldest report was dropped" in log
    assert seen[0] == 1 and seen[-1] == 7  # the newest report always survives


def test_the_wire_form_is_the_state_report_schema_and_holds_what_the_transition_holds():
    body = json.loads(report_body(t(A, 3, to=S.FAILED, frm=S.STARTING, reason="x", code="INST-HEALTH-TIMEOUT", health="unhealthy")))
    assert body == {"instance_id": A, "epoch": 1, "transition": 3, "from_state": "starting", "to_state": "failed",
                    "at": "2026-10-12T12:00:00Z", "reason": "x", "error_code": "INST-HEALTH-TIMEOUT", "health": "unhealthy"}
    assert json.loads(report_body(t(A, 1, frm=None, to=S.REQUESTED)))["from_state"] is None


@pytest.mark.parametrize("url,ok", [
    ("https://platform.example.invalid", True), ("http://127.0.0.1:8000", True), ("http://localhost:8000", True), ("http://[::1]:8000", True),
    ("http://platform.example.invalid", False), ("http://10.0.0.5", False), ("ftp://127.0.0.1", False), ("http://127.0.0.1.evil.invalid", False),
])
def test_the_report_url_is_https_or_loopback(url, ok):
    if ok:
        check_report_url(url)
    else:
        with pytest.raises(ValueError):
            check_report_url(url)


def test_a_real_http_exchange_with_a_path_prefix_signs_the_target_as_sent():
    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = self.rfile.read(int(self.headers["Content-Length"]))
            seen["ok"] = Verifier(KEY, nonces=NonceMemory()).verify(
                "POST", self.path, {k.lower(): v for k, v in self.headers.items()}, body_sha256(body))
            seen["path"], seen["type"] = self.path, self.headers["Content-Type"]
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    p = ReportPusher(f"http://127.0.0.1:{server.server_port}/platform/", KEY)
    p.start()
    try:
        p.submit(t(A, 1))
        assert p.flush(5)
    finally:
        p.stop()
        server.shutdown()
        server.server_close()
    assert seen == {"ok": True, "path": "/platform" + TARGET, "type": "application/json"}
