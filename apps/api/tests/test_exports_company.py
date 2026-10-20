"""Story P-29 (FR-EXP-03, 04, OI-27): a recruiter's export of one template's results over the real company and assessment services, with a stand-in for the lab's
read side (one submitted attempt with a known score): CSV and JSON of scores, no evidence, the audit entry, the candidate's view history, another company refused,
and the route's gate (only recruiters)."""
from __future__ import annotations

import csv
import io
import json
import zipfile
from dataclasses import dataclass, field
from datetime import timedelta
from types import SimpleNamespace

import pytest

import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from test_assessments import active_company, assessments, basic, mail_rows, token_in  # noqa: F401
from test_companies import ADMIN_SCOPE, GOOD, audit, clock, companies, ended, org_row, sessions, signup, user_id, verify  # noqa: F401
from test_consent import add_user, client, make_app, sign_in
from test_invite_acceptance import participant
from vulnmart.accounts.directory import UserDirectory
from vulnmart.assessments.accept import InviteAcceptance
from vulnmart.assessments.service import TemplateNotFound
from vulnmart.ports.scope import Role, Scope
from vulnmart.privacy.exports import ExportService
from vulnmart.privacy.views import ViewHistory

CAND_EMAIL = "cand@example.org"


@dataclass
class FakeRecord:
    id: str
    org_id: str
    created_at: object = None
    started_at: object = None
    submitted_at: object = None
    purged_at: object = None
    state: SimpleNamespace = field(default_factory=lambda: SimpleNamespace(value="submitted"))


class FakeLab:
    """The read side of the lab runtime the company export uses: one attempt with a known score and one open integrity flag."""

    def __init__(self, rec: FakeRecord):
        self.rec = rec
        self.engine = SimpleNamespace(get=self._get)
        self.integrity = SimpleNamespace(of=lambda aid: [SimpleNamespace(status="open")])

    def _get(self, aid):
        if aid != self.rec.id:
            raise KeyError(aid)
        return self.rec

    def score_rows(self, aid):
        return 420, [{"challenge_key": "C01", "best_milestone": "M3", "points": 300, "held": False, "hints_used": 1},
                     {"challenge_key": "C02", "best_milestone": "M1", "points": 120, "held": False, "hints_used": 0}]

    def time_metrics(self, aid):
        return SimpleNamespace(headline={"C01": 600}, active_seconds=1500)


@pytest.fixture
def rig(sessions, companies, assessments, audit, clock):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    assessments.create_invite(owner, template.template_id, CAND_EMAIL)
    token = token_in(mail_rows(sessions)[-1])
    candidate_id = participant(sessions, CAND_EMAIL)
    accepted = InviteAcceptance(assessments, UserDirectory(sessions)).accept(candidate_id, token)
    views = ViewHistory(sessions, now=clock)
    lab = FakeLab(FakeRecord(id=accepted.attempt_id, org_id=str(owner.org_id), started_at=clock(), submitted_at=clock() + timedelta(minutes=30)))
    service = ExportService(sessions=sessions, audit=audit, consent=None, views=views, deletion=None, assessments=assessments, companies=companies,
                            lab=lambda: lab, now=clock)
    return SimpleNamespace(service=service, owner=owner, template=template, candidate_id=candidate_id, views=views, audit=audit, lab=lab)


def unzip(data: bytes) -> dict[str, str]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {n: z.read(n).decode("utf-8") for n in z.namelist()}


def test_a_recruiter_exports_one_template_s_scores_without_evidence_and_it_is_recorded(rig):
    data, count = rig.service.company_zip(rig.owner, rig.template.template_id)
    files = unzip(data)
    assert set(files) == {"README.txt", "results.csv", "results.json"} and count == 1
    rows = list(csv.reader(io.StringIO(files["results.csv"])))
    assert rows[0][:4] == ["email", "invite_state", "attempt_state", "score"]
    assert rows[0][-3:] == [f"points_{k}" for k in rig.template.challenge_keys]
    assert rows[1][0] == CAND_EMAIL and rows[1][2] == "submitted" and rows[1][3] == "420" and rows[1][7] == "1"
    payload = json.loads(files["results.json"])
    assert payload["candidates"][0]["results"]["active_seconds"] == 1500 and payload["template"]["template_id"] == rig.template.template_id
    assert "evidence" not in files["results.json"] and "VM{" not in "".join(files.values())
    assert rig.audit.records[-1].action == "export.company"
    assert rig.audit.records[-1].details == {"org": str(rig.owner.org_id), "template": rig.template.template_id, "candidates": 1}
    assert [v.action for v in rig.views.list_mine(rig.candidate_id)[0]] == ["exported"]


def test_another_company_cannot_export_the_template(rig, companies, sessions):
    signup(companies, email="olga@globex.example", company="Globex")
    verify(sessions, "olga@globex.example")
    other_org = str(org_row(sessions, "olga@globex.example").id)
    companies.approve(ADMIN_SCOPE, other_org)
    other = Scope(user_id=user_id(sessions, "olga@globex.example"), org_id=other_org, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))
    with pytest.raises(TemplateNotFound):
        rig.service.company_zip(other, rig.template.template_id)
    assert not any(e.action == "export.company" for e in rig.audit.records)


def test_the_route_is_only_for_recruiters_and_answers_a_zip(rig, sessions, clock, companies, assessments):
    app = make_app(sessions, clock, None)
    app.state.companies, app.state.assessments, app.state.export_service = companies, assessments, rig.service
    app.state.session_service.set_org_resolver(companies.membership_of)
    with client(app) as web:
        r = web.post("/api/v1/session", json={"email": "ana@acme.example", "password": GOOD})
        csrf = {"x-csrf-token": r.json()["csrf_token"]}
        got = web.post("/api/v1/company/exports", json={"template_id": rig.template.template_id}, headers=csrf)
        assert got.status_code == 200 and got.headers["content-type"] == "application/zip"
        assert got.headers["content-disposition"] == 'attachment; filename="vulnmart-results.zip"'
        assert "results.csv" in unzip(got.content)
        missing = web.post("/api/v1/company/exports", json={"template_id": "00000000-0000-4000-8000-000000000000"}, headers=csrf)
        assert (missing.status_code, missing.json()["code"]) == (404, "ATT-NOT-FOUND")
        web.cookies.clear()
        add_user(sessions, "u-LEARNERLEARNERLE", "lena@example.org")
        learner = sign_in(web, "lena@example.org")
        refused = web.post("/api/v1/company/exports", json={"template_id": rig.template.template_id}, headers=learner)
        assert (refused.status_code, refused.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")
