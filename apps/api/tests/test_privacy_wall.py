"""Story P-30 (FR-DSH-06): the privacy wall in every view. No dashboard or API answer shows a learner's practice data to a recruiter, or one user's flags, progress
or score to another user, and no company reads another company's data.

Two parts. `CLASSES` puts every operation of the bundle (IF-1 and IF-2) in one class and names the test that proves the wall for it; a new operation without a class,
or a class pointing to a test that does not exist, fails `test_every_operation_is_classified_and_has_a_wall_test`. Then one combined world: the real lab runtime with
the real company, invite, consent, deletion, view-history and export services on SQLite, with two learners (Ada, who captured a flag, and Eve), two companies
(Rita's and Rob's) and Cam, a candidate of Rita's company whose attempt the consent created (state `ready`). Every role tries the other parties' data, and every try fails.
"""
from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from support import ROOT, play
from test_assessments import KEYS, active_company, assessments, basic, mail_rows, token_in  # noqa: F401
from test_companies import ADMIN_SCOPE, GOOD, T0, audit, clock, companies, ended, org_row, sessions, signup, user_id, verify  # noqa: F401
from test_password_reset import ORIGIN  # the origin the app accepts
from vulnmart.accounts import security
from vulnmart.accounts.directory import UserDirectory
from vulnmart.accounts.models import User, UserRole
from vulnmart.accounts.passwords import PasswordPolicy
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.sessions import SessionService
from vulnmart.assessments.accept import InviteAcceptance, InviteConsentTargets
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.settings import Settings
from vulnmart.lab.catalog import load_catalog
from vulnmart.lab.runtime import LabRuntime
from vulnmart.lab.tickets import TicketMinter
from vulnmart.main import create_app
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.privacy.consent import ConsentService
from vulnmart.privacy.deletion import DeletionService
from vulnmart.privacy.exports import ExportService
from vulnmart.privacy.retention.records import SqlAttemptRecords
from vulnmart.privacy.views import ViewHistory

BUNDLE = json.loads((ROOT / "contracts" / "api" / "bundle" / "openapi.json").read_text(encoding="utf-8"))
TESTS = Path(__file__).parent

# ---- every operation, its class, and the test that proves the wall for it ----
# public: no session and nobody's data; self: only the caller's own data, the client names no id; own_id: the client names an id that must be the caller's;
# company: only the caller's company; admin: only an admin with a second factor (anyone else gets the answer of a route that does not exist).
W = "test_privacy_wall.py::"
CLASSES: dict[str, tuple[str, str]] = {
    **{op: ("public", W + "test_public_routes_carry_nobody_s_data") for op in (
        "getHealth", "createAccount", "verifyEmail", "resendVerification", "createSession", "completeMfaLogin", "requestPasswordReset", "confirmPasswordReset",
        "openInvite", "signupRecruiter", "listCatalogue", "getCatalogueChallenge")},
    **{op: ("self", W + "test_self_routes_show_only_the_caller_s_data") for op in (
        "getSession", "deleteSession", "getMe", "updateMe", "changePassword", "startMfaEnrolment", "disableMfa", "confirmMfaEnrolment", "listMyConsents",
        "listMyDeletionRequests", "listMyDataViews", "listMyInvites", "exportMyData", "listMyAttempts", "requestInstance", "getMyProgress")},
    "listMySessions": ("self", "test_my_sessions_api.py::test_the_list_shows_only_my_live_sessions_and_marks_the_current_one"),
    "logOutEverywhere": ("self", "test_my_sessions_api.py::test_log_out_everywhere_ends_every_session_clears_the_cookie_and_is_audited"),
    "revokeMySession": ("own_id", "test_my_sessions_api.py::test_another_users_ref_ends_nothing"),
    **{op: ("self", "test_live_authorisation.py::test_two_people_never_share_a_user_stream_and_two_companies_never_share_a_company_stream") for op in ("openLiveStream", "getLiveSnapshot", "createLiveTicket")},
    **{op: ("own_id", W + "test_another_learner_cannot_use_an_attempt_or_instance_of_mine") for op in (
        "getInstance", "openInstance", "resetInstance", "stopInstance", "getAttempt", "startAttempt", "submitAttempt", "submitFlag", "getScore", "listChallenges",
        "listHints", "unlockHint", "listEvidence", "listIntegrityFlags", "getReport", "getTimeline", "beginChallenge")},
    **{op: ("own_id", W + "test_another_person_cannot_use_a_consent_deletion_invite_or_withdrawal_of_mine") for op in (
        "getConsentNotice", "recordConsent", "createDeletionRequest", "cancelDeletionRequest", "acceptInvite", "withdrawAttempt", "undoWithdrawal")},
    **{op: ("company", W + "test_another_company_sees_none_of_a_company_s_data") for op in (
        "getMyCompany", "reapplyCompany", "getCompanyTerms", "acceptCompanyTerms", "listTemplates", "createTemplate", "getTemplate", "updateTemplate", "deleteTemplate",
        "listCompanyInvites", "createInvites", "actOnInvite", "exportCompanyResults", "decideIntegrityFlag", "releaseResults")},
    **{op: ("admin", W + "test_admin_routes_answer_everyone_else_like_unknown_routes") for op in (
        "listPendingCompanies", "decideCompany", "listUsers", "actOnUser", "forceStopInstance", "listSettings", "updateSetting", "resetSetting", "listQuotas",
        "setQuota", "removeQuota", "getCapacity", "listJobs")},
    "listAuditLog": ("admin", "test_breakglass.py::test_reading_the_audit_log_is_itself_audited_and_only_for_admins"),
    **{op: ("admin", "test_breakglass.py::test_a_session_alerts_the_other_admin_and_the_company_records_reads_and_is_reviewed_by_the_other_admin") for op in (
        "listBreakGlassSessions", "openBreakGlass", "readBreakGlassAttempt", "closeBreakGlass", "reviewBreakGlass")},
}


def operations() -> dict[str, tuple[str, str]]:
    return {o["operationId"]: (m.upper(), p) for p, ops in BUNDLE["paths"].items() for m, o in ops.items() if isinstance(o, dict) and "operationId" in o}


def test_every_operation_is_classified_and_has_a_wall_test():
    ops = operations()
    missing = sorted(set(ops) - set(CLASSES))
    assert not missing, f"operations without a privacy-wall class: {missing}"
    assert not sorted(set(CLASSES) - set(ops)), "classes for operations that no longer exist"
    for op, (_, where) in CLASSES.items():
        file, name = where.split("::")
        text = (TESTS / file).read_text(encoding="utf-8")
        assert f"def {name}(" in text, f"{op}: {where} does not exist"


# ---- the combined world ----

class World:
    def __init__(self, sessions, clock, companies, assessments, audit):
        self.sessions, self.clock = sessions, clock
        self.lab = LabRuntime(host=FakeInstanceHost(), clock=clock, ready_poll_s=0, sleep=lambda _s: time.sleep(0.001),
                              catalog=load_catalog(ROOT / "challenges" / "catalog"))
        settings = FakeSettingsPort()
        policy = PasswordPolicy()
        svc = SessionService(sessions, settings, b"k" * 32, now=clock)
        svc.set_org_resolver(companies.membership_of)
        roles = RoleService(sessions, audit)
        consent = ConsentService(sessions, InviteConsentTargets(assessments, self.lab.attempts, roles), audit, settings, KEYS, now=clock)
        self.app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(now=lambda: clock.now.timestamp()), policy=policy,
                              accounts=AccountService(sessions, settings, public_origin=ORIGIN, now=clock, policy=policy), sessions=svc,
                              self_service=SelfService(sessions, svc, policy), lab=self.lab, lab_tickets=TicketMinter(b"g" * 32, "labs.example.test"),
                              consent=consent)
        st = self.app.state
        st.ports.settings = settings
        views = ViewHistory(sessions, now=clock)
        deletion = DeletionService(sessions, assessments, SqlAttemptRecords(sessions), settings, audit, None, None, now=clock)
        st.companies, st.assessments, st.view_history, st.deletion_service = companies, assessments, views, deletion
        st.invite_acceptance = InviteAcceptance(assessments, UserDirectory(sessions))
        st.export_service = ExportService(sessions=sessions, audit=audit, consent=consent, views=views, deletion=deletion, assessments=assessments,
                                          companies=companies, lab=lambda: self.lab, now=clock)

    def browser(self, email: str) -> "Browser":
        return Browser(self.app, email)

    def learner(self, uid: str, email: str) -> None:
        with self.sessions.begin() as s:
            s.add(User(id=uid, account_type="participant", email=email, email_ci=email, password_hash=security.hash_password(GOOD), display_name=email.split("@")[0],
                       status="active", email_verified_at=T0))
            s.flush()
            s.add(UserRole(user_id=uid, role="learner", account_type="participant"))


class Browser:
    def __init__(self, app, email: str):
        self.c = TestClient(app, headers={"origin": ORIGIN}, base_url="https://testserver", raise_server_exceptions=False)
        r = self.c.post("/api/v1/session", json={"email": email, "password": GOOD})
        assert r.status_code == 200, r.text
        self.csrf = r.json()["csrf_token"]

    def get(self, url: str, **kw):
        return self.c.get(url, **kw)

    def post(self, url: str, body=None):
        return self.c.post(url, json=body, headers={"x-csrf-token": self.csrf}) if body is not None else self.c.post(url, headers={"x-csrf-token": self.csrf})

    def put(self, url: str, body):
        return self.c.put(url, json=body, headers={"x-csrf-token": self.csrf})

    def delete(self, url: str, body=None):
        return self.c.request("DELETE", url, json=body, headers={"x-csrf-token": self.csrf})

    def patch(self, url: str, body):
        return self.c.patch(url, json=body, headers={"x-csrf-token": self.csrf})


ADA, EVE, CAM = "u-ADAADAADAADAADAA", "u-EVEEVEEVEEVEEVEE", "u-CAMCAMCAMCAMCAMC"
ADA_EMAIL, EVE_EMAIL, CAM_EMAIL = "ada@learners.example", "eve@learners.example", "cam@candidates.example"
RITA, ROB = "ana@acme.example", "rob@globex.example"


def wait_running(lab, attempt_id: str) -> None:
    end = time.monotonic() + 5
    while time.monotonic() < end:
        if lab.engine.get(attempt_id).state.value == "running":
            return
        time.sleep(0.01)
    raise AssertionError("the attempt did not start")


@pytest.fixture
def w(sessions, clock, companies, assessments, audit):
    world = World(sessions, clock, companies, assessments, audit)
    world.learner(ADA, ADA_EMAIL)
    world.learner(EVE, EVE_EMAIL)
    # Ada practises and captures C01
    ada = world.browser(ADA_EMAIL)
    r = ada.post("/api/v1/instances", {"kind": "learner"})
    assert r.status_code == 202, r.text
    world.ada_instance, world.ada_attempt = r.json()["instance_id"], r.json()["attempt_id"]
    wait_running(world.lab, world.ada_attempt)
    play(world.lab, world.ada_instance)
    world.ada_flag = world.lab.keys.flag(world.ada_instance, "C01", 1)
    assert ada.post(f"/api/v1/attempts/{world.ada_attempt}/flags", {"challenge_key": "C01", "flag": world.ada_flag}).json()["credit"] == "credited"
    world.ada_request = ada.post("/api/v1/me/deletion-requests", {"kind": "learner"}).json()["request_id"]
    # Rita's company invites Cam, who accepts, consents and starts
    owner = active_company(companies, sessions)
    world.template = assessments.create_template(owner, basic(hints_mode="on", hint_cost_pct=10)).template_id
    assessments.create_invite(owner, world.template, CAM_EMAIL)
    world.cam_token = token_in(mail_rows(sessions)[-1])
    world.learner(CAM, CAM_EMAIL)
    cam = world.browser(CAM_EMAIL)
    accepted = cam.post("/api/v1/invites/accept", {"token": world.cam_token}).json()
    world.cam_attempt, world.cam_invite = accepted["attempt_id"], accepted["invite_id"]
    notice = cam.get("/api/v1/consent/notice", params={"attempt_id": world.cam_attempt}).json()
    world.cam_notice = notice
    granted = cam.post("/api/v1/consent", {"attempt_id": world.cam_attempt, "notice_version": notice["notice_version"],
                                           "notice_text_sha256": notice["notice_text_sha256"], "decision": "granted"})
    assert granted.status_code in (200, 201), granted.text
    # the grant creates the attempt in the lab (state `ready`); the candidate starts it through startAttempt (H-356, D-80)
    assert world.lab.engine.get(world.cam_attempt).state.value == "ready"
    # Rob's company, approved, terms accepted, with a template of its own
    signup(companies, email=ROB, company="Globex", name="Rob Owner")
    verify(sessions, ROB)
    companies.approve(ADMIN_SCOPE, str(org_row(sessions, ROB).id))
    rob_id = user_id(sessions, ROB)
    terms = companies.terms_for(rob_id)
    companies.accept_terms(rob_id, terms.version, terms.sha256)
    return world


def secret_markers(w) -> list[str]:
    """Strings that must never reach another party: Ada's flag, her ids and address, Cam's ids, address and token."""
    return [w.ada_flag, w.ada_attempt, w.ada_instance, ADA_EMAIL, w.ada_request, w.cam_attempt, CAM_EMAIL, w.cam_token, w.cam_invite]


def leaks(text: str, w, allowed: tuple[str, ...] = ()) -> list[str]:
    return [m for m in secret_markers(w) if m and m not in allowed and m in text]


# ---- the classes ----

def test_public_routes_carry_nobody_s_data(w):
    anon = TestClient(w.app, headers={"origin": ORIGIN}, base_url="https://testserver", raise_server_exceptions=False)
    for r in (anon.get("/api/v1/health"), anon.post("/api/v1/invites/open", json={"token": "nope"})):
        assert not leaks(r.text, w)
    eve = w.browser(EVE_EMAIL)  # the catalogue needs a session but is the same for everyone
    for r in (eve.get("/api/v1/challenges"), eve.get("/api/v1/challenges/C01")):
        assert r.status_code == 200 and not leaks(r.text, w) and "VM{" not in r.text
    # opening Cam's link shows the assessment, never Cam's address
    assert CAM_EMAIL not in anon.post("/api/v1/invites/open", json={"token": w.cam_token}).text


def test_self_routes_show_only_the_caller_s_data(w):
    eve = w.browser(EVE_EMAIL)
    for url in ("/api/v1/session", "/api/v1/me", "/api/v1/me/consents", "/api/v1/me/deletion-requests", "/api/v1/me/data-views", "/api/v1/me/invites",
                "/api/v1/me/attempts", "/api/v1/me/progress"):
        r = eve.get(url)
        assert r.status_code == 200, (url, r.text)
        assert not leaks(r.text, w), (url, leaks(r.text, w))
    exported = eve.post("/api/v1/me/exports")
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as z:
        everything = "".join(z.read(n).decode("utf-8") for n in z.namelist())
    assert not leaks(everything, w) and EVE_EMAIL in everything
    # Ada's own export holds her data but never her flag value
    ada_zip = w.browser(ADA_EMAIL).post("/api/v1/me/exports").content
    assert w.ada_flag.encode() not in ada_zip


def test_another_learner_cannot_use_an_attempt_or_instance_of_mine(w):
    eve = w.browser(EVE_EMAIL)
    a, i = w.ada_attempt, w.ada_instance
    tries = [eve.get(f"/api/v1/instances/{i}"), eve.post(f"/api/v1/instances/{i}/open"), eve.post(f"/api/v1/instances/{i}/reset", {"confirm": True}),
             eve.post(f"/api/v1/instances/{i}/stop"), eve.get(f"/api/v1/attempts/{a}"), eve.post(f"/api/v1/attempts/{a}/start"),
             eve.post(f"/api/v1/attempts/{a}/submit", {"confirm": True}), eve.post(f"/api/v1/attempts/{a}/flags", {"challenge_key": "C02", "flag": "VM{x}"}),
             eve.get(f"/api/v1/attempts/{a}/score"), eve.get(f"/api/v1/attempts/{a}/challenges"), eve.get(f"/api/v1/attempts/{a}/challenges/C01/hints"),
             eve.post(f"/api/v1/attempts/{a}/challenges/C01/hints/1/unlock"), eve.get(f"/api/v1/attempts/{a}/evidence"),
             eve.get(f"/api/v1/attempts/{a}/integrity-flags"), eve.get(f"/api/v1/attempts/{a}/report"), eve.get(f"/api/v1/attempts/{a}/timeline"),
             eve.post(f"/api/v1/attempts/{a}/challenges/C01/begin")]
    for r in tries:
        assert r.status_code == 404, r.text
        assert not leaks(r.text, w, allowed=(a, i))
    # nothing changed: Ada's attempt still runs, her instance is still hers, her score still counts C01
    assert w.lab.engine.get(a).state.value == "running"
    ada = w.browser(ADA_EMAIL)
    assert ada.get(f"/api/v1/attempts/{a}/score").json()["score"] > 0
    # the candidate and the learner cannot read each other either
    cam = w.browser(CAM_EMAIL)
    assert cam.get(f"/api/v1/attempts/{a}/report").status_code == 404
    assert ada.get(f"/api/v1/attempts/{w.cam_attempt}/report").status_code == 404
    # a recruiter never sees a person's practice history
    rita = w.browser(RITA)
    for url in (f"/api/v1/attempts/{a}", f"/api/v1/attempts/{a}/report", f"/api/v1/attempts/{a}/evidence", f"/api/v1/attempts/{a}/timeline",
                f"/api/v1/attempts/{a}/score", f"/api/v1/attempts/{a}/challenges"):
        assert rita.get(url).status_code == 404, url


def test_another_person_cannot_use_a_consent_deletion_invite_or_withdrawal_of_mine(w):
    eve = w.browser(EVE_EMAIL)
    c = w.cam_attempt
    assert eve.get("/api/v1/consent/notice", params={"attempt_id": c}).status_code == 404
    n = w.cam_notice  # the real notice values, so the refusal is the ownership check, not the validation of the body
    refused = eve.post("/api/v1/consent", {"attempt_id": c, "notice_version": n["notice_version"], "notice_text_sha256": n["notice_text_sha256"], "decision": "declined"})
    assert refused.status_code == 404, refused.text
    assert eve.post("/api/v1/me/deletion-requests", {"kind": "candidate", "attempt_id": c}).status_code == 404
    assert eve.delete(f"/api/v1/me/deletion-requests/{w.ada_request}").status_code == 404
    accepted = eve.post("/api/v1/invites/accept", {"token": w.cam_token})
    assert accepted.status_code == 409 and CAM_EMAIL not in accepted.text
    assert eve.post(f"/api/v1/attempts/{c}/withdraw", {"confirm": True}).status_code == 404
    assert eve.post(f"/api/v1/attempts/{c}/withdraw/undo").status_code == 404
    # nothing changed for Cam and Ada
    assert w.lab.engine.get(c).state.value == "ready"
    assert [r["status"] for r in w.browser(ADA_EMAIL).get("/api/v1/me/deletion-requests").json()["items"]] == ["pending"]


def test_another_company_sees_none_of_a_company_s_data(w):
    rob = w.browser(ROB)
    assert rob.get("/api/v1/company").json()["company_name"] == "Globex"
    assert rob.get("/api/v1/company/templates").json() == {"items": []}
    assert rob.get("/api/v1/company/invites").json() == {"items": []}
    for r in (rob.get(f"/api/v1/company/templates/{w.template}"), rob.put(f"/api/v1/company/templates/{w.template}", basic(title="taken")),
              rob.delete(f"/api/v1/company/templates/{w.template}"), rob.post(f"/api/v1/company/invites/{w.cam_invite}/actions", {"action": "revoke"}),
              rob.post("/api/v1/company/exports", {"template_id": w.template}),
              rob.post("/api/v1/company/invites", {"template_id": w.template, "emails": ["x@example.org"]})):
        assert r.status_code in (404, 409), r.text
        assert not leaks(r.text, w)
    # Rob cannot read or decide on Cam's attempt; Rita can read it (the control)
    c = w.cam_attempt
    for url in (f"/api/v1/attempts/{c}", f"/api/v1/attempts/{c}/report", f"/api/v1/attempts/{c}/evidence", f"/api/v1/attempts/{c}/integrity-flags",
                f"/api/v1/attempts/{c}/timeline", f"/api/v1/attempts/{c}/challenges", f"/api/v1/attempts/{c}/score"):
        assert rob.get(url).status_code == 404, url
    assert rob.post(f"/api/v1/attempts/{c}/integrity-flags/f-AAAAAAAAAAAAAAAA/decision", {"decision": "accept", "note": "x"}).status_code == 404
    assert rob.post(f"/api/v1/attempts/{c}/release").status_code == 404  # another company cannot release the results either (H-355)
    assert w.browser(RITA).get(f"/api/v1/attempts/{c}/report").status_code == 200
    # Rob's look left no trace in Cam's view history; Rita's did
    views = w.browser(CAM_EMAIL).get("/api/v1/me/data-views").json()["items"]
    assert {v["company_name"] for v in views} <= {"Acme"}
    # the company routes do not exist for a learner or a candidate
    for who in (EVE_EMAIL, CAM_EMAIL):
        b = w.browser(who)
        for r in (b.get("/api/v1/company"), b.get("/api/v1/company/templates"), b.get("/api/v1/company/invites"), b.get("/api/v1/company/terms"),
                  b.post("/api/v1/company/exports", {"template_id": w.template})):
            assert (r.status_code, r.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")


def test_admin_routes_answer_everyone_else_like_unknown_routes(w):
    calls = [("get", "/api/v1/admin/companies/pending", None), ("post", "/api/v1/admin/companies/00000000-0000-4000-8000-000000000000/decision", {"decision": "approve"}),
             ("get", "/api/v1/admin/users", None), ("post", f"/api/v1/admin/users/{ADA}/actions", {"action": "lock", "reason": "x"}),
             ("post", f"/api/v1/admin/attempts/{w.ada_attempt}/force-stop", None), ("get", "/api/v1/admin/settings", None),
             ("put", "/api/v1/admin/settings/candidate_retention_days", {"value": 90}), ("delete", "/api/v1/admin/settings/candidate_retention_days", None),
             ("get", "/api/v1/admin/quotas", None), ("put", "/api/v1/admin/quotas", {"scope": "global", "max_instances": 5}),
             ("delete", "/api/v1/admin/quotas?scope=global", None), ("get", "/api/v1/admin/capacity", None), ("get", "/api/v1/admin/jobs", None)]
    for who in (ADA_EMAIL, RITA, CAM_EMAIL):
        b = w.browser(who)
        for method, url, body in calls:
            r = getattr(b, method)(url) if body is None and method in ("get", "post", "delete") else getattr(b, method)(url, body)
            assert (r.status_code, r.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN"), (who, method, url, r.text)
    assert w.lab.engine.get(w.ada_attempt).state.value == "running", "nothing was force-stopped"
