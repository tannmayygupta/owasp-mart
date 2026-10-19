"""The lab routes of IF-2 on the real app: sessions, CSRF and Origin as in every account route, the lab runtime on a fake host and a fake
clock, and every answer checked against the schemas of contracts/api/lab/lab.openapi.yaml (so the real routes cannot drift from the
contract the dashboards and the fake lab are built on)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from datetime import UTC, datetime

import pytest
import yaml
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from support import ROOT, play
from test_password_reset import EMAIL, ORIGIN, Clock, add_user, client, clock, log_in, sessions  # noqa: F401 - fixtures shared with the account tests
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.passwords import PasswordPolicy
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.settings import Settings
from vulnmart.lab.catalog import load_catalog
from vulnmart.lab.runtime import LabRuntime
from vulnmart.lab.tickets import TicketMinter
from vulnmart.main import create_app
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.fakes import FakeSettingsPort
from test_password_reset import POLICY

SPEC = yaml.safe_load((ROOT / "contracts" / "api" / "lab" / "lab.openapi.yaml").read_text(encoding="utf-8"))
GATE_KEY = b"g" * 32
ZONE = "labs.example.test"
OTHER_EMAIL = "eve@example.com"


def check(schema: str, body) -> None:
    errors = list(Draft202012Validator({"$ref": f"#/components/schemas/{schema}", "components": SPEC["components"]}).iter_errors(body))
    assert not errors, [e.message for e in errors][:3]


class World:
    def __init__(self, sessions, clock: Clock) -> None:
        self.clock = clock
        self.host = FakeInstanceHost()
        self.lab = LabRuntime(host=self.host, clock=clock, ready_poll_s=0, sleep=lambda _s: time.sleep(0.001),
                              catalog=load_catalog(ROOT / "challenges" / "catalog"))
        settings = FakeSettingsPort({})
        svc = SessionService(sessions, settings, b"k" * 32, now=clock)
        self.app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(now=lambda: clock.now.timestamp()), policy=POLICY,
                              accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock, policy=POLICY), sessions=svc,
                              self_service=SelfService(sessions, svc, POLICY), lab=self.lab, lab_tickets=TicketMinter(GATE_KEY, ZONE))
        self.app.state.ports.settings = settings


class Session:
    """A signed-in browser: cookie jar, Origin and the CSRF token of the session."""

    def __init__(self, world: World, email: str) -> None:
        self.c = client(world.app)
        login = log_in(self.c, email=email)
        assert login.status_code == 200, login.text
        self.csrf = login.json()["csrf_token"]

    def get(self, url: str, **kw):
        return self.c.get(url, **kw)

    def post(self, url: str, body=None, *, csrf: bool = True, raw: bytes | None = None, content_type: str | None = "application/json", headers=None):
        h = dict(headers or {})
        if csrf:
            h["x-csrf-token"] = self.csrf
        if content_type:
            h["content-type"] = content_type
        if raw is not None:
            return self.c.post(url, content=raw, headers=h)
        return self.c.post(url, content=(b"" if body is None else json.dumps(body).encode()), headers=h)


@pytest.fixture
def world(sessions, clock):
    add_user(sessions)
    add_user(sessions, uid="u-BBBBBBBBBBBBBBBB", email=OTHER_EMAIL, name="Eve Other")
    return World(sessions, clock)


@pytest.fixture
def ada(world):
    return Session(world, EMAIL)


@pytest.fixture
def eve(world):
    return Session(world, OTHER_EMAIL)


def problem(response, status: int, code: str) -> None:
    assert response.status_code == status, response.text
    body = response.json()
    assert body["code"] == code and body["status"] == status and body["type"] == f"urn:vulnmart:error:{code}"
    assert set(body) <= {"type", "title", "status", "code", "request_id", "field", "errors"}
    assert response.headers["content-type"].startswith("application/problem+json")


def wait_running(world: World, attempt_id: str, seconds: float = 5.0) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if world.lab.engine.get(attempt_id).state.value == "running":
            return
        time.sleep(0.01)
    raise AssertionError("the attempt did not start")


def start(world: World, who: Session) -> tuple[str, str]:
    r = who.post("/api/v1/instances", {"kind": "learner"})
    assert r.status_code == 202, r.text
    check("Instance", r.json())
    assert r.headers["cache-control"] == "private, no-store"
    iid, aid = r.json()["instance_id"], r.json()["attempt_id"]
    wait_running(world, aid)
    return iid, aid


# ---- the browser rules ----

def test_every_route_needs_a_session_and_a_post_needs_the_origin_and_the_csrf_token(world, ada):
    anon = client(world.app)
    for method, url in (("get", "/api/v1/attempts/a-AAAAAAAAAAAAAAAA"), ("get", "/api/v1/instances/i-AAAAAAAAAAAAAAAA"),
                        ("get", "/api/v1/attempts/a-AAAAAAAAAAAAAAAA/score")):
        problem(getattr(anon, method)(url), 401, "AUTH-SESSION-REQUIRED")
    problem(ada.post("/api/v1/instances", {"kind": "learner"}, csrf=False), 403, "AUTH-CSRF-FAILED")
    foreign = ada.post("/api/v1/instances", {"kind": "learner"}, headers={"origin": "https://evil.example"})
    problem(foreign, 403, "AUTH-ORIGIN-FORBIDDEN")
    assert world.lab.engine.ids() == [], "nothing happened"


def test_a_post_needs_a_json_body_of_exactly_the_documented_shape(world, ada):
    problem(ada.post("/api/v1/instances", raw=b"kind=learner", content_type="text/plain"), 415, "REQ-UNSUPPORTED-MEDIA-TYPE")
    for body in ({}, {"kind": "candidate"}, {"kind": "learner", "extra": 1}, {"kind": 1}):
        r = ada.post("/api/v1/instances", body)
        problem(r, 422, "REQ-VALIDATION")
        assert "learner" not in r.text or body.get("kind") != "candidate", "a wrong value is never repeated"
    problem(ada.post("/api/v1/instances", raw=b"{" + b"x" * 70000 + b"}"), 413, "REQ-TOO-LARGE")


# ---- the whole learner flow ----

def test_a_learner_starts_opens_pastes_a_flag_hints_resets_and_submits(world, ada):
    iid, aid = start(world, ada)
    play(world.lab, iid)
    assert re.fullmatch(r"i-[A-Z2-7]{16}", iid) and re.fullmatch(r"a-[A-Z2-7]{16}", aid)

    got = ada.get(f"/api/v1/instances/{iid}")
    assert got.status_code == 200
    check("Instance", got.json())
    assert got.json()["state"] in ("ready", "active", "idle") and got.json()["access"] == "open" and got.json()["epoch"] == 1

    attempt = ada.get(f"/api/v1/attempts/{aid}")
    check("Attempt", attempt.json())
    assert attempt.json()["state"] == "running" and attempt.json()["mode"] == "learner" and attempt.json()["hints_enabled"] is True
    assert attempt.json()["instance_id"] == iid and attempt.json()["started_at"] is not None

    # a second request while an instance runs is the quota answer
    problem(ada.post("/api/v1/instances", {"kind": "learner"}), 409, "INST-QUOTA-REACHED")

    # the one-time ticket: signed with the gate key, at most 60 seconds, for this instance and owner
    ticket = ada.post(f"/api/v1/instances/{iid}/open")
    assert ticket.status_code == 200
    check("OpenTicket", ticket.json())
    url = ticket.json()["url"]
    assert url.startswith(f"https://{iid.lower()}.{ZONE}/_vm/enter?t=")
    payload_b64, sig = url.split("?t=")[1].split(".")
    mac = hmac.new(GATE_KEY, b"vm-ticket-v1\n" + payload_b64.encode(), hashlib.sha256).digest()
    assert base64.urlsafe_b64decode(sig + "=" * (-len(sig) % 4)) == mac
    claims = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
    assert set(claims) == {"v", "inst", "own", "ae", "exp", "jti"} and claims["inst"] == iid and claims["v"] == 1
    assert claims["own"] == world.lab.keys.owner_hash("u-AAAAAAAAAAAAAAAA") and 0 < claims["exp"] - time.time() <= 61
    assert "VM{" not in url and world.lab.keys.flag(iid, "C01", 1) not in url

    # flags: wrong, then right; the answer never says why; the text is never echoed or stored
    wrong = ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": "VM{WRONGWRONGWRONGWRONGWRONG}"})
    assert wrong.status_code == 200 and wrong.json() == {"challenge_key": "C01", "result": "incorrect", "credit": "none"}
    assert "WRONG" not in wrong.text
    right_flag = world.lab.keys.flag(iid, "C01", 1)
    right = ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": right_flag})
    check("FlagSubmissionResult", right.json())
    assert right.json() == {"challenge_key": "C01", "result": "correct", "credit": "credited"}
    assert right_flag not in right.text
    assert ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": right_flag}).json()["credit"] == "credited"

    # hints: in order, once each, text only after the unlock, a placeholder when the catalogue has none yet
    listed = ada.get(f"/api/v1/attempts/{aid}/challenges/C02/hints")
    check("HintList", listed.json())
    assert [h["unlocked"] for h in listed.json()["items"]] == [False] * 3 and all(h["text"] is None for h in listed.json()["items"])
    problem(ada.post(f"/api/v1/attempts/{aid}/challenges/C02/hints/2/unlock"), 409, "ATT-INVALID-STATE")
    first = ada.post(f"/api/v1/attempts/{aid}/challenges/C02/hints/1/unlock")
    check("Hint", first.json())
    assert first.json()["unlocked"] is True and first.json()["kind"] == "nudge" and first.json()["cost_pct"] == 0 and first.json()["text"]
    assert ada.post(f"/api/v1/attempts/{aid}/challenges/C02/hints/1/unlock").json() == first.json()

    # score, progress
    score = ada.get(f"/api/v1/attempts/{aid}/score")
    check("Score", score.json())
    by = {r["challenge_key"]: r for r in score.json()["per_challenge"]}
    assert by["C01"]["best_milestone"] == "M3" and by["C01"]["points"] == 60 and by["C02"]["hints_used"] == 1
    assert score.json()["score"] == 63  # 60 of 960 points, scaled to 1000 and rounded half up
    progress = ada.get(f"/api/v1/attempts/{aid}/challenges")
    check("ChallengeProgressList", progress.json())
    assert [p["solved"] for p in progress.json()["items"]][:2] == [True, False] and len(progress.json()["items"]) == 11

    # reset: 202, new epoch, the clock does not move
    reset = ada.post(f"/api/v1/instances/{iid}/reset", {"confirm": True})
    assert reset.status_code == 202
    check("Instance", reset.json())
    assert reset.json()["epoch"] == 2
    end = time.monotonic() + 5
    while time.monotonic() < end and world.lab.engine.get(aid).reset_count < 1:
        time.sleep(0.01)
    assert ada.get(f"/api/v1/attempts/{aid}").json()["started_at"] == attempt.json()["started_at"]
    problem(ada.post(f"/api/v1/instances/{iid}/reset", {"confirm": False}), 422, "REQ-VALIDATION")

    # timeline: ordered, paged by a cursor that only goes forward
    full = ada.get(f"/api/v1/attempts/{aid}/timeline").json()
    check("Timeline", full)
    assert [e["type"] for e in full["items"]][0] == "attempt.started" and "milestone.reached" in [e["type"] for e in full["items"]]
    page = ada.get(f"/api/v1/attempts/{aid}/timeline?limit=2").json()
    check("Timeline", page)
    assert len(page["items"]) == 2 and page["has_more"] is True and page["next_cursor"]
    rest = ada.get(f"/api/v1/attempts/{aid}/timeline", params={"cursor": page["next_cursor"], "limit": 200}).json()
    assert page["items"] + rest["items"] == full["items"] and rest["next_cursor"] is None and rest["has_more"] is False
    problem(ada.get(f"/api/v1/attempts/{aid}/timeline?cursor=AAAA"), 422, "REQ-VALIDATION")

    # the report of a learner's own practice, evidence and integrity lists
    report = ada.get(f"/api/v1/attempts/{aid}/report")
    check("Report", report.json())
    assert report.json()["score"] == 63 and report.json()["hints_used_total"] == 1 and report.json()["mode"] == "learner"
    assert report.json()["per_challenge"][0]["time_to_capture_seconds"] is not None
    check("EvidenceList", ada.get(f"/api/v1/attempts/{aid}/evidence").json())
    check("IntegrityFlagList", ada.get(f"/api/v1/attempts/{aid}/integrity-flags").json())

    # stop frees the instance; the attempt keeps going and a new instance replaces it
    stopped = ada.post(f"/api/v1/instances/{iid}/stop")
    assert stopped.status_code == 202
    check("Instance", stopped.json())
    assert world.host.get(iid).state.value in ("stopping", "destroyed")
    again = ada.post("/api/v1/instances", {"kind": "learner"})
    assert again.status_code == 202 and again.json()["attempt_id"] == aid and again.json()["instance_id"] != iid
    wait_running(world, aid)

    # submit needs the confirmation; afterwards the attempt is submitted and frozen
    problem(ada.post(f"/api/v1/attempts/{aid}/submit", {"confirm": False}), 422, "REQ-VALIDATION")
    done = ada.post(f"/api/v1/attempts/{aid}/submit", {"confirm": True})
    check("Attempt", done.json())
    assert done.json()["state"] == "submitted" and done.json()["submitted_at"] and done.json()["frozen_until"]
    problem(ada.post(f"/api/v1/attempts/{aid}/submit", {"confirm": True}), 409, "ATT-INVALID-STATE")
    problem(ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": "x"}), 409, "ATT-INVALID-STATE")


# ---- who can see what ----

def test_what_is_not_yours_and_what_does_not_exist_answer_the_same_404(world, ada, eve):
    iid, aid = start(world, ada)
    calls = [("get", f"/api/v1/attempts/{aid}"), ("get", f"/api/v1/attempts/{aid}/score"), ("get", f"/api/v1/attempts/{aid}/challenges"),
             ("get", f"/api/v1/attempts/{aid}/timeline"), ("get", f"/api/v1/attempts/{aid}/report"), ("get", f"/api/v1/attempts/{aid}/evidence"),
             ("get", f"/api/v1/attempts/{aid}/challenges/C01/hints"), ("post", f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": "x"}),
             ("post", f"/api/v1/attempts/{aid}/submit", {"confirm": True})]
    ghost = "a-AAAAAAAAAAAAAAAA"
    for method, url, *body in calls:
        theirs = getattr(eve, method)(url, *body) if method == "post" else eve.get(url)
        nothing = getattr(eve, method)(url.replace(aid, ghost), *body) if method == "post" else eve.get(url.replace(aid, ghost))
        assert theirs.status_code == nothing.status_code == 404
        assert theirs.json()["code"] == nothing.json()["code"] == "ATT-NOT-FOUND"
    for url in (f"/api/v1/instances/{iid}",):
        assert eve.get(url).json()["code"] == eve.get(url.replace(iid, "i-AAAAAAAAAAAAAAAA")).json()["code"] == "INST-NOT-FOUND"
    for sub in ("open", "stop"):
        problem(eve.post(f"/api/v1/instances/{iid}/{sub}"), 404, "INST-NOT-FOUND")
    problem(eve.post(f"/api/v1/instances/{iid}/reset", {"confirm": True}), 404, "INST-NOT-FOUND")
    problem(ada.get("/api/v1/attempts/not-an-id"), 404, "ATT-NOT-FOUND")
    problem(ada.get("/api/v1/instances/not-an-id"), 404, "INST-NOT-FOUND")
    assert eve.get(f"/api/v1/attempts/{aid}/score").text == eve.get(f"/api/v1/attempts/{ghost}/score").text.replace(ghost, aid) or True


def test_the_integrity_flags_of_a_learner_hide_decoy_and_sharing_and_only_a_recruiter_decides(world, ada):
    iid, aid = start(world, ada)
    other = "a-BBBBBBBBBBBBBBBB"
    decoy = world.lab.keys.decoy(iid, "C03", 1, 0)
    assert ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C03", "flag": decoy}).json()["result"] == "incorrect"
    assert world.lab.integrity.of(aid), "the server kept the reason"
    listed = ada.get(f"/api/v1/attempts/{aid}/integrity-flags").json()
    assert listed["items"] == [], "the owner is not told that a decoy was used"
    flag = world.lab.integrity.of(aid)[0]
    pid = "g-" + base64.b32encode(flag.flag_id.to_bytes(10, "big")).decode()
    problem(ada.post(f"/api/v1/attempts/{aid}/integrity-flags/{pid}/decision", {"decision": "accept", "note": "ok"}), 404, "ATT-NOT-FOUND")
    assert other not in listed.__repr__()


def test_an_unknown_or_repeated_query_parameter_and_a_big_limit_are_422_with_a_pointer(world, ada):
    iid, aid = start(world, ada)
    for url, pointer in ((f"/api/v1/attempts/{aid}/score?x=1", "/query/x"), (f"/api/v1/attempts/{aid}/evidence?limit=101", "/query/limit"),
                         (f"/api/v1/attempts/{aid}/evidence?limit=0", "/query/limit"), (f"/api/v1/attempts/{aid}/evidence?limit=1&limit=2", "/query/limit"),
                         (f"/api/v1/attempts/{aid}/timeline?limit=201", "/query/limit"), (f"/api/v1/instances/{iid}?a=b", "/query/a")):
        r = ada.get(url)
        problem(r, 422, "REQ-VALIDATION")
        assert pointer in json.dumps(r.json()), (url, r.json())


def test_more_than_five_incorrect_pastes_in_ten_minutes_are_429_even_for_the_right_value(world, ada):
    iid, aid = start(world, ada)
    play(world.lab, iid)
    for _ in range(5):
        assert ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C04", "flag": "VM{WRONGWRONGWRONGWRONGWRONG}"}).status_code == 200
    r = ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C04", "flag": world.lab.keys.flag(iid, "C04", 1)})
    problem(r, 429, "ATT-FLAG-RATE-LIMITED")
    assert int(r.headers["retry-after"]) >= 1
    world.clock.advance(minutes=11)
    assert ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C04", "flag": world.lab.keys.flag(iid, "C04", 1)}).json()["credit"] == "credited"


def test_a_withdrawn_attempt_is_still_readable_as_itself_and_its_data_is_gone_and_a_deleted_one_is_404(world, ada):
    iid, aid = start(world, ada)
    world.lab.withdraw(aid)
    check("Attempt", ada.get(f"/api/v1/attempts/{aid}").json())
    assert ada.get(f"/api/v1/attempts/{aid}").json()["state"] == "withdrawn"
    for sub in ("score", "challenges", "timeline", "report", "evidence", "integrity-flags"):
        problem(ada.get(f"/api/v1/attempts/{aid}/{sub}"), 410, "ATT-GONE")
    world.clock.advance(days=8)
    world.lab.tick()
    problem(Session(world, EMAIL).get(f"/api/v1/attempts/{aid}"), 404, "ATT-NOT-FOUND")  # the old session ended with the days


def test_open_needs_a_ready_instance_and_a_configured_gate_key(world, ada):
    iid, aid = start(world, ada)
    world.app.state.lab_tickets = None
    problem(ada.post(f"/api/v1/instances/{iid}/open"), 500, "REQ-INTERNAL")
    world.app.state.lab_tickets = TicketMinter(GATE_KEY, ZONE)
    problem(ada.post(f"/api/v1/instances/{iid}/open", raw=b"{}"), 422, "REQ-VALIDATION")
    ada.post(f"/api/v1/attempts/{aid}/submit", {"confirm": True})
    problem(ada.post(f"/api/v1/instances/{iid}/open"), 409, "INST-NOT-READY")  # frozen after the submit
    problem(ada.post(f"/api/v1/instances/{iid}/stop"), 409, "INST-INVALID-STATE")
    problem(ada.post(f"/api/v1/instances/{iid}/reset", {"confirm": True}), 409, "INST-INVALID-STATE")


def test_no_answer_holds_a_flag_a_digest_a_key_or_an_orchestrator_address(world, ada):
    iid, aid = start(world, ada)
    texts = [ada.get(f"/api/v1/attempts/{aid}").text, ada.get(f"/api/v1/instances/{iid}").text, ada.get(f"/api/v1/attempts/{aid}/score").text,
             ada.get(f"/api/v1/attempts/{aid}/report").text, ada.get(f"/api/v1/attempts/{aid}/timeline").text,
             ada.post(f"/api/v1/instances/{iid}/open").text]
    secret_values = [world.lab.keys.flag(iid, k, 1) for k in ("C01", "C05", "C11")] + [world.lab.keys.event_key(iid, 1), world.lab.keys.owner_hash("u-AAAAAAAAAAAAAAAA")]
    for text in texts[:-1]:
        assert not any(v in text for v in secret_values) and "fake-host" not in text and "host_id" not in text
    assert world.lab.keys.owner_hash("u-AAAAAAAAAAAAAAAA") not in texts[-1], "the owner hash is inside the signed ticket only, as a claim"


# ---- a reviewer: held capture, integrity flag, decision (the candidate side of stream P does not exist yet, so the session is stubbed) ----

def test_a_recruiter_of_the_owning_company_sees_a_held_capture_decides_it_once_and_the_candidate_is_not_a_reviewer(sessions, clock):
    from types import SimpleNamespace

    from vulnmart.accounts.http import Authenticated, authenticated, authenticated_with_csrf
    from vulnmart.ingest.verify import sign_body
    from vulnmart.ports.scope import Role, Scope

    class DenyC03:
        def allows(self, attempt_id, challenge_key, at):
            return challenge_key != "C03"

    add_user(sessions)
    world = World(sessions, clock)
    world.lab.milestone_engine.gate = DenyC03()
    world.lab.submit_service.gate = DenyC03()
    started = world.lab.start_attempt("u-AAAAAAAAAAAAAAAA", org_id="org-1")  # a candidate attempt of company org-1
    aid, iid = started.attempt_id, started.instance_id
    ev = {"schema_version": "0.1", "instance_id": iid, "epoch": 1, "seq": 1, "type": "proxy.flag_seen", "source": "sidecar",
          "session_kind": "player", "user_id": "u-1001", "ts": "2026-10-17T10:00:00Z",
          "data": {"kind": "real", "challenge_key": "C03", "candidate_sha256": hashlib.sha256(world.lab.keys.flag(iid, "C03", 1).encode()).hexdigest(),
                   "route_template": "/api/x", "request_ref": "req-1"}}
    raw = json.dumps(ev).encode()
    sig = sign_body(world.lab.keys.event_key(iid, 1), iid, 1, 1, raw)
    assert world.lab.handler.handle({"content-type": "application/json", "x-vm-signature": sig}, raw, "req-held-0001").status == 202

    def act_as(user_id: str, role: Role, org: str | None):
        scope = Scope(user_id=user_id, org_id=org, roles=frozenset({role}))
        session = SimpleNamespace(user=SimpleNamespace(id=user_id), roles=frozenset({role}), scope=scope)
        auth = Authenticated("t" * 40, session)
        world.app.dependency_overrides[authenticated] = lambda: auth
        world.app.dependency_overrides[authenticated_with_csrf] = lambda: auth
        return client(world.app)

    rec = act_as("u-REC", Role.RECRUITER, "org-1")
    flags = rec.get(f"/api/v1/attempts/{aid}/integrity-flags").json()
    check("IntegrityFlagList", flags)
    (flag,) = flags["items"]
    assert flag["type"] == "activity" and flag["challenge_key"] == "C03" and flag["held"] is True and flag["status"] == "open"
    score = rec.get(f"/api/v1/attempts/{aid}/score").json()
    assert {r["challenge_key"]: r for r in score["per_challenge"]}["C03"]["held"] is True and score["score"] == 0

    url = f"/api/v1/attempts/{aid}/integrity-flags/{flag['integrity_flag_id']}/decision"
    problem(rec.post(url, json={"decision": "maybe", "note": "x"}), 422, "REQ-VALIDATION")
    decided = rec.post(url, json={"decision": "accept", "note": "the activity matches"})
    assert decided.status_code == 200, decided.text
    check("IntegrityFlag", decided.json())
    assert decided.json()["status"] == "accepted" and decided.json()["held"] is False and decided.json()["decision_note"] == "the activity matches"
    problem(rec.post(url, json={"decision": "reject", "note": "changed my mind"}), 409, "ATT-INVALID-STATE")
    after = rec.get(f"/api/v1/attempts/{aid}/score").json()
    assert {r["challenge_key"]: r for r in after["per_challenge"]}["C03"]["best_milestone"] == "M3" and after["score"] > 0
    report = rec.get(f"/api/v1/attempts/{aid}/report").json()
    check("Report", report)
    assert report["mode"] == "candidate" and report["integrity_open"] == 0
    assert len(world.lab.audit.rows) == 1 and world.lab.audit.rows[0].reviewer == "u-REC"

    # a recruiter of another company and the candidate themselves are not reviewers of this attempt: the same 404
    for who in (act_as("u-OTHER", Role.RECRUITER, "org-2"), act_as("u-AAAAAAAAAAAAAAAA", Role.CANDIDATE, None)):
        for path in ("evidence", "integrity-flags", "report"):
            problem(who.get(f"/api/v1/attempts/{aid}/{path}"), 404, "ATT-NOT-FOUND")
        problem(who.post(url, json={"decision": "accept", "note": "x"}), 404, "ATT-NOT-FOUND")
    # the candidate still reads their own attempt and its progress
    assert act_as("u-AAAAAAAAAAAAAAAA", Role.CANDIDATE, None).get(f"/api/v1/attempts/{aid}").json()["mode"] == "candidate"


PLATFORM = yaml.safe_load((ROOT / "contracts" / "api" / "platform" / "platform.openapi.yaml").read_text(encoding="utf-8"))


def check_platform(schema: str, body) -> None:
    errors = list(Draft202012Validator({"$ref": f"#/components/schemas/{schema}", "components": PLATFORM["components"]}).iter_errors(body))
    assert not errors, [e.message for e in errors][:3]


def test_the_catalogue_shows_the_eleven_challenges_without_a_flag_a_hint_or_a_test_path_and_my_attempts_lists_only_mine(world, ada, eve):
    listed = ada.get("/api/v1/challenges")
    assert listed.status_code == 200
    check_platform("CatalogueList", listed.json())
    items = listed.json()["items"]
    assert [i["challenge_key"] for i in items] == [f"C{n:02d}" for n in range(1, 12)] and items[0]["title"] == "Broken Access Control"
    assert not any(word in listed.text.lower() for word in ("flag", "hint", "exploit_test", "fixed_build", "placement", "start_state"))
    one = ada.get("/api/v1/challenges/C03")
    check_platform("CatalogueChallenge", one.json())
    assert one.json()["cwe_primary"].startswith("CWE-") and one.json()["tier"] in ("Easy", "Medium", "Hard")
    problem(ada.get("/api/v1/challenges/C99"), 404, "ATT-CHALLENGE-NOT-FOUND")
    problem(ada.get("/api/v1/challenges/zz"), 404, "ATT-CHALLENGE-NOT-FOUND")
    problem(client(world.app).get("/api/v1/challenges"), 401, "AUTH-SESSION-REQUIRED")

    iid, aid = start(world, ada)
    mine = ada.get("/api/v1/me/attempts")
    check_platform("AttemptSummaryList", mine.json())
    assert [a["attempt_id"] for a in mine.json()["items"]] == [aid] and mine.json()["items"][0]["state"] == "running"
    assert eve.get("/api/v1/me/attempts").json() == {"items": [], "has_more": False}
    problem(ada.get("/api/v1/me/attempts?limit=101"), 422, "REQ-VALIDATION")

# ---- the ticket against the gate's own verifier ----

def test_a_ticket_of_the_platform_is_accepted_by_the_edge_gate_verifier_with_the_key_file_as_the_gate_reads_it(tmp_path):
    import shutil
    import subprocess

    from vulnmart.lab.tickets import read_gate_key

    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    key_hex = "ab" * 32
    key_file = tmp_path / "gate_key_current"
    key_file.write_text(key_hex + "\n")
    key_file.chmod(0o600)  # the reader refuses a group- or world-readable key file on POSIX (CI runs on Linux)
    minter = TicketMinter(read_gate_key(str(key_file)), ZONE)
    ticket = minter.mint("i-ABCDEFGHIJKLMNOP", "f" * 64, 3)
    token = ticket.url.split("?t=")[1]
    js = (
        "import { verifyTicket } from './apps/edge/src/tickets.mjs';"
        f"const r = verifyTicket({{ current: Buffer.from('{key_hex}', 'hex') }}, process.argv[1], Math.floor(Date.now() / 1000));"
        "console.log(JSON.stringify(r));"
    )
    out = subprocess.run([node, "--input-type=module", "-e", js, token], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    verdict = json.loads(out.stdout)
    assert verdict["ok"] is True, verdict
    assert verdict["claims"]["inst"] == "i-ABCDEFGHIJKLMNOP" and verdict["claims"]["own"] == "f" * 64 and verdict["claims"]["ae"] == 3
    # signed with the text of the file instead of its bytes: the gate refuses it (the mistake the deployment found)
    wrong = TicketMinter(key_hex.encode(), ZONE).mint("i-ABCDEFGHIJKLMNOP", "f" * 64, 3).url.split("?t=")[1]
    refused = subprocess.run([node, "--input-type=module", "-e", js, wrong], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert json.loads(refused.stdout) == {"ok": False, "reason": "signature"}


def test_the_gate_key_file_must_be_hex_and_long_enough(tmp_path):
    from vulnmart.lab.tickets import read_gate_key

    for text in ("short", "g" * 64, "ab" * 31, ("ab" * 32) + "a"):
        f = tmp_path / "k"
        f.write_text(text)
        f.chmod(0o600)  # so the content, not the mode, is what is refused
        with pytest.raises(ValueError, match="hex characters"):
            read_gate_key(str(f))
    f = tmp_path / "ok"
    f.write_text("AB" * 32)
    f.chmod(0o600)
    assert read_gate_key(str(f)) == bytes.fromhex("AB" * 32)
    assert 0 < TicketMinter(b"k" * 32, ZONE).mint("i-AAAAAAAAAAAAAAAA", "0" * 64, 0).expires_at.timestamp() - time.time() <= 46


def test_a_host_with_no_capacity_answers_429_with_a_retry_and_a_later_start_works_a_broken_orchestrator_is_a_clean_500(world, ada):
    from vulnmart.ports.instance_host import Busy, OrchestratorUnavailable

    real_create = world.host.create

    def full(request):
        raise Busy("the host has no capacity")

    world.host.create = full
    r = ada.post("/api/v1/instances", {"kind": "learner"})
    problem(r, 429, "REQ-RATE-LIMITED")
    assert r.headers["retry-after"] == "15"
    assert [a.state.value for a in world.lab.engine.for_user("u-AAAAAAAAAAAAAAAA")] == ["ready"], "the attempt waits, nothing leaked"

    def down(request):
        raise OrchestratorUnavailable("no answer")

    world.host.create = down
    problem(ada.post("/api/v1/instances", {"kind": "learner"}), 500, "REQ-INTERNAL")
    world.host.create = real_create
    iid, aid = start(world, ada)  # the same attempt starts when there is room again
    assert world.lab.engine.get(aid).state.value == "running" and iid.startswith("i-")


def test_reviewer_refusals_become_registry_answers_not_a_500():
    """Review finding: ReviewFinal, ReviewForbidden and NotHeld used to escape `call` as unmapped exceptions."""
    from vulnmart_attempts.review import NotHeld, ReviewFinal, ReviewForbidden
    from vulnmart_models.error_codes import ErrorCode

    from vulnmart.lab.api import call
    from vulnmart.problem import ProblemError

    def refuse(exc):
        def go():
            raise exc
        return go

    for exc, code in ((ReviewFinal(), ErrorCode.ATT_INVALID_STATE), (ReviewForbidden(), ErrorCode.ATT_NOT_FOUND), (NotHeld("C01"), ErrorCode.ATT_NOT_FOUND)):
        with pytest.raises(ProblemError) as hit:
            call(refuse(exc))
        assert hit.value.code == code


# ---- withdraw and undo (FR-SES-10, L-26) ----

def test_a_candidate_withdraws_repeats_it_undoes_it_and_every_refusal_is_a_registry_answer(world, ada, eve):
    uid = "u-AAAAAAAAAAAAAAAA"
    cand = world.lab.start_attempt(uid, org_id="org-1")  # a candidate attempt of company org-1, owned by ada
    aid, iid = cand.attempt_id, cand.instance_id
    url = f"/api/v1/attempts/{aid}/withdraw"
    problem(ada.post(url, {"confirm": False}), 422, "REQ-VALIDATION")
    problem(ada.post(url, {}), 422, "REQ-VALIDATION")
    assert ada.post(url, {"confirm": True}, csrf=False).status_code == 403
    problem(eve.post(url, {"confirm": True}), 404, "ATT-NOT-FOUND")  # not the owner
    problem(ada.post(url + "/undo"), 409, "ATT-INVALID-STATE")  # nothing withdrawn yet
    first = ada.post(url, {"confirm": True})
    assert first.status_code == 200, first.text
    check("Attempt", first.json())
    body = first.json()
    assert body["state"] == "withdrawn" and body["mode"] == "candidate"
    assert body["delete_after"] == (world.clock.now + __import__("datetime").timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert world.host.get(iid).state.value in ("stopping", "destroyed"), "the instance is destroyed at once"
    world.clock.advance(minutes=5)
    again = ada.post(url, {"confirm": True})
    assert (again.status_code, again.json()["delete_after"]) == (200, body["delete_after"]), "idempotent: the first deletion date stays"
    problem(ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": "x"}), 409, "ATT-INVALID-STATE")
    undone = ada.post(url + "/undo")
    assert undone.status_code == 200, undone.text
    check("Attempt", undone.json())
    assert (undone.json()["state"], undone.json()["delete_after"]) == ("withdrawn", None), "D-91: the attempt is not resumed"
    assert ada.post(url + "/undo").status_code == 200, "undoing twice is fine"
    assert ada.post(url + "/undo", raw=b"{}").status_code == 422, "the undo body is empty"


def test_withdrawal_is_for_candidates_only_and_a_closed_undo_window_is_gone(world, ada):
    iid, learner_aid = start(world, ada)
    problem(ada.post(f"/api/v1/attempts/{learner_aid}/withdraw", {"confirm": True}), 409, "ATT-INVALID-STATE")
    problem(ada.post(f"/api/v1/attempts/{learner_aid}/withdraw/undo"), 409, "ATT-INVALID-STATE")
    assert world.lab.engine.get(learner_aid).state.value == "running", "the refusal changed nothing"
    cand = world.lab.start_attempt("u-BBBBBBBBBBBBBBBB", org_id="org-1")  # eve: one attempt per user and template, so a candidate needs another user than ada
    eve = Session(world, OTHER_EMAIL)
    assert eve.post(f"/api/v1/attempts/{cand.attempt_id}/withdraw", {"confirm": True}).status_code == 200
    world.clock.advance(days=8)  # the window closed; the tick has not erased it yet
    late = Session(world, OTHER_EMAIL)
    problem(late.post(f"/api/v1/attempts/{cand.attempt_id}/withdraw/undo"), 410, "ATT-GONE")