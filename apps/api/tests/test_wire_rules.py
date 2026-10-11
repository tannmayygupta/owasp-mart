"""Wire rules of IF-5 that both hosts must keep alike (story 1.15, ADR 0028): integers are integer tokens only,
a cursor is checked the same way, the HTTP client refuses a TLS context that does not verify.

The `kind` fixture runs the shared tests against FakeInstanceHost and against HttpInstanceHost plus the fake service."""
from __future__ import annotations

import dataclasses
import json
import ssl

import pytest

from support import PLATFORM_KEY, ServiceProcess, create_request, raw_call, reset_request
from vulnmart.ports.http_instance_host import HttpInstanceHost
from vulnmart.ports.instance_host import (
    Access, CursorInvalid, InstanceState, ValidationFailed,
)

S = InstanceState
NOT_INTEGERS = [1.0, True, "1", None]


def _limits(req, **kw):
    return dataclasses.replace(req, limits=dataclasses.replace(req.limits, **kw))


# ---- integers are integer tokens, on both hosts ----
@pytest.mark.parametrize("bad", NOT_INTEGERS)
def test_a_create_epoch_that_is_not_an_integer_is_a_validation_error(harness, bad):
    req = dataclasses.replace(create_request(), epoch=bad)
    with pytest.raises(ValidationFailed) as err:
        harness.host.create(req)
    assert err.value.field == "/epoch"
    assert harness.host.host_status().instances == 0


@pytest.mark.parametrize("name", ["memory_mb", "pids_limit", "idle_minutes", "max_minutes"])
@pytest.mark.parametrize("bad", [256.0, True])
def test_a_limit_that_is_not_an_integer_is_a_validation_error(harness, name, bad):
    req = _limits(create_request(), **{name: bad})
    with pytest.raises(ValidationFailed) as err:
        harness.host.create(req)
    assert err.value.field == f"/limits/{name}"


@pytest.mark.parametrize("bad", [True, "1", None])
def test_cpu_limit_must_be_a_real_number_and_not_a_boolean(harness, bad):
    with pytest.raises(ValidationFailed) as err:
        harness.host.create(_limits(create_request(), cpu_limit=bad))
    assert err.value.field == "/limits/cpu_limit"


def test_cpu_limit_two_and_two_point_zero_are_the_same_request(harness):
    # cpu_limit is the one number field that is not an integer; it is compared by value, so 2 and 2.0 are one request
    req = _limits(create_request(), cpu_limit=2)
    harness.host.create(req)
    assert harness.host.create(_limits(req, cpu_limit=2.0)).changed is False  # a repeat, not a mismatch


@pytest.mark.parametrize("bad", [1.0, True])
def test_a_decoy_index_that_is_not_an_integer_is_a_validation_error(harness, bad):
    req = create_request()
    decoys = (dataclasses.replace(req.material.decoys[0], index=bad),)
    req = dataclasses.replace(req, material=dataclasses.replace(req.material, decoys=decoys))
    with pytest.raises(ValidationFailed) as err:
        harness.host.create(req)
    assert err.value.field == "/decoys/0/index"


@pytest.mark.parametrize("bad", [2.0, True, "2"])
def test_a_reset_epoch_that_is_not_an_integer_is_a_validation_error(harness, bad):
    req = create_request()
    harness.host.create(req)
    harness.settle(req.instance_id, S.READY)
    with pytest.raises(ValidationFailed) as err:
        harness.host.reset(req.instance_id, dataclasses.replace(reset_request(2), epoch=bad))
    assert err.value.field == "/epoch"
    assert harness.host.get(req.instance_id).epoch == 1


@pytest.mark.parametrize("bad", [1.0, True, "1"])
def test_an_access_epoch_that_is_not_an_integer_is_a_validation_error(harness, bad):
    req = create_request()
    harness.host.create(req)
    with pytest.raises(ValidationFailed) as err:
        harness.host.set_access(req.instance_id, Access.OPEN, bad)
    assert err.value.field == "/access_epoch"
    assert harness.host.get(req.instance_id).access_epoch == 0


@pytest.mark.parametrize("big", [2**53, 2**63, 10**30])
def test_an_integer_above_two_to_the_53_minus_1_is_refused(harness, big):
    req = create_request()
    harness.host.create(req)
    with pytest.raises(ValidationFailed) as err:
        harness.host.set_access(req.instance_id, Access.OPEN, big)
    assert err.value.field == "/access_epoch"
    assert harness.host.set_access(req.instance_id, Access.OPEN, 2**53 - 1).access_epoch == 2**53 - 1  # the largest one is fine


@pytest.mark.parametrize("bad", [True, 1.0, 0, 501, -1])
def test_a_list_limit_that_is_not_a_plain_integer_in_range_is_refused(harness, bad):
    with pytest.raises(ValidationFailed) as err:
        harness.host.list_instances(limit=bad)
    assert err.value.field == "limit"


# ---- a cursor is the same thing on both hosts ----
GARBAGE_CURSORS = ["!!", "AAAA", "x" * 200, "", "a" * 23, "a" * 25, "bm90LWFuLWlk", "aS1BQUFBQUFBQUFBQUFBQUE", "%00", "AAAAAAAAAAAAAAAAAAAAAAAA"]


@pytest.mark.parametrize("cursor", GARBAGE_CURSORS)
def test_a_garbage_cursor_is_refused_with_its_own_problem_type(harness, cursor):
    with pytest.raises(CursorInvalid) as err:
        harness.host.list_instances(cursor=cursor)
    assert err.value.code == "ORCH-CURSOR-INVALID" and err.value.field == "cursor"


def test_a_cursor_from_a_page_still_works(harness):
    reqs = [create_request() for _ in range(3)]
    for r in reqs:
        harness.host.create(r)
    page = harness.host.list_instances(limit=2)
    assert page.next_cursor and len(page.next_cursor) == 24
    assert len(harness.host.list_instances(cursor=page.next_cursor, limit=2).items) == 1


# ---- the HTTP client refuses a TLS context that does not verify ----
def _ctx(verify_mode, check_hostname):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = check_hostname
    ctx.verify_mode = verify_mode
    return ctx


@pytest.mark.parametrize("mode,hostname", [
    (ssl.CERT_NONE, False), (ssl.CERT_OPTIONAL, False), (ssl.CERT_REQUIRED, False),
])
def test_an_https_client_refuses_a_context_that_does_not_verify(mode, hostname):
    with pytest.raises(ValueError, match="verify"):
        HttpInstanceHost("https://orchestrator.example.invalid", PLATFORM_KEY, ssl_context=_ctx(mode, hostname))


def test_an_https_client_accepts_a_context_that_verifies_the_certificate_and_the_name():
    HttpInstanceHost("https://orchestrator.example.invalid", PLATFORM_KEY, ssl_context=_ctx(ssl.CERT_REQUIRED, True))
    HttpInstanceHost("https://orchestrator.example.invalid", PLATFORM_KEY, ssl_context=ssl.create_default_context())


@pytest.mark.parametrize("url", ["http://orchestrator.example.invalid", "http://10.0.0.5:8443", "http://127.0.0.1.evil.invalid", "http://localhost.evil.invalid"])
def test_plain_http_is_for_loopback_only(url):
    with pytest.raises(ValueError):
        HttpInstanceHost(url, PLATFORM_KEY)


# ---- the service reads the number tokens of the body itself ----
@pytest.fixture
def svc():
    s = ServiceProcess()
    yield s
    s.stop()


def _body_text(req=None, **over):
    body = json.dumps((req or create_request()).to_json(), separators=(",", ":"))
    for old, new in over.items():
        assert old in body, old
        body = body.replace(old, new, 1)
    return body.encode()


@pytest.mark.parametrize("old,new,field", [
    ('"epoch":1', '"epoch":1.0', "/epoch"), ('"epoch":1', '"epoch":1e0', "/epoch"), ('"epoch":1', '"epoch":1E0', "/epoch"),
    ('"epoch":1', '"epoch":true', "/epoch"), ('"epoch":1', '"epoch":10e-1', "/epoch"), ('"epoch":1', '"epoch":9007199254740993', "/epoch"),
    ('"epoch":1', '"epoch":9007199254740992', "/epoch"), ('"memory_mb":256', '"memory_mb":256.0', "/limits/memory_mb"),
    ('"memory_mb":256', '"memory_mb":2.56e2', "/limits/memory_mb"), ('"pids_limit":512', '"pids_limit":512.0', "/limits/pids_limit"),
    ('"index":0', '"index":0.0', "/decoys/0/index"), ('"index":0', '"index":false', "/decoys/0/index"),
    ('"cpu_limit":1.5', '"cpu_limit":true', "/limits/cpu_limit"),
])
def test_the_service_refuses_a_number_that_is_not_an_integer_token(svc, old, new, field):
    res = raw_call(svc.url, "POST", "/v1/instances", _body_text(**{old: new}))
    assert res[0] == 422, res[1]
    data = json.loads(res[1])
    assert data["code"] == "ORCH-VALIDATION" and data["field"] == field


@pytest.mark.parametrize("token", ["2.0", "2", "2e0", "20e-1"])
def test_the_service_compares_cpu_limit_by_value(svc, token):
    req = create_request()
    first = raw_call(svc.url, "POST", "/v1/instances", _body_text(req, **{'"cpu_limit":1.5': '"cpu_limit":2'}))
    assert first[0] == 202
    again = raw_call(svc.url, "POST", "/v1/instances", _body_text(req, **{'"cpu_limit":1.5': f'"cpu_limit":{token}'}))
    assert again[0] == 200, again[1]


def test_the_service_refuses_non_finite_and_bad_json_numbers(svc):
    for token in ["NaN", "Infinity", "-Infinity", "01", "+1", ".5", "1.", "0x10"]:
        res = raw_call(svc.url, "POST", "/v1/instances", _body_text(**{'"epoch":1': f'"epoch":{token}'}))
        assert res[0] == 422 and json.loads(res[1])["code"] == "ORCH-VALIDATION", token


def test_the_service_refuses_an_access_epoch_given_as_1e0(svc):
    host = HttpInstanceHost(svc.url, PLATFORM_KEY)
    req = create_request()
    host.create(req)
    for token in ["1.0", "1e0", "true"]:
        body = ('{"access":"open","access_epoch":%s}' % token).encode()
        res = raw_call(svc.url, "POST", f"/v1/instances/{req.instance_id}/access", body)
        assert res[0] == 422 and json.loads(res[1])["field"] == "/access_epoch", token
    assert host.get(req.instance_id).access_epoch == 0
