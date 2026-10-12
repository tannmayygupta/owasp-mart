"""The wire pieces of the service: strict JSON, request signing (with the fixed vector of the contract), the rate limit, problem bodies."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from support import OPENAPI, ROOT

from vulnmart_orchestrator.auth import MAX_SKEW_SECONDS, NonceMemory, Verifier, body_sha256, sign, signing_string
from vulnmart_orchestrator.builder import parse_create
from vulnmart_orchestrator.jsonstrict import FloatToken, JsonStrictError, OutOfRangeInt, loads_strict
from vulnmart_models.error_codes import ERRORS, ErrorCode

from vulnmart_orchestrator.problems import ProblemError, pointer, problem_body
from vulnmart_orchestrator.ratelimit import RateLimiter

VECTOR = json.loads((ROOT / "contracts" / "orchestrator" / "examples" / "signing-vector.json").read_text(encoding="utf-8"))
KEY = b"FAKE-SIGNING-KEY-NOT-REAL-0000000000"


# ---- strict JSON (D2) ----
def test_integer_tokens_are_ints_and_other_numbers_are_marked():
    data = loads_strict(b'{"a":1,"b":-0,"c":9007199254740991,"d":1.0,"e":1e0,"f":9007199254740992,"g":123456789012345678901234567890,"h":true}')
    assert data["a"] == 1 and type(data["a"]) is int and data["b"] == 0 and type(data["b"]) is int
    assert type(data["c"]) is int and data["c"] == 2**53 - 1
    assert isinstance(data["d"], FloatToken) and isinstance(data["e"], FloatToken)
    assert isinstance(data["f"], OutOfRangeInt) and isinstance(data["g"], OutOfRangeInt)
    assert data["h"] is True and type(data["h"]) is bool


@pytest.mark.parametrize("text", [
    b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":-Infinity}', b'{"a":01}', b'{"a":+1}', b'{"a":.5}', b'{"a":1.}',
    b'{"a":0x10}', b"{not json", b"", b"\xff\xfe", b"[" * 100 + b"]" * 100, b'{"a":1} x',
])
def test_what_the_contract_refuses_is_refused(text):
    with pytest.raises(JsonStrictError):
        loads_strict(text)


def test_a_float_or_a_huge_integer_is_not_an_integer_for_the_create_body():
    from support import body

    for token, value in (("epoch", FloatToken("1.0")), ("epoch", OutOfRangeInt(2**53)), ("epoch", True)):
        with pytest.raises(Exception) as err:
            parse_create(body(**{token: value}))
        assert err.value.field == "/epoch"
    ok = parse_create(body(limits={**body()["limits"], "cpu_limit": FloatToken("2.0")}))
    assert ok.cpu_limit == 2.0


def test_the_body_text_is_never_in_the_error():
    try:
        loads_strict(b'{"secret":"VM{AAAAAAAAAAAAAAAAAAAAAAAA}","a":')
    except JsonStrictError as e:
        assert "VM{" not in str(e) and "secret" not in str(e)


# ---- signing (D1) ----
def test_the_signer_reproduces_the_fixed_vector_of_the_contract():
    assert body_sha256(VECTOR["body"].encode()) == VECTOR["body_sha256"]
    assert signing_string(VECTOR["method"], VECTOR["target"], VECTOR["timestamp"], VECTOR["nonce"], VECTOR["body_sha256"]) == VECTOR["signing_string"]
    assert sign(VECTOR["key"].encode(), VECTOR["method"], VECTOR["target"], VECTOR["timestamp"], VECTOR["nonce"], VECTOR["body_sha256"]) == VECTOR["signature"]


def at(seconds: int = 0) -> datetime:
    return datetime(2026, 10, 12, 12, 0, 0, tzinfo=timezone.utc) + timedelta(seconds=seconds)


def headers(*, key=KEY, method="GET", target="/v1/host", body=b"", ts=None, nonce="0123456789abcdef0123456789abcdef", moment=0):
    ts = ts or at(moment).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"x-vm-timestamp": ts, "x-vm-nonce": nonce, "x-vm-signature": sign(key, method, target, ts, nonce, body_sha256(body))}


def verifier(now=0):
    clock = {"t": now}
    v = Verifier(KEY, now=lambda: at(clock["t"]))
    return v, clock


def test_a_good_request_passes_once_and_a_replay_is_refused():
    v, _ = verifier()
    h = headers()
    assert v.verify("GET", "/v1/host", h, body_sha256(b"")) is True
    assert v.verify("GET", "/v1/host", h, body_sha256(b"")) is False


@pytest.mark.parametrize("what", ["key", "method", "target", "body", "missing-ts", "missing-nonce", "missing-sig", "short-nonce", "upper-nonce", "bad-version"])
def test_every_way_to_be_wrong_is_refused(what):
    v, _ = verifier()
    h = headers()
    method, target, body = "GET", "/v1/host", b""
    if what == "key":
        h = headers(key=b"WRONG-KEY-NOT-REAL-000000000000000000")
    elif what == "method":
        method = "POST"
    elif what == "target":
        target = "/v1/instances"
    elif what == "body":
        body = b"x"
    elif what == "missing-ts":
        del h["x-vm-timestamp"]
    elif what == "missing-nonce":
        del h["x-vm-nonce"]
    elif what == "missing-sig":
        del h["x-vm-signature"]
    elif what == "short-nonce":
        h = headers(nonce="abcd")
    elif what == "upper-nonce":
        h = headers(nonce="ABCDEF0123456789ABCDEF0123456789")
    else:
        h["x-vm-signature"] = h["x-vm-signature"].replace("v1=", "v2=")
    assert v.verify(method, target, h, body_sha256(body)) is False


def test_the_skew_is_sixty_seconds_either_way():
    for offset, ok in ((-MAX_SKEW_SECONDS, True), (MAX_SKEW_SECONDS, True), (-MAX_SKEW_SECONDS - 1, False), (MAX_SKEW_SECONDS + 1, False)):
        v, _ = verifier()
        assert v.verify("GET", "/v1/host", headers(moment=offset), body_sha256(b"")) is ok, offset


@pytest.mark.parametrize("ts", ["2026-13-45T99:99:99Z", "0000-00-00T00:00:00Z", "2026-10-12 12:00:00", "2026-10-12T12:00:00+00:00"])
def test_a_timestamp_that_is_not_a_real_utc_second_is_refused_even_when_signed(ts):
    v, _ = verifier()
    assert v.verify("GET", "/v1/host", headers(ts=ts), body_sha256(b"")) is False


def test_a_nonce_is_remembered_for_five_minutes_and_then_forgotten():
    t = {"now": 0.0}
    memory = NonceMemory(clock=lambda: t["now"])
    assert memory.add("a" * 32) and not memory.add("a" * 32)
    t["now"] = 299
    assert not memory.add("a" * 32)
    t["now"] = 301
    assert memory.add("a" * 32)


def test_the_nonce_memory_is_bounded():
    memory = NonceMemory(limit=3)
    for i in range(10):
        assert memory.add(f"{i:032x}")
    assert len(memory._seen) <= 3


def test_a_short_key_is_refused():
    with pytest.raises(ValueError):
        Verifier(b"short")


# ---- rate limit (D7) ----
def test_burst_of_forty_then_twenty_per_second():
    t = {"now": 100.0}
    limiter = RateLimiter(20, 40, clock=lambda: t["now"])
    assert all(limiter.check("c") is None for _ in range(40))
    wait = limiter.check("c")
    assert wait == 1  # whole seconds, at least 1
    t["now"] += 0.5  # 10 tokens come back
    assert all(limiter.check("c") is None for _ in range(10))
    assert limiter.check("c") is not None
    assert limiter.check("other") is None  # another client has its own bucket


def test_a_rate_of_zero_switches_the_limit_off():
    limiter = RateLimiter(0, 40)
    assert all(limiter.check("c") is None for _ in range(1000))


# ---- problem bodies (the closed IF-8 body) ----
def test_a_problem_is_the_closed_if8_body_with_registry_title_and_status():
    status, raw, rid = problem_body("ORCH-STALE-EPOCH", "/epoch")
    data = json.loads(raw)
    assert status == 409 and data["status"] == 409 and data["code"] == "ORCH-STALE-EPOCH"
    assert data["type"] == "urn:vulnmart:error:ORCH-STALE-EPOCH" and data["request_id"] == rid
    assert data["title"] == ERRORS[ErrorCode.ORCH_STALE_EPOCH].title
    assert "field" not in data  # a field is for a 422 only
    assert not {"detail", "instance", "message", "stack", "trace"} & set(data)
    status, raw, _ = problem_body("ORCH-VALIDATION", "/epoch")
    assert json.loads(raw)["field"] == "/epoch" and status == 422


def test_a_pointer_is_made_of_names_and_a_long_one_is_the_whole_body():
    assert pointer("query", "limit") == "/query/limit" and pointer("a/b", "c~d") == "/a~1b/c~0d"
    assert pointer("x" * 300) == ""


def test_every_orch_code_of_the_openapi_file_is_in_the_registry_with_its_status():
    import re

    spec_text = OPENAPI.read_text(encoding="utf-8")
    codes = set(re.findall(r"ORCH-[A-Z0-9]+(?:-[A-Z0-9]+)*", spec_text))
    assert codes and all(ErrorCode(c) for c in codes)
    for code in codes:
        assert ProblemError(code, "d").status == ERRORS[ErrorCode(code)].status
    assert ProblemError("ORCH-BUSY", "d").status == 429