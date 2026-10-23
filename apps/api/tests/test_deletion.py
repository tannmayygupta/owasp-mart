"""Story P-25 (FR-PRV-08, FR-PRV-09, FR-PRV-11): the deletion workflow with its 7-day undo, the company's part, and the view history. Real company, template and invite services on
SQLite with the lab's `attempts` table; the lab's erase is a recording stand-in. The same flows against Postgres as the application role are in test_deletion_postgres.py."""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

import vulnmart.accounts.models  # noqa: F401
import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
from test_assessments import ANA, active_company, assessments, basic  # noqa: F401
from test_companies import ADMIN_SCOPE, T0, audit, clock, companies, ended, entries, org_row, sessions, signup, user_id, verify  # noqa: F401
from test_retention_candidates import Eraser, SCOPE
from vulnmart.accounts.models import User, UserRole
from vulnmart.assessments.models import Invite
from vulnmart.lab.models import Attempt
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.scope import Role, Scope
from vulnmart.privacy.deletion import DeletionExists, DeletionNotFound, DeletionService, DeletionState, NotLearner
from vulnmart.privacy.models import ConsentRecord, DataView, DeletionRequest, SubjectMap
from vulnmart.privacy.retention.candidates import NoEraser, months
from vulnmart.privacy.retention.records import SqlAttemptRecords
from vulnmart.privacy.subjects import SubjectService
from vulnmart.privacy.views import ViewHistory

CAND = "u-CANDIDATECANDID2"
OTHER = "u-OTHERCANDIDATE22"
LEARNER = "u-LEARNERONE222222"
LEARNER2 = "u-LEARNERTWO22222"
DAY = timedelta(days=1)


class Rig:
    def __init__(self, sessions, companies, assessments, audit, clock, eraser="default"):
        self.sessions, self.assessments, self.audit, self.clock = sessions, assessments, audit, clock
        self.owner = active_company(companies, sessions)
        self.org = self.owner.org_id
        self.eraser = Eraser() if eraser == "default" else eraser
        self.subjects = SubjectService(sessions)
        self.service = DeletionService(sessions, assessments, SqlAttemptRecords(sessions), FakeSettingsPort(), audit, self.subjects, self.eraser, now=clock)
        self.template = assessments.create_template(self.owner, basic(title="T"))
        self.count = 0

    def learner(self, uid=LEARNER, *, roles=("learner",), account_type="participant"):
        with self.sessions.begin() as s:
            s.add(User(id=uid, account_type=account_type, email=f"{uid}@example.org", email_ci=f"{uid}@example.org".lower(), password_hash="x", display_name="L",
                       status="active", email_verified_at=T0, last_login_at=T0))
            s.flush()
            if account_type == "participant":
                for role in roles:
                    s.add(UserRole(user_id=uid, role=role, account_type="participant"))

    def practice(self, uid, attempt_id):
        with self.sessions.begin() as s:
            s.add(Attempt(id=attempt_id, user_id=uid, template_id="t-" + attempt_id, org_id=None, state="reported", version=0, record={}))

    def candidate_attempt(self, *, user=CAND, state="submitted", consent=True):
        """An invite taken all the way to a started attempt of `user`; the attempt is over (submitted now) unless `state` says otherwise."""
        self.count += 1
        invite = self.assessments.create_invite(self.owner, self.template.template_id, f"c{self.count}@example.org")
        self.assessments.advance(self.org, invite.invite_id, "opened")
        attempt_id = self.assessments.bind_candidate(self.org, invite.invite_id, user).attempt_id
        self.assessments.advance(self.org, invite.invite_id, "consented")
        self.assessments.advance(self.org, invite.invite_id, "started")
        record = {"submitted_at": self.clock.now.isoformat()} if state == "submitted" else {}
        with self.sessions.begin() as s:
            s.add(Attempt(id=attempt_id, user_id=user, template_id=invite.template_id, org_id=self.org, state=state, version=0, record=record))
            if consent:
                s.add(ConsentRecord(id="k-" + attempt_id[2:].ljust(16, "A")[:16], user_id=user, attempt_id=attempt_id, org_id=self.org, template_id=invite.template_id,
                                    notice_version="2026-10-18.1", notice_text_sha256="0" * 64, notice_text_snapshot="text", retention_days_shown=180,
                                    controller_name_shown="Acme", action="granted", at=self.clock.now, audit_seq=1))
        return attempt_id, invite.invite_id

    def invites(self):
        with SCOPE.acting_as(Scope(user_id="system:test", org_id=self.org, roles=frozenset({Role.RECRUITER}))):
            with self.sessions() as s:
                return {i.id for i in s.scalars(select(Invite))}

    def consent(self, attempt_id):
        with self.sessions() as s:
            return s.scalars(select(ConsentRecord).where(ConsentRecord.attempt_id == attempt_id)).all()

    def user_exists(self, uid):
        with self.sessions() as s:
            return s.get(User, uid) is not None

    def row(self, request_id):
        with self.sessions() as s:
            s.expire_all()
            return s.get(DeletionRequest, request_id)

    def run(self, days=0):
        return self.service.run(self.clock.now + timedelta(days=days))


@pytest.fixture
def rig(sessions, companies, assessments, audit, clock):
    return Rig(sessions, companies, assessments, audit, clock)


def second_company(companies, sessions, *, email="other-owner@beta.example", company="Beta"):
    """A second approved company, for a test that needs two: `active_company`'s own fixed admin account already exists by the time this runs, so this skips
    `add_admin` instead of inserting it again."""
    signup(companies, email=email, company=company, name="Beta Owner")
    verify(sessions, email)
    uid = user_id(sessions, email)
    org_id = str(org_row(sessions, email).id)
    companies.approve(ADMIN_SCOPE, org_id)
    t = companies.terms_for(uid)
    companies.accept_terms(uid, t.version, t.sha256)
    return Scope(user_id=uid, org_id=org_id, roles=frozenset({Role.RECRUITER, Role.ORG_OWNER}))


# ---- a learner ---------------------------------------------------------------------------------------------------------------------------------

def test_a_learner_request_is_held_seven_days_and_audited(rig, audit):
    rig.learner()
    view = rig.service.request_learner(LEARNER)
    assert (view.kind, view.status, view.can_undo) == ("learner", "pending", True)
    assert view.execute_after == T0 + 7 * DAY and view.attempt_id is None and view.decide_by is None
    [(action, actor, subject, details)] = entries(audit, "deletion.requested")
    assert (actor, subject, details["kind"]) == (LEARNER, LEARNER, "learner")


def test_nothing_is_deleted_before_the_seven_days_are_up_and_everything_after(rig):
    rig.learner()
    rig.practice(LEARNER, "a-PRACTICEONE22222")
    rig.practice(LEARNER, "a-PRACTICETWO22222")
    pseudonym = rig.subjects.pseudonym(LEARNER)
    request = rig.service.request_learner(LEARNER)
    assert rig.run(6) == "0 learner requests done (0 kept the account for assessment data), 0 candidate requests done, 0 escalated"
    assert rig.user_exists(LEARNER) and rig.eraser.calls == []
    assert rig.run(7) == "1 learner requests done (0 kept the account for assessment data), 0 candidate requests done, 0 escalated"
    assert not rig.user_exists(LEARNER)
    assert sorted(rig.eraser.calls) == ["a-PRACTICEONE22222", "a-PRACTICETWO22222"]
    assert rig.subjects.identity(pseudonym) is None  # the log entries identify nobody now
    assert rig.row(request.request_id).status == "done" and rig.row(request.request_id).finished_at is not None


def test_an_undo_before_the_date_keeps_everything(rig):
    rig.learner()
    rig.practice(LEARNER, "a-PRACTICEONE22222")
    request = rig.service.request_learner(LEARNER)
    undone = rig.service.cancel(LEARNER, request.request_id)
    assert (undone.status, undone.can_undo) == ("cancelled", False)
    assert rig.run(30).startswith("0 learner requests done")
    assert rig.user_exists(LEARNER) and rig.eraser.calls == []


def test_after_an_undo_the_learner_can_ask_again_but_not_twice_at_once(rig):
    rig.learner()
    first = rig.service.request_learner(LEARNER)
    with pytest.raises(DeletionExists):
        rig.service.request_learner(LEARNER)
    rig.service.cancel(LEARNER, first.request_id)
    second = rig.service.request_learner(LEARNER)
    assert second.request_id != first.request_id and second.status == "pending"


def test_only_a_learner_account_asks_for_the_learner_deletion(rig):
    rig.learner("u-RECRUITERACCOUNT2", account_type="recruiter")
    rig.learner(CAND, roles=("candidate",))
    for who in ("u-RECRUITERACCOUNT2", CAND, "u-NOSUCHACCOUNT222"):
        with pytest.raises(NotLearner):
            rig.service.request_learner(who)


def test_a_request_that_is_not_yours_is_not_found_and_a_finished_one_cannot_be_undone(rig):
    rig.learner()
    rig.learner(LEARNER2)
    request = rig.service.request_learner(LEARNER)
    with pytest.raises(DeletionNotFound):
        rig.service.cancel(LEARNER2, request.request_id)
    with pytest.raises(DeletionNotFound):
        rig.service.cancel(LEARNER, "d-NOSUCHREQUEST222")
    rig.service.cancel(LEARNER, request.request_id)
    with pytest.raises(DeletionState):
        rig.service.cancel(LEARNER, request.request_id)
    assert rig.service.mine(LEARNER2) == []


def test_a_learner_who_took_part_in_an_assessment_keeps_the_account_but_loses_the_practice_data(rig):
    rig.learner(CAND, roles=("learner", "candidate"))
    rig.practice(CAND, "a-PRACTICEONE22222")
    rig.candidate_attempt(user=CAND)
    rig.service.request_learner(CAND)
    assert rig.run(7) == "0 learner requests done (1 kept the account for assessment data), 0 candidate requests done, 0 escalated"
    assert rig.user_exists(CAND)
    assert "a-PRACTICEONE22222" in rig.eraser.calls and len(rig.eraser.calls) == 1  # the assessment attempt is the company's: only the practice attempt went


def test_without_a_lab_to_erase_the_attempts_the_job_fails_and_the_request_stays_open(sessions, companies, assessments, audit, clock):
    rig = Rig(sessions, companies, assessments, audit, clock, eraser=None)
    rig.learner()
    rig.practice(LEARNER, "a-PRACTICEONE22222")
    request = rig.service.request_learner(LEARNER)
    with pytest.raises(NoEraser):
        rig.run(7)
    assert rig.user_exists(LEARNER) and rig.row(request.request_id).status == "pending"


def test_mine_lists_the_newest_first_and_nobody_elses(rig):
    rig.learner()
    rig.learner(LEARNER2)
    first = rig.service.request_learner(LEARNER)
    rig.service.cancel(LEARNER, first.request_id)
    clock_step = rig.clock
    clock_step.advance(hours=1)
    second = rig.service.request_learner(LEARNER)
    rig.service.request_learner(LEARNER2)
    assert [v.request_id for v in rig.service.mine(LEARNER)] == [second.request_id, first.request_id]


# ---- a candidate -------------------------------------------------------------------------------------------------------------------------------

def test_a_candidate_request_names_the_company_and_waits_for_its_decision_for_fourteen_days(rig):
    attempt, _ = rig.candidate_attempt()
    view = rig.service.request_candidate(CAND, attempt)
    assert (view.kind, view.status, view.attempt_id, view.company_name) == ("candidate", "pending", attempt, "Acme")
    assert view.decide_by == T0 + 14 * DAY and view.execute_after is None


def test_a_candidate_asks_only_about_their_own_finished_attempt(rig):
    mine, _ = rig.candidate_attempt()
    theirs, _ = rig.candidate_attempt(user=OTHER)
    going, _ = rig.candidate_attempt(user="u-THIRDCANDIDATE222", state="running")
    with pytest.raises(DeletionNotFound):
        rig.service.request_candidate(CAND, theirs)
    with pytest.raises(DeletionNotFound):
        rig.service.request_candidate(CAND, "a-NOSUCHATTEMPT2222")
    with pytest.raises(DeletionState):
        rig.service.request_candidate("u-THIRDCANDIDATE222", going)
    rig.service.request_candidate(CAND, mine)
    with pytest.raises(DeletionExists):
        rig.service.request_candidate(CAND, mine)


def test_a_request_nobody_approved_deletes_nothing_however_long_it_waits(rig):
    attempt, invite = rig.candidate_attempt()
    rig.service.request_candidate(CAND, attempt)
    assert rig.run(60).startswith("0 learner requests done (0 kept the account for assessment data), 0 candidate requests done")
    assert rig.eraser.calls == [] and invite in rig.invites()


def test_after_the_company_approves_the_record_goes_after_seven_days(rig):
    attempt, invite = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    rig.clock.advance(days=3)
    decided = rig.service.decide(rig.org, request.request_id, approve=True, actor_id=rig.owner.user_id)
    assert decided.status == "approved" and decided.execute_after == T0 + 10 * DAY
    assert rig.run(6).startswith("0 learner requests done (0 kept the account for assessment data), 0 candidate requests done")
    assert rig.eraser.calls == [] and invite in rig.invites()
    assert rig.run(7).startswith("0 learner requests done (0 kept the account for assessment data), 1 candidate requests done")
    assert rig.eraser.calls == [attempt] and invite not in rig.invites()
    [record] = rig.consent(attempt)
    assert record.erase_after is not None and record.erase_after.replace(tzinfo=None) == (T0 + 10 * DAY + months(12)).replace(tzinfo=None)  # the proof of consent outlives it (OI-37)
    assert rig.row(request.request_id).status == "done"


def test_the_candidate_can_undo_during_the_hold(rig):
    attempt, invite = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    rig.service.decide(rig.org, request.request_id, approve=True, actor_id=rig.owner.user_id)
    assert rig.service.cancel(CAND, request.request_id).status == "cancelled"
    rig.run(30)
    assert rig.eraser.calls == [] and invite in rig.invites()


def test_a_declined_request_deletes_nothing_and_cannot_be_decided_again(rig):
    attempt, invite = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    declined = rig.service.decide(rig.org, request.request_id, approve=False, actor_id=rig.owner.user_id)
    assert declined.status == "declined"
    with pytest.raises(DeletionState):
        rig.service.decide(rig.org, request.request_id, approve=True, actor_id=rig.owner.user_id)
    rig.run(60)
    assert rig.eraser.calls == [] and invite in rig.invites()
    assert rig.service.mine(CAND)[0].status == "declined" and not rig.service.mine(CAND)[0].can_undo


def test_a_company_decides_only_about_its_own_requests(rig):
    attempt, _ = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    with pytest.raises(DeletionNotFound):
        rig.service.decide("00000000-0000-0000-0000-000000000001", request.request_id, approve=True, actor_id="u-X")
    assert rig.row(request.request_id).status == "pending"
    assert [r.attempt_id for r in rig.service.for_company(rig.org)] == [attempt]
    assert rig.service.for_company("00000000-0000-0000-0000-000000000001") == []


def test_a_company_that_does_not_decide_in_fourteen_days_is_reported_to_the_admins_once(rig, audit):
    attempt, _ = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    assert rig.run(13).endswith("0 escalated")
    assert rig.run(14).endswith("1 escalated")
    assert rig.run(20).endswith("0 escalated")
    [(action, actor, subject, details)] = entries(audit, "deletion.escalated")
    assert details == {"org": rig.org, "request": request.request_id} and subject is None
    assert rig.row(request.request_id).status == "pending"  # escalation is a report, not a decision


def test_an_admin_sees_an_escalated_request_and_decides_it_on_the_silent_companys_behalf(rig):
    attempt, invite = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    assert rig.service.escalated() == []  # not escalated yet, not an admin's to decide
    rig.run(14)
    [row] = rig.service.escalated()
    assert (row.request_id, row.org_id, row.attempt_id) == (request.request_id, rig.org, attempt)
    decided = rig.service.decide_escalated(request.request_id, approve=True, actor_id="u-ADMINACCOUNT2222")
    assert decided.status == "approved" and decided.execute_after == T0 + 7 * DAY  # the usual 7-day hold starts from the decision, not from the escalation
    assert rig.service.escalated() == []  # decided, so no longer waiting on an admin
    assert rig.run(20).startswith("0 learner requests done (0 kept the account for assessment data), 1 candidate requests done")
    assert rig.eraser.calls == [attempt] and invite not in rig.invites()


def test_a_request_that_was_never_escalated_is_not_the_admins_to_decide(rig):
    attempt, _ = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    with pytest.raises(DeletionNotFound):
        rig.service.decide_escalated(request.request_id, approve=True, actor_id="u-ADMINACCOUNT2222")
    with pytest.raises(DeletionNotFound):
        rig.service.decide_escalated("d-NOSUCHREQUEST2222", approve=True, actor_id="u-ADMINACCOUNT2222")
    assert rig.row(request.request_id).status == "pending"


def test_an_escalated_request_the_company_already_decided_is_not_decided_twice(rig):
    attempt, _ = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    rig.run(14)
    rig.service.decide(rig.org, request.request_id, approve=False, actor_id=rig.owner.user_id)  # the company still can, even after the admins were told
    with pytest.raises(DeletionState):
        rig.service.decide_escalated(request.request_id, approve=True, actor_id="u-ADMINACCOUNT2222")
    assert rig.service.escalated() == []  # declined, not open any more: nothing left for an admin here


def test_an_admin_can_decline_an_escalated_request_too_and_it_deletes_nothing(rig):
    attempt, invite = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    rig.run(14)
    declined = rig.service.decide_escalated(request.request_id, approve=False, actor_id="u-ADMINACCOUNT2222")
    assert declined.status == "declined" and declined.execute_after is None
    rig.run(60)
    assert rig.eraser.calls == [] and invite in rig.invites()


def test_escalated_requests_are_listed_oldest_first_across_every_company(rig, companies, sessions):
    owner2 = second_company(companies, sessions)
    rig2_attempt_template = rig.assessments.create_template(owner2, basic(title="T2"))
    invite2 = rig.assessments.create_invite(owner2, rig2_attempt_template.template_id, "c-other@example.org")
    rig.assessments.advance(owner2.org_id, invite2.invite_id, "opened")
    other_attempt = rig.assessments.bind_candidate(owner2.org_id, invite2.invite_id, OTHER).attempt_id
    rig.assessments.advance(owner2.org_id, invite2.invite_id, "consented")
    rig.assessments.advance(owner2.org_id, invite2.invite_id, "started")
    with rig.sessions.begin() as s:
        s.add(Attempt(id=other_attempt, user_id=OTHER, template_id=invite2.template_id, org_id=owner2.org_id, state="submitted", version=0,
                      record={"submitted_at": rig.clock.now.isoformat()}))
    first_attempt, _ = rig.candidate_attempt()
    first = rig.service.request_candidate(CAND, first_attempt)
    rig.clock.advance(days=2)
    second = rig.service.request_candidate(OTHER, other_attempt)
    # two separate job passes, so the two requests get different escalated_at instants and the order is not left to an arbitrary id tiebreak
    rig.service.run(T0 + timedelta(days=15))  # past the first's 14-day deadline only
    rig.service.run(T0 + timedelta(days=17))  # now past the second's too (decide_by = T0 + 2 + 14 days)
    assert [r.request_id for r in rig.service.escalated()] == [first.request_id, second.request_id]


def test_the_admins_decision_is_audited_as_the_admins_not_the_company(rig, audit):
    attempt, _ = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    rig.run(14)
    rig.service.decide_escalated(request.request_id, approve=True, actor_id="u-ADMINACCOUNT2222")
    [(action, actor, subject, details)] = entries(audit, "deletion.admin_decided")
    assert (action, actor, subject) == ("deletion.admin_decided", "u-ADMINACCOUNT2222", None)
    assert details == {"org": rig.org, "request": request.request_id, "approved": True}
    assert entries(audit, "deletion.approved") == []  # this was the admin's decision, not the company's


def test_the_company_can_delete_a_candidate_at_any_time_and_that_settles_an_open_request(rig):
    attempt, invite = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    assert rig.service.company_delete(rig.org, attempt, actor_id=rig.owner.user_id) == 1
    assert rig.eraser.calls == [attempt] and invite not in rig.invites()
    assert rig.row(request.request_id).status == "done"
    assert rig.consent(attempt)[0].erase_after is not None


def test_a_company_cannot_delete_another_companys_attempt(rig):
    attempt, invite = rig.candidate_attempt()
    with pytest.raises(DeletionNotFound):
        rig.service.company_delete("00000000-0000-0000-0000-000000000002", attempt, actor_id="u-X")
    with pytest.raises(DeletionNotFound):
        rig.service.company_delete(rig.org, "a-NOSUCHATTEMPT2222", actor_id="u-X")
    assert rig.eraser.calls == [] and invite in rig.invites()


def test_the_audit_entries_name_the_company_and_counts_never_the_person(rig, audit):
    attempt, _ = rig.candidate_attempt()
    request = rig.service.request_candidate(CAND, attempt)
    rig.service.decide(rig.org, request.request_id, approve=True, actor_id=rig.owner.user_id)
    rig.run(7)
    rig.service.company_delete(rig.org, attempt, actor_id=rig.owner.user_id)
    for action in ("deletion.approved", "deletion.candidate_done", "deletion.company_deleted"):
        for _, actor, subject, details in entries(audit, action):
            assert subject is None and CAND not in str(details) and "@" not in str(details)
    [(_, _, _, done)] = entries(audit, "deletion.candidate_done")
    assert done == {"org": rig.org, "attempts": 1, "invites": 1}


def test_the_view_history_of_a_candidate_goes_with_the_record(rig):
    attempt, _ = rig.candidate_attempt()
    views = ViewHistory(rig.sessions, now=rig.clock)
    views.record(candidate_user_id=CAND, org_id=rig.org, org_name="Acme", action="viewed")
    views.record(candidate_user_id=CAND, org_id="another-company", org_name="Other Co", action="viewed")
    rig.service.company_delete(rig.org, attempt, actor_id=rig.owner.user_id)
    entries_, _ = views.list_mine(CAND)
    assert [e.company_name for e in entries_] == ["Other Co"]  # only the deleted company's history went


def test_a_learner_deletion_removes_the_view_history_too(rig):
    rig.learner()
    ViewHistory(rig.sessions, now=rig.clock).record(candidate_user_id=LEARNER, org_id="x", org_name="Acme", action="viewed")
    rig.service.request_learner(LEARNER)
    rig.run(7)
    with rig.sessions() as s:
        assert s.scalars(select(DataView)).all() == []
        assert s.scalars(select(SubjectMap).where(SubjectMap.user_id == LEARNER)).all() == []


# ---- who viewed me -----------------------------------------------------------------------------------------------------------------------------

def test_a_view_is_company_action_and_time_and_the_same_view_twice_in_a_day_is_one_entry(sessions, clock):
    views = ViewHistory(sessions, now=clock)
    assert views.record(candidate_user_id=CAND, org_id="o1", org_name="Acme", action="viewed") is True
    assert views.record(candidate_user_id=CAND, org_id="o1", org_name="Acme", action="viewed") is False
    assert views.record(candidate_user_id=CAND, org_id="o1", org_name="Acme", action="exported") is True
    clock.advance(days=1, minutes=1)
    assert views.record(candidate_user_id=CAND, org_id="o1", org_name="Acme", action="viewed") is True
    items, more = views.list_mine(CAND)
    assert [(e.company_name, e.action) for e in items] == [("Acme", "viewed"), ("Acme", "exported"), ("Acme", "viewed")] and not more
    assert all(e.at.tzinfo is not None for e in items)


def test_a_person_reads_only_their_own_history_and_the_list_is_paged(sessions, clock):
    views = ViewHistory(sessions, now=clock)
    for index in range(3):
        views.record(candidate_user_id=CAND, org_id=f"o{index}", org_name=f"Co {index}", action="viewed")
    views.record(candidate_user_id=OTHER, org_id="o9", org_name="Secret Co", action="viewed")
    items, more = views.list_mine(CAND, limit=2)
    assert len(items) == 2 and more is True and "Secret Co" not in [e.company_name for e in items]
    assert views.list_mine("u-NOBODYATALL222222") == ([], False)


def test_an_unknown_action_is_refused(sessions, clock):
    with pytest.raises(ValueError):
        ViewHistory(sessions, now=clock).record(candidate_user_id=CAND, org_id="o1", org_name="Acme", action="peeked")
