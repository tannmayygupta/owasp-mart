"""Story edge-4: the real event receiver (IF-4), one test per row of the plan's matrix, plus the HTTP front."""
from __future__ import annotations

import json
import logging
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from ingest_support import A as ENGINE_A
from ingest_support import World
from ingest_wire_support import A, B, JSON_HEADERS, KEYS, NOW, VECTOR, Parts, example, flag_event, signed

from vulnmart.ingest.handler import IngestHandler
from vulnmart.ingest.route import ROUTE, install_event_route
from vulnmart.ingest.store import EventSink, EventStore, InstanceEpochs, MemoryEventStore, MemoryInstanceEpochs, SecuritySink
from vulnmart.ingest.verify import sign_body, verify_signature
from vulnmart.ports.keys import derive_event_key
from vulnmart.problem import install_problem_handlers


def code(reply) -> str | None:
    return reply.body.get("code")


def test_python_key_derivation_matches_the_written_vector():
    from ingest_wire_support import MASTER
    for case in VECTOR["cases"]:
        assert derive_event_key(MASTER, case["instance_id"], case["epoch"]) == case["key"]


def test_ports_are_protocols_the_stores_fit():
    assert isinstance(MemoryEventStore(), EventStore)
    assert isinstance(MemoryInstanceEpochs(), InstanceEpochs)
    assert isinstance(Parts().security, SecuritySink)
    assert isinstance(lambda e, t: None, EventSink)


def test_good_event_is_202_and_stored_once():
    p = Parts()
    r = p.post(flag_event())
    assert (r.status, r.body) == (202, {"status": "accepted", "instance_id": A, "epoch": 1, "seq": 3})
    assert p.store.triples() == [(A, 1, 3)] and len(p.sunk) == 1


def test_identical_repeat_is_200_still_one_row_and_not_handed_on_again():
    p = Parts()
    ev = flag_event()
    assert p.post(ev).status == 202
    r = p.post(ev)
    assert (r.status, r.body["status"]) == (200, "duplicate")
    assert len(p.store) == 1 and len(p.sunk) == 1


def test_same_triple_other_body_is_409():
    p = Parts()
    assert p.post(flag_event()).status == 202
    r = p.post(flag_event(user_id="u-2002"))
    assert (r.status, code(r), r.problem) == (409, "EVT-DUPLICATE-MISMATCH", True)
    assert len(p.store) == 1 and len(p.sunk) == 1


def test_raw_bytes_are_signed_and_stored_not_a_reserialisation():
    p = Parts()
    ev = flag_event()
    pretty = json.dumps(ev, indent=2).encode()
    h, raw = signed(ev, body=pretty)
    assert p.handler.handle(h, raw).status == 202
    # the same event as compact bytes is another body for the same triple
    h2, raw2 = signed(ev)
    assert p.handler.handle(h2, raw2).status == 409


FORGERIES = {
    "wrong key": lambda ev: signed(ev, key="FAKE-WRONG-KEY-NOT-REAL-000000000000000"),
    "missing header": lambda ev: ({**JSON_HEADERS}, json.dumps(ev).encode()),
    "bad hex": lambda ev: signed(ev, headers={"x-vm-signature": "v1=" + "z" * 64}),
    "uppercase hex": lambda ev: signed(ev, headers={"x-vm-signature": signed(ev)[0]["x-vm-signature"].upper().replace("V1=", "v1=")}),
    "short": lambda ev: signed(ev, headers={"x-vm-signature": "v1=abcd"}),
    "no prefix": lambda ev: signed(ev, headers={"x-vm-signature": signed(ev)[0]["x-vm-signature"][3:]}),
    "trailing newline": lambda ev: signed(ev, headers={"x-vm-signature": signed(ev)[0]["x-vm-signature"] + "\n"}),
    "tampered body": lambda ev: (signed(ev)[0], json.dumps({**ev, "user_id": "u-9"}).encode()),
}


@pytest.mark.parametrize("name", sorted(FORGERIES))
def test_forged_is_401_with_one_body_and_a_security_event_and_nothing_stored(name):
    p = Parts()
    h, raw = FORGERIES[name](flag_event())
    r = p.handler.handle(h, raw, "req-test-0001")
    assert (r.status, code(r)) == (401, "EVT-BAD-SIGNATURE")
    assert len(p.store) == 0 and not p.sunk
    assert [x.kind for x in p.security.records] == ["bad_signature"]
    reference = Parts().post(flag_event(), key="FAKE-WRONG-KEY-NOT-REAL-000000000000000")
    assert r.body == reference.body  # the same body for every refusal


def test_unknown_instance_is_401_with_the_same_body():
    p = Parts({B: 1})
    r = p.post(flag_event())
    assert (r.status, code(r)) == (401, "EVT-BAD-SIGNATURE")
    assert [x.kind for x in p.security.records] == ["unknown_instance"]
    assert r.body == Parts().post(flag_event(), key="FAKE-WRONG-KEY-NOT-REAL-000000000000000").body


def test_epoch_above_the_current_one_is_401_and_not_stored():
    p = Parts({A: 1})
    r = p.post(flag_event(epoch=2))
    assert (r.status, code(r)) == (401, "EVT-BAD-SIGNATURE")
    assert len(p.store) == 0 and [x.kind for x in p.security.records] == ["future_epoch"]


def test_epoch_below_the_current_one_is_late_history_stored_under_its_own_epoch():
    p = Parts({A: 3})
    assert p.post(flag_event(epoch=1)).status == 202
    assert p.post(flag_event(epoch=3)).status == 202
    assert p.store.triples() == [(A, 1, 3), (A, 3, 3)]


def test_the_epoch_is_the_one_the_platform_set():
    p = Parts({A: 1})
    assert p.post(flag_event(epoch=2)).status == 401
    p.epochs.set(A, 2)
    assert p.post(flag_event(epoch=2)).status == 202


def test_signature_of_another_epoch_does_not_verify():
    p = Parts({A: 2})
    ev = flag_event(epoch=2)
    assert p.post(ev, key=KEYS.event_key(A, 1)).status == 401


def test_oversize_is_413_before_anything_else():
    p = Parts()
    r = p.handler.handle({}, b"x" * (16 * 1024 + 1))
    assert (r.status, code(r), "errors" not in r.body) == (413, "EVT-TOO-LARGE", True)
    assert len(p.security.records) == 0


def test_exactly_the_cap_is_not_413():
    p = Parts()
    r = p.handler.handle(JSON_HEADERS, b" " * (16 * 1024))
    assert r.status == 422


@pytest.mark.parametrize("ctype", [None, "text/plain", "application/jsonx", "application/xml", "multipart/form-data"])
def test_wrong_content_type_is_422(ctype):
    p = Parts()
    ev = flag_event()
    h, raw = signed(ev)
    if ctype is None:
        del h["content-type"]
    else:
        h["content-type"] = ctype
    r = p.handler.handle(h, raw)
    assert (r.status, code(r)) == (422, "EVT-SCHEMA") and len(p.store) == 0


@pytest.mark.parametrize("ctype", ["application/json", "Application/JSON", "application/json; charset=utf-8"])
def test_json_content_types_are_accepted(ctype):
    p = Parts()
    h, raw = signed(flag_event())
    h["content-type"] = ctype
    assert p.handler.handle(h, raw).status == 202


@pytest.mark.parametrize("body", [b"", b"not json", b"{", b'{"a": NaN}', b"null", b'"x"', b"7"])
def test_not_a_json_object_is_422(body):
    r = Parts().handler.handle(JSON_HEADERS, body)
    assert (r.status, code(r)) == (422, "EVT-SCHEMA")


def test_many_events_in_one_request_are_422():
    p = Parts()
    ev1, ev2 = flag_event(seq=3), flag_event(seq=4)
    for body in (json.dumps([ev1, ev2]).encode(), json.dumps([ev1]).encode(), json.dumps({"events": [ev1, ev2]}).encode()):
        h, raw = signed(ev1, body=body)
        r = p.handler.handle(h, raw)
        assert (r.status, code(r)) == (422, "EVT-SCHEMA")
    assert len(p.store) == 0
    assert p.post(ev1).status == 202 and p.post(ev2).status == 202  # one per request works


@pytest.mark.parametrize("over", [{"instance_id": "i-short"}, {"instance_id": 5}, {"epoch": 0}, {"epoch": "1"}, {"epoch": True},
                                  {"epoch": 1.5}, {"seq": 0}, {"seq": "3"}, {"seq": 2**53}])
def test_unusable_identity_is_422_before_the_signature(over):
    p = Parts()
    r = p.handler.handle(JSON_HEADERS, json.dumps({**flag_event(), **over}).encode())
    assert (r.status, code(r)) == (422, "EVT-SCHEMA") and not p.security.records


def test_integral_float_counts_as_the_integer():
    p = Parts()
    raw = json.dumps(flag_event()).replace('"seq": 3', '"seq": 3.0').encode()
    h, _ = signed(flag_event(), body=raw)
    assert p.handler.handle(h, raw).status == 202
    assert p.store.triples() == [(A, 1, 3)]


def test_bad_ts_is_422_and_ten_minutes_ahead_is_the_limit():
    p = Parts()
    for ts in ("yesterday", "2026-13-01T00:00:00Z", "2026-01-01T00:00:00", "2026-01-01T00:00:00Z\n"):
        r = p.post(flag_event(ts=ts))
        assert (r.status, code(r)) == (422, "EVT-SCHEMA"), ts
    edge = (NOW + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    over = (NOW + timedelta(minutes=10, seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    r = p.post(flag_event(ts=over, seq=5))
    assert (r.status, r.body["errors"]) == (422, [{"pointer": "/ts", "detail": "is too far in the future"}])
    assert p.post(flag_event(ts=edge, seq=6)).status == 202


def test_schema_refusal_names_the_place_and_never_echoes_the_value():
    p = Parts()
    ev = flag_event()
    ev["data"] = {**ev["data"], "VM{leaky}": "VM{AAAAAAAAAAAAAAAAAAAAAAAA}", "kind": "VM{AAAAAAAAAAAAAAAAAAAAAAAA}"}
    r = p.post(ev)
    assert r.status == 422
    text = json.dumps(r.body)
    assert "VM{" not in text and "AAAAAAAAAAAAAAAAAAAAAAAA" not in text
    assert all(set(e) == {"pointer", "detail"} for e in r.body["errors"])


def test_challenge_key_must_agree_in_a_flag_event():
    ev = flag_event(challenge_key="C02")
    r = Parts().post(ev)
    assert r.status == 422
    assert {"pointer": "/challenge_key", "detail": "must equal data.challenge_key when both are present"} in r.body["errors"]


def test_evidence_body_over_8_kib_is_413_and_under_the_schema_limit_is_not():
    ev = example("evidence.capture.json")
    big = {**ev, "data": {**ev["data"], "body": "x" * (8 * 1024 + 1)}}
    r = Parts().post(big)
    assert (r.status, code(r)) == (413, "EVT-TOO-LARGE")
    assert Parts().post(ev).status == 202


def test_store_full_is_503_but_a_repeat_is_still_200():
    p = Parts(max_stored=1)
    assert p.post(flag_event(seq=3)).status == 202
    r = p.post(flag_event(seq=4))
    assert (r.status, code(r)) == (503, "EVT-STORE-FULL")
    assert p.post(flag_event(seq=3)).status == 200


def test_a_failing_consumer_does_not_change_the_answer():
    def boom(event, at):
        raise RuntimeError("x")
    p = Parts(sink=boom)
    assert p.post(flag_event()).status == 202 and len(p.store) == 1


def test_bot_events_pass_through_unflagged_to_the_engine():
    w = World()
    w.add_instance(ENGINE_A)
    p = Parts(sink=w.engine.process)
    bot = example("bot.visit.json")
    r = p.post(bot)
    assert r.status == 202 and len(p.store) == 1
    assert not w.integrity.rows and not w.milestones.items and not p.security.records
    # a bot event is still a normal accepted event: the identical repeat is 200
    assert p.post(bot).status == 200


def test_engine_gets_an_accepted_event_once():
    w = World()
    w.add_instance(ENGINE_A)
    p = Parts(sink=w.engine.process)
    ev = flag_event()
    p.post(ev)
    p.post(ev)
    assert len(w.log.read(ENGINE_A)) == 1


def test_no_key_signature_or_event_data_in_the_log(caplog):
    caplog.set_level(logging.DEBUG)
    p = Parts()
    key = KEYS.event_key(A, 1)
    h, raw = signed(flag_event(), key="FAKE-WRONG-KEY-NOT-REAL-000000000000000")
    p.handler.handle(h, raw)
    p.post(flag_event(epoch=2))
    p.post(flag_event())
    text = caplog.text
    assert key not in text and h["x-vm-signature"] not in text and "candidate_sha256" not in text and "u-1001" not in text


def test_verify_signature_constant_time_api_and_vector_shape():
    key = KEYS.event_key(A, 1)
    sig = sign_body(key, A, 1, 3, b"{}")
    assert sig.startswith("v1=") and len(sig) == 67
    assert verify_signature(key, A, 1, 3, b"{}", sig)
    assert not verify_signature(key, A, 1, 4, b"{}", sig)
    assert not verify_signature(key, A, 1, 3, b"{} ", sig)
    assert not verify_signature(key, A, 1, 3, b"{}", None)


# ---- the HTTP front ----

def make_client(handler: IngestHandler | None = None) -> TestClient:
    app = FastAPI()
    install_problem_handlers(app)
    install_event_route(app, handler)
    return TestClient(app, raise_server_exceptions=False)


def test_http_good_replay_forged_and_headers():
    p = Parts()
    c = make_client(p.handler)
    h, raw = signed(flag_event())
    r = c.post(ROUTE, content=raw, headers=h)
    assert (r.status_code, r.json()["status"], r.headers["content-type"]) == (202, "accepted", "application/json")
    assert c.post(ROUTE, content=raw, headers=h).status_code == 200
    hf, rawf = signed(flag_event(seq=4), key="FAKE-WRONG-KEY-NOT-REAL-000000000000000")
    bad = c.post(ROUTE, content=rawf, headers=hf)
    assert (bad.status_code, bad.json()["code"], bad.headers["content-type"]) == (401, "EVT-BAD-SIGNATURE", "application/problem+json")
    assert bad.headers["cache-control"] == "private, no-store" and len(p.store) == 1


def test_http_oversize_declared_and_chunked_are_413():
    p = Parts()
    c = make_client(p.handler)
    assert c.post(ROUTE, content=b"x" * (16 * 1024 + 1), headers=JSON_HEADERS).status_code == 413

    pulled = []

    def chunks():
        for i in range(100):
            pulled.append(i)
            yield b"x" * 1024
    r = c.post(ROUTE, content=chunks(), headers=JSON_HEADERS)
    assert r.status_code == 413 and r.json()["code"] == "EVT-TOO-LARGE"
    assert len(p.store) == 0


def test_http_other_method_and_unconfigured_handler():
    c = make_client(Parts().handler)
    assert c.get(ROUTE).status_code == 405
    r = make_client().post(ROUTE, content=b"{}", headers=JSON_HEADERS)
    assert (r.status_code, r.json()["code"]) == (500, "REQ-INTERNAL")


def test_the_ingest_entrypoint_registers_the_route():
    from vulnmart.kernel.entrypoints import ingest
    assert any(getattr(r, "path", None) == ROUTE for r in ingest.app.routes)
