"""Structured logs and the secret filter (NFR-OBS-01, NFR-PRI-02): one JSON object per line, with the request id, and
nothing secret in it."""
from __future__ import annotations

import io
import json
import logging

import pytest
from fastapi.testclient import TestClient

from vulnmart.kernel.observability import REDACTED, JsonFormatter, accept_request_id, configure_logging, redact
from vulnmart.kernel.service import create_service_app
from vulnmart.kernel.settings import Settings


@pytest.fixture
def lines():
    stream = io.StringIO()
    handler = configure_logging("api", "DEBUG", stream=stream)
    yield lambda: [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]
    logging.getLogger().removeHandler(handler)


def test_a_log_line_is_one_json_object_with_the_fields(lines):
    logging.getLogger("vulnmart.test").info("hello %s", "world", extra={"attempt_id": "a-AAAAAAAAAAAAAAAA"})
    [line] = [x for x in lines() if x["logger"] == "vulnmart.test"]
    assert line["message"] == "hello world"
    assert (line["level"], line["service"], line["attempt_id"]) == ("INFO", "api", "a-AAAAAAAAAAAAAAAA")
    assert line["ts"].endswith("Z") and line["request_id"] is None


def test_lines_logged_during_a_request_carry_its_id(lines):
    app = create_service_app("api", checks={}, settings=Settings())

    @app.get("/_log")
    async def log_something() -> dict:
        logging.getLogger("vulnmart.test").warning("inside")
        return {}

    with TestClient(app) as c:
        c.get("/_log", headers={"X-Request-ID": "trace-0001-abcd"})
    inside = [x for x in lines() if x["message"] == "inside"]
    assert inside and inside[0]["request_id"] == "trace-0001-abcd"


@pytest.mark.parametrize(("message", "leak"), [
    ("login failed password=hunter2", "hunter2"),
    ("db postgresql://vulnmart:s3cret-pw@postgres:5432/vulnmart unreachable", "s3cret-pw"),
    ("captured VM{ABCDEFGHIJKLMNOPQRSTUVWX} in a response", "ABCDEFGHIJKLMNOPQRSTUVWX"),
    ("header authorization: Bearer abc.def.ghi", "abc.def.ghi"),
    ("token=eyJhbGciOi", "eyJhbGciOi"),
])
def test_secrets_in_a_message_are_redacted(lines, message, leak):
    logging.getLogger("vulnmart.test").error(message)
    text = json.dumps(lines())
    assert leak not in text and REDACTED in text


def test_secrets_in_extra_fields_are_redacted_by_key_and_by_value(lines):
    logging.getLogger("vulnmart.test").info("x", extra={
        "password": "hunter2", "csrf_token": "abc", "cookie": "__Host-vm_session=xyz", "dsn": "postgresql://a:b@c/d",
        "nested": {"api_key": "k-123", "flags": ["VM{ABCDEFGHIJKLMNOPQRSTUVWX}"]}, "user_id": "u-AAAAAAAAAAAAAAAA",
    })
    [line] = [x for x in lines() if x["logger"] == "vulnmart.test"]
    for key in ("password", "csrf_token", "cookie", "dsn"):
        assert line[key] == REDACTED, key
    assert line["nested"]["api_key"] == REDACTED
    assert "ABCDEFGHIJKLMNOPQRSTUVWX" not in json.dumps(line)
    assert line["user_id"] == "u-AAAAAAAAAAAAAAAA", "an ordinary id is kept"


def test_an_exception_logs_its_type_not_its_text_or_stack(lines):
    try:
        raise RuntimeError("password=hunter2 at db.internal")
    except RuntimeError:
        logging.getLogger("vulnmart.test").warning("failed", exc_info=True)
    [line] = [x for x in lines() if x["logger"] == "vulnmart.test"]
    assert line["error"] == "RuntimeError" and "stack" not in line
    assert "hunter2" not in json.dumps(line)


def test_redact_keeps_ordinary_values_and_shapes():
    assert redact({"a": [1, "two"], "b": None}) == {"a": [1, "two"], "b": None}
    assert redact("plain text") == "plain text"


def test_request_id_rules():
    assert accept_request_id("abcd-1234-efgh") == "abcd-1234-efgh"
    for bad in (None, "", "bad id!", "short", "x" * 65, "a\nb-1234567"):
        assert accept_request_id(bad).startswith("req-")


def test_the_formatter_never_fails_on_odd_extras():
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "msg", (), None)
    record.odd = object()
    assert json.loads(JsonFormatter("api").format(record))["message"] == "msg"


@pytest.mark.parametrize(("message", "leak"), [
    ("csrf_token=abc123x", "abc123x"),
    ("access_token: abc123y", "abc123y"),
    ("db_password=hunter3", "hunter3"),
    ("payload {'password': 'hunter4'}", "hunter4"),
    ('payload {"reset_token": "tok-555"}', "tok-555"),
    ("GET /reset?token=tok-666&x=1", "tok-666"),
    ("Cookie: a=1; __Host-vm_session=sess-777", "sess-777"),
    ("GET /flag?v=VM%7BABCDEFGHIJKLMNOPQRSTUVWX%7D", "ABCDEFGHIJKLMNOPQRSTUVWX"),
])
def test_prefixed_quoted_header_and_encoded_secrets_are_redacted(lines, message, leak):
    logging.getLogger("vulnmart.test").info(message)
    assert leak not in json.dumps(lines())
