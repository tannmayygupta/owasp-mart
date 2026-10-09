"""The lab API contract (IF-2) as a test: the OpenAPI file, the examples, the text and the Node mock say the same thing.
Every answer of the mock is validated against the OpenAPI response schema and headers; the rows of the plan's matrix are run
against the mock process; the check itself is proved to fail when a rule is broken."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate

from support import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
import check_lab_contract as contract  # noqa: E402
import check_orchestrator_contract as base  # noqa: E402

LAB_DIR = ROOT / "contracts" / "api" / "lab"
IF5_FILE = ROOT / "contracts" / "orchestrator" / "orchestrator.openapi.yaml"
SERVER = ROOT / "contracts" / "mocks" / "fake-lab" / "server.mjs"
SPEC = yaml.safe_load((LAB_DIR / contract.SPEC).read_text(encoding="utf-8"))
ORIGIN = "https://dashboard.example.invalid"
CSRF = "FAKE-CSRF-TOKEN-0123456789"
SESSIONS = {"ada": "FAKE-SESSION-ADA", "cam": "FAKE-SESSION-CAM", "rex": "FAKE-SESSION-REX", "eve": "FAKE-SESSION-EVE"}
A_LEARNER, A_CAND, A_READY, A_DONE = "a-AAAAAAAAAAAAAAAA", "a-BBBBBBBBBBBBBBBB", "a-CCCCCCCCCCCCCCCC", "a-DDDDDDDDDDDDDDDD"
I_CAND = "i-BBBBBBBBBBBBBBBB"
FAKE = {"correct": "A", "decoy": "B", "other_instance": "C", "stale_epoch": "D"}
FORBIDDEN_IN_ANSWERS = ["owner_hash", "event_key", "flag_digests", "host_id", "orchestrator", "Traceback", "stack_trace", "seed"]


# ---- the mock as a process ----
class Mock:
    def __init__(self, *args: str) -> None:
        node = shutil.which("node")
        assert node, "node is required"
        self.proc = subprocess.Popen([node, str(SERVER), "--port", "0", *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = self.proc.stdout.readline()
        assert line, "the fake lab printed no port"
        self.url = f"http://127.0.0.1:{json.loads(line)['port']}"
        self.answers: list[str] = []
        self.operations: set[str] = set()

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc.stdout.close()

    def call(self, method, path, user="ada", body=None, *, csrf=CSRF, origin=ORIGIN, ctype="application/json", raw=None, cookie=True, extra_headers=None):
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        headers = {}
        if cookie and user:
            headers["Cookie"] = f"__Host-vm_session={SESSIONS[user]}; __Host-vm_csrf={CSRF}"
        if method == "POST":
            if origin:
                headers["Origin"] = origin
            if csrf:
                headers["X-CSRF-Token"] = csrf
        if data is not None:
            headers["Content-Type"] = ctype
        headers.update(extra_headers or {})
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=10) as resp:
                status, text, hdr = resp.status, resp.read().decode(), {k.lower(): v for k, v in resp.headers.items()}
        except urllib.error.HTTPError as err:
            status, text, hdr = err.code, err.read().decode(), {k.lower(): v for k, v in err.headers.items()}
            err.close()
        parsed = json.loads(text) if text else None
        self.answers.append(text)
        self.check_conforms(method, path, status, parsed, hdr)
        return status, parsed, hdr

    def check_conforms(self, method, path, status, body, hdr):
        """The answer must match the OpenAPI response (schema and the headers it declares)."""
        op_path, op = match_operation(method, path)
        if op is not None:
            self.operations.add(op["operationId"])
        response = None
        if op is not None:
            response = op["responses"].get(str(status))
        if response is None and status == 405:
            response = {"$ref": "#/components/responses/MethodNotAllowed"}
        if response is None and status in (404, 413, 415):
            response = {"$ref": f"#/components/responses/{ {404: 'NotFound', 413: 'TooLarge', 415: 'UnsupportedMedia'}[status] }"}
        assert response is not None, f"{method} {path} answered {status}, which the contract does not declare"
        if "$ref" in response:
            response = base._resolve(SPEC, response["$ref"])
        assert hdr.get("cache-control") == "private, no-store", (path, hdr)
        for name in response.get("headers") or {}:
            if name.lower() in ("retry-after", "allow"):
                assert name.lower() in hdr, f"{method} {path} {status} lacks the header {name}"
        content = response.get("content") or {}
        if not content:
            assert body is None
            return
        media = hdr["content-type"].split(";")[0]
        assert media in content, f"{method} {path} {status}: content type {media} is not declared"
        errors = list(Draft202012Validator({"$ref": "#/components/schemas/__x", "components": _components(content[media]["schema"])}).iter_errors(body))
        assert errors == [], f"{method} {path} {status}: " + "; ".join(f"{base.error_path(e)} {e.message}" for e in errors)


def _components(schema):
    comps = dict(SPEC["components"])
    comps["schemas"] = {**SPEC["components"]["schemas"], "__x": schema}
    return comps


def match_operation(method, path):
    path = path.split("?")[0]
    for template, item in SPEC["paths"].items():
        pattern = "^" + re.sub(r"\{[^}]+\}", "[^/]+", template) + "$"
        if re.match(pattern, path):
            return template, item.get(method.lower())
    return None, None


@pytest.fixture(scope="module")
def mock():
    m = Mock()
    yield m
    m.stop()


@pytest.fixture
def fresh():
    started = []

    def factory(*args):
        m = Mock(*args)
        started.append(m)
        return m

    yield factory
    for m in started:
        m.stop()


def wait_state(m, instance_id, state, user="ada", timeout=10.0):
    end = time.monotonic() + timeout
    while True:
        status, body, _ = m.call("GET", f"/api/v1/instances/{instance_id}", user)
        assert status == 200
        if body["state"] == state:
            return body
        assert time.monotonic() < end, f"{instance_id} did not reach {state}, last {body['state']}"
        time.sleep(0.01)


def flag(letter):
    return "VM{" + letter * 24 + "}"


# ---- the file, the check and the examples ----
def test_the_openapi_file_is_valid_openapi_3_1():
    assert SPEC["openapi"].startswith("3.1")
    validate(SPEC)


def test_the_contract_check_passes_on_the_repository():
    errors, counts = contract.run(LAB_DIR)
    assert errors == []
    assert counts["operations"] == 18 and counts["valid"] >= 30 and counts["invalid"] >= 60


def test_the_contract_check_command_exits_0_and_prints_pass():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_lab_contract.py")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "lab contract: PASS" in r.stdout


def test_the_contract_check_usage():
    script = str(ROOT / "scripts" / "check_lab_contract.py")
    assert subprocess.run([sys.executable, script, "--help"], capture_output=True).returncode == 0
    assert subprocess.run([sys.executable, script, "--nope"], capture_output=True).returncode == 2
    assert subprocess.run([sys.executable, script, "--dir", str(ROOT / "no-such-folder")], capture_output=True).returncode == 1


def test_states_access_and_health_are_identical_to_if5():
    if5 = yaml.safe_load(IF5_FILE.read_text(encoding="utf-8"))["components"]["schemas"]
    for name in ("State", "Access", "Health"):
        assert SPEC["components"]["schemas"][name]["enum"] == if5[name]["enum"]
    assert len(SPEC["components"]["schemas"]["State"]["enum"]) == 10


def test_every_route_is_under_api_v1_and_every_operation_has_an_id():
    ids = [op["operationId"] for item in SPEC["paths"].values() for m, op in item.items() if m in contract.METHODS]
    assert len(ids) == len(set(ids)) == 18
    assert all(p.startswith("/api/v1/") for p in SPEC["paths"])


def test_the_text_lists_every_operation_and_has_open_points():
    text = (LAB_DIR / contract.TEXT).read_text(encoding="utf-8")
    for item in SPEC["paths"].values():
        for m, op in item.items():
            if m in contract.METHODS:
                assert f"`{op['operationId']}`" in text, op["operationId"]
    rows = [line for line in text.split("## Open points (to confirm)")[1].splitlines() if re.match(r"^\| \d+ \|", line)]
    assert len(rows) >= 20
    for needle in ["OI-22", "OI-14", "OI-15", "OI-21", "OI-23", "OI-24", "OI-26", "OI-38", "X-CSRF-Token", "/api/v1/", "Prism"]:
        assert any(needle in r for r in rows), needle


def test_error_codes_in_the_text_are_in_the_pattern_and_examples_use_them():
    text = (LAB_DIR / contract.TEXT).read_text(encoding="utf-8")
    section = text.split("## 5. Error codes")[1].split("## 6.")[0]
    pattern = re.compile(SPEC["components"]["schemas"]["ErrorCode"]["pattern"])
    codes = set(re.findall(r"`((?:AUTH|ATT|INST|REQ)-[A-Z-]+)`", section))
    assert len(codes) >= 15 and all(pattern.match(c) for c in codes)


# ---- the check fails when a rule is broken ----
@pytest.fixture
def copy_of_contract(tmp_path):
    dest = tmp_path / "lab"
    shutil.copytree(LAB_DIR, dest)
    return dest


def _edit_spec(folder, edit):
    f = folder / contract.SPEC
    spec = yaml.safe_load(f.read_text(encoding="utf-8"))
    edit(spec)
    f.write_text(yaml.safe_dump(spec), encoding="utf-8")


def test_check_fails_when_a_secret_name_is_added_to_a_get_answer(copy_of_contract):
    _edit_spec(copy_of_contract, lambda s: s["components"]["schemas"]["Score"]["properties"].update({"seed": {"type": "string"}}))
    errors, _ = contract.run(copy_of_contract)
    assert any("secret-looking property 'seed'" in e for e in errors), errors


@pytest.mark.parametrize("name", ["host_id", "orchestrator_url", "flags", "event_key", "owner_hash", "stack_trace"])
def test_check_fails_for_each_forbidden_name_in_a_get_answer(copy_of_contract, name):
    _edit_spec(copy_of_contract, lambda s: s["components"]["schemas"]["Instance"]["properties"].update({name: {"type": "string"}}))
    errors, _ = contract.run(copy_of_contract)
    assert any(f"secret-looking property {name!r}" in e for e in errors), errors


def test_check_fails_when_a_secret_name_is_added_to_a_valid_answer_example(copy_of_contract):
    f = copy_of_contract / "examples" / "valid" / "score.json"
    data = json.loads(f.read_text(encoding="utf-8"))
    data["event_key"] = "x"
    f.write_text(json.dumps(data), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("score.json" in e for e in errors), errors


def test_check_fails_when_an_operation_is_removed(copy_of_contract):
    def edit(spec):
        del spec["paths"]["/api/v1/attempts/{attempt_id}/report"]
    _edit_spec(copy_of_contract, edit)
    errors, _ = contract.run(copy_of_contract)
    assert any("missing operation GET /api/v1/attempts/{attempt_id}/report" in e for e in errors), errors


def test_check_fails_when_an_operation_is_added(copy_of_contract):
    def edit(spec):
        spec["paths"]["/api/v1/cancel"] = {"post": {"operationId": "cancelAttempt", "responses": {"200": {"description": "x"}}}}
    _edit_spec(copy_of_contract, edit)
    errors, _ = contract.run(copy_of_contract)
    assert any("unexpected operation POST" in e for e in errors), errors


def test_check_fails_when_a_path_is_not_under_api_v1(copy_of_contract):
    def edit(spec):
        spec["paths"]["/v1/instances"] = spec["paths"].pop("/api/v1/instances")
    _edit_spec(copy_of_contract, edit)
    errors, _ = contract.run(copy_of_contract)
    assert any("is not under /api/v1/" in e for e in errors), errors


def test_check_fails_when_a_state_differs_from_if5(copy_of_contract):
    _edit_spec(copy_of_contract, lambda s: s["components"]["schemas"]["State"].update({"enum": ["requested", "ready"]}))
    errors, _ = contract.run(copy_of_contract)
    assert any("State differs" in e for e in errors), errors


def test_check_fails_when_a_post_loses_the_csrf_requirement(copy_of_contract):
    def edit(spec):
        spec["paths"]["/api/v1/instances/{instance_id}/stop"]["post"]["security"] = [{"sessionCookie": []}]
    _edit_spec(copy_of_contract, edit)
    errors, _ = contract.run(copy_of_contract)
    assert any("does not require the CSRF header" in e for e in errors), errors


def test_check_fails_when_a_get_answer_is_a_free_form_object(copy_of_contract):
    _edit_spec(copy_of_contract, lambda s: s["components"]["schemas"]["Score"].update({"additionalProperties": True}))
    errors, _ = contract.run(copy_of_contract)
    assert any("free-form object" in e for e in errors), errors


def test_check_fails_when_an_invalid_example_becomes_valid(copy_of_contract):
    (copy_of_contract / "examples" / "invalid" / "confirm-false.json").write_text(
        (copy_of_contract / "examples" / "valid" / "instance.reset.request.json").read_text(encoding="utf-8"), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("confirm-false.json passed" in e for e in errors), errors


def test_check_fails_on_a_real_looking_flag(copy_of_contract):
    f = copy_of_contract / "examples" / "valid" / "flags.request.json"
    f.write_text(f.read_text(encoding="utf-8").replace("VM{AAAAAAAAAAAAAAAAAAAAAAAA}", "VM{K7Q2M4ZPX3R5T6V7W2A3B4C5}"), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("real-looking flag" in e for e in errors), errors


def test_check_fails_when_a_flag_result_has_no_example(copy_of_contract):
    (copy_of_contract / "examples" / "valid" / "flags.result.decoy.json").unlink()
    m = copy_of_contract / "examples" / "valid" / "manifest.json"
    manifest = json.loads(m.read_text(encoding="utf-8"))
    del manifest["flags.result.decoy.json"]
    m.write_text(json.dumps(manifest), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("flag result decoy" in e for e in errors), errors


def test_check_fails_when_the_open_points_table_is_missing(copy_of_contract):
    f = copy_of_contract / contract.TEXT
    f.write_text(f.read_text(encoding="utf-8").replace("## Open points (to confirm)", "## Other"), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("Open points" in e for e in errors), errors


@pytest.mark.parametrize("target,content", [
    (contract.SPEC, "paths: [unclosed"),
    (contract.SPEC, "just: text"),
    ("examples/valid/manifest.json", "{not json"),
    ("examples/invalid/manifest.json", "[1]"),
    ("examples/valid/score.json", "{broken"),
])
def test_a_malformed_file_gives_a_fail_line_and_exit_1(copy_of_contract, target, content):
    (copy_of_contract / target).write_text(content, encoding="utf-8")
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_lab_contract.py"), "--dir", str(copy_of_contract)], capture_output=True, text=True)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "Traceback" not in r.stderr + r.stdout
    assert "FAIL" in r.stderr and "lab contract: FAIL" in r.stdout


# ---- the mock: every operation answers, every answer conforms ----
def test_every_operation_answers_and_every_answer_conforms(fresh):
    m = fresh()
    ok = lambda r, *codes: (r[0] in codes) or pytest.fail(f"{r[0]} {r[1]}")  # noqa: E731
    r = m.call("POST", "/api/v1/instances", "ada", {"kind": "learner"}); ok(r, 202)
    iid = r[1]["instance_id"]
    wait_state(m, iid, "ready")
    ok(m.call("GET", f"/api/v1/instances/{iid}"), 200)
    r = m.call("POST", f"/api/v1/instances/{iid}/open"); ok(r, 200)
    assert r[1]["url"].startswith("https://") and "/_vm/enter?t=" in r[1]["url"]
    ok(m.call("GET", f"/api/v1/attempts/{A_LEARNER}"), 200)
    ok(m.call("POST", f"/api/v1/attempts/{A_READY}/start", "cam"), 200)
    ok(m.call("POST", f"/api/v1/attempts/{A_LEARNER}/flags", "ada", {"challenge_key": "C01", "flag": flag("A")}), 200)
    ok(m.call("GET", f"/api/v1/attempts/{A_LEARNER}/score"), 200)
    ok(m.call("GET", f"/api/v1/attempts/{A_LEARNER}/challenges"), 200)
    ok(m.call("GET", f"/api/v1/attempts/{A_LEARNER}/challenges/C02/hints"), 200)
    ok(m.call("POST", f"/api/v1/attempts/{A_LEARNER}/challenges/C02/hints/1/unlock"), 200)
    ok(m.call("GET", f"/api/v1/attempts/{A_CAND}/evidence", "rex"), 200)
    r = m.call("GET", f"/api/v1/attempts/{A_CAND}/integrity-flags", "rex"); ok(r, 200)
    fid = r[1]["items"][0]["integrity_flag_id"]
    ok(m.call("POST", f"/api/v1/attempts/{A_CAND}/integrity-flags/{fid}/decision", "rex", {"decision": "accept", "note": "checked"}), 200)
    ok(m.call("GET", f"/api/v1/attempts/{A_CAND}/report", "rex"), 200)
    ok(m.call("GET", f"/api/v1/attempts/{A_CAND}/timeline", "rex"), 200)
    ok(m.call("POST", f"/api/v1/instances/{iid}/reset", "ada", {"confirm": True}), 202)
    wait_state(m, iid, "ready")
    ok(m.call("POST", f"/api/v1/instances/{iid}/stop"), 202)
    ok(m.call("POST", f"/api/v1/instances/{iid}/stop"), 200)
    ok(m.call("POST", f"/api/v1/attempts/{A_LEARNER}/submit", "ada", {"confirm": True}), 200)
    assert m.operations == {op["operationId"] for item in SPEC["paths"].values() for k, op in item.items() if k in contract.METHODS}
    for text in m.answers:  # no secret in any answer
        for word in FORBIDDEN_IN_ANSWERS:
            assert word not in text, word
        assert "VM{" not in text


# ---- the matrix rows ----
def test_read_as_owner_and_by_a_reviewer(mock):
    assert mock.call("GET", f"/api/v1/attempts/{A_CAND}", "cam")[0] == 200
    assert mock.call("GET", f"/api/v1/attempts/{A_CAND}", "rex")[0] == 200
    assert mock.call("GET", f"/api/v1/instances/{I_CAND}", "cam")[1]["state"] == "ready"


def test_no_session_is_401(mock):
    status, body, _ = mock.call("GET", f"/api/v1/attempts/{A_CAND}", None)
    assert status == 401 and body["code"] == "AUTH-SESSION-REQUIRED"
    assert mock.call("GET", f"/api/v1/attempts/{A_CAND}", "ada", cookie=False)[0] == 401


def test_a_post_without_csrf_or_with_another_origin_is_403_and_changes_nothing(fresh):
    m = fresh()
    path = f"/api/v1/attempts/{A_LEARNER}/flags"
    body = {"challenge_key": "C01", "flag": flag("A")}
    s1, b1, _ = m.call("POST", path, "ada", body, csrf=None)
    s2, b2, _ = m.call("POST", path, "ada", body, csrf="WRONG-TOKEN-0123456789")
    s3, b3, _ = m.call("POST", path, "ada", body, origin="https://evil.example.invalid")
    s4, b4, _ = m.call("POST", path, "ada", body, origin=None)
    assert (s1, s2, s3, s4) == (403, 403, 403, 403)
    assert (b1["code"], b2["code"]) == ("AUTH-CSRF-FAILED", "AUTH-CSRF-FAILED") and b3["code"] == b4["code"] == "AUTH-ORIGIN-FORBIDDEN"
    assert m.call("GET", f"/api/v1/attempts/{A_LEARNER}/timeline")[1]["items"] == []  # nothing changed


def test_not_yours_and_missing_give_the_same_404(mock):
    s1, b1, _ = mock.call("GET", f"/api/v1/attempts/{A_CAND}", "eve")
    s2, b2, _ = mock.call("GET", "/api/v1/attempts/a-ZZZZZZZZZZZZZZZZ", "eve")
    s3, b3, _ = mock.call("GET", "/api/v1/attempts/not-an-id", "eve")
    assert (s1, s2, s3) == (404, 404, 404)
    assert {k: v for k, v in b1.items() if k != "request_id"} == {k: v for k, v in b2.items() if k != "request_id"} == {k: v for k, v in b3.items() if k != "request_id"}
    i1 = mock.call("GET", f"/api/v1/instances/{I_CAND}", "eve")
    i2 = mock.call("GET", "/api/v1/instances/i-ZZZZZZZZZZZZZZZZ", "eve")
    assert i1[0] == i2[0] == 404 and i1[1]["code"] == i2[1]["code"] == "INST-NOT-FOUND"
    # a body error does not tell an existing id from a missing one
    assert mock.call("POST", f"/api/v1/attempts/{A_CAND}/flags", "eve", {"nope": 1})[1]["code"] == "ATT-NOT-FOUND"
    # a recruiter does not read a learner practice attempt, and a learner does not read a candidate report
    assert mock.call("GET", f"/api/v1/attempts/{A_LEARNER}", "rex")[0] == 404
    assert mock.call("GET", f"/api/v1/attempts/{A_CAND}/report", "cam")[0] == 404
    assert mock.call("POST", f"/api/v1/attempts/{A_CAND}/integrity-flags/g-AAAAAAAAAAAAAAAA/decision", "eve", {"decision": "accept", "note": "x"})[0] == 404


def test_flag_results_by_input_and_the_text_is_never_echoed_or_kept(fresh):
    m = fresh()
    path = f"/api/v1/attempts/{A_LEARNER}/flags"
    marker = "VM{ZZZZZZZZZZZZZZZZZZZZZZZZ}"
    for letter, expected in [("B", "decoy"), ("C", "other_instance"), ("D", "stale_epoch")]:
        s, b, _ = m.call("POST", path, "ada", {"challenge_key": "C03", "flag": flag(letter)})
        assert s == 200 and b == {"challenge_key": "C03", "result": expected, "credit": "none"}
    s, b, _ = m.call("POST", path, "ada", {"challenge_key": "C03", "flag": marker})
    assert s == 200 and b["result"] == "wrong"
    s, b, _ = m.call("POST", path, "ada", {"challenge_key": "C03", "flag": flag("A")})
    assert s == 200 and b == {"challenge_key": "C03", "result": "correct", "credit": "credited"}
    for p in ["score", "timeline", "challenges", "report", "integrity-flags", "evidence"]:
        m.call("GET", f"/api/v1/attempts/{A_LEARNER}/{p}", "ada")
    joined = "\n".join(m.answers)
    assert marker not in joined and flag("A") not in joined and flag("B") not in joined
    flags = m.call("GET", f"/api/v1/attempts/{A_LEARNER}/integrity-flags", "ada")[1]["items"]
    assert {f["type"] for f in flags} == {"decoy", "sharing"}  # decoy and other_instance raise a flag for a human
    assert m.call("GET", f"/api/v1/attempts/{A_LEARNER}/score", "ada")[1]["score"] > 0


def test_a_correct_flag_that_fails_the_activity_check_is_held(mock):
    s, b, _ = mock.call("POST", f"/api/v1/attempts/{A_CAND}/flags", "cam", {"challenge_key": "C11", "flag": flag("A")})
    assert s == 200 and b["result"] == "correct" and b["credit"] == "held"


def test_more_than_five_wrong_in_ten_minutes_is_429_with_retry_after(fresh):
    m = fresh()
    path = f"/api/v1/attempts/{A_LEARNER}/flags"
    for n in range(5):
        assert m.call("POST", path, "ada", {"challenge_key": "C05", "flag": f"wrong {n}"})[1]["result"] == "wrong"
    s, b, h = m.call("POST", path, "ada", {"challenge_key": "C05", "flag": flag("A")})  # even a correct value is refused
    assert s == 429 and b["code"] == "ATT-FLAG-RATE-LIMITED" and 1 <= int(h["retry-after"]) <= 600
    assert m.call("POST", path, "ada", {"challenge_key": "C06", "flag": flag("A")})[0] == 200  # the limit is per challenge


def test_hints_off_refuses_list_and_unlock_with_404(mock):
    for method, path in [("GET", f"/api/v1/attempts/{A_CAND}/challenges/C01/hints"), ("POST", f"/api/v1/attempts/{A_CAND}/challenges/C01/hints/1/unlock")]:
        s, b, _ = mock.call(method, path, "cam")
        assert s == 404 and b["code"] == "ATT-HINTS-DISABLED"
    assert mock.call("GET", f"/api/v1/attempts/{A_CAND}/challenges", "cam")[1]["items"][0]["hints_available"] is False


def test_hints_text_is_null_until_unlocked_and_unlock_is_repeatable(fresh):
    m = fresh()
    base_path = f"/api/v1/attempts/{A_LEARNER}/challenges/C04/hints"
    assert [h["text"] for h in m.call("GET", base_path)[1]["items"]] == [None, None, None]
    first = m.call("POST", base_path + "/2/unlock")[1]
    assert first["unlocked"] and first["text"] and first["kind"] == "direction"
    assert m.call("POST", base_path + "/2/unlock")[1] == first
    assert m.call("POST", base_path + "/4/unlock")[0] == 404


def test_wrong_state_is_409(mock):
    s, b, _ = mock.call("POST", f"/api/v1/attempts/{A_DONE}/submit", "cam", {"confirm": True})
    assert s == 409 and b["code"] == "ATT-INVALID-STATE"
    s, b, _ = mock.call("POST", f"/api/v1/attempts/{A_DONE}/flags", "cam", {"challenge_key": "C01", "flag": "x"})
    assert s == 409 and b["code"] == "ATT-INVALID-STATE"
    s, b, _ = mock.call("POST", f"/api/v1/attempts/{A_CAND}/start", "cam")  # already running
    assert s == 409 and b["code"] == "ATT-INVALID-STATE"


def test_reset_raises_the_epoch_and_other_states_are_409(fresh):
    m = fresh("--step-delay-ms", "600000")
    iid = m.call("POST", "/api/v1/instances", "ada", {"kind": "learner"})[1]["instance_id"]
    s, b, _ = m.call("POST", f"/api/v1/instances/{iid}/reset", "ada", {"confirm": True})  # still requested
    assert s == 409 and b["code"] == "INST-INVALID-STATE"
    s, b, _ = m.call("POST", f"/api/v1/instances/{iid}/open")
    assert s == 409 and b["code"] == "INST-NOT-READY"
    s, b, _ = m.call("POST", f"/api/v1/instances/{I_CAND}/reset", "cam", {"confirm": True})  # seeded ready instance, steps held
    assert s == 202 and b["epoch"] == 2 and b["state"] == "resetting"
    assert m.call("POST", f"/api/v1/instances/{I_CAND}/reset", "cam", {"confirm": True})[0] == 409  # already resetting
    fast = fresh()
    s, b, _ = fast.call("POST", f"/api/v1/instances/{I_CAND}/reset", "cam", {"confirm": True})
    assert s == 202 and b["epoch"] == 2
    assert wait_state(fast, I_CAND, "ready", "cam")["epoch"] == 2


def test_open_ticket_for_a_ready_instance(mock):
    s, b, _ = mock.call("POST", f"/api/v1/instances/{I_CAND}/open", "cam")
    assert s == 200 and re.match(r"^https://i-bbbbbbbbbbbbbbbb\.labs\.example\.invalid/_vm/enter\?t=[A-Za-z0-9_-]{16,}$", b["url"])
    other = mock.call("POST", f"/api/v1/instances/{I_CAND}/open", "cam")[1]["url"]
    assert other != b["url"]  # one ticket per call


FLAGS = f"/api/v1/attempts/{A_LEARNER}/flags"
DECISION = f"/api/v1/attempts/{A_CAND}/integrity-flags/g-AAAAAAAAAAAAAAAA/decision"


@pytest.mark.parametrize("user,path,body,field", [
    ("ada", FLAGS, {"challenge_key": "C01"}, "/flag"),
    ("ada", FLAGS, {"challenge_key": "C01", "flag": 5}, "/flag"),
    ("ada", FLAGS, {"challenge_key": "C01", "flag": "x", "extra": 1}, "/extra"),
    ("ada", FLAGS, {"challenge_key": "C99", "flag": "x"}, "/challenge_key"),
    ("ada", FLAGS, {"challenge_key": "C01", "flag": "x" * 201}, "/flag"),
    ("ada", f"/api/v1/attempts/{A_LEARNER}/submit", {"confirm": False}, "/confirm"),
    ("ada", f"/api/v1/attempts/{A_LEARNER}/submit", {}, "/confirm"),
    ("cam", f"/api/v1/instances/{I_CAND}/reset", {"confirm": False}, "/confirm"),
    ("cam", f"/api/v1/instances/{I_CAND}/reset", {}, "/confirm"),
    ("ada", "/api/v1/instances", {"kind": "candidate"}, "/kind"),
    ("ada", "/api/v1/instances", {}, "/kind"),
    ("rex", DECISION, {"decision": "fail", "note": "x"}, "/decision"),
    ("rex", DECISION, {"decision": "accept", "note": ""}, "/note"),
    ("rex", DECISION, {"decision": "accept", "note": "x" * 1001}, "/note"),
    ("rex", DECISION, {"decision": "accept"}, "/note"),
])
def test_a_bad_body_is_422_with_the_exact_field_pointer(mock, user, path, body, field):
    s, b, _ = mock.call("POST", path, user, body)
    assert s == 422 and b["code"] == "REQ-VALIDATION" and b["field"] == field


def test_422_names_the_field_and_never_repeats_the_value(mock):
    secret = "VM{QQQQQQQQQQQQQQQQQQQQQQQQ}"
    s, b, _ = mock.call("POST", f"/api/v1/attempts/{A_LEARNER}/flags", "ada", {"challenge_key": "C01", "flag": 7, secret: 1})
    assert s == 422 and secret not in json.dumps(b) and b["field"] == ""
    s, b, _ = mock.call("POST", f"/api/v1/attempts/{A_LEARNER}/flags", "ada", {"challenge_key": "C01", "flag": 7})
    assert b["field"] == "/flag" and "7" not in b["message"]


def test_json_only_size_and_a_body_where_none_is_allowed(mock):
    assert mock.call("POST", f"/api/v1/attempts/{A_LEARNER}/flags", "ada", raw=b"challenge_key=C01", ctype="application/x-www-form-urlencoded")[0] == 415
    assert mock.call("POST", f"/api/v1/attempts/{A_LEARNER}/flags", "ada", raw=b"{not json")[0] == 422
    assert mock.call("POST", f"/api/v1/attempts/{A_LEARNER}/flags", "ada", raw=b"[1]")[0] == 422
    assert mock.call("POST", f"/api/v1/instances/{I_CAND}/open", "cam", raw=b"{}")[0] == 422
    try:
        s, b, _ = mock.call("POST", f"/api/v1/attempts/{A_LEARNER}/flags", "ada", raw=b"{" + b" " * (70 * 1024) + b"}")
        assert s == 413 and b["code"] == "REQ-TOO-LARGE"
    except (urllib.error.URLError, ConnectionError, OSError):
        pass  # the mock drops the connection after answering; a reset while sending is also a refusal


def test_unknown_path_and_method(mock):
    s, b, _ = mock.call("GET", "/api/v1/nothing", "ada")
    assert s == 404 and b["code"] == "REQ-ROUTE-UNKNOWN"
    s, b, h = mock.call("DELETE", f"/api/v1/instances/{I_CAND}", "cam")
    assert s == 405 and b["code"] == "REQ-METHOD-NOT-ALLOWED" and h["allow"] == "GET"
    s, b, h = mock.call("GET", f"/api/v1/attempts/{A_LEARNER}/flags", "ada")
    assert s == 405 and h["allow"] == "POST"
    assert mock.call("GET", "/api/v1/instances", "ada")[0] == 405


def test_review_decision_credits_a_held_capture_once(fresh):
    m = fresh()
    flags = m.call("GET", f"/api/v1/attempts/{A_CAND}/integrity-flags", "rex")[1]["items"]
    held = next(f for f in flags if f["held"])
    before = m.call("GET", f"/api/v1/attempts/{A_CAND}/score", "rex")[1]["score"]
    s, b, _ = m.call("POST", f"/api/v1/attempts/{A_CAND}/integrity-flags/{held['integrity_flag_id']}/decision", "rex", {"decision": "accept", "note": "ok"})
    assert s == 200 and b["status"] == "accepted" and b["decision_note"] == "ok" and b["decided_at"]
    assert m.call("GET", f"/api/v1/attempts/{A_CAND}/score", "rex")[1]["score"] > before
    assert m.call("POST", f"/api/v1/attempts/{A_CAND}/integrity-flags/{held['integrity_flag_id']}/decision", "rex", {"decision": "reject", "note": "x"})[0] == 409
    assert m.call("POST", f"/api/v1/attempts/{A_CAND}/integrity-flags/{held['integrity_flag_id']}/decision", "cam", {"decision": "accept", "note": "x"})[0] == 404


def test_timeline_paging(mock):
    s, b, _ = mock.call("GET", f"/api/v1/attempts/{A_CAND}/timeline?limit=1", "rex")
    assert s == 200 and len(b["items"]) == 1 and b["next_cursor"]
    s2, b2, _ = mock.call("GET", f"/api/v1/attempts/{A_CAND}/timeline?limit=1&cursor={b['next_cursor']}", "rex")
    assert s2 == 200 and b2["items"][0] != b["items"][0]
    for q in ["limit=0", "limit=201", "limit=abc", "cursor=%20", "cursor=!!", "other=1", "limit=1&limit=2"]:
        assert mock.call("GET", f"/api/v1/attempts/{A_CAND}/timeline?{q}", "rex")[0] == 422, q


def test_start_and_submit_move_the_attempt_and_freeze_the_instance(fresh):
    m = fresh()
    s, b, _ = m.call("POST", f"/api/v1/attempts/{A_READY}/start", "cam")
    assert s == 200 and b["state"] == "running" and b["started_at"] and b["deadline_at"]
    s, b, _ = m.call("POST", f"/api/v1/attempts/{A_CAND}/submit", "cam", {"confirm": True})
    assert s == 200 and b["state"] == "submitted" and b["frozen_until"]
    assert m.call("GET", f"/api/v1/instances/{I_CAND}", "cam")[1]["access"] == "frozen"
    assert m.call("POST", f"/api/v1/instances/{I_CAND}/open", "cam")[0] == 409


def test_a_second_instance_request_is_refused_by_the_quota_rule(fresh):
    m = fresh()
    assert m.call("POST", "/api/v1/instances", "ada", {"kind": "learner"})[0] == 202
    s, b, _ = m.call("POST", "/api/v1/instances", "ada", {"kind": "learner"})
    assert s == 409 and b["code"] == "INST-QUOTA-REACHED"
    assert m.call("POST", "/api/v1/instances", "eve", {"kind": "learner"})[0] == 202  # another user is fine


def test_the_mock_startup_line_and_bad_arguments():
    node = shutil.which("node")
    r = subprocess.run([node, str(SERVER), "--bogus", "1"], capture_output=True, text=True)
    assert r.returncode == 2 and "Unknown or incomplete argument" in r.stderr
    r = subprocess.run([node, str(SERVER), "--port", "-1"], capture_output=True, text=True)
    assert r.returncode == 2


def test_no_flag_like_value_in_the_mock_except_the_fake_ones():
    text = SERVER.read_text(encoding="utf-8")
    assert "VM{" in text  # the fake test flags are built from it
    for m in base.FLAG_LIKE.finditer(text):
        assert base.FAKE_FLAG.match(m.group(0)), m.group(0)
    for n, line in enumerate(text.splitlines(), 1):
        for lit in re.findall(r"VM\{[^}]*\}", line):
            assert re.fullmatch(r"VM\{([A-Z2-7])\1*\}", lit) or "'" in lit or "+" in line, (n, lit)


# ---- review fixes ----
def test_a_prototype_key_is_not_a_session(mock):
    for name in ("constructor", "__proto__", "toString", "hasOwnProperty"):
        s, b, _ = mock.call("GET", f"/api/v1/attempts/{A_CAND}", None, cookie=False, extra_headers={"Cookie": f"__Host-vm_session={name}"})
        assert s == 401 and b["code"] == "AUTH-SESSION-REQUIRED", name


def test_a_csrf_header_of_another_length_is_403_not_500(mock):
    for token in ("x", "X" * 200):
        s, b, _ = mock.call("POST", FLAGS, "ada", {"challenge_key": "C01", "flag": "x"}, csrf=token)
        assert s == 403 and b["code"] == "AUTH-CSRF-FAILED"


@pytest.mark.parametrize("path", ["/api/v1/attempts/%ZZ", "/api/v1/instances/%", "/api/v1/attempts/a-AAAAAAAAAAAAAAAA/challenges/%E0%A4%A/hints"])
def test_bad_percent_encoding_is_the_uniform_404(mock, path):
    s, b, _ = mock.call("GET", path, "ada")
    assert s == 404 and b["code"] == "REQ-ROUTE-UNKNOWN"


def test_reset_and_stop_after_submit_are_409_and_the_freeze_holds(fresh):
    m = fresh()
    assert m.call("POST", f"/api/v1/attempts/{A_CAND}/submit", "cam", {"confirm": True})[0] == 200
    s, b, _ = m.call("POST", f"/api/v1/instances/{I_CAND}/reset", "cam", {"confirm": True})
    assert s == 409 and b["code"] == "INST-INVALID-STATE"
    s, b, _ = m.call("POST", f"/api/v1/instances/{I_CAND}/stop", "cam")
    assert s == 409 and b["code"] == "INST-INVALID-STATE"
    inst = m.call("GET", f"/api/v1/instances/{I_CAND}", "cam")[1]
    assert inst["access"] == "frozen" and inst["epoch"] == 1 and inst["state"] == "ready"


def test_the_timer_does_not_reopen_an_instance_of_a_submitted_attempt(fresh):
    m = fresh("--step-delay-ms", "150")
    iid = m.call("POST", "/api/v1/instances", "ada", {"kind": "learner"})[1]["instance_id"]
    assert m.call("POST", f"/api/v1/attempts/{A_LEARNER}/submit", "ada", {"confirm": True})[0] == 200
    inst = wait_state(m, iid, "ready")
    assert inst["access"] != "open"
    assert m.call("POST", f"/api/v1/instances/{iid}/open")[0] == 409


def test_the_owner_of_a_learner_attempt_reads_flags_but_cannot_decide(fresh):
    m = fresh()
    assert m.call("POST", FLAGS, "ada", {"challenge_key": "C01", "flag": flag("B")})[1]["result"] == "decoy"
    items = m.call("GET", f"/api/v1/attempts/{A_LEARNER}/integrity-flags", "ada")[1]["items"]
    fid = items[0]["integrity_flag_id"]
    s, b, _ = m.call("POST", f"/api/v1/attempts/{A_LEARNER}/integrity-flags/{fid}/decision", "ada", {"decision": "accept", "note": "x"})
    assert s == 404 and b["code"] == "ATT-NOT-FOUND"
    assert m.call("GET", f"/api/v1/attempts/{A_LEARNER}/integrity-flags", "ada")[1]["items"][0]["status"] == "open"


def test_check_fails_when_a_secret_name_is_in_a_post_answer_schema(copy_of_contract):
    _edit_spec(copy_of_contract, lambda s: s["components"]["schemas"]["FlagSubmissionResult"]["properties"].update({"seed": {"type": "string"}}))
    errors, _ = contract.run(copy_of_contract)
    assert any("POST /api/v1/attempts/{attempt_id}/flags" in e and "'seed'" in e for e in errors), errors


def test_a_secret_name_in_a_request_body_schema_is_allowed(copy_of_contract):
    errors, _ = contract.run(copy_of_contract)  # FlagSubmissionRequest has `flag`
    assert errors == []


@pytest.mark.parametrize("name", ["State", "Access", "Health"])
def test_check_fails_when_a_shared_enum_is_missing_from_the_lab_file(copy_of_contract, name):
    _edit_spec(copy_of_contract, lambda s: s["components"]["schemas"].update({name: {"type": "string"}}))
    errors, _ = contract.run(copy_of_contract)
    assert any(f"{name} enumeration is missing from the lab file" in e for e in errors), errors


def test_check_fails_when_a_shared_enum_is_missing_from_if5(copy_of_contract, tmp_path):
    spec = yaml.safe_load(IF5_FILE.read_text(encoding="utf-8"))
    del spec["components"]["schemas"]["Health"]
    other = tmp_path / "if5.yaml"
    other.write_text(yaml.safe_dump(spec), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract, other)
    assert any("Health enumeration is missing from the IF-5 file" in e for e in errors), errors


def test_a_non_string_valid_manifest_value_is_reported_and_the_check_continues(copy_of_contract):
    m = copy_of_contract / "examples" / "valid" / "manifest.json"
    manifest = json.loads(m.read_text(encoding="utf-8"))
    manifest["score.json"] = ["Score"]
    m.write_text(json.dumps(manifest), encoding="utf-8")
    errors, counts = contract.run(copy_of_contract)
    assert any("entry for score.json is malformed" in e for e in errors), errors
    assert counts["invalid"] >= 60  # the run went on to the invalid examples
