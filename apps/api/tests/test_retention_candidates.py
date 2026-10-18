"""Story P-24 (FR-PRV-04, OI-37): a candidate's assessment record is deleted when its time is up. Real company, template and invite services on SQLite with the lab's `attempts`
table; the lab's erase is a recording stand-in. The same job against Postgres and the privileged consent purge are in test_retention_postgres.py."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
from test_assessments import ANA, CAND, active_company, assessments, basic  # noqa: F401
from test_companies import ADMIN_SCOPE, T0, audit, clock, companies, ended, entries, org_row, sessions, signup, user_id, verify  # noqa: F401
from vulnmart.assessments.models import Invite
from vulnmart.kernel.scope import ContextScopePort
from vulnmart.lab.models import Attempt
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.scope import Role, Scope
from vulnmart.privacy.models import ConsentRecord
from vulnmart.privacy.retention.candidates import SHORTEST_DAYS, CandidateRetention, NoEraser, months
from vulnmart.privacy.retention.records import SqlAttemptRecords

DAY = timedelta(days=1)
SCOPE = ContextScopePort()


class Eraser:
    def __init__(self):
        self.calls = []

    def __call__(self, attempt_id):
        self.calls.append(attempt_id)


class Rig:
    def __init__(self, sessions, companies, assessments, audit, clock, eraser="default"):
        self.sessions, self.companies, self.assessments, self.audit, self.clock = sessions, companies, assessments, audit, clock
        self.owner = active_company(companies, sessions)
        self.eraser = Eraser() if eraser == "default" else eraser
        self.records = SqlAttemptRecords(sessions)
        self.settings = FakeSettingsPort()
        self.retention = CandidateRetention(sessions, assessments, self.records, self.settings, audit, self.eraser)
        self.templates = {}

    def template(self, retention_days=None):
        key = retention_days
        if key not in self.templates:
            extra = {} if retention_days is None else {"retention_days": retention_days}
            self.templates[key] = self.assessments.create_template(self.owner, basic(title=f"T{len(self.templates)}", **extra))
        return self.templates[key]

    def invite(self, email, *, retention_days=None):
        return self.assessments.create_invite(self.owner, self.template(retention_days).template_id, email)

    def take_part(self, invite, *, state="submitted", ended_in_days=0, user="u-CANDIDATECANDID2", org=True, started=True, record=None, consent=True):
        """The invite goes opened, bound, consented and started (when asked); the lab has the attempt in `state`, ended `ended_in_days` after the invite was made (the clock
        stands at that moment); a consent record exists."""
        oid = self.owner.org_id
        self.assessments.advance(oid, invite.invite_id, "opened")
        bound = self.assessments.bind_candidate(oid, invite.invite_id, user)
        attempt_id = bound.attempt_id
        self.assessments.advance(oid, invite.invite_id, "consented")
        if started:
            self.assessments.advance(oid, invite.invite_id, "started")
        ended = self.clock.now + timedelta(days=ended_in_days)
        rec = {"submitted_at": ended.isoformat()} if state in ("submitted", "reported") else ({"cancelled_at": ended.isoformat()} if state == "cancelled" else {})
        rec.update(record or {})
        with self.sessions.begin() as s:
            s.add(Attempt(id=attempt_id, user_id=user, template_id=invite.template_id, org_id=oid if org else None, state=state, version=0, record=rec))
            if consent:
                s.add(ConsentRecord(id="k-" + attempt_id[2:].ljust(16, "A")[:16], user_id=user, attempt_id=attempt_id, org_id=oid, template_id=invite.template_id,
                                    notice_version="2026-10-18.1", notice_text_sha256="0" * 64, notice_text_snapshot="text", retention_days_shown=180,
                                    controller_name_shown="Acme", action="granted", at=ended, audit_seq=1))
        return attempt_id

    def invites(self):
        with SCOPE.acting_as(Scope(user_id="system:test", org_id=self.owner.org_id, roles=frozenset({Role.RECRUITER}))):
            with self.sessions() as s:
                return {i.id: i for i in s.scalars(select(Invite))}

    def consent(self, attempt_id):
        with self.sessions() as s:
            return s.scalars(select(ConsentRecord).where(ConsentRecord.attempt_id == attempt_id)).all()

    def run(self, days_from_now=0):
        return self.retention.run(self.clock.now + timedelta(days=days_from_now))


@pytest.fixture
def rig(sessions, companies, assessments, audit, clock):
    return Rig(sessions, companies, assessments, audit, clock)


# ---- when a record is due ---------------------------------------------------------------------------------------------------------------------

def test_an_invite_the_candidate_never_started_is_deleted_a_retention_period_after_the_invite_date(rig):
    old = rig.invite("old@example.org")
    assert rig.run(179) == "0 invites deleted, 0 attempts erased"
    assert old.invite_id in rig.invites()
    assert rig.run(181) == "1 invites deleted, 0 attempts erased"
    assert rig.invites() == {} and rig.eraser.calls == []


def test_the_template_chooses_the_period_between_30_and_365_days_and_the_platform_default_is_180(rig):
    short = rig.invite("short@example.org", retention_days=30)
    default = rig.invite("default@example.org")
    long = rig.invite("long@example.org", retention_days=365)
    rig.run(29)
    assert set(rig.invites()) == {short.invite_id, default.invite_id, long.invite_id}
    rig.run(31)
    assert set(rig.invites()) == {default.invite_id, long.invite_id}
    rig.run(181)
    assert set(rig.invites()) == {long.invite_id}
    rig.run(366)
    assert rig.invites() == {}


def test_nothing_is_looked_at_before_the_shortest_retention_a_template_may_set(rig):
    rig.invite("new@example.org", retention_days=30)
    assert SHORTEST_DAYS == 30
    rig.settings.set("candidate_retention_days", 1)  # even a platform default shorter than that cannot make a young invite due
    assert rig.run(5) == "0 invites deleted, 0 attempts erased"


def test_the_clock_of_a_started_assessment_runs_from_the_end_of_the_attempt_not_from_the_invite(rig):
    invite = rig.invite("taker@example.org", retention_days=30)
    attempt = rig.take_part(invite, ended_in_days=100)  # the invite is made today, the attempt ends in 100 days
    assert rig.run(129) == "0 invites deleted, 0 attempts erased", "the invite is 129 days old, the attempt ended 29 days ago"
    assert invite.invite_id in rig.invites() and rig.eraser.calls == []
    assert rig.run(131) == "1 invites deleted, 1 attempts erased"
    assert rig.eraser.calls == [attempt]


def test_an_attempt_that_is_still_going_is_never_due(rig):
    invite = rig.invite("taker@example.org", retention_days=30)
    rig.take_part(invite, state="running", started=True)
    assert rig.run(400) == "0 invites deleted, 0 attempts erased"
    assert invite.invite_id in rig.invites()


def test_cancelled_and_expired_attempts_end_when_they_were_cancelled_or_reached_their_deadline(rig):
    cancelled = rig.invite("c@example.org", retention_days=30)
    expired = rig.invite("e@example.org", retention_days=30)
    rig.take_part(cancelled, state="cancelled", ended_in_days=5)
    rig.take_part(expired, state="expired", record={"deadline_at": (rig.clock.now + timedelta(days=10)).isoformat()}, user="u-OTHERCANDIDATE222")
    assert rig.run(34) == "0 invites deleted, 0 attempts erased", "the cancelled one ended 29 days ago, the expired one 24 days ago"
    assert rig.run(41) == "2 invites deleted, 2 attempts erased"


def test_an_attempt_whose_data_is_already_gone_makes_its_invite_due_at_once_without_erasing_again(rig):
    invite = rig.invite("gone@example.org", retention_days=365)
    rig.take_part(invite, state="submitted")
    with rig.sessions.begin() as s:
        s.delete(s.get(Attempt, rig.invites()[invite.invite_id].attempt_id))
    assert rig.run(31) == "1 invites deleted, 0 attempts erased"
    assert rig.eraser.calls == []


def test_an_invite_that_was_opened_but_never_consented_to_has_no_attempt_and_is_due_by_its_invite_date(rig):
    invite = rig.invite("opened@example.org", retention_days=30)
    rig.assessments.advance(rig.owner.org_id, invite.invite_id, "opened")
    rig.assessments.bind_candidate(rig.owner.org_id, invite.invite_id, "u-CANDIDATECANDID2")
    assert rig.run(10) == "0 invites deleted, 0 attempts erased"
    assert rig.run(31) == "1 invites deleted, 0 attempts erased"


def test_a_declined_invite_goes_with_the_others_and_its_decline_record_is_scheduled(rig):
    invite = rig.invite("decline@example.org", retention_days=30)
    oid = rig.owner.org_id
    rig.assessments.advance(oid, invite.invite_id, "opened")
    attempt = rig.assessments.bind_candidate(oid, invite.invite_id, "u-CANDIDATECANDID2").attempt_id
    rig.assessments.advance(oid, invite.invite_id, "declined")
    with rig.sessions.begin() as s:
        s.add(ConsentRecord(id="k-DECLINEDDECLINED"[:18], user_id="u-CANDIDATECANDID2", attempt_id=attempt, org_id=oid, template_id=invite.template_id, notice_version="v",
                            notice_text_sha256="0" * 64, notice_text_snapshot="t", retention_days_shown=30, controller_name_shown="Acme", action="declined", at=T0, audit_seq=1))
    rig.run(31)
    assert rig.invites() == {}
    [record] = rig.consent(attempt)
    assert record.erase_after is not None


# ---- what is done when it is due --------------------------------------------------------------------------------------------------------------

def test_a_due_assessment_is_erased_its_consent_record_scheduled_a_year_later_and_its_invite_deleted_in_that_order(rig):
    order = []
    invite = rig.invite("taker@example.org", retention_days=30)
    attempt = rig.take_part(invite)

    def eraser(attempt_id):
        order.append(("erase", attempt_id, len(rig.invites()), rig.consent(attempt_id)[0].erase_after))

    rig.retention._eraser = eraser
    summary = rig.run(31)
    assert summary == "1 invites deleted, 1 attempts erased"
    [(kind, erased, invites_then, scheduled_then)] = order
    assert (kind, erased, invites_then, scheduled_then) == ("erase", attempt, 1, None), "the data goes first: the invite and the consent record are still there"
    [record] = rig.consent(attempt)
    assert record.erase_after.replace(tzinfo=UTC) == rig.clock.now + timedelta(days=31) + months(12), "OI-37: the consent record outlives the assessment record by 12 months"
    assert rig.invites() == {}


def test_the_consent_extra_time_is_the_setting(rig):
    invite = rig.invite("taker@example.org", retention_days=30)
    attempt = rig.take_part(invite)
    rig.settings.set("consent_record_extra_months", 6)
    rig.run(31)
    assert rig.consent(attempt)[0].erase_after.replace(tzinfo=UTC) == rig.clock.now + timedelta(days=31) + months(6)


def test_a_second_run_changes_nothing(rig):
    invite = rig.invite("taker@example.org", retention_days=30)
    attempt = rig.take_part(invite)
    rig.run(31)
    first = rig.consent(attempt)[0].erase_after
    assert rig.run(34) == "0 invites deleted, 0 attempts erased"
    assert rig.consent(attempt)[0].erase_after == first and rig.eraser.calls == [attempt]


def test_without_a_way_to_erase_the_job_fails_and_deletes_nothing(sessions, companies, assessments, audit, clock):
    rig = Rig(sessions, companies, assessments, audit, clock, eraser=None)
    invite = rig.invite("taker@example.org", retention_days=30)
    attempt = rig.take_part(invite)
    with pytest.raises(NoEraser):
        rig.run(31)
    assert invite.invite_id in rig.invites() and rig.consent(attempt)[0].erase_after is None


def test_a_failing_erase_leaves_the_invite_so_the_next_run_finishes_the_job(rig):
    invite = rig.invite("taker@example.org", retention_days=30)
    attempt = rig.take_part(invite)
    state = {"fail": True}

    def flaky(attempt_id):
        if state["fail"]:
            raise ConnectionError("the lab database is away")
        rig.eraser.calls.append(attempt_id)

    rig.retention._eraser = flaky
    with pytest.raises(ConnectionError):
        rig.run(31)
    assert invite.invite_id in rig.invites() and rig.consent(attempt)[0].erase_after is None
    state["fail"] = False
    assert rig.run(31) == "1 invites deleted, 1 attempts erased" and rig.eraser.calls == [attempt]


def test_the_audit_entry_names_the_company_and_counts_and_never_a_person(rig, audit):
    invite = rig.invite("taker@example.org", retention_days=30)
    rig.take_part(invite)
    rig.run(31)
    [(action, actor, subject, details)] = entries(audit, "retention.candidate_deleted")
    assert (action, actor, subject) == ("retention.candidate_deleted", "job:candidate_retention", None)
    assert details == {"org": rig.owner.org_id, "invites": 1, "attempts": 1}
    assert "taker@example.org" not in str(details) and "u-CANDIDATE" not in str(details)


def test_the_invites_of_every_company_are_handled_and_each_company_is_audited_separately(rig, sessions, companies, assessments, audit, clock):
    mine = rig.invite("a@example.org", retention_days=30)
    signup(companies, email="dee@other.example", company="Other", name="Dee")
    verify(sessions, "dee@other.example")
    other_org = str(org_row(sessions, "dee@other.example").id)
    companies.approve(ADMIN_SCOPE, other_org)
    dee_user = user_id(sessions, "dee@other.example")
    terms = companies.terms_for(dee_user)
    companies.accept_terms(dee_user, terms.version, terms.sha256)
    dee = Scope(user_id=dee_user, org_id=other_org, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))
    theirs = assessments.create_invite(dee, assessments.create_template(dee, basic(retention_days=30)).template_id, "b@example.org")
    assert rig.run(31) == "2 invites deleted, 0 attempts erased"
    assert sorted(d["org"] for _, _, _, d in entries(audit, "retention.candidate_deleted")) == sorted([rig.owner.org_id, other_org])
    assert rig.invites() == {} and mine.invite_id and theirs.invite_id


def test_an_invite_a_candidate_is_still_inside_the_period_of_stays_with_its_consent_record_untouched(rig):
    invite = rig.invite("taker@example.org", retention_days=365)
    attempt = rig.take_part(invite)
    assert rig.run(100) == "0 invites deleted, 0 attempts erased"
    assert invite.invite_id in rig.invites() and rig.consent(attempt)[0].erase_after is None
