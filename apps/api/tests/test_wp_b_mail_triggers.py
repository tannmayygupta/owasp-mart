"""Work package B (FR-NTF-01, FR-PRV-08, FR-PRV-09): the mails that were never sent. Each trigger is run for real over the company, invite, deletion and outbox services on
SQLite, and the test reads the rows in `email_outbox` (who is told, which template, which parameters, never an address in a row).

Withdrawal, the time warning, the submission and the release happen in the lab (stream L); `MailTriggers` is what the lab calls, so these tests call it the way the lab will."""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

import vulnmart.accounts.models  # noqa: F401
import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from test_assessments import ANA, KEYS, active_company, assessments, basic  # noqa: F401
from test_companies import ORIGIN, T0, audit, clock, companies, ended, entries, sessions  # noqa: F401
from test_deletion import CAND, LEARNER, Rig
from test_retention_candidates import Eraser  # noqa: F401
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.lab.mail_log import MailingAttemptLog, mail_sink
from vulnmart_attempts.attempt_log import InMemoryAttemptLog
from vulnmart.notifications.fakes import FakeEmailProvider
from vulnmart.notifications.models import EmailOutbox
from vulnmart.notifications.service import EmailOutboxService
from vulnmart.notifications.templates import TemplateRenderer
from vulnmart.notifications.triggers import MailTriggers, notify_consent_withdrawn
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.privacy.deletion import DeletionService
from vulnmart.privacy.retention.records import SqlAttemptRecords


MINE = ("recruiter.consent_withdrawn", "candidate.time_warning", "candidate.submission_received", "recruiter.submission_received", "candidate.results_released",
        "privacy.deletion_requested", "privacy.deletion_request_for_company", "privacy.deletion_declined", "privacy.deletion_confirmed",
        "privacy.deletion_overdue", "admin.deletion_escalated")


class MailRig(Rig):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.mail = MailTriggers(self.sessions, ContextScopePort(), public_origin=ORIGIN, keys=KEYS, now=self.clock)
        self.service = DeletionService(self.sessions, self.assessments, SqlAttemptRecords(self.sessions), FakeSettingsPort(), self.audit, self.subjects, self.eraser,
                                       now=self.clock, mail=self.mail)

    def outbox(self, *templates):
        """The rows of the mails this package sends (the signup, approval and invite mails of the rig's own setup are left out)."""
        with self.sessions() as s:
            q = select(EmailOutbox).order_by(EmailOutbox.id).where(EmailOutbox.template.in_(templates or MINE))
            return list(s.scalars(q))

    def mails(self, template):
        return [(r.to_user_id, dict(r.params)) for r in self.outbox(template)]


@pytest.fixture
def rig(sessions, companies, assessments, audit, clock):
    return MailRig(sessions, companies, assessments, audit, clock)


# ---- the four flows of the lab ----------------------------------------------------------------------------------------

def test_consent_withdrawn_tells_the_company_owner_with_the_assessment_name(rig):
    attempt, _ = rig.candidate_attempt()
    assert notify_consent_withdrawn(rig.mail, attempt, deletion_on="2026-10-25") == 1
    [(to, params)] = rig.mails("recruiter.consent_withdrawn")
    assert to == rig.owner.user_id
    assert params == {"org_name": "Acme", "assessment_name": "T", "deletion_on": "2026-10-25"}


def test_the_time_warning_goes_to_the_candidate_only_and_carries_a_link_to_the_attempt(rig):
    attempt, _ = rig.candidate_attempt()
    assert rig.mail.time_warning(attempt, 5) == 1
    [(to, params)] = rig.mails("candidate.time_warning")
    assert to == CAND and params["minutes_left"] == 5 and params["assessment_name"] == "T"
    assert params["link"] == f"{ORIGIN}/assessment/{attempt}"


def test_a_submission_is_told_to_the_candidate_and_to_the_recruiter(rig):
    attempt, _ = rig.candidate_attempt()
    assert rig.mail.submission_received(attempt) == 2
    assert [t for t, _ in rig.mails("candidate.submission_received")] == [CAND]
    assert [t for t, _ in rig.mails("recruiter.submission_received")] == [rig.owner.user_id]


def test_released_results_are_told_to_the_candidate(rig):
    attempt, _ = rig.candidate_attempt()
    assert rig.mail.results_released(attempt) == 1
    [(to, params)] = rig.mails("candidate.results_released")
    assert to == CAND and params["org_name"] == "Acme"


def test_no_row_holds_an_address_and_every_new_row_renders(rig):
    attempt, _ = rig.candidate_attempt()
    rig.mail.consent_withdrawn(attempt)
    rig.mail.time_warning(attempt, 15)
    rig.mail.submission_received(attempt)
    rig.mail.results_released(attempt)
    renderer = TemplateRenderer()
    rows = rig.outbox()
    assert len(rows) == 5
    for row in rows:
        assert "@" not in repr(row.params) and row.to_address_sealed is None
        renderer.render(row.template, row.params)  # the parameters fit the template, so the worker will not fail it


def test_a_practice_attempt_an_unknown_attempt_and_a_broken_lookup_queue_nothing_and_raise_nothing(rig):
    rig.learner()
    rig.practice(LEARNER, "a-PRACTICEONE22222")
    assert rig.mail.submission_received("a-PRACTICEONE22222") == 0
    assert rig.mail.time_warning("a-NOSUCHATTEMPT222", 5) == 0
    assert rig.outbox() == []


def test_the_recruiter_is_the_invites_author_while_a_member_and_the_owner_otherwise(rig, companies, sessions):
    attempt, _ = rig.candidate_attempt()
    ctx = rig.mail.context_for(attempt)
    assert ctx.recruiter_id == rig.owner.user_id  # the owner made the invite
    from vulnmart.assessments.models import Invite
    from vulnmart.ports.scope import Role, Scope
    with ContextScopePort().acting_as(Scope(user_id="system:test", org_id=rig.org, roles=frozenset({Role.RECRUITER}))):
        with sessions.begin() as s:
            for invite in s.scalars(select(Invite)):
                invite.created_by = "u-GONEMEMBER222222"  # someone who is not a member any more
    assert rig.mail.context_for(attempt).recruiter_id == rig.owner.user_id


# ---- the deletion mails -------------------------------------------------------------------------------------------------

def test_a_candidate_request_tells_the_candidate_and_the_company(rig):
    attempt, _ = rig.candidate_attempt()
    view = rig.service.request_candidate(CAND, attempt)
    [(to, params)] = rig.mails("privacy.deletion_requested")
    assert to == CAND and params["company_name"] == "Acme" and "undo_link" in params
    [(company_to, company_params)] = rig.mails("privacy.deletion_request_for_company")
    assert company_to == rig.owner.user_id
    assert company_params["decide_by"] == view.decide_by.date().isoformat() and company_params["assessment_name"] == "T"
    assert company_params["link"] == f"{ORIGIN}/company/privacy"


def test_a_learner_request_tells_the_learner_the_date(rig):
    rig.learner()
    view = rig.service.request_learner(LEARNER)
    [(to, params)] = rig.mails("privacy.deletion_requested")
    assert to == LEARNER and params["deletion_on"] == view.execute_after.date().isoformat()


def test_the_decision_tells_the_candidate_and_a_refusal_has_its_own_mail(rig):
    attempt, _ = rig.candidate_attempt()
    other, _ = rig.candidate_attempt(user="u-OTHERCANDIDATE22")
    first, second = rig.service.request_candidate(CAND, attempt), rig.service.request_candidate("u-OTHERCANDIDATE22", other)
    rig.service.decide(rig.org, first.request_id, approve=True, actor_id=rig.owner.user_id)
    rig.service.decide(rig.org, second.request_id, approve=False, actor_id=rig.owner.user_id)
    approved = [m for m in rig.mails("privacy.deletion_requested") if "deletion_on" in m[1]]
    assert [to for to, _ in approved] == [CAND]
    assert [to for to, _ in rig.mails("privacy.deletion_declined")] == ["u-OTHERCANDIDATE22"]


def test_when_the_record_is_deleted_the_person_who_asked_is_told_it_is_done(rig):
    attempt, _ = rig.candidate_attempt()
    view = rig.service.request_candidate(CAND, attempt)
    rig.service.decide(rig.org, view.request_id, approve=True, actor_id=rig.owner.user_id)
    rig.run(days=8)
    [(to, params)] = rig.mails("privacy.deletion_confirmed")
    assert to == CAND and params == {"completed_on": (T0 + timedelta(days=8)).date().isoformat()}


def test_the_company_deleting_a_record_settles_the_open_request_and_tells_the_asker(rig):
    attempt, _ = rig.candidate_attempt()
    rig.service.request_candidate(CAND, attempt)
    assert rig.service.company_delete(rig.org, attempt, actor_id=rig.owner.user_id) == 1
    assert [to for to, _ in rig.mails("privacy.deletion_confirmed")] == [CAND]


def test_a_deleted_learner_account_is_told_by_a_sealed_address_that_leaves_with_the_mail(rig, sessions):
    rig.learner()
    view = rig.service.request_learner(LEARNER)
    rig.run(days=8)
    assert not rig.user_exists(LEARNER)
    [row] = rig.outbox("privacy.deletion_confirmed")
    assert row.to_user_id == view.request_id and row.to_address_sealed and "@" not in row.to_address_sealed and "@" not in repr(row.params)
    provider = FakeEmailProvider()
    worker = EmailOutboxService(sessions, provider, recipients=None, renderer=TemplateRenderer(), settings=FakeSettingsPort(), now=rig.clock,
                                address_opener=lambda sealed, aad: KEYS.open(sealed, account=aad))
    assert worker.deliver(row.id) == "sent"
    assert [m.to for m in provider.sent] == [f"{LEARNER}@example.org".lower()]
    with sessions() as s:
        assert s.get(EmailOutbox, row.id).to_address_sealed is None, "no copy of the address stays once the mail left"


def test_a_learner_who_keeps_the_account_for_assessment_data_is_told_by_id(rig):
    rig.learner(roles=("learner", "candidate"))
    rig.candidate_attempt(user=LEARNER)
    rig.practice(LEARNER, "a-PRACTICEONE22222")
    rig.service.request_learner(LEARNER)
    rig.run(days=8)
    [row] = rig.outbox("privacy.deletion_confirmed")
    assert row.to_user_id == LEARNER and row.to_address_sealed is None


def test_a_service_without_mail_still_works(sessions, companies, assessments, audit, clock):
    plain = Rig(sessions, companies, assessments, audit, clock)
    attempt, _ = plain.candidate_attempt()
    plain.service.request_candidate(CAND, attempt)
    with sessions() as s:
        assert s.scalars(select(EmailOutbox).where(EmailOutbox.template.in_(MINE))).all() == []


def test_the_escalation_is_visible_to_the_company(rig):
    attempt, _ = rig.candidate_attempt()
    rig.service.request_candidate(CAND, attempt)
    assert [r.escalated for r in rig.service.for_company(rig.org)] == [False]
    rig.run(days=15)
    assert [r.escalated for r in rig.service.for_company(rig.org)] == [True]


def test_the_escalation_after_fourteen_days_reminds_the_company_and_tells_every_active_admin(rig, sessions):
    attempt, _ = rig.candidate_attempt()
    req = rig.service.request_candidate(CAND, attempt)
    with sessions.begin() as s:
        from vulnmart.accounts.models import User
        for uid, status in (("u-ADMINACTIVE55555", "active"), ("u-ADMINLOCKED55555", "disabled")):
            s.add(User(id=uid, account_type="admin", email=f"{uid.lower()}@vulnmart.example", email_ci=f"{uid.lower()}@vulnmart.example", password_hash="x", display_name="Admin",
                       status=status))
    rig.run(days=15)
    assert [t for t, _ in rig.mails("privacy.deletion_overdue")] == [rig.owner.user_id]
    told = [t for t, _ in rig.mails("admin.deletion_escalated")]  # the rig has one admin of its own
    assert "u-ADMINACTIVE55555" in told and "u-ADMINLOCKED55555" not in told and len(told) == len(set(told)) == 2  # a disabled admin is not told
    params = rig.mails("admin.deletion_escalated")[0][1]
    assert params["request_id"] == req.request_id and params["org_name"] == "Acme"
    rig.run(days=16)  # the job runs again: the escalation is done once, so is its mail
    assert len(rig.outbox("privacy.deletion_overdue")) == 1 and len(rig.outbox("admin.deletion_escalated")) == 2


# ---- the attempt log that causes the mails -----------------------------------------------------------------------------

def test_the_attempt_log_queues_the_four_mails_when_the_lab_writes_the_events(rig):
    attempt, _ = rig.candidate_attempt()
    log = MailingAttemptLog(InMemoryAttemptLog(), mail_sink(rig.mail))
    at = "2026-10-21T10:00:00+00:00"
    log.append({"event": "time_warning_sent", "attempt_id": attempt, "at": at, "state": "running", "minutes_left": 15})
    log.append({"event": "session_submitted", "attempt_id": attempt, "at": at, "state": "submitted", "submitted_at": at, "reason": "manual"})
    log.append({"event": "attempt_withdrawn", "attempt_id": attempt, "at": at, "state": "withdrawn", "delete_after": "2026-10-28T10:00:00+00:00"})
    mail_sink(rig.mail)({"event": "results_released", "attempt_id": attempt, "at": at, "viewer_id": rig.owner.user_id})  # the release route appends this line (stream L, attempt-lifecycle)
    log.append({"event": "milestone_reached", "attempt_id": attempt, "at": at, "instance_id": "i-X", "challenge_key": "C01", "level": "M1"})  # no mail
    assert [p["minutes_left"] for _, p in rig.mails("candidate.time_warning")] == [15]
    assert len(rig.outbox("candidate.submission_received")) == 1 and len(rig.outbox("recruiter.submission_received")) == 1
    [(to, params)] = rig.mails("recruiter.consent_withdrawn")
    assert to == rig.owner.user_id and params["deletion_on"].startswith("2026-10-28")
    assert len(rig.outbox("candidate.results_released")) == 1
    assert len(log.read(attempt)) >= 3 and log.read_keyed(attempt)


def test_a_line_the_log_refuses_causes_no_mail_and_a_failing_sink_never_fails_the_write(rig):
    attempt, _ = rig.candidate_attempt()
    log = MailingAttemptLog(InMemoryAttemptLog(), mail_sink(rig.mail))
    with pytest.raises(ValueError):
        log.append({"event": "time_warning_sent", "attempt_id": attempt, "at": "x", "minutes_left": 5, "email": "a@b.example"})
    assert rig.outbox("candidate.time_warning") == []
    def boom(event):
        raise RuntimeError("mail down")
    broken = MailingAttemptLog(InMemoryAttemptLog(), boom)
    broken.append({"event": "session_submitted", "attempt_id": attempt, "at": "2026-10-21T10:00:00+00:00", "state": "submitted"})
    assert len(broken.read(attempt)) == 1


def test_the_real_engine_writes_the_warning_and_the_submission_mails_through_the_runtime():
    from test_lab_runtime import make_runtime
    rt, clock, _ = make_runtime()
    seen = []
    rt.mail_log.sink = lambda event: seen.append((event["event"], event.get("minutes_left")))
    started = rt.start_attempt("u-1")
    clock.advance(minutes=106)  # 14 minutes left: the 15-minute warning is due
    rt.tick()
    clock.advance(minutes=20)  # past the deadline: the attempt is submitted
    rt.tick()
    assert ("time_warning_sent", 15) in seen and ("session_submitted", None) in seen, seen
    assert rt.state(started.attempt_id)["state"] in ("submitted", "reported")