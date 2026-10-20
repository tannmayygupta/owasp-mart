"""Story P-29 (FR-EXP-01, 02, 04): a person's own export through the route over the real lab runtime (a learner who captured a flag: the flag value never appears),
the audit entry, the CSV formula guard and the flag redaction. The company's export is in test_exports_company.py."""
from __future__ import annotations

import csv
import io
import json
import zipfile

import pytest

import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from support import play
from test_lab_api import EMAIL, OTHER_EMAIL, Session, World, start  # noqa: F401
from test_password_reset import clock, sessions  # noqa: F401
from vulnmart.ports.fakes import FakeAuditPort
from vulnmart.privacy.exports import ExportService, cell, csv_text, redact
from vulnmart.privacy.views import ViewHistory


def unzip(data: bytes) -> dict[str, str]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {n: z.read(n).decode("utf-8") for n in z.namelist()}


# ---- the pieces ----

def test_anything_shaped_like_a_flag_is_redacted():
    assert redact("GET /orders?id=1&x=VM{abc_123-DEF} HTTP") == "GET /orders?id=1&x=VM{redacted} HTTP"
    assert redact("vm{lower} and VM{unterminated") == "VM{redacted} and VM{redacted}"
    assert redact(None) is None and redact("nothing here") == "nothing here"


def test_csv_cells_that_a_spreadsheet_would_run_are_quoted():
    assert [cell(v) for v in ("=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "plain", None, 7)] == ["'=1+1", "'+cmd", "'-2", "'@SUM(A1)", "'\tx", "plain", "", "7"]
    rows = list(csv.reader(io.StringIO(csv_text(["a"], [["=HYPERLINK(\"x\")"]]))))
    assert rows == [["a"], ["'=HYPERLINK(\"x\")"]]


# ---- a learner's own export over the real lab ----

@pytest.fixture
def world(sessions, clock):
    from test_password_reset import add_user

    add_user(sessions)
    add_user(sessions, uid="u-BBBBBBBBBBBBBBBB", email=OTHER_EMAIL, name="Eve Other")
    w = World(sessions, clock)
    w.audit = FakeAuditPort()
    w.views = ViewHistory(sessions, now=clock)
    w.app.state.export_service = ExportService(sessions=sessions, audit=w.audit, consent=None, views=w.views, deletion=None, assessments=None, companies=None,
                                               lab=lambda: w.lab, now=clock)
    return w


def test_a_learner_exports_their_own_data_with_results_and_never_a_flag_value(world):
    ada = Session(world, EMAIL)
    iid, aid = start(world, ada)
    play(world.lab, iid)
    flag = world.lab.keys.flag(iid, "C01", 1)
    assert ada.post(f"/api/v1/attempts/{aid}/flags", {"challenge_key": "C01", "flag": flag}).json()["credit"] == "credited"
    r = ada.post("/api/v1/me/exports")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip" and r.headers["cache-control"] == "private, no-store"
    assert 'attachment; filename="vulnmart-my-data.zip"' == r.headers["content-disposition"]
    assert flag.encode() not in r.content
    files = unzip(r.content)
    assert set(files) == {"README.txt", "profile.json", "consents.json", "consents.csv", "attempts.json", "attempts.csv", "data_views.json", "data_views.csv",
                          "deletion_requests.json"}
    assert all(flag not in text for text in files.values())
    profile = json.loads(files["profile.json"])
    assert profile["email"] == EMAIL and "password" not in files["profile.json"].lower()
    attempts = json.loads(files["attempts.json"])["attempts"]
    assert [a["attempt_id"] for a in attempts] == [aid] and attempts[0]["mode"] == "learner"
    c01 = next(c for c in attempts[0]["per_challenge"] if c["challenge_key"] == "C01")
    assert c01["best_milestone"] == "M3" and c01["points"] > 0
    assert "C01" in files["attempts.csv"]
    assert world.audit.records[-1].action == "export.own" and world.audit.records[-1].details == {"attempts": 1}


def test_another_person_exports_only_their_own_data(world):
    ada = Session(world, EMAIL)
    start(world, ada)
    eve = Session(world, OTHER_EMAIL)
    files = unzip(eve.post("/api/v1/me/exports").content)
    assert json.loads(files["attempts.json"])["attempts"] == []
    assert json.loads(files["profile.json"])["email"] == OTHER_EMAIL and EMAIL not in "".join(files.values())


def test_the_export_needs_a_session_and_the_csrf_header_and_is_rate_limited(world):
    from test_lab_api import client

    anon = client(world.app)
    assert anon.post("/api/v1/me/exports").status_code == 401
    ada = Session(world, EMAIL)
    assert ada.post("/api/v1/me/exports", csrf=False).status_code == 403
    allowed = int(world.app.state.ports.settings.get("rate_export_per_user_per_hour"))
    codes = [ada.post("/api/v1/me/exports").status_code for _ in range(allowed + 1)]
    assert codes[-1] == 429 and set(codes[:-1]) == {200}


def test_without_a_lab_the_export_says_so(sessions, clock):
    from test_password_reset import add_user

    add_user(sessions)
    uid = "u-AAAAAAAAAAAAAAAA"
    service = ExportService(sessions=sessions, audit=FakeAuditPort(), consent=None, views=None, deletion=None, assessments=None, companies=None, lab=lambda: None,
                            now=clock)
    data, count = service.own_zip(uid)
    assert count == 0 and "not running" in json.loads(unzip(data)["attempts.json"])["note"]
