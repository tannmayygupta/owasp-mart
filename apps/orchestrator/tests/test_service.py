"""The service as a process (`python -m vulnmart_orchestrator --backend fake`): what the protocol suites of apps/api do not check, such as
the rate limit, the reset placeholder, the command line and that no secret reaches an answer or the log. The protocol, wire, http, report
and mTLS suites run against this same service with `VM_ORCH_SERVICE=python` (see the CI step and docs/dev-log)."""
import json
import os
import queue
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from support import ROOT, TEMPLATE_FILE, TEMPLATE_SCHEMA, body

from vulnmart_orchestrator.auth import body_sha256, sign

KEY = "FAKE-SIGNING-KEY-NOT-REAL-0000000000"
REPORT_KEY = "FAKE-ORCHESTRATOR-KEY-NOT-REAL-0000000"
SRC = ROOT / "apps" / "orchestrator" / "src"


def command(*extra: str, templates: Path, key: str | None = KEY) -> list[str]:
    args = [sys.executable, "-m", "vulnmart_orchestrator", "--backend", "fake", "--port", "0", "--templates-dir", str(templates),
            "--template-schema", str(TEMPLATE_SCHEMA)]
    if key is not None:
        args += ["--key", key]
    return args + list(extra)


@pytest.fixture(scope="module")
def templates():
    d = Path(tempfile.mkdtemp(prefix="vm-svc-templates-"))
    shutil.copy(TEMPLATE_FILE, d / "shop-template.json")
    yield d
    shutil.rmtree(d, ignore_errors=True)


class Svc:
    def __init__(self, templates: Path, *extra: str):
        env = {**os.environ, "PYTHONPATH": str(SRC)}
        self.err = tempfile.TemporaryFile(mode="w+", encoding="utf-8")
        self.proc = subprocess.Popen(command(*extra, templates=templates), stdout=subprocess.PIPE, stderr=self.err, text=True, env=env)
        lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=lambda: lines.put(self.proc.stdout.readline()), daemon=True).start()
        line = lines.get(timeout=30)
        assert line, "the service did not start: " + self.stderr()
        self.url = f"http://127.0.0.1:{json.loads(line)['port']}"

    def stderr(self) -> str:
        self.err.flush()
        self.err.seek(0)
        return self.err.read()

    def stop(self) -> None:
        self.proc.terminate()
        self.proc.wait(10)
        self.proc.stdout.close()
        self.err.close()

    def call(self, method: str, target: str, payload: bytes | None = None, *, key: str = KEY, ctype: str = "application/json"):
        raw = payload or b""
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        nonce = secrets.token_hex(16)
        headers = {"X-VM-Timestamp": ts, "X-VM-Nonce": nonce, "X-VM-Signature": sign(key.encode(), method, target, ts, nonce, body_sha256(raw))}
        if payload is not None:
            headers["Content-Type"] = ctype
        req = urllib.request.Request(self.url + target, data=payload, method=method, headers=headers)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read() or b"null"), {k.lower(): v for k, v in resp.headers.items()}
        except urllib.error.HTTPError as err:
            data = err.read()
            err.close()
            return err.code, json.loads(data), {k.lower(): v for k, v in err.headers.items()}


@pytest.fixture
def svc(templates):
    s = Svc(templates, "--rate-per-s", "0")
    yield s
    s.stop()


def create_body(iid="i-ABCDEFGHIJKLMNOP", **over) -> bytes:
    return json.dumps(body(iid=iid, **over)).encode()


def wait_state(s: Svc, iid: str, state: str, timeout: float = 10.0) -> dict:
    end = time.monotonic() + timeout
    while True:
        status, data, _ = s.call("GET", f"/v1/instances/{iid}")
        if data["state"] == state:
            return data
        assert time.monotonic() < end, f"{iid} is {data['state']}, not {state}"
        time.sleep(0.01)


# ---- rate limit (D7) ----
def test_over_twenty_per_second_with_a_burst_of_forty_is_429_with_retry_after(templates):
    from vulnmart_orchestrator.ratelimit import BURST, RATE_PER_SECOND

    assert (RATE_PER_SECOND, BURST) == (20, 40)  # the defaults of D7; the run below uses a slower bucket so a slow machine cannot hide the limit
    s = Svc(templates, "--rate-per-s", "2", "--rate-burst", "5")
    try:
        results = [s.call("GET", "/v1/host") for _ in range(60)]
    finally:
        s.stop()
    statuses = [r[0] for r in results]
    assert statuses[:5] == [200] * 5
    limited = [r for r in results if r[0] == 429]
    assert limited, "the limit never triggered"
    status, problem, headers = limited[0]
    assert problem["code"] == "ORCH-RATE-LIMITED" and int(headers["retry-after"]) >= 1
    assert not {"message", "detail", "instance"} & set(problem)


def test_a_bad_signature_is_401_before_the_rate_limit_is_counted(templates):
    s = Svc(templates)
    try:
        for _ in range(100):
            assert s.call("GET", "/v1/host", key="WRONG-KEY-NOT-REAL-00000000000000000000")[0] == 401
        assert s.call("GET", "/v1/host")[0] == 200  # unauthenticated requests did not use the bucket
    finally:
        s.stop()


# ---- accept at once, ready after the injection (D4) ----
def test_create_answers_at_once_with_202_and_the_instance_becomes_ready_later(templates):
    s = Svc(templates, "--rate-per-s", "0", "--step-delay-ms", "300")
    try:
        started = time.monotonic()
        status, data, _ = s.call("POST", "/v1/instances", create_body())
        assert status == 202 and data["state"] == "requested" and time.monotonic() - started < 1.0
        assert s.call("GET", "/v1/instances/i-ABCDEFGHIJKLMNOP")[1]["state"] in ("requested", "provisioning")
        ready = wait_state(s, "i-ABCDEFGHIJKLMNOP", "ready")
        assert ready["health"] == "healthy" and ready["error_code"] is None
        assert s.call("POST", "/v1/instances", create_body())[0] == 200  # an identical repeat
    finally:
        s.stop()


# ---- the reset placeholder (story 3.4) ----
def test_reset_is_a_marked_placeholder_that_changes_nothing(svc):
    iid = "i-ABCDEFGHIJKLMNOP"
    svc.call("POST", "/v1/instances", create_body(iid))
    wait_state(svc, iid, "ready")
    payload = {k: body()[k] for k in ("flags", "decoys", "flag_digests", "event_key", "seed")}
    status, problem, _ = svc.call("POST", f"/v1/instances/{iid}/reset", json.dumps({**payload, "epoch": 2}).encode())
    assert status == 501 and problem["code"] == "ORCH-NOT-IMPLEMENTED" and "detail" not in problem
    after = svc.call("GET", f"/v1/instances/{iid}")[1]
    assert after["state"] == "ready" and after["epoch"] == 1
    # the checks that come before the placeholder still run: shape, state, epoch
    assert svc.call("POST", f"/v1/instances/{iid}/reset", json.dumps({**payload, "epoch": 3}).encode())[1]["code"] == "ORCH-STALE-EPOCH"
    assert svc.call("POST", f"/v1/instances/{iid}/reset", json.dumps({**payload, "epoch": 1}).encode())[1]["code"] == "ORCH-VALIDATION"


# ---- destroy ----
def test_destroy_then_repeat_and_the_tombstone_stays(svc):
    iid = "i-ABCDEFGHIJKLMNOP"
    svc.call("POST", "/v1/instances", create_body(iid))
    wait_state(svc, iid, "ready")
    status, data, _ = svc.call("POST", f"/v1/instances/{iid}/destroy")
    assert status == 202 and data["state"] == "stopping"
    wait_state(svc, iid, "destroyed")
    assert svc.call("POST", f"/v1/instances/{iid}/destroy")[0] == 200
    assert svc.call("GET", f"/v1/instances/{iid}")[1]["state"] == "destroyed"
    assert svc.call("POST", "/v1/instances", create_body(iid))[1]["code"] == "ORCH-INSTANCE-EXISTS"
    assert svc.call("POST", f"/v1/instances/{'i-' + 'Z' * 16}/destroy")[0] == 404


def test_an_unusual_method_is_refused_in_the_contract_order_as_a_problem(svc):
    import http.client

    conn = http.client.HTTPConnection(svc.url.removeprefix("http://"), timeout=10)
    conn.request("PROPFIND", "/v1/host")
    res = conn.getresponse()
    assert res.status == 401 and json.loads(res.read())["code"] == "ORCH-BAD-SIGNATURE"  # unsigned: the signature comes first
    conn.close()
    status, problem, headers = svc.call("PROPFIND", "/v1/host")
    assert status == 405 and problem["code"] == "ORCH-METHOD-NOT-ALLOWED" and headers["allow"] == "GET"
    assert headers["content-type"] == "application/problem+json"


# ---- no secret anywhere (NFR-SEC-03) ----
def test_no_answer_and_no_log_line_holds_a_secret(svc):
    from support import EVENT_KEY, FLAG_A, OWNER, SEED

    answers = []
    for extra in ({}, {"image": "evil"}, {"limits": {"memory_mb": 1}}, {"seed": FLAG_A + "x"}, {"hostname": EVENT_KEY}):
        status, data, _ = svc.call("POST", "/v1/instances", create_body(**extra))
        answers.append(json.dumps(data))
    wait_state(svc, "i-ABCDEFGHIJKLMNOP", "ready")
    answers.append(json.dumps(svc.call("GET", "/v1/instances/i-ABCDEFGHIJKLMNOP")[1]))
    answers.append(json.dumps(svc.call("GET", "/v1/instances")[1]))
    answers.append(json.dumps(svc.call("POST", "/v1/instances", b'{"flags": [VM{' + FLAG_A.encode() + b'}', )[1]))
    text = "\n".join(answers) + svc.stderr()
    for secret in (FLAG_A, SEED, EVENT_KEY, OWNER, KEY, REPORT_KEY):
        assert secret not in text
    assert "Traceback" not in text and "File \"" not in text


def test_forbidden_fields_create_nothing(svc):
    for name in ("image", "command", "port", "env", "volume"):
        status, data, _ = svc.call("POST", "/v1/instances", create_body(**{name: "x"}))
        assert status == 422 and data["code"] == "ORCH-FIELD-FORBIDDEN" and data["field"] == "/" + name
    assert svc.call("GET", "/v1/host")[1]["instances"] == 0


def test_a_body_over_64_kib_is_413_and_the_service_lives_on(svc):
    payload = json.dumps({"pad": "x" * (70 * 1024)}).encode()
    for _ in range(5):
        try:
            status, data, _ = svc.call("POST", "/v1/instances", payload)
            break
        except (ConnectionError, urllib.error.URLError):
            time.sleep(0.2)
    else:
        pytest.fail("never saw the 413")
    assert status == 413 and data["code"] == "ORCH-BODY-TOO-LARGE"
    assert svc.call("GET", "/v1/host")[0] == 200


# ---- every error answer is the closed IF-8 body ----
def test_every_error_answer_validates_against_the_if8_schema(svc):
    import re

    from jsonschema import Draft202012Validator
    from vulnmart_models.error_codes import ERRORS, ErrorCode

    schema = json.loads((ROOT / "contracts" / "errors" / "problem.schema.json").read_text(encoding="utf-8"))
    check = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    iid = "i-ABCDEFGHIJKLMNOP"
    assert svc.call("POST", "/v1/instances", create_body(iid))[0] == 202
    wait_state(svc, iid, "ready")
    calls = {
        "unknown instance": ("GET", "/v1/instances/i-ZZZZZZZZZZZZZZZZ", None),
        "bad id in the path": ("GET", "/v1/instances/not-an-id", None),
        "unknown route": ("GET", "/v1/nothing", None),
        "wrong method": ("PUT", "/v1/host", None),
        "forbidden field": ("POST", "/v1/instances", create_body(image="x")),
        "unknown template": ("POST", "/v1/instances", create_body("i-BBBBBBBBBBBBBBBB", template_id="no-such-template")),
        "bad body": ("POST", "/v1/instances", b"[]"),
        "same identity, other body": ("POST", "/v1/instances", create_body(iid, seed="X" * 40)),
        "stale epoch": ("POST", f"/v1/instances/{iid}/access", json.dumps({"access": "open", "access_epoch": 0}).encode()),
        "unknown label": ("GET", "/v1/instances?bogus=1", None),
        "bad limit": ("GET", "/v1/instances?limit=0", None),
        "bad cursor": ("GET", "/v1/instances?cursor=nope", None),
        "wrong media type": ("POST", f"/v1/instances/{iid}/access", b"x"),
    }
    seen = {}
    for name, (method, target, payload) in calls.items():
        ctype = "text/plain" if name == "wrong media type" else "application/json"
        status, data, headers = svc.call(method, target, payload, ctype=ctype)
        assert status >= 400, name
        assert headers["content-type"] == "application/problem+json", name
        errors = [f"{e.json_path}: {e.message}" for e in check.iter_errors(data)]
        assert not errors, (name, errors)
        info = ERRORS[ErrorCode(data["code"])]
        assert data["status"] == status == info.status and data["title"] == info.title, name
        assert data["type"] == "urn:vulnmart:error:" + data["code"], name
        assert ("field" in data) <= (status == 422), name
        seen[name] = data["code"]
    assert seen["bad cursor"] == "ORCH-CURSOR-INVALID" and seen["wrong media type"] == "ORCH-UNSUPPORTED-MEDIA-TYPE"
    assert seen["unknown route"] == "ORCH-ROUTE-UNKNOWN"
    # the unsigned answer and the too-large answer too
    import http.client

    conn = http.client.HTTPConnection(svc.url.removeprefix("http://"), timeout=10)
    conn.request("GET", "/v1/host")
    res = conn.getresponse()
    unsigned = json.loads(res.read())
    conn.close()
    assert res.status == 401 and not list(check.iter_errors(unsigned)) and unsigned["code"] == "ORCH-BAD-SIGNATURE"
    assert re.fullmatch(r"req-[0-9a-f]{12}", unsigned["request_id"])


# ---- command line ----
@pytest.mark.parametrize("extra,key,message", [
    (["--tls-cert", "a.pem"], KEY, "must be given together"),
    (["--tls-cert", "a.pem", "--tls-key", "a.key"], KEY, "must be given together"),
    (["--tls-ca", "ca.pem"], KEY, "must be given together"),
    ([], None, "key"),
    ([], "short", "at least 32"),
    (["--report-url", "http://platform.example.invalid"], KEY, "https"),
    (["--report-url", "http://127.0.0.1:1"], KEY, "report-key"),
    (["--tls-cert", "missing.pem", "--tls-key", "missing.key", "--tls-ca", "missing-ca.pem"], KEY, "missing"),
    (["--templates-dir", "no-such-folder"], KEY, "no template"),
    (["--backend", "docker"], KEY, "images-manifest"),
    (["--port", "abc"], KEY, "invalid"),
    (["--nope", "1"], KEY, "unrecognized"),
])
def test_bad_command_lines_exit_2_without_starting(templates, extra, key, message):
    env = {k: v for k, v in os.environ.items() if k not in ("VM_ORCH_PLATFORM_KEY", "VM_ORCH_REPORT_KEY")}
    env["PYTHONPATH"] = str(SRC)
    res = subprocess.run(command(*extra, templates=templates, key=key), capture_output=True, text=True, timeout=60, env=env)
    assert res.returncode == 2, res.stdout + res.stderr
    assert res.stdout == "" and message in res.stderr


def test_the_keys_can_come_from_the_environment(templates):
    env = {**os.environ, "PYTHONPATH": str(SRC), "VM_ORCH_PLATFORM_KEY": KEY}
    proc = subprocess.Popen(command(templates=templates, key=None), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    try:
        lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=lambda: lines.put(proc.stdout.readline()), daemon=True).start()
        assert json.loads(lines.get(timeout=30))["listening"] is True
    finally:
        proc.terminate()
        proc.wait(10)
        proc.stdout.close()
