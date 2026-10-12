"""The platform API contract (IF-1) and the bundle as a test: the real files pass, and the checker is proved to fail when a rule is broken.
Each mutation takes the real fragment (or bundle), breaks one rule, and expects the named problem."""
from __future__ import annotations

import copy
import json
import shutil
import sys
from pathlib import Path

import pytest

from support import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
import check_platform_contract as contract  # noqa: E402

PLATFORM = contract.load(contract.PLATFORM)
LAB = contract.load(contract.LAB)
BUNDLE = contract.load(contract.BUNDLE)
REPORT = contract.load(contract.REPORT)
CODES = {c["code"]: c for c in contract.load(contract.ERRORS)["codes"]}
PROBLEM = contract.load(contract.PROBLEM)
EVENTS = contract.load(contract.EVENTS)
NO_EXAMPLES = None


def fragment_problems(doc: dict, examples_dir: Path | None = NO_EXAMPLES) -> list[str]:
    return contract.check_fragment(doc, codes=CODES, problem_schema=PROBLEM, events_schema=EVENTS, examples_dir=examples_dir)


def mutated(change) -> dict:
    doc = copy.deepcopy(PLATFORM)
    change(doc)
    return doc


def op(doc: dict, operation_id: str) -> tuple[str, str, dict]:
    return next((p, m, o) for p, m, o in contract.operations(doc) if o.get("operationId") == operation_id)


def has(problems: list[str], text: str) -> bool:
    return any(text in p for p in problems)


# ---- the real files ----

def test_the_real_fragment_passes_every_check():
    assert fragment_problems(PLATFORM, contract.EXAMPLES) == []


def test_the_fragment_has_the_planned_slice():
    ops = contract.operations(PLATFORM)
    assert len(ops) == 25
    assert all(p.startswith("/api/v1/") for p, _, _ in ops)
    # the one route that waits on a decision is marked, not hidden
    assert op(PLATFORM, "createLiveTicket")[2].get("x-pending")


def test_the_real_bundle_passes():
    assert contract.check_bundle(BUNDLE, REPORT, PLATFORM, LAB) == []


def test_the_main_command_is_ok_on_the_real_files(capsys):
    assert contract.main([]) == 0
    assert "OK: platform fragment 25 operations" in capsys.readouterr().out


# ---- the fragment rules fail when broken ----

def test_a_missing_operation_id_is_found():
    doc = mutated(lambda d: op(d, "getHealth")[2].pop("operationId"))
    assert has(fragment_problems(doc), "no operationId")


def test_a_repeated_operation_id_is_found():
    def change(d):
        op(d, "getHealth")[2]["operationId"] = "getSession"
    # the OpenAPI validator refuses it first, before the checker's own rule is reached
    problems = fragment_problems(mutated(change))
    assert has(problems, "Operation ID 'getSession'") and has(problems, "is not unique")


def test_a_path_outside_api_v1_is_found():
    def change(d):
        d["paths"]["/health"] = d["paths"].pop("/api/v1/health")
    assert has(fragment_problems(mutated(change)), "not under /api/v1/")


def test_an_internal_route_is_found():
    def change(d):
        d["paths"]["/api/v1/internal/events"] = d["paths"].pop("/api/v1/health")
    assert has(fragment_problems(mutated(change)), "an internal route is never in a browser fragment")


def test_an_authenticated_route_without_the_session_cookie_is_found():
    def change(d):
        op(d, "getMe")[2]["security"] = [{"csrfHeader": []}]
    assert has(fragment_problems(mutated(change)), "needs the session cookie")


def test_a_state_changing_authenticated_route_without_csrf_is_found():
    def change(d):
        op(d, "changePassword")[2]["security"] = [{"sessionCookie": []}]
    assert has(fragment_problems(mutated(change)), "needs the CSRF header")


@pytest.mark.parametrize("status", ["403", "429"])
def test_a_public_state_changing_route_without_the_origin_and_rate_limit_answers_is_found(status):
    def change(d):
        o = op(d, "createSession")[2]
        o["responses"].pop(status)
    assert has(fragment_problems(mutated(change)), f"declares {status}")


def test_an_answer_without_cache_control_is_found():
    def change(d):
        resp = op(d, "getMe")[2]["responses"]["200"]
        resp.pop("headers", None)
    assert has(fragment_problems(mutated(change)), "no Cache-Control header")


def test_an_error_answer_that_does_not_use_the_problem_schema_is_found():
    def change(d):
        resp = d["components"]["responses"]["NotFound"]
        resp["content"]["application/problem+json"]["schema"] = {"type": "object"}
    assert has(fragment_problems(mutated(change)), "an error answer uses the Problem schema")


def test_an_answer_without_an_example_is_found():
    def change(d):
        media = op(d, "getMe")[2]["responses"]["200"]["content"]["application/json"]
        media.pop("examples", None)
        media.pop("example", None)
    assert has(fragment_problems(mutated(change)), "no example")


def test_an_example_that_does_not_fit_its_schema_is_found():
    def change(d):
        media = op(d, "getHealth")[2]["responses"]["200"]["content"]["application/json"]
        for ex in media["examples"].values():
            ex["value"] = {"status": "great"}
    assert has(fragment_problems(mutated(change)), "example")


def test_a_problem_schema_that_differs_from_if8_is_found():
    def change(d):
        d["components"]["schemas"]["Problem"]["properties"]["extra"] = {"type": "string"}
    assert has(fragment_problems(mutated(change)), "differs from contracts/errors/problem.schema.json")


def test_a_missing_problem_schema_is_found():
    def change(d):
        d["components"]["schemas"].pop("Problem")
    # the OpenAPI validator refuses the dangling references first; whichever rule speaks, the problem names Problem
    problems = fragment_problems(mutated(change))
    assert problems and has(problems, "Problem")


def test_a_request_body_that_is_not_json_is_found():
    def change(d):
        body = op(d, "createSession")[2]["requestBody"]
        body["content"]["text/plain"] = body["content"]["application/json"]
    assert has(fragment_problems(mutated(change)), "a request body is JSON only")


def test_an_operation_without_a_success_answer_is_found():
    def change(d):
        o = op(d, "getHealth")[2]
        for s in [s for s in o["responses"] if s.startswith("2")]:
            o["responses"].pop(s)
    assert has(fragment_problems(mutated(change)), "no success answer")


def test_an_error_example_with_a_code_that_is_not_in_the_registry_is_found():
    def change(d):
        d["components"]["examples"]["SessionRequired"]["value"]["code"] = "AUTH-NO-SUCH-CODE"
    problems = fragment_problems(mutated(change))
    assert has(problems, "AUTH-NO-SUCH-CODE") or has(problems, "is not in the error registry")


def test_check_problem_example_names_a_wrong_status_title_and_type():
    ok = {"type": "urn:vulnmart:error:AUTH-SESSION-REQUIRED", "title": CODES["AUTH-SESSION-REQUIRED"]["title"], "status": 401, "code": "AUTH-SESSION-REQUIRED"}
    assert contract.check_problem_example(ok, 401, CODES) == []
    assert has(contract.check_problem_example({**ok, "status": 403}, 403, CODES), "status 403 must be 401")
    assert has(contract.check_problem_example(ok, 403, CODES), "the answer's 403")
    assert has(contract.check_problem_example({**ok, "title": "x"}, 401, CODES), "title must equal the registry title")
    assert has(contract.check_problem_example({**ok, "type": "urn:x"}, 401, CODES), "type must be urn:vulnmart:error:")
    assert has(contract.check_problem_example({**ok, "code": "NOPE"}, 401, CODES), "is not in the error registry")


# ---- the live stream example ----

def test_a_stream_frame_without_an_id_or_with_a_wrong_event_name_or_bad_json_is_found():
    assert has(contract.check_stream("event: x\ndata: {}\n\n", None), "no stream id")
    assert has(contract.check_stream('id: 1-0\nevent: other\ndata: {"type":"stream.resync"}\n\n', None), "not the event type")
    assert has(contract.check_stream("id: 1-0\nevent: x\ndata: nope\n\n", None), "not JSON")
    assert contract.check_stream(": heartbeat\n\n", None) == ["no frame"]


def test_a_stream_frame_that_is_not_an_if3_event_is_found():
    bad =contract.check_stream('id: 1-0\nevent: instance.state_changed\ndata: {"type":"instance.state_changed"}\n\n', EVENTS)
    assert any(p.startswith("IF-3") for p in bad)


# ---- the request examples ----

def copy_examples(tmp_path: Path) -> Path:
    dest = tmp_path / "examples"
    shutil.copytree(contract.EXAMPLES, dest)
    return dest


def test_a_valid_request_example_that_fails_is_found(tmp_path):
    dest = copy_examples(tmp_path)
    f = dest / "valid" / "login.json"
    data = json.loads(f.read_text(encoding="utf-8"))
    data["body"].pop("password")
    f.write_text(json.dumps(data), encoding="utf-8")
    assert has(fragment_problems(PLATFORM, dest), "examples/valid/login.json")


def test_an_invalid_request_example_that_passes_is_found(tmp_path):
    dest = copy_examples(tmp_path)
    good = json.loads((dest / "valid" / "login.json").read_text(encoding="utf-8"))
    (dest / "invalid" / "login-fine.json").write_text(json.dumps({"schema": "LoginRequest", "body": good["body"], "path": "/email", "rule": "none"}), encoding="utf-8")
    assert has(fragment_problems(PLATFORM, dest), "examples/invalid/login-fine.json: should fail /email but passes")


def test_an_invalid_request_example_that_fails_elsewhere_is_found(tmp_path):
    dest = copy_examples(tmp_path)
    f = next((dest / "invalid").glob("*.json"))
    data = json.loads(f.read_text(encoding="utf-8"))
    data["path"] = "/nowhere"
    f.write_text(json.dumps(data), encoding="utf-8")
    assert has(fragment_problems(PLATFORM, dest), "should fail at /nowhere")


def test_an_example_for_a_schema_that_does_not_exist_is_found(tmp_path):
    dest = copy_examples(tmp_path)
    (dest / "valid" / "ghost.json").write_text(json.dumps({"schema": "NoSuchRequest", "body": {}}), encoding="utf-8")
    assert has(fragment_problems(PLATFORM, dest), "no schema NoSuchRequest")


def test_no_valid_example_at_all_is_found(tmp_path):
    dest = tmp_path / "examples"
    (dest / "valid").mkdir(parents=True)
    (dest / "invalid").mkdir()
    assert has(fragment_problems(PLATFORM, dest), "examples/valid has no request example")


# ---- the bundle rules fail when broken ----

def bundle_problems(change) -> list[str]:
    bundle = copy.deepcopy(BUNDLE)
    report = copy.deepcopy(REPORT)
    change(bundle, report)
    return contract.check_bundle(bundle, report, PLATFORM, LAB)


def any_op(bundle: dict) -> dict:
    return next(o for _, _, o in contract.operations(bundle))


def test_a_bundle_with_a_missing_operation_is_found():
    def change(b, r):
        path = next(iter(b["paths"]))
        b["paths"].pop(path)
    problems = bundle_problems(change)
    assert has(problems, "the fragments have")


def test_a_bundle_operation_without_x_fragment_is_found():
    assert has(bundle_problems(lambda b, r: any_op(b).pop("x-fragment")), "no x-fragment")


def test_a_repeated_operation_id_in_the_bundle_is_found():
    def change(b, r):
        ops = [o for _, _, o in contract.operations(b)]
        ops[1]["operationId"] = ops[0]["operationId"]
    assert has(bundle_problems(change), "is not unique")


def test_an_internal_route_in_the_bundle_is_found():
    def change(b, r):
        b["paths"]["/api/v1/internal/x"] = b["paths"].pop(next(iter(b["paths"])))
    assert has(bundle_problems(change), "an internal route is in the browser bundle")


def test_a_lab_component_that_the_report_does_not_list_is_found():
    def change(b, r):
        b["components"]["schemas"]["LabGhost"] = {"type": "string"}
    assert has(bundle_problems(change), "LabGhost has the Lab prefix but is not in the report")


def test_a_renamed_component_that_is_not_in_the_bundle_is_found():
    def change(b, r):
        r["renamed_components"].append({"section": "schemas", "name": "Ghost", "renamed_to": "LabGhost2", "reason": "x"})
    assert has(bundle_problems(change), "which is not in the bundle")


def test_a_report_with_the_wrong_operation_count_is_found():
    def change(b, r):
        r["operations"] += 1
    assert has(bundle_problems(change), "the report's operation count differs")


def test_a_bundle_that_is_not_openapi_is_found():
    def change(b, r):
        b["openapi"] = "2.0"
    assert has(bundle_problems(change), "the bundle is not a valid OpenAPI 3.1 document")


# ---- the command ----

def test_the_command_usage_and_input_errors(capsys, tmp_path):
    assert contract.main(["--help"]) == 0
    assert "Checks the platform API contract" in capsys.readouterr().out
    assert contract.main(["--frobnicate"]) == 2
    assert 'Unknown argument "--frobnicate"' in capsys.readouterr().err
    assert contract.main(["--platform", str(tmp_path / "missing.yaml")]) == 1
    assert "cannot read an input" in capsys.readouterr().err


def test_the_command_fails_when_the_bundle_is_missing(capsys, tmp_path):
    assert contract.main(["--bundle", str(tmp_path / "none.json")]) == 1
    assert "openapi.json or bundle-report.json is missing" in capsys.readouterr().err


# ---- rules added by the code review ----

def test_an_error_answer_that_is_not_problem_json_is_found():
    def change(d):
        content = d["components"]["responses"]["NotFound"]["content"]
        content["application/json"] = content.pop("application/problem+json")
    assert has(fragment_problems(mutated(change)), "an error answer is application/problem+json")


def test_an_error_answer_without_content_is_found():
    def change(d):
        d["components"]["responses"]["NotFound"].pop("content")
    assert has(fragment_problems(mutated(change)), "an error answer is application/problem+json")


def test_the_health_503_is_the_one_error_answer_that_is_not_a_problem():
    content = contract.resolve(PLATFORM, op(PLATFORM, "getHealth")[2]["responses"]["503"])["content"]
    assert "application/problem+json" not in content


def test_a_cache_control_that_is_not_the_constant_is_found():
    def change(d):
        d["components"]["headers"]["CacheControl"]["schema"] = {"type": "string"}
    assert has(fragment_problems(mutated(change)), "must be the constant private, no-store")


@pytest.mark.parametrize("operation_id", ["updateMe", "disableMfa", "confirmMfaEnrolment", "recordConsent", "changePassword"])
def test_an_authenticated_route_with_a_body_must_declare_429(operation_id):
    def change(d):
        op(d, operation_id)[2]["responses"].pop("429")
    assert has(fragment_problems(mutated(change)), "declares 429")


def test_the_two_new_409_codes_are_used_by_their_routes():
    for operation_id, code in (("startMfaEnrolment", "AUTH-MFA-STATE"), ("disableMfa", "AUTH-MFA-STATE"), ("confirmMfaEnrolment", "AUTH-MFA-STATE"), ("recordConsent", "ATT-CONSENT-STALE")):
        resp = contract.resolve(PLATFORM, op(PLATFORM, operation_id)[2]["responses"]["409"])
        codes = {contract.resolve(PLATFORM, e)["value"]["code"] for e in resp["content"]["application/problem+json"]["examples"].values()}
        assert code in codes, operation_id
    resp = contract.resolve(PLATFORM, op(PLATFORM, "getCatalogueChallenge")[2]["responses"]["404"])
    assert next(iter(resp["content"]["application/problem+json"]["examples"].values()))["value"]["code"] == "ATT-CHALLENGE-NOT-FOUND"


def test_same_compares_a_member_called_title_but_not_a_title_keyword():
    a = {"type": "object", "properties": {"title": {"type": "string", "maxLength": 10}}}
    assert contract.same(a, {"type": "object", "properties": {"title": {"type": "string", "maxLength": 10}}})
    assert not contract.same(a, {"type": "object", "properties": {"title": {"type": "string", "maxLength": 99}}})
    assert not contract.same(a, {"type": "object", "properties": {"title": {"type": "string", "maxLength": 10}, "description": {"type": "string"}}})
    # a title keyword (cosmetic) does not matter
    assert contract.same({"type": "string", "title": "x"}, {"type": "string", "title": "y"})


def test_a_problem_member_called_title_that_drifts_from_if8_is_found():
    def change(d):
        d["components"]["schemas"]["Problem"]["properties"]["title"]["maxLength"] = 1
    assert has(fragment_problems(mutated(change)), "differs from contracts/errors/problem.schema.json")


@pytest.mark.parametrize("path", ["/api/v1/internal", "/api/v1/Internal/x", "/api/v1/x/internal"])
def test_an_internal_path_in_any_spelling_is_found(path):
    def change(d):
        d["paths"][path] = d["paths"].pop("/api/v1/health")
    assert has(fragment_problems(mutated(change)), "an internal route is never in a browser fragment")


def test_a_range_error_key_does_not_crash_the_checker():
    def change(d):
        o = op(d, "getHealth")[2]
        o["responses"]["4XX"] = copy.deepcopy(contract.resolve(d, d["components"]["responses"]["NotFound"]))
        o["responses"]["4XX"]["content"]["application/problem+json"]["examples"] = {"default": {"value": {"type": "urn:vulnmart:error:ATT-NOT-FOUND", "title": "Attempt not found.", "status": 404, "code": "ATT-NOT-FOUND", "request_id": "r"}}}
    assert isinstance(fragment_problems(mutated(change)), list)


def test_check_stream_reads_the_frame_rules_of_sse():
    event = '{"type":"stream.resync","reason":"buffer_reset"}'
    assert not has(contract.check_stream(f"id: 1-0\nevent: stream.resync\ndata:{event}\n\n", None), "not JSON")
    assert not has(contract.check_stream('id: 1-0\nevent: stream.resync\ndata: {"type":"stream.resync",\ndata: "reason":"x"}\n\n', None), "not JSON")
    assert has(contract.check_stream("id: 1-0\nevent: x\ndata: [1]\n\n", None), "not a JSON object")
    assert has(contract.check_stream("id: 1-0\nevent: x\ndata: 5\n\n", None), "not a JSON object")


def test_malformed_request_examples_are_reported_not_a_traceback(tmp_path):
    dest = copy_examples(tmp_path)
    (dest / "valid" / "broken.json").write_text("{not json", encoding="utf-8")
    (dest / "valid" / "nobody.json").write_text(json.dumps({"schema": "LoginRequest"}), encoding="utf-8")
    problems = fragment_problems(PLATFORM, dest)
    assert has(problems, "examples/valid/broken.json: not valid JSON")
    assert has(problems, "examples/valid/nobody.json: needs the members schema and body")


def test_a_swapped_operation_in_the_bundle_is_found_although_the_count_is_the_same():
    def change(b, r):
        b["paths"]["/api/v1/health"]["get"]["operationId"] = "getHealthRenamed"
    problems = bundle_problems(change)
    assert has(problems, "is not in the bundle with x-fragment platform")
    assert has(problems, "is in the bundle but not in the fragment")


def test_an_operation_with_the_wrong_x_fragment_is_found():
    def change(b, r):
        b["paths"]["/api/v1/health"]["get"]["x-fragment"] = "lab"
    assert has(bundle_problems(change), "of the platform fragment is not in the bundle with x-fragment platform")


def test_a_malformed_bundle_file_is_reported_not_a_traceback(capsys, tmp_path):
    bad = tmp_path / "openapi.json"
    bad.write_text("{nope", encoding="utf-8")
    assert contract.main(["--bundle", str(bad)]) == 1
    assert "cannot read the bundle or its report" in capsys.readouterr().err
