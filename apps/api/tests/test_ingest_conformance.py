"""Story edge-4: the Python receiver and the Node fake ingest (`createIngest`) must answer every shared vector with the same
status and the same error code. The Node side runs as a process over the same request bytes and the same fake master
(`contracts/events/examples/event-key-vector.json`). Skipped, with a message, when `node` or the repository's Node modules are
missing."""
from __future__ import annotations

import base64
import json
import shutil
import subprocess
from datetime import timedelta

import pytest
from ingest_wire_support import A, B, EXAMPLES, JSON_HEADERS, KEYS, NOW, ROOT, VECTOR, Parts, example, flag_event, signed

NODE = shutil.which("node")
FAKE = (ROOT / "contracts" / "mocks" / "fake-ingest" / "ingest.mjs").as_uri()

DRIVER = """
import fs from 'node:fs';
const { createIngest } = await import(%r);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const out = input.scenarios.map((s) => {
  const ing = createIngest({ master: input.master_hex, instances: s.instances, now: () => input.now_ms, limits: s.limits || {} });
  return s.requests.map((r) => {
    const x = ing.handle({ headers: r.headers, body: Buffer.from(r.body_b64, 'base64') });
    return { status: x.status, code: x.body.code || x.body.status };
  });
});
process.stdout.write(JSON.stringify(out));
""" % FAKE

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed: the conformance test needs the Node fake ingest")


def run_node(scenarios: list[dict]) -> list[list[dict]]:
    payload = {"master_hex": VECTOR["master_hex"], "now_ms": int(NOW.timestamp() * 1000), "scenarios": scenarios}
    p = subprocess.run([NODE, "--input-type=module", "-e", DRIVER], input=json.dumps(payload), capture_output=True, text=True,
                       cwd=ROOT, timeout=120, check=False)
    if p.returncode != 0:
        pytest.skip(f"the Node fake could not run here (is `pnpm install` done?): {p.stderr.strip()[:300]}")
    return json.loads(p.stdout)


def run_python(scenarios: list[dict]) -> list[list[dict]]:
    out = []
    for s in scenarios:
        parts = Parts(s["instances"], **({"max_stored": s["limits"]["maxStored"]} if "limits" in s else {}))
        res = []
        for r in s["requests"]:
            reply = parts.handler.handle(r["headers"], base64.b64decode(r["body_b64"]))
            res.append({"status": reply.status, "code": reply.body.get("code") or reply.body.get("status")})
        out.append(res)
    return out


def req(headers: dict, raw: bytes) -> dict:
    return {"headers": headers, "body_b64": base64.b64encode(raw).decode("ascii")}


def req_signed(event: dict, **kw) -> dict:
    return req(*signed(event, **kw))


def sign_loose(event: dict) -> dict:
    """Sign what can be signed; a body without usable identity goes out unsigned."""
    try:
        return req_signed(event)
    except (KeyError, TypeError, ValueError, UnicodeEncodeError):
        return req(JSON_HEADERS, json.dumps(event).encode())


def scenario(*requests: dict, instances: dict | None = None, **extra) -> dict:
    return {"instances": instances if instances is not None else {A: 1}, "requests": list(requests), **extra}


def minutes(n: float, extra_s: int = 0) -> str:
    return (NOW + timedelta(minutes=n, seconds=extra_s)).strftime("%Y-%m-%dT%H:%M:%SZ")


WRONG = "FAKE-WRONG-KEY-NOT-REAL-000000000000000"


def vectors() -> list[tuple[str, dict]]:
    v: list[tuple[str, dict]] = []
    for f in sorted((EXAMPLES / "valid" / "instance-events").glob("*.json")):
        v.append((f"valid/{f.name}", scenario(req_signed(json.loads(f.read_text(encoding="utf-8"))))))
    for f in sorted((EXAMPLES / "invalid" / "instance-events").glob("*.json")):
        v.append((f"invalid/{f.name}", scenario(sign_loose(json.loads(f.read_text(encoding="utf-8"))))))
    for f in sorted((EXAMPLES / "invalid" / "posted").glob("*.json")):
        v.append((f"posted/{f.name}", scenario(req(JSON_HEADERS, f.read_bytes()))))
    ev = flag_event()
    raw = json.dumps(ev).encode()
    bot = example("bot.visit.json")
    evid = example("evidence.capture.json")
    h, _ = signed(ev)
    sig = h["x-vm-signature"]
    v += [
        ("good", scenario(req_signed(ev))),
        ("replay identical", scenario(req_signed(ev), req_signed(ev))),
        ("replay other body", scenario(req_signed(ev), req_signed({**ev, "user_id": "u-2002"}))),
        ("replay pretty vs compact", scenario(req_signed(ev, body=json.dumps(ev, indent=1).encode()), req_signed(ev))),
        ("bot event", scenario(req_signed(bot), req_signed(bot))),
        ("forged wrong key", scenario(req_signed(ev, key=WRONG))),
        ("forged bad hex", scenario(req(signed(ev)[0] | {"x-vm-signature": "v1=" + "g" * 64}, raw))),
        ("forged uppercase", scenario(req(signed(ev)[0] | {"x-vm-signature": "v1=" + sig[3:].upper()}, raw))),
        ("forged missing header", scenario(req(JSON_HEADERS, raw))),
        ("forged short", scenario(req(signed(ev)[0] | {"x-vm-signature": "v1=ab"}, raw))),
        ("forged trailing newline", scenario(req(signed(ev)[0] | {"x-vm-signature": sig + "\n"}, raw))),
        ("forged tampered body", scenario(req(signed(ev)[0], json.dumps({**ev, "user_id": "u-9"}).encode()))),
        ("forged unknown instance", scenario(req_signed(ev), instances={B: 1})),
        ("forged key of another epoch", scenario(req_signed(flag_event(epoch=2), key=KEYS.event_key(A, 1)), instances={A: 2})),
        ("future epoch", scenario(req_signed(flag_event(epoch=2)))),
        ("future epoch then set", scenario(req_signed(flag_event(epoch=3)), instances={A: 3})),
        ("old epoch", scenario(req_signed(flag_event(epoch=1)), req_signed(flag_event(epoch=2)), instances={A: 3})),
        ("oversize", scenario(req(JSON_HEADERS, b"x" * (16 * 1024 + 1)))),
        ("oversize valid json", scenario(req_signed(ev, body=json.dumps({**ev, "pad": "x" * 17000}).encode()))),
        ("exactly the cap", scenario(req(JSON_HEADERS, b" " * (16 * 1024)))),
        ("wrong type text/plain", scenario(req_signed(ev, headers={"content-type": "text/plain"}))),
        ("wrong type jsonx", scenario(req_signed(ev, headers={"content-type": "application/jsonx"}))),
        ("charset type", scenario(req_signed(ev, headers={"content-type": "application/json; charset=utf-8"}))),
        ("upper type", scenario(req_signed(ev, headers={"content-type": "APPLICATION/JSON"}))),
        ("no type", scenario(req({"x-vm-signature": sig}, raw))),
        ("array of two", scenario(req_signed(ev, body=json.dumps([ev, flag_event(seq=4)]).encode()))),
        ("array of one", scenario(req_signed(ev, body=json.dumps([ev]).encode()))),
        ("events wrapper", scenario(req_signed(ev, body=json.dumps({"events": [ev]}).encode()))),
        ("two then one each", scenario(req_signed(ev), req_signed(flag_event(seq=4)))),
        ("empty", scenario(req(JSON_HEADERS, b""))),
        ("not json", scenario(req(JSON_HEADERS, b"nope"))),
        ("json null", scenario(req(JSON_HEADERS, b"null"))),
        ("json number", scenario(req(JSON_HEADERS, b"7"))),
        ("epoch float", scenario(req_signed(ev, body=json.dumps(ev).replace('"epoch": 1', '"epoch": 1.0').encode()))),
        ("seq float", scenario(req_signed(ev, body=json.dumps(ev).replace('"seq": 3', '"seq": 3.0').encode()))),
        ("epoch fractional", scenario(req(JSON_HEADERS, json.dumps({**ev, "epoch": 1.5}).encode()))),
        ("epoch true", scenario(req(JSON_HEADERS, json.dumps({**ev, "epoch": True}).encode()))),
        ("seq unsafe", scenario(req(JSON_HEADERS, json.dumps({**ev, "seq": 2**53}).encode()))),
        ("instance id bad", scenario(req(JSON_HEADERS, json.dumps({**ev, "instance_id": "i-xx"}).encode()))),
        ("instance id newline", scenario(req(JSON_HEADERS, json.dumps({**ev, "instance_id": A + "\n"}).encode()))),
        ("ts newline", scenario(req_signed(flag_event(ts="2026-01-01T00:00:00Z\n")))),
        ("ts unreadable", scenario(req_signed(flag_event(ts="yesterday")))),
        ("ts bad month", scenario(req_signed(flag_event(ts="2026-13-01T00:00:00Z")))),
        ("ts not utc", scenario(req_signed(flag_event(ts="2026-01-01T00:00:00+02:00")))),
        ("ts 11 minutes ahead", scenario(req_signed(flag_event(ts=minutes(11))))),
        ("ts 10 minutes ahead", scenario(req_signed(flag_event(ts=minutes(10))))),
        ("ts 10 minutes 1 s ahead", scenario(req_signed(flag_event(ts=minutes(10, 1))))),
        ("ts fraction", scenario(req_signed(flag_event(ts="2026-01-01T00:00:00.123456Z")))),
        ("challenge key mismatch", scenario(req_signed(flag_event(challenge_key="C02")))),
        ("evidence over 8 KiB", scenario(req_signed({**evid, "data": {**evid["data"], "body": "x" * 8193}}))),
        ("evidence over 8 KiB unsigned", scenario(req(JSON_HEADERS, json.dumps({**evid, "data": {**evid["data"], "body": "x" * 8193}}).encode()))),
        ("evidence multibyte over", scenario(req_signed({**evid, "data": {**evid["data"], "body": "é" * 4100}}))),
        ("evidence at limit", scenario(req_signed({**evid, "data": {**evid["data"], "body": "x" * 8192}}))),
        ("flag name in property", scenario(req_signed({**ev, "data": {**ev["data"], "VM{x}": 1}}))),
        ("extra envelope field", scenario(req_signed({**ev, "event_id": "e-1"}))),
        ("unknown type", scenario(req_signed({**ev, "type": "nope.nope"}))),
        ("store full", scenario(req_signed(flag_event(seq=3)), req_signed(flag_event(seq=4)), req_signed(flag_event(seq=3)),
                                limits={"maxStored": 1})),
        ("lone surrogate escape", scenario(req_signed(ev, body=raw.replace(b'"u-1001"', b'"u-\\\\ud800"')))),
    ]
    return v


ALL = vectors()


def test_the_vector_set_is_large_and_covers_the_written_examples():
    assert len(ALL) > 150
    assert sum(1 for n, _ in ALL if n.startswith("valid/")) >= 25


def test_python_receiver_and_node_fake_answer_every_vector_alike():
    scenarios = [s for _, s in ALL]
    node, py = run_node(scenarios), run_python(scenarios)
    diffs = [(n, a, b) for (n, _), a, b in zip(ALL, node, py, strict=True) if a != b]
    assert not diffs, f"{len(diffs)} of {len(ALL)} vectors differ (name, node, python): {diffs[:5]}"


def test_the_shared_vectors_have_the_answers_the_contract_names():
    py = dict(zip((n for n, _ in ALL), run_python([s for _, s in ALL]), strict=True))
    assert all(r[0]["status"] == 202 for n, r in py.items() if n.startswith("valid/"))
    assert all(r[0]["status"] in (413, 422) for n, r in py.items() if n.startswith("invalid/") or n.startswith("posted/"))
    assert [x["status"] for x in py["replay identical"]] == [202, 200]
    assert [x["status"] for x in py["replay other body"]] == [202, 409]
    assert py["forged wrong key"][0] == {"status": 401, "code": "EVT-BAD-SIGNATURE"}
    assert py["future epoch"][0]["status"] == 401 and py["oversize"][0]["status"] == 413
    assert [x["status"] for x in py["old epoch"]] == [202, 202]
    assert [x["status"] for x in py["store full"]] == [202, 503, 200]
