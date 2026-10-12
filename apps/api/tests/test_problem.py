"""Story P-02: API errors follow the IF-8 contract (contracts/errors/problem.schema.json and error-codes.yaml)."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from pydantic import BaseModel
from vulnmart.main import create_app
from starlette.exceptions import HTTPException as StarletteHTTPException
from vulnmart.problem import MAX_ERRORS, PROBLEM_MEDIA_TYPE, ProblemError, problem_response
from vulnmart_models.error_codes import ERRORS, ErrorCode, problem_type

REPO = Path(__file__).resolve().parents[3]
SCHEMA = Draft202012Validator(json.loads((REPO / "contracts" / "errors" / "problem.schema.json").read_text(encoding="utf-8")))
SECRET = "SECRET-VALUE-4711 host=db.internal.example"


class Item(BaseModel):
    quantity: int
    name: str


class Order(BaseModel):
    items: list[Item]


class Many(BaseModel):
    values: list[int]


class Tags(BaseModel):
    tags: dict[str, int]


def make_client() -> TestClient:
    app = create_app({})

    @app.post("/_test/items")
    async def items(item: Item) -> dict[str, str]:
        return {"ok": item.name}

    @app.get("/_test/boom")
    async def boom() -> None:
        raise RuntimeError(SECRET)

    @app.post("/_test/order")
    async def order(o: Order) -> dict[str, int]:
        return {"n": len(o.items)}

    @app.post("/_test/many")
    async def many(m: Many) -> dict[str, int]:
        return {"n": len(m.values)}

    @app.post("/_test/tags")
    async def tags(t: Tags) -> dict[str, int]:
        return {"n": len(t.tags)}

    @app.get("/_test/query")
    async def query(limit: int) -> dict[str, int]:
        return {"limit": limit}

    @app.get("/_test/http/{status}")
    async def http_status(status: int) -> None:
        raise StarletteHTTPException(status, headers={"Retry-After": "5", "X-Internal": "no", "WWW-Authenticate": "Bearer"})

    @app.get("/_test/problem-error")
    async def problem_error() -> None:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND, headers={"Retry-After": "7"})

    # An unhandled error must give an answer, not propagate to the test.
    return TestClient(app, raise_server_exceptions=False)


def assert_follows_contract(response, code: ErrorCode) -> dict:
    assert response.headers["content-type"].split(";")[0] == PROBLEM_MEDIA_TYPE
    assert response.headers["cache-control"] == "private, no-store"
    body = response.json()
    SCHEMA.validate(body)  # raises with the failing path when the body breaks the schema
    info = ERRORS[code]
    assert response.status_code == info.status
    assert body["status"] == info.status
    assert body["code"] == code.value
    assert body["type"] == problem_type(code)
    assert body["title"] == info.title
    return body


def test_unknown_route_is_req_route_unknown():
    r = make_client().get("/no/such/route")
    assert_follows_contract(r, ErrorCode.REQ_ROUTE_UNKNOWN)


def test_wrong_method_is_req_method_not_allowed_and_keeps_allow_header():
    r = make_client().post("/healthz")
    assert_follows_contract(r, ErrorCode.REQ_METHOD_NOT_ALLOWED)
    assert "GET" in r.headers["allow"]


def test_invalid_body_is_req_validation_with_pointers_and_never_echoes_the_value():
    r = make_client().post("/_test/items", json={"quantity": SECRET})
    body = assert_follows_contract(r, ErrorCode.REQ_VALIDATION)
    assert {"pointer": "/quantity", "detail": "This value is not valid."} in body["errors"]
    assert {"pointer": "/name", "detail": "This field is required."} in body["errors"]
    assert "SECRET-VALUE" not in r.text
    assert "db.internal" not in r.text


def test_body_that_is_not_json_is_req_validation_for_the_whole_body():
    r = make_client().post("/_test/items", content=b"not json", headers={"content-type": "application/json"})
    body = assert_follows_contract(r, ErrorCode.REQ_VALIDATION)
    assert all(e["pointer"] == "" for e in body["errors"])


def test_unhandled_error_is_req_internal_and_shows_no_internals():
    r = make_client().get("/_test/boom")
    assert_follows_contract(r, ErrorCode.REQ_INTERNAL)
    for leak in ("RuntimeError", "SECRET-VALUE", "db.internal", "Traceback", "boom"):
        assert leak not in r.text


def test_a_well_formed_request_id_is_kept():
    r = make_client().get("/no/such/route", headers={"X-Request-ID": "client-req-0001"})
    assert r.json()["request_id"] == "client-req-0001"


@pytest.mark.parametrize("supplied", ["short", "has space in it", "x" * 65, "bad/chars/here"])
def test_a_malformed_request_id_is_replaced_not_echoed(supplied):
    r = make_client().get("/no/such/route", headers={"X-Request-ID": supplied})
    body = assert_follows_contract(r, ErrorCode.REQ_ROUTE_UNKNOWN)
    assert body["request_id"] != supplied


def test_every_request_id_is_unique_when_not_supplied():
    c = make_client()
    ids = {c.get("/no/such/route").json()["request_id"] for _ in range(5)}
    assert len(ids) == 5


@pytest.mark.parametrize("code", [c for c, info in ERRORS.items() if info.status is not None])
def test_every_http_code_of_the_registry_builds_a_body_that_follows_the_schema(code):
    response = problem_response(code, "req-0a1b2c3d")
    body = json.loads(response.body)
    SCHEMA.validate(body)
    assert response.status_code == ERRORS[code].status
    assert body["title"] == ERRORS[code].title


@pytest.mark.parametrize("code", [c for c, info in ERRORS.items() if info.status is None])
def test_a_code_that_is_never_an_http_answer_is_refused(code):
    with pytest.raises(ValueError):
        problem_response(code, "req-0a1b2c3d")


@pytest.mark.parametrize(("status", "code"), [(413, ErrorCode.REQ_TOO_LARGE), (415, ErrorCode.REQ_UNSUPPORTED_MEDIA_TYPE)])
def test_framework_413_and_415_map_to_their_registry_codes(status, code):
    assert_follows_contract(make_client().get(f"/_test/http/{status}"), code)


def test_an_unmapped_framework_status_is_answered_as_req_internal_and_logged(caplog):
    with caplog.at_level("WARNING", logger="vulnmart.problem"):
        r = make_client().get("/_test/http/418")
    assert_follows_contract(r, ErrorCode.REQ_INTERNAL)
    assert "418" in caplog.text


def test_only_useful_headers_of_a_framework_error_are_kept():
    r = make_client().get("/_test/http/413")
    assert r.headers["retry-after"] == "5"
    assert r.headers["www-authenticate"] == "Bearer"
    assert "x-internal" not in r.headers


def test_route_code_can_raise_a_registry_code():
    r = make_client().get("/_test/problem-error")
    assert_follows_contract(r, ErrorCode.ATT_NOT_FOUND)
    assert r.headers["retry-after"] == "7"


def test_problem_error_refuses_a_code_that_is_never_an_http_answer():
    with pytest.raises(ValueError):
        ProblemError(ErrorCode.INST_LOST)


def test_the_errors_list_is_capped_at_the_schema_limit():
    r = make_client().post("/_test/many", json={"values": ["x"] * (MAX_ERRORS + 10)})
    body = assert_follows_contract(r, ErrorCode.REQ_VALIDATION)
    assert len(body["errors"]) == MAX_ERRORS


def test_a_nested_location_is_a_json_pointer():
    r = make_client().post("/_test/order", json={"items": [{"quantity": "x", "name": "ok"}]})
    body = assert_follows_contract(r, ErrorCode.REQ_VALIDATION)
    assert body["errors"] == [{"pointer": "/items/0/quantity", "detail": "This value is not valid."}]


def test_a_key_with_slash_or_tilde_is_escaped_in_the_pointer():
    r = make_client().post("/_test/tags", json={"tags": {"a/b": "x", "c~d": "y"}})
    body = assert_follows_contract(r, ErrorCode.REQ_VALIDATION)
    assert {e["pointer"] for e in body["errors"]} == {"/tags/a~1b", "/tags/c~0d"}


def test_a_very_long_client_key_never_breaks_the_schema():
    r = make_client().post("/_test/tags", json={"tags": {"k" * 500: "x"}})
    body = assert_follows_contract(r, ErrorCode.REQ_VALIDATION)
    assert body["errors"] == [{"pointer": "", "detail": "This value is not valid."}]
    assert "kkkk" not in r.text


def test_a_query_parameter_error_names_its_location_first():
    r = make_client().get("/_test/query?limit=abc")
    body = assert_follows_contract(r, ErrorCode.REQ_VALIDATION)
    assert body["errors"] == [{"pointer": "/query/limit", "detail": "This value is not valid."}]


def test_a_body_that_is_not_json_says_so_in_a_fixed_text():
    r = make_client().post("/_test/items", content=b"not json", headers={"content-type": "application/json"})
    assert r.json()["errors"] == [{"pointer": "", "detail": "The request body is not valid JSON."}]
