"""Work package G (scenario matrix): the shared world of the `test_scenarios_*.py` files.

It extends the combined world of the privacy-wall tests (the real lab runtime on the fake instance host, the real company, invite, consent, deletion, view-history and export
services on SQLite; Ada and Eve are learners, Rita's company invited Cam, Rob's company is approved) with what the role scenarios of docs/audit/2026-10-21-role-scenarios.md
also need: two admins with a proved second factor, the real admin operations, the second-factor service, and helpers that read the mail outbox and make people through the
public routes. Everything goes through the routes the dashboards call; nothing here reaches into a service where a route exists, except to read the outbox and to move the
clock, which the dashboards cannot do either.
"""
from __future__ import annotations

import re
import time
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from support import play  # noqa: F401 - re-exported for the scenario files
from test_assessments import KEYS, active_company, assessments, basic, mail_rows, token_in  # noqa: F401
from test_companies import ADMIN_SCOPE, GOOD, T0, audit, clock, companies, ended, org_row, sessions, signup, user_id, verify  # noqa: F401
from test_password_reset import ORIGIN
from test_privacy_wall import ADA, ADA_EMAIL, CAM, CAM_EMAIL, EVE, EVE_EMAIL, RITA, ROB, Browser, World, w, wait_running  # noqa: F401
from vulnmart.accounts import security
from vulnmart.accounts.mfa import MfaService
from vulnmart.accounts.models import User, UserSession
from vulnmart.accounts.passwords import CommonPasswordList, PasswordPolicy
from vulnmart.accounts.roles import RoleService
from vulnmart.accounts.status import AccountStatusService
from vulnmart.admin.breakglass import BreakGlassService
from vulnmart.admin.ops import AdminOps
from vulnmart.kernel.quota import DbQuotaPort
from vulnmart.notifications.models import EmailOutbox
from vulnmart.privacy.retention.records import SqlAttemptRecords
from vulnmart.privacy.subjects import SubjectService

ALICE, BORIS = "u-ALICEADMINALICEA", "u-BORISADMINBORISB"
ALICE_EMAIL, BORIS_EMAIL = "alice@vulnmart.example", "boris@vulnmart.example"
ALL_KEYS = [f"C{n:02d}" for n in range(1, 12)]


def anonymous(world) -> TestClient:
    return TestClient(world.app, headers={"origin": ORIGIN}, base_url="https://testserver", raise_server_exceptions=False)


def outbox(sessions, template: str | None = None) -> list[EmailOutbox]:
    with sessions() as s:
        q = select(EmailOutbox).order_by(EmailOutbox.id)
        if template is not None:
            q = q.where(EmailOutbox.template == template)
        return list(s.scalars(q))


def link_token(row: EmailOutbox) -> str:
    """The token of a mailed link (any kind of link; invite tokens have their own shape, the generic one is `token=<chars>`)."""
    return re.search(r"token=([A-Za-z0-9_.-]+)", row.params["link"]).group(1)


def make_admin(world, uid: str, email: str, *, proved: bool = True) -> Browser:
    with world.sessions.begin() as s:
        s.add(User(id=uid, account_type="admin", email=email, email_ci=email, password_hash=security.hash_password(GOOD), display_name=email.split("@")[0],
                   status="active", email_verified_at=T0))
    browser = world.browser(email)
    if proved:  # the second factor, proved (the same way the admin stack test marks it)
        with world.sessions.begin() as s:
            s.execute(update(UserSession).where(UserSession.user_id == uid).values(mfa_at=T0))
    return browser


def new_learner(world, n: int) -> tuple[str, str]:
    tag = chr(65 + n // 26) + chr(65 + n % 26)  # letters only: a user id is Base32, which has no 0, 1, 8 or 9
    uid, email = f"u-SCEN{tag}SCEN{tag}SCEN"[:18], f"scen{n}@learners.example"
    world.learner(uid, email)
    return uid, email


def wait_state(lab, attempt_id: str, state: str, seconds: float = 5.0) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if lab.engine.get(attempt_id).state.value == state:
            return
        time.sleep(0.01)
    raise AssertionError(f"the attempt {attempt_id} did not reach {state}: it is {lab.engine.get(attempt_id).state.value}")


def start_practice(world, browser: Browser) -> tuple[str, str]:
    """A learner presses Start on the practice lab; returns (instance id, attempt id) once the instance runs."""
    r = browser.post("/api/v1/instances", {"kind": "learner"})
    assert r.status_code == 202, r.text
    instance, attempt = r.json()["instance_id"], r.json()["attempt_id"]
    wait_running(world.lab, attempt)
    return instance, attempt


def invite_candidate(world, email: str, template: str | None = None, *, as_user: str = RITA):
    """A recruiter invites `email` through the route; returns (token of the mail, the answer body). The person still has to accept and consent."""
    before = len(mail_rows(world.sessions))
    r = world.browser(as_user).post("/api/v1/company/invites", {"template_id": template or world.template, "emails": [email]})
    assert r.status_code in (200, 201, 202), r.text
    rows = mail_rows(world.sessions)
    assert len(rows) == before + 1, "one invite mail"
    return token_in(rows[-1]), r.json()


def accept_and_consent(world, browser: Browser, token: str) -> str:
    """Accept the invite and grant the consent; returns the attempt id (state `ready`)."""
    accepted = browser.post("/api/v1/invites/accept", {"token": token})
    assert accepted.status_code in (200, 201), accepted.text
    attempt = accepted.json()["attempt_id"]
    notice = browser.get("/api/v1/consent/notice", params={"attempt_id": attempt}).json()
    granted = browser.post("/api/v1/consent", {"attempt_id": attempt, "notice_version": notice["notice_version"],
                                               "notice_text_sha256": notice["notice_text_sha256"], "decision": "granted"})
    assert granted.status_code in (200, 201), granted.text
    return attempt


def start_candidate(world, browser: Browser, attempt: str) -> str:
    started = browser.post(f"/api/v1/attempts/{attempt}/start")
    assert started.status_code == 200, started.text
    wait_running(world.lab, attempt)
    return browser.get(f"/api/v1/attempts/{attempt}").json()["instance_id"]


def problem_code(response) -> str:
    return response.json().get("code", "")


@pytest.fixture
def sw(w, sessions, companies, audit, clock):  # noqa: F811
    """The combined world plus two admins, the real admin operations, break-glass and the second-factor service."""
    st = w.app.state
    settings = st.ports.settings
    production_policy = PasswordPolicy(common=CommonPasswordList())  # what `make_policy` builds by default: the rules and the bundled list of common passwords
    st.accounts._policy = st.self_service._policy = production_policy
    st.mfa_service = MfaService(sessions, KEYS, audit, st.session_service, now=clock)
    st.break_glass = BreakGlassService(sessions=sessions, roles=RoleService(sessions, audit), audit=audit, companies=companies, lab=lambda: w.lab, now=clock)
    roles = RoleService(sessions, audit)
    st.admin_ops = AdminOps(
        sessions=sessions, roles=roles, companies=companies, status=AccountStatusService(sessions, roles, audit), accounts=st.accounts, settings=settings,
        quotas=DbQuotaPort(sessions, settings), audit=audit, records=SqlAttemptRecords(sessions), deletion=st.deletion_service,
        end_sessions=st.session_service.revoke_all, stopper=w.lab.force_stop, host_status=lambda: w.lab.host.host_status(),
        instance_states=lambda: w.lab.instance_states, job_status=lambda: [], pseudonym=SubjectService(sessions).pseudonym, now=clock)
    w.audit = audit
    w.settings = settings
    w.alice = make_admin(w, ALICE, ALICE_EMAIL)
    w.boris = make_admin(w, BORIS, BORIS_EMAIL)
    return w
