"""Story P-31 (FR-ADM-03, FR-ADM-07, FR-ADM-08; D-94): break-glass and the admin's audit log, through the routes, in the privacy-wall world (the real lab runtime with
Cam's candidate attempt of Rita's company and Ada's practice attempt) with two admins.

Without a session an admin reads no candidate content; a session needs a written reason, lasts 15 minutes, mails the other admin and the company's owner, records every
read and is reviewed by the other admin; a practice attempt cannot be opened; reading the audit log is itself audited; the reason text never reaches the audit log."""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select, update

from test_assessments import KEYS, active_company, assessments, basic, mail_rows, token_in  # noqa: F401
from test_companies import ADMIN_SCOPE, GOOD, T0, audit, clock, companies, ended, org_row, sessions, signup, user_id, verify  # noqa: F401
from test_privacy_wall import ADA_EMAIL, CAM_EMAIL, RITA, Browser, w  # noqa: F401
from vulnmart.accounts import security
from vulnmart.accounts.models import User, UserSession
from vulnmart.accounts.roles import RoleService
from vulnmart.admin.breakglass import BreakGlassService
from vulnmart.admin.models import BreakGlassSession
from vulnmart.notifications.models import EmailOutbox

ALICE, BORIS = "u-ALICEADMINALICEA", "u-BORISADMINBORISB"
REASON = "A candidate disputes the score of C01; checking the capture."


def admin(world, uid: str, email: str) -> Browser:
    with world.sessions.begin() as s:
        s.add(User(id=uid, account_type="admin", email=email, email_ci=email, password_hash=security.hash_password(GOOD), display_name=email.split("@")[0],
                   status="active", email_verified_at=T0))
    b = world.browser(email)
    with world.sessions.begin() as s:  # the second factor, proved (as the P-28 stack test marks it)
        s.execute(update(UserSession).where(UserSession.user_id == uid).values(mfa_at=T0))
    return b


@pytest.fixture
def g(w, sessions, companies, audit, clock):
    w.app.state.break_glass = BreakGlassService(sessions=sessions, roles=RoleService(sessions, audit), audit=audit, companies=companies, lab=lambda: w.lab, now=clock)
    w.alice, w.boris = admin(w, ALICE, "alice@vulnmart.example"), admin(w, BORIS, "boris@vulnmart.example")
    w.audit = audit
    return w


def mails(sessions, template):
    with sessions() as s:
        return [r.to_user_id for r in s.scalars(select(EmailOutbox).where(EmailOutbox.template == template))]


def test_without_a_session_an_admin_reads_no_candidate_content(g):
    c = g.cam_attempt
    for url in (f"/api/v1/attempts/{c}", f"/api/v1/attempts/{c}/report", f"/api/v1/attempts/{c}/evidence", f"/api/v1/attempts/{c}/timeline",
                f"/api/v1/attempts/{c}/challenges", f"/api/v1/attempts/{c}/score", f"/api/v1/attempts/{c}/integrity-flags"):
        assert g.alice.get(url).status_code == 404, url
    capacity = g.alice.get("/api/v1/admin/break-glass")
    assert capacity.status_code == 200 and capacity.json() == {"items": []}


def test_opening_needs_a_reason_and_a_candidate_attempt(g):
    short = g.alice.post("/api/v1/admin/break-glass", {"attempt_id": g.cam_attempt, "reason": "too short"})
    assert short.status_code == 422
    practice = g.alice.post("/api/v1/admin/break-glass", {"attempt_id": g.ada_attempt, "reason": REASON})
    assert (practice.status_code, practice.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN"), "a learner's practice is never opened"
    unknown = g.alice.post("/api/v1/admin/break-glass", {"attempt_id": "a-AAAAAAAAAAAAAAAA", "reason": REASON})
    assert unknown.status_code == 404


def test_a_session_alerts_the_other_admin_and_the_company_records_reads_and_is_reviewed_by_the_other_admin(g, clock, sessions, companies):
    opened = g.alice.post("/api/v1/admin/break-glass", {"attempt_id": g.cam_attempt, "reason": REASON})
    assert opened.status_code == 201, opened.text
    s = opened.json()
    assert s["state"] == "open" and s["admin_id"] == ALICE and s["reason"] == REASON and s["reads"] == []
    from datetime import datetime
    started, ends = (datetime.fromisoformat(s[k].replace("Z", "+00:00")) for k in ("started_at", "expires_at"))
    assert ends - started == timedelta(minutes=15)
    # the real-time alert: the other admin and the company's owner, not the admin who opened it
    alerted = mails(sessions, "admin.break_glass_opened")
    assert BORIS in alerted and ALICE not in alerted, "every other active admin, never the one who opened it"
    assert mails(sessions, "company.break_glass_opened") == [user_id(sessions, RITA)]
    # reading: only the session's admin, while it is open; every read recorded; no flag value
    read = g.alice.get(f"/api/v1/admin/break-glass/{s['session_id']}/attempt")
    assert read.status_code == 200, read.text
    body = read.json()
    assert body["attempt_id"] == g.cam_attempt and "per_challenge" in body["results"] and "evidence" in body["results"] and "VM{" not in read.text.replace("VM{redacted}", "")
    assert g.boris.get(f"/api/v1/admin/break-glass/{s['session_id']}/attempt").status_code == 404, "another admin cannot use it"
    with sessions() as db:
        row = db.get(BreakGlassSession, s["session_id"])
        assert [r["what"] for r in row.what_read] == [["report", "evidence", "timeline"]]
    # the review waits until it is over, and is never the admin's own
    assert g.boris.post(f"/api/v1/admin/break-glass/{s['session_id']}/review", {"note": "checked"}).status_code == 409
    closed = g.alice.post(f"/api/v1/admin/break-glass/{s['session_id']}/close")
    assert closed.status_code == 200 and closed.json()["state"] == "over"
    assert g.alice.get(f"/api/v1/admin/break-glass/{s['session_id']}/attempt").status_code == 409, "closed is closed"
    assert g.alice.post(f"/api/v1/admin/break-glass/{s['session_id']}/review", {"note": "my own"}).status_code == 409
    reviewed = g.boris.post(f"/api/v1/admin/break-glass/{s['session_id']}/review", {"note": "The reason matches the dispute ticket; one read."})
    assert reviewed.status_code == 200 and reviewed.json()["state"] == "reviewed" and reviewed.json()["reviewed_by"] == BORIS
    assert g.boris.post(f"/api/v1/admin/break-glass/{s['session_id']}/review", {"note": "again"}).status_code == 409
    # the audit log has the steps, never the reason text
    actions = [r.action for r in g.audit.records]
    for a in ("breakglass.opened", "breakglass.read", "breakglass.closed", "breakglass.reviewed"):
        assert a in actions, a
    assert REASON not in repr(g.audit.records) and "dispute" not in repr(g.audit.records)


def test_a_session_ends_after_15_minutes(g, clock, sessions):
    s = g.alice.post("/api/v1/admin/break-glass", {"attempt_id": g.cam_attempt, "reason": REASON}).json()
    # 15 minutes later (moving the whole clock would also end the admin's own sign-in, which idles out after 15 minutes): the window is moved back instead
    with sessions.begin() as db:
        db.execute(update(BreakGlassSession).where(BreakGlassSession.id == s["session_id"]).values(started_at=clock() - timedelta(minutes=16),
                                                                                                   expires_at=clock() - timedelta(seconds=1)))
    assert g.alice.get(f"/api/v1/admin/break-glass/{s['session_id']}/attempt").status_code == 409
    assert g.alice.get("/api/v1/admin/break-glass").json()["items"][0]["state"] == "over"


def test_reading_the_audit_log_is_itself_audited_and_only_for_admins(g):
    g.alice.post("/api/v1/admin/break-glass", {"attempt_id": g.cam_attempt, "reason": REASON})
    r = g.alice.get("/api/v1/admin/audit", params={"action": "breakglass.opened"})
    assert r.status_code == 200 and [i["action"] for i in r.json()["items"]] == ["breakglass.opened"]
    assert set(r.json()["items"][0]) == {"seq", "at", "actor", "action", "subject", "details"}
    assert g.audit.records[-1].action == "admin.audit_read" and g.audit.records[-1].details["count"] == 1
    for who in (ADA_EMAIL, RITA, CAM_EMAIL):
        refused = g.browser(who).get("/api/v1/admin/audit")
        assert (refused.status_code, refused.json()["code"]) == (404, "REQ-ROUTE-UNKNOWN")
