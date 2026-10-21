"""The API for the browser tests of apps/web (work package E): the REAL FastAPI app with its real routes, sessions, CSRF and Origin checks, account, company,
invite, consent and lab services, on a throw-away SQLite file, the in-memory fake instance host and the real (offset) clock. Nothing of the API is stubbed; only the
database, the instance host (no Docker) and the mail (rows in the outbox table, never sent) are the ones the unit tests use.

    uv run --locked --package vulnmart-api python apps/api/tests/e2e_web_server.py --port 18000 --web-origin http://127.0.0.1:3100 --out state.json

It prints one JSON line {"listening": true, "port": N} when ready and writes the seed (ids, invite tokens of the local test accounts) to --out. Test-only hooks live under
`/_e2e` on this server only (the web proxy never forwards them, it forwards /api/* only): the mail link of a sign-up, the activity a player's requests would give
(a pasted flag is held without it), the flag of an instance (made from this process's random keys, nothing real), and the clock (`/_e2e/advance`).

Local test accounts only. The password below is a local test value and belongs to no real account.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from sqlalchemy import create_engine, event, select

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]

import vulnmart.accounts.models  # noqa: E402,F401
import vulnmart.assessments.models  # noqa: E402,F401
import vulnmart.kernel.models  # noqa: E402,F401
import vulnmart.lab.models  # noqa: E402,F401
import vulnmart.notifications.models  # noqa: E402,F401
import vulnmart.orgs.models  # noqa: E402,F401
import vulnmart.privacy.models  # noqa: E402,F401
from vulnmart.accounts import security  # noqa: E402
from vulnmart.accounts.directory import UserDirectory  # noqa: E402
from vulnmart.accounts.fieldkeys import FieldKeys  # noqa: E402
from vulnmart.accounts.models import User, UserRole  # noqa: E402
from vulnmart.accounts.passwords import CommonPasswordList, PasswordPolicy  # noqa: E402
from vulnmart.accounts.roles import RoleService  # noqa: E402
from vulnmart.accounts.self_service import SelfService  # noqa: E402
from vulnmart.accounts.service import AccountService  # noqa: E402
from vulnmart.accounts.sessions import SessionService  # noqa: E402
from vulnmart.accounts.status import AccountStatusService  # noqa: E402
from vulnmart.assessments.accept import InviteAcceptance, InviteConsentTargets  # noqa: E402
from vulnmart.assessments.service import AssessmentService  # noqa: E402
from vulnmart.kernel.db import Base, make_sessions  # noqa: E402
from vulnmart.kernel.ratelimit import InMemoryRateLimiter  # noqa: E402
from vulnmart.kernel.scope import ContextScopePort, scope_or_none  # noqa: E402
from vulnmart.kernel.settings import Settings  # noqa: E402
from vulnmart.lab.catalog import load_catalog  # noqa: E402
from vulnmart.lab.runtime import LabRuntime  # noqa: E402
from vulnmart.lab.tickets import TicketMinter  # noqa: E402
from vulnmart.main import create_app  # noqa: E402
from vulnmart.notifications.models import EmailOutbox  # noqa: E402
from vulnmart.orgs.service import CompanyService  # noqa: E402
from vulnmart.ports.fake_instance_host import FakeInstanceHost  # noqa: E402
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort  # noqa: E402
from vulnmart.ports.scope import Role, Scope  # noqa: E402
from vulnmart.privacy.consent import ConsentService  # noqa: E402

PASSWORD = "correct horse battery staple"  # local test accounts only
FIELD_KEYS = FieldKeys.from_secret(b"an e2e field key secret of 32+ bytes!!")
ZONE = "labs.example.test"
RECRUITER_EMAIL = "recruiter-e2e@acme.example"
CANDIDATES = {"release": "cand-release@e2e.example", "submit": "cand-submit@e2e.example", "closed": "cand-closed@e2e.example"}
ADMIN_ID = "u-ADMINADMINADMIN2"[:18]


def now() -> datetime:
    return datetime.now(UTC)


def add_user(sessions, uid: str, email: str, *, account_type: str = "participant", name: str = "E2E Person") -> None:
    with sessions.begin() as s:
        s.add(User(id=uid, account_type=account_type, email=email, email_ci=email.lower(), password_hash=security.hash_password(PASSWORD), display_name=name,
                   status="active", email_verified_at=now()))
        s.flush()
        if account_type == "participant":
            s.add(UserRole(user_id=uid, role="learner", account_type="participant"))


def build(web_origin: str):
    path = Path(tempfile.mkdtemp(prefix="vm-e2e-")) / "e2e.sqlite"
    engine = create_engine(f"sqlite:///{path.as_posix()}", connect_args={"check_same_thread": False, "timeout": 30})

    @event.listens_for(engine, "connect")
    def _pragmas(conn, _record):  # one writer at a time, readers do not block: several request threads share the file
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()

    Base.metadata.create_all(engine)
    sessions = make_sessions(engine, scope_or_none)
    settings = FakeSettingsPort({})
    policy = PasswordPolicy(CommonPasswordList())
    audit = FakeAuditPort()
    scope = ContextScopePort()

    host = FakeInstanceHost()
    lab = LabRuntime(host=host, ready_poll_s=0, sleep=lambda _s: time.sleep(0.001), catalog=load_catalog(ROOT / "challenges" / "catalog"),
                     sequenced=True)  # the deployed learner mode (VULNMART_LAB_SEQUENCE=1); a company assessment is not sequenced

    accounts = AccountService(sessions, settings, public_origin=web_origin, policy=policy)
    session_service = SessionService(sessions, settings, b"k" * 32)
    roles = RoleService(sessions, audit)
    companies = CompanyService(sessions, accounts, UserDirectory(sessions), roles, audit, scope, settings, AccountStatusService(sessions, roles, audit),
                               public_origin=web_origin, end_sessions=lambda *_a: None)
    assessments = AssessmentService(sessions, companies, audit, scope, settings, FIELD_KEYS, public_origin=web_origin, attempts=lab.attempts)
    acceptance = InviteAcceptance(assessments, UserDirectory(sessions))
    targets = InviteConsentTargets(assessments, lab.attempts, roles)
    consent = ConsentService(sessions, targets, audit, settings, FIELD_KEYS)

    app = create_app({}, settings=Settings(public_origin=web_origin), rate_limiter=InMemoryRateLimiter(now=lambda: time.time()), policy=policy, accounts=accounts,
                     sessions=session_service, self_service=SelfService(sessions, session_service, policy), lab=lab, lab_tickets=TicketMinter(b"g" * 32, ZONE),
                     consent=consent, consent_targets=targets)
    app.state.ports.settings = settings
    app.state.assessments, app.state.invite_acceptance = assessments, acceptance
    session_service.set_org_resolver(companies.membership_of)  # a recruiter acts for their company in every request

    # ---- the seed: an approved company with a recruiter, three templates and three invited candidates (local test data) ----
    add_user(sessions, ADMIN_ID, "admin-e2e@e2e.example", account_type="admin", name="E2E Admin")
    companies.signup_recruiter(email=RECRUITER_EMAIL, password=PASSWORD, display_name="Rita Recruiter", company_name="Acme Security")
    with sessions.begin() as s:
        recruiter = s.scalar(select(User).where(User.email_ci == RECRUITER_EMAIL))
        recruiter.email_verified_at = now()
        recruiter_id = recruiter.id
    from vulnmart.orgs.models import Organization, OrgMember

    with scope.acting_as(Scope(user_id=recruiter_id, roles=frozenset({Role.RECRUITER}))):
        with sessions() as s:
            member = s.scalar(select(OrgMember).where(OrgMember.user_id == recruiter_id))
    org_id = str(member.org_id)
    companies.approve(Scope(user_id=ADMIN_ID, roles=frozenset({Role.ADMIN})), org_id)
    terms = companies.terms_for(recruiter_id)
    companies.accept_terms(recruiter_id, terms.version, terms.sha256)
    owner = Scope(user_id=recruiter_id, org_id=org_id, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))

    invites: dict[str, str] = {}

    def invite(name: str, template: dict, email: str) -> str:
        view = assessments.create_template(owner, template)
        made = assessments.create_invite(owner, view.template_id, email)
        invites[name] = made.invite_id
        with sessions() as s:
            rows = [r for r in s.scalars(select(EmailOutbox).where(EmailOutbox.template == "candidate.invite").order_by(EmailOutbox.id))]
        return re.search(r"token=([a-z2-7]{26}\.[A-Za-z0-9_-]{43})", rows[-1].params["link"]).group(1)

    for i, email in enumerate(CANDIDATES.values()):
        add_user(sessions, f"u-CANDIDATE{i}CANDIDAT"[:18], email, name=f"Candidate {i}")
    seed = {
        "password": PASSWORD,
        "recruiter_email": RECRUITER_EMAIL,
        "candidates": CANDIDATES,
        "tokens": {
            # results held until the recruiter releases them, hints on at 10 percent
            "release": invite("release", {"title": "Release assessment", "challenge_keys": ["C01", "C02"], "time_limit_min": 30, "hints_mode": "on", "hint_cost_pct": 10,
                               "results_visibility": "after_release"}, CANDIDATES["release"]),
            # results shown at submit, hints off
            "submit": invite("submit", {"title": "Submit assessment", "challenge_keys": ["C01"], "time_limit_min": 30, "hints_mode": "off",
                              "results_visibility": "after_submit"}, CANDIDATES["submit"]),
            "closed": invite("closed", {"title": "Closed assessment", "challenge_keys": ["C01"], "time_limit_min": 30}, CANDIDATES["closed"]),
        },
    }
    # the third invite is cancelled by the company: the candidate must see a closed-invite message
    assessments.cancel(owner, invites["closed"])

    hooks = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @hooks.get("/seed")
    def get_seed():
        return seed

    @hooks.get("/mail")
    def mail(to: str, template: str = "account.verify"):
        with sessions() as s:
            rows = [r for r in s.scalars(select(EmailOutbox).where(EmailOutbox.template == template).order_by(EmailOutbox.id))]
        found = [r for r in rows if r.to_user_id and _email_of(sessions, r.to_user_id) == to.lower()]
        if not found:
            raise HTTPException(404, "no mail")
        m = re.search(r"token=([A-Za-z0-9_-]{20,})", found[-1].params["link"])
        return {"token": m.group(1)}

    @hooks.post("/play")
    def play(instance_id: str, requests: int = 8):
        lab.activity.record({"type": "proxy.request", "instance_id": instance_id, "epoch": 1, "session_kind": "player",
                             "data": {"route_template": "/api/x", "method": "GET", "status": 200, "count": requests}}, lab.clock())
        return {"ok": True}

    @hooks.get("/flag")
    def flag(instance_id: str, challenge_key: str):
        return {"flag": lab.keys.flag(instance_id, challenge_key, 1)}

    @hooks.post("/advance")
    def advance(seconds: int):
        return {"offset": lab.clock.advance(seconds)}

    app.mount("/_e2e", hooks)
    return app, seed


def _email_of(sessions, user_id: str) -> str | None:
    with sessions() as s:
        u = s.get(User, user_id)
        return u.email_ci if u else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--web-origin", default="http://127.0.0.1:3100")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    app, seed = build(args.web_origin)
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", args.port))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="on"))
    t = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    t.start()
    while not server.started:
        time.sleep(0.05)
    if args.out:
        Path(args.out).write_text(json.dumps({"port": port, **seed}), encoding="utf-8")
    print(json.dumps({"listening": True, "port": port}), flush=True)
    try:
        while t.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        server.should_exit = True


if __name__ == "__main__":
    sys.exit(main())
