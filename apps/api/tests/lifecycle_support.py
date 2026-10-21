"""A full stack for the lifecycle tests (WP-A): the real assessment service over a database (SQLite), the real consent service, the real lab runtime on the fake host, and the real
lab routes with sessions, CSRF and Origin. A company invites, the candidate accepts and consents (the attempt is created in the lab's own engine, through the lab port, with the
invite's rules), and the candidate and the recruiter then call the routes. Nothing of the lifecycle is faked: only the orchestrator (the fake host) and the mail provider are."""
from __future__ import annotations

import time
from contextlib import contextmanager
from types import SimpleNamespace

from fastapi.testclient import TestClient

from support import ROOT
from test_assessments import CAND, KEYS, active_company, basic, mail_rows, token_in
from test_invite_acceptance import Rig, SCOPE
from test_lab_api import GATE_KEY, ZONE, Session, wait_running
from test_password_reset import POLICY, add_user, client
from vulnmart.accounts.http import Authenticated, authenticated, authenticated_with_csrf
from vulnmart.accounts.passwords import PasswordPolicy  # noqa: F401
from vulnmart.accounts.self_service import SelfService
from vulnmart.accounts.service import AccountService
from vulnmart.accounts.sessions import SessionService
from vulnmart.kernel.ratelimit import InMemoryRateLimiter
from vulnmart.kernel.settings import Settings
from vulnmart.lab.catalog import load_catalog
from vulnmart.lab.runtime import LabRuntime
from vulnmart.lab.tickets import TicketMinter
from vulnmart.main import create_app
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.scope import Role, Scope
from vulnmart.privacy.models import ConsentRecord  # noqa: F401

CAND_ID = "u-CANDCANDCANDCAND"
CAND_EMAIL = CAND
PASSWORD_USER = {"uid": CAND_ID, "email": CAND_EMAIL}


class Stack:
    def __init__(self, sessions, companies, assessments, audit, clock, *, quota=None, settings: FakeSettingsPort | None = None) -> None:
        self.sessions, self.clock = sessions, clock
        self.host = FakeInstanceHost()
        self.lab = LabRuntime(host=self.host, clock=clock, ready_poll_s=0, sleep=lambda _s: time.sleep(0.001), catalog=load_catalog(ROOT / "challenges" / "catalog"), quota=quota)
        self.settings = settings or FakeSettingsPort({})
        add_user(sessions, **PASSWORD_USER, name="Cand Idate")
        svc = SessionService(sessions, self.settings, b"k" * 32, now=clock)
        self.app = create_app({}, settings=Settings(), rate_limiter=InMemoryRateLimiter(now=lambda: clock.now.timestamp()), policy=POLICY,
                              accounts=AccountService(sessions, self.settings, public_origin="http://127.0.0.1:3000", now=clock, policy=POLICY), sessions=svc,
                              self_service=SelfService(sessions, svc, POLICY), lab=self.lab, lab_tickets=TicketMinter(GATE_KEY, ZONE))
        self.app.state.ports.settings = self.settings
        # the real invite stack, with the lab's own attempt port behind it (so a consent creates the attempt in the lab engine, under the invite's rules)
        self.rig = Rig(sessions, companies, assessments, audit, clock, attempts=self.lab.attempts)
        self.assessments = self.rig.assessments
        self.app.state.assessments, self.app.state.consent_service = self.assessments, self.rig.consent
        self.owner = self.rig.owner
        self.template = self.rig.template

    # ---- the company and the candidate ----

    def new_template(self, **rules):
        return self.assessments.create_template(self.owner, basic(**rules))

    def invite(self, template=None, email: str = CAND_EMAIL):
        view = self.assessments.create_invite(self.owner, (template or self.template).template_id, email)
        return view, token_in(mail_rows(self.sessions)[-1])

    def consented_attempt(self, template=None, email: str = CAND_EMAIL, user_id: str = CAND_ID):
        """invite -> open -> accept -> consent: returns (invite view, attempt id); the attempt is `ready` in the lab engine."""
        view, token = self.invite(template, email)
        accepted = self.rig.accept.accept(user_id, token)
        self.rig.decide(user_id, accepted.attempt_id)
        return view, accepted.attempt_id

    def candidate(self) -> Session:
        return Session(self, CAND_EMAIL)

    @contextmanager
    def recruiter(self, org_id: str | None = None, user_id: str = "u-RECRUITERRECRUIT"):
        """A client that is a recruiter of `org_id` (default: the inviting company) for the routes that look at the session's role and company. The override is removed on exit,
        so a candidate's session works as itself again."""
        scope = Scope(user_id=user_id, org_id=org_id or self.owner.org_id, roles=frozenset({Role.RECRUITER}))
        auth = Authenticated("t" * 40, SimpleNamespace(user=SimpleNamespace(id=user_id), roles=frozenset({Role.RECRUITER}), scope=scope))
        self.app.dependency_overrides[authenticated] = lambda: auth
        self.app.dependency_overrides[authenticated_with_csrf] = lambda: auth
        try:
            yield client(self.app)
        finally:
            self.app.dependency_overrides.clear()
    def invite_state(self, invite_id: str) -> str:
        return self.assessments.get_invite(self.owner, invite_id).state

    def running(self, attempt_id: str) -> None:
        wait_running(self, attempt_id)


def stack_fixture(sessions, companies, assessments, audit, clock, **kw) -> Stack:
    active = Stack(sessions, companies, assessments, audit, clock, **kw)
    return active
