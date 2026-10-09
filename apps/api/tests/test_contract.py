"""The orchestrator contract (IF-5) as a test: the OpenAPI file, the examples, the text, the Python types and the
Node signer all say the same thing. Also proves the contract check itself fails when a rule is broken."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys

import pytest
import yaml
from openapi_spec_validator import validate

from support import CONTRACT_DIR, ROOT, SERVER, create_request, reset_request
from vulnmart.ports import http_instance_host
from vulnmart.ports.fake_instance_host import ALLOWED_TEMPLATES, FakeInstanceHost
from vulnmart.ports.http_instance_host import HttpInstanceHost
from vulnmart.ports.instance_host import ERRORS_BY_CODE, LIST_LABELS, InstanceHost

sys.path.insert(0, str(ROOT / "scripts"))
import check_orchestrator_contract as contract  # noqa: E402

SPEC_FILE = CONTRACT_DIR / "orchestrator.openapi.yaml"
SPEC = yaml.safe_load(SPEC_FILE.read_text(encoding="utf-8"))


def test_the_openapi_file_is_valid_openapi_3_1():
    assert SPEC["openapi"].startswith("3.1")
    validate(SPEC)  # raises on any error


def test_the_contract_check_passes_on_the_repository():
    errors, counts = contract.run(CONTRACT_DIR)
    assert errors == []
    assert counts["operations"] == 8 and counts["valid"] >= 12 and counts["invalid"] >= 25


def test_the_contract_check_command_exits_0_and_prints_pass():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_orchestrator_contract.py")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "orchestrator contract: PASS" in r.stdout


def test_the_contract_check_usage():
    script = str(ROOT / "scripts" / "check_orchestrator_contract.py")
    assert subprocess.run([sys.executable, script, "--help"], capture_output=True).returncode == 0
    assert subprocess.run([sys.executable, script, "--nope"], capture_output=True).returncode == 2
    assert subprocess.run([sys.executable, script, "--dir", str(ROOT / "no-such-folder")], capture_output=True).returncode == 1


# ---- the check fails when a rule is broken ----
@pytest.fixture
def copy_of_contract(tmp_path):
    dest = tmp_path / "orchestrator"
    shutil.copytree(CONTRACT_DIR, dest)
    return dest


def test_check_fails_when_a_get_example_carries_a_flag(copy_of_contract):
    f = copy_of_contract / "examples" / "valid" / "get.response.json"
    data = json.loads(f.read_text(encoding="utf-8"))
    data["flags"] = []
    f.write_text(json.dumps(data), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("get.response.json" in e for e in errors)


def test_check_fails_when_a_get_answer_schema_can_carry_a_secret(copy_of_contract):
    f = copy_of_contract / contract.SPEC
    spec = yaml.safe_load(f.read_text(encoding="utf-8"))
    spec["components"]["schemas"]["InstanceStatus"]["properties"]["seed"] = {"type": "string"}
    f.write_text(yaml.safe_dump(spec), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("secret-looking property 'seed'" in e for e in errors)


def test_check_fails_when_an_invalid_example_becomes_valid(copy_of_contract):
    (copy_of_contract / "examples" / "invalid" / "create-image-field.json").write_text(
        (copy_of_contract / "examples" / "valid" / "create.request.json").read_text(encoding="utf-8"), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("create-image-field.json passed" in e for e in errors)


def test_check_fails_when_an_invalid_example_fails_at_another_path(copy_of_contract):
    m = copy_of_contract / "examples" / "invalid" / "manifest.json"
    manifest = json.loads(m.read_text(encoding="utf-8"))
    manifest["create-image-field.json"]["path"] = "/command"
    m.write_text(json.dumps(manifest), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("create-image-field.json failed at" in e for e in errors)


def _break_get_host_response(copy_of_contract, edit):
    f = copy_of_contract / contract.SPEC
    spec = yaml.safe_load(f.read_text(encoding="utf-8"))
    edit(spec)
    f.write_text(yaml.safe_dump(spec), encoding="utf-8")


def test_check_fails_when_a_secret_hides_in_a_referenced_get_response(copy_of_contract):
    # GET /v1/instances/{id} answers 404 through components/responses/NotFound; put a secret in that referenced response
    def edit(spec):
        spec["components"]["responses"]["NotFound"]["content"]["application/problem+json"]["schema"] = {
            "type": "object", "additionalProperties": False, "properties": {"event_key": {"type": "string"}}}
    _break_get_host_response(copy_of_contract, edit)
    errors, _ = contract.run(copy_of_contract)
    assert any("application/problem+json" in e and "'event_key'" in e for e in errors), errors


def test_check_fails_when_a_get_answer_is_a_free_form_object(copy_of_contract):
    def edit(spec):
        spec["components"]["schemas"]["HostStatus"]["additionalProperties"] = True
    _break_get_host_response(copy_of_contract, edit)
    errors, _ = contract.run(copy_of_contract)
    assert any("free-form object" in e for e in errors), errors


def test_check_fails_when_a_media_type_other_than_json_carries_a_secret(copy_of_contract):
    def edit(spec):
        spec["paths"]["/v1/host"]["get"]["responses"]["200"]["content"]["text/plain"] = {
            "schema": {"type": "object", "additionalProperties": False, "properties": {"seed": {"type": "string"}}}}
    _break_get_host_response(copy_of_contract, edit)
    errors, _ = contract.run(copy_of_contract)
    assert any("text/plain" in e and "'seed'" in e for e in errors), errors


@pytest.mark.parametrize("target,content", [
    (contract.SPEC, "paths: [unclosed"),
    (contract.SPEC, "just: text"),
    ("examples/valid/manifest.json", "{not json"),
    ("examples/valid/manifest.json", "[1]"),
    ("examples/invalid/manifest.json", "{not json"),
    ("examples/invalid/manifest.json", '{"create-image-field.json": {"schema": "CreateInstanceRequest"}}'),
    ("examples/invalid/manifest.json", '{"create-image-field.json": "x"}'),
    ("examples/invalid/manifest.json", '{"create-image-field.json": {"schema": "NoSuchSchema", "path": "/x"}}'),
    ("examples/valid/get.response.json", "{broken"),
    ("examples/invalid/create-image-field.json", "{broken"),
    ("examples/signing-vector.json", "{broken"),
    ("examples/signing-vector.json", '{"key": "k"}'),
])
def test_a_malformed_file_gives_a_fail_line_naming_it_and_exit_1(copy_of_contract, target, content):
    (copy_of_contract / target).write_text(content, encoding="utf-8")
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_orchestrator_contract.py"), "--dir", str(copy_of_contract)],
                       capture_output=True, text=True)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "Traceback" not in r.stderr and "Traceback" not in r.stdout
    assert "FAIL" in r.stderr and "orchestrator contract: FAIL" in r.stdout
    name = target.split("/")[-1]
    # the FAIL line names the broken file (or, for a bad manifest entry, the example the entry is about)
    assert name in r.stderr or "create-image-field.json" in r.stderr, r.stderr


def test_a_signing_vector_without_body_sha256_fails(copy_of_contract):
    f = copy_of_contract / "examples" / "signing-vector.json"
    vec = json.loads(f.read_text(encoding="utf-8"))
    del vec["body_sha256"]
    f.write_text(json.dumps(vec), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("signing-vector.json" in e and "body_sha256" in e for e in errors)


def test_check_fails_when_an_operation_is_removed(copy_of_contract):
    f = copy_of_contract / contract.SPEC
    spec = yaml.safe_load(f.read_text(encoding="utf-8"))
    del spec["paths"]["/v1/host"]
    f.write_text(yaml.safe_dump(spec), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("missing operation GET /v1/host" in e for e in errors)


def test_check_fails_on_a_real_looking_flag(copy_of_contract):
    f = copy_of_contract / "examples" / "valid" / "create.request.json"
    f.write_text(f.read_text(encoding="utf-8").replace("VM{AAAAAAAAAAAAAAAAAAAAAAAA}", "VM{K7Q2M4ZPX3R5T6V7W2A3B4C5}"), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("real-looking flag" in e for e in errors)


def test_check_fails_when_the_signing_vector_is_wrong(copy_of_contract):
    f = copy_of_contract / "examples" / "signing-vector.json"
    vec = json.loads(f.read_text(encoding="utf-8"))
    vec["signature"] = "v1=" + "0" * 64
    f.write_text(json.dumps(vec), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("signing-vector" in e for e in errors)


def test_check_fails_when_the_open_points_table_is_missing(copy_of_contract):
    f = copy_of_contract / contract.TEXT
    f.write_text(f.read_text(encoding="utf-8").replace("## Open points (to confirm)", "## Other"), encoding="utf-8")
    errors, _ = contract.run(copy_of_contract)
    assert any("Open points" in e for e in errors)


# ---- the Python types, the text, the fake and the schemas agree ----
def test_python_types_match_the_openapi_request_schemas():
    schemas = SPEC["components"]["schemas"]
    create = create_request().to_json()
    assert set(create) == set(schemas["CreateInstanceRequest"]["properties"]) == set(schemas["CreateInstanceRequest"]["required"])
    assert set(create["limits"]) == set(schemas["Limits"]["properties"])
    reset = reset_request().to_json()
    assert set(reset) == set(schemas["ResetInstanceRequest"]["properties"])
    for name, body in [("CreateInstanceRequest", create), ("ResetInstanceRequest", reset)]:
        assert list(contract.schema_validator(SPEC, name).iter_errors(body)) == []


def test_no_request_type_can_carry_an_image_command_volume_port_network_or_env():
    forbidden = {"image", "command", "cmd", "entrypoint", "volume", "volumes", "mounts", "port", "ports", "network", "networks", "env", "environment"}
    assert not forbidden & set(create_request().to_json())
    assert not forbidden & set(reset_request().to_json())


def test_error_codes_in_the_text_and_the_python_classes_are_the_same_set():
    text = (CONTRACT_DIR / contract.TEXT).read_text(encoding="utf-8")
    section = text.split("## 6. Errors")[1].split("## 7.")[0]
    in_text = set(re.findall(r"`(ORCH-[A-Z-]+)`", section))
    # ORCH-UNAVAILABLE is the client's own "could not reach or understand the orchestrator", never on the wire.
    assert in_text == set(ERRORS_BY_CODE) - {"ORCH-UNAVAILABLE"}
    for code, cls in ERRORS_BY_CODE.items():
        assert cls.code == code
    for cls in ERRORS_BY_CODE.values():  # the http status of the class is the one the text table gives
        if cls.code == "ORCH-UNAVAILABLE":
            continue
        assert re.search(rf"\| {cls.http_status} \| `{cls.code}` \|", section), cls.code


def test_state_enum_equals_the_state_machine_of_the_contract():
    from vulnmart.ports.instance_host import InstanceState
    assert {s.value for s in InstanceState} == set(SPEC["components"]["schemas"]["State"]["enum"])
    text = (CONTRACT_DIR / contract.TEXT).read_text(encoding="utf-8")
    for s in InstanceState:
        assert f"`{s.value}`" in text


def test_list_labels_and_templates_match():
    params = {p["name"] for p in SPEC["paths"]["/v1/instances"]["get"]["parameters"] if "name" in p}
    assert LIST_LABELS <= params
    assert "shop-v0" in ALLOWED_TEMPLATES


def test_the_open_points_table_has_rows_and_the_traceable_proposals():
    text = (CONTRACT_DIR / contract.TEXT).read_text(encoding="utf-8")
    rows = [line for line in text.split("## Open points (to confirm)")[1].splitlines() if re.match(r"^\| \d+ \|", line)]
    assert len(rows) >= 20
    for needle in ["202", "X-VM-Timestamp", "60 seconds", "5 minutes", "memory_mb", "access epoch", "shop-v0", "64 KiB"]:
        assert any(needle in r for r in rows), needle


def test_the_ports_package_holds_only_the_three_modules():
    ports = ROOT / "apps" / "api" / "src" / "vulnmart" / "ports"
    names = sorted(p.name for p in ports.glob("*.py"))
    assert names == ["__init__.py", "fake_instance_host.py", "http_instance_host.py", "instance_host.py"]
    assert sorted(p.name for p in (ROOT / "apps" / "api" / "src" / "vulnmart").iterdir() if p.name != "__pycache__") == ["__init__.py", "ports", "py.typed"]


def test_both_implementations_are_instance_hosts():
    assert isinstance(FakeInstanceHost(), InstanceHost)
    assert isinstance(HttpInstanceHost("http://127.0.0.1:1", b"k" * 32), InstanceHost)


# ---- signing ----
VECTOR = json.loads((CONTRACT_DIR / "examples" / "signing-vector.json").read_text(encoding="utf-8"))


def test_python_signing_reproduces_the_vector():
    v = VECTOR
    sig = http_instance_host.sign_request(v["key"].encode(), v["method"], v["target"], v["timestamp"], v["nonce"], v["body"].encode())
    assert sig == v["signature"]
    assert http_instance_host.signing_string(v["method"], v["target"], v["timestamp"], v["nonce"], v["body"].encode()) == v["signing_string"]


def test_node_signing_reproduces_the_vector():
    node = shutil.which("node")
    assert node, "node is required"
    script = (
        "const m = await import(process.argv[1]);"
        "const v = JSON.parse(process.argv[2]);"
        "process.stdout.write(m.sign(v.key, v.method, v.target, v.timestamp, v.nonce, m.sha256Hex(Buffer.from(v.body))));"
    )
    out = subprocess.run([node, "--input-type=module", "-e", script, SERVER.as_uri(), json.dumps(VECTOR)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert out.stdout == VECTOR["signature"]


def test_verify_request_rejects_what_the_text_says_it_rejects():
    from datetime import UTC, datetime, timedelta
    key = b"FAKE-KEY"
    nonces = http_instance_host.NonceCache()
    ts = http_instance_host.utc_timestamp()
    h = http_instance_host.signed_headers(key, "GET", "/v1/host", b"", timestamp=ts, nonce="a" * 32)
    http_instance_host.verify_request(key, "GET", "/v1/host", h, b"", nonces=nonces)
    with pytest.raises(Exception, match="bad signature"):  # replay
        http_instance_host.verify_request(key, "GET", "/v1/host", h, b"", nonces=nonces)
    h2 = http_instance_host.signed_headers(key, "GET", "/v1/host", b"", nonce="b" * 32)
    with pytest.raises(Exception, match="bad signature"):  # other path
        http_instance_host.verify_request(key, "GET", "/v1/instances", h2, b"", nonces=nonces)
    old = http_instance_host.signed_headers(key, "GET", "/v1/host", b"", timestamp=http_instance_host.utc_timestamp(datetime.now(UTC) - timedelta(seconds=61)), nonce="c" * 32)
    with pytest.raises(Exception, match="bad signature"):  # stale
        http_instance_host.verify_request(key, "GET", "/v1/host", old, b"", nonces=nonces)


def test_nonces_are_forgotten_after_the_ttl():
    now = [0.0]
    cache = http_instance_host.NonceCache(ttl_seconds=300, clock=lambda: now[0])
    assert cache.check_and_add("n") is True
    assert cache.check_and_add("n") is False
    now[0] = 301.0
    assert cache.check_and_add("n") is True
