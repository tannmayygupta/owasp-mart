"""Story P-24 (FR-PRV-05, FR-PRV-16): a learner's data goes 12 months after their last login, with a warning email 30 days before; a login before the date cancels the
deletion; an account that took part in an assessment keeps its account until that data is gone. SQLite, the real session service, the real mail outbox table, a recording
stand-in for the lab's erase."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

import vulnmart.accounts.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
import vulnmart.notifications.models  # noqa: F401
from test_companies import T0, audit, clock, entries, sessions  # noqa: F401
from vulnmart.accounts.models import User, UserRole, UserSession
from vulnmart.accounts.sessions import SessionService
from vulnmart.lab.models import Attempt
from vulnmart.notifications.models import EmailOutbox
from vulnmart.notifications.templates import TEMPLATES
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.privacy.models import ConsentRecord, SubjectMap
from vulnmart.privacy.subjects import PseudonymisingAudit, SubjectService
from vulnmart.privacy.retention.candidates import NoEraser, months
from vulnmart.privacy.retention.learners import LearnerRetention
from vulnmart.privacy.retention.records import SqlAttemptRecords

ORIGIN = "https://vulnmart.example"
YEAR = months(12)
WARN = timedelta(days=30)


class Eraser:
    def __init__(self):
        self.calls = []

    def __call__(self, attempt_id):
        self.calls.append(attempt_id)


class Rig:
    def __init__(self, sessions, audit, clock, eraser="default"):
        self.sessions, self.clock = sessions, clock
        self.settings = FakeSettingsPort()
        self.eraser = Eraser() if eraser == "default" else eraser
        self.subjects = SubjectService(sessions)
        self.audit = audit
        self.retention = LearnerRetention(sessions, SqlAttemptRecords(sessions), self.settings, PseudonymisingAudit(audit, self.subjects), self.subjects, self.eraser,
                                          public_origin=ORIGIN)

    def learner(self, uid, *, last_login_days_ago: float | None = 0, roles=("learner",), account_type="participant", verified=True, status="active", created_days_ago=0):
        last = None if last_login_days_ago is None else T0 - timedelta(days=last_login_days_ago)
        with self.sessions.begin() as s:
            s.add(User(id=uid, account_type=account_type, email=f"{uid}@example.org", email_ci=f"{uid}@example.org".lower(), password_hash="x", display_name="L", status=status,
                       email_verified_at=T0 if verified else None, last_login_at=last, created_at=T0 - timedelta(days=created_days_ago)))
            s.flush()
            if account_type == "participant":
                for role in roles:
                    s.add(UserRole(user_id=uid, role=role, account_type="participant"))

    def user(self, uid):
        with self.sessions() as s:
            s.expire_all()
            return s.get(User, uid)

    def mails(self):
        with self.sessions() as s:
            return [(r.template, r.to_user_id, dict(r.params)) for r in s.scalars(select(EmailOutbox).order_by(EmailOutbox.id))]

    def practice(self, uid, attempt_id, org=None):
        with self.sessions.begin() as s:
            s.add(Attempt(id=attempt_id, user_id=uid, template_id=f"t-{attempt_id}", org_id=org, state="reported", version=0, record={}))

    def at(self, days):
        return T0 + timedelta(days=days)


@pytest.fixture
def rig(sessions, audit, clock):
    return Rig(sessions, audit, clock)


L1, L2, L3 = "u-LEARNERONE222222", "u-LEARNERTWO22222", "u-LEARNERTHREE3333"  # real user ids: the audit pseudonymiser only recognises Base32 ids


# ---- the warning ------------------------------------------------------------------------------------------------------------------------------

def test_a_learner_is_warned_thirty_days_before_the_twelve_months_are_up(rig):
    rig.learner(L1, last_login_days_ago=0)
    assert rig.retention.warn(T0 + YEAR - WARN - timedelta(days=1)) == "0 warned"
    assert rig.mails() == []
    due = T0 + YEAR - WARN
    assert rig.retention.warn(due) == "1 warned"
    [(template, to, params)] = rig.mails()
    assert (template, to) == ("learner.retention_warning", L1)
    assert params == {"delete_on": (T0 + YEAR).date().isoformat(), "login_url": f"{ORIGIN}/login"}
    assert rig.user(L1).retention_warned_at.replace(tzinfo=UTC) == due


def test_the_warning_is_sent_once(rig):
    rig.learner(L1)
    rig.retention.warn(T0 + YEAR)
    assert rig.retention.warn(T0 + YEAR + timedelta(days=1)) == "0 warned" and len(rig.mails()) == 1


def test_the_mail_validates_against_its_template_and_says_nothing_of_a_legal_duty(rig):
    rig.learner(L1)
    rig.retention.warn(T0 + YEAR)
    [(template, _, params)] = rig.mails()
    rendered = TEMPLATES[template].build({k: str(v) for k, v in params.items()})
    text = (rendered.text if hasattr(rendered, "text") else str(rendered)).lower()
    assert "deleted" in text and "sign in" in text
    for claim in ("legal", "law", "required", "obliged", "48 hours", "48-hour", "dpdp", "gdpr"):
        assert claim not in text, claim


def test_only_active_verified_learners_are_warned(rig):
    rig.learner(L1)
    rig.learner(L2, verified=False)
    rig.learner(L3, status="disabled")
    rig.learner("u-RECRUITERRECRUIT2", account_type="recruiter")
    rig.learner("u-ADMINADMINADMIN22", account_type="admin")
    rig.learner("u-CANDIDATEONLY2222", roles=("candidate",))
    assert rig.retention.warn(T0 + YEAR) == "1 warned"
    assert [to for _, to, _ in rig.mails()] == [L1]


def test_a_learner_who_never_logged_in_counts_from_the_day_the_account_was_made(rig):
    rig.learner(L1, last_login_days_ago=None, created_days_ago=400)
    assert rig.retention.warn(T0) == "1 warned"


def test_the_warning_time_and_the_retention_are_settings(rig):
    rig.learner(L1)
    rig.settings.set("learner_retention_months", 6)
    rig.settings.set("learner_warning_days", 10)
    assert rig.retention.warn(T0 + months(6) - timedelta(days=11)) == "0 warned"
    assert rig.retention.warn(T0 + months(6) - timedelta(days=10)) == "1 warned"


def test_a_login_clears_the_warning_so_the_deletion_is_cancelled_and_a_later_silence_is_warned_again(rig, sessions, clock):
    rig.learner(L1)
    rig.retention.warn(T0 + YEAR)
    assert rig.user(L1).retention_warned_at is not None
    service = SessionService(sessions, rig.settings, b"k" * 32, now=lambda: T0 + YEAR + timedelta(days=5))
    service.open_session(L1, ip_trunc=None, ua_class=None, mfa=False)
    after = rig.user(L1)
    assert after.retention_warned_at is None
    assert after.last_login_at.replace(tzinfo=UTC) == T0 + YEAR + timedelta(days=5)
    assert rig.retention.delete(T0 + YEAR + timedelta(days=60)) == "0 learners deleted, 0 kept for assessment data", "the login cancelled the deletion"
    assert rig.user(L1) is not None
    assert rig.retention.warn(T0 + YEAR + timedelta(days=5) + YEAR) == "1 warned", "twelve more silent months earn a new warning"


# ---- the deletion -----------------------------------------------------------------------------------------------------------------------------

def test_a_warned_learner_is_deleted_after_the_twelve_months_and_the_warning_period(rig, audit):
    rig.learner(L1)
    rig.retention.warn(T0 + YEAR - WARN)
    assert rig.retention.delete(T0 + YEAR - timedelta(days=1)) == "0 learners deleted, 0 kept for assessment data"
    assert rig.retention.delete(T0 + YEAR) == "1 learners deleted, 0 kept for assessment data"
    assert rig.user(L1) is None


def test_a_learner_is_never_deleted_without_having_been_warned_first_at_least_thirty_days_ago(rig):
    rig.learner(L1)
    assert rig.retention.delete(T0 + YEAR + timedelta(days=100)) == "0 learners deleted, 0 kept for assessment data", "no warning was sent: nothing is deleted"
    rig.retention.warn(T0 + YEAR + timedelta(days=100))
    assert rig.retention.delete(T0 + YEAR + timedelta(days=129)) == "0 learners deleted, 0 kept for assessment data", "the warning is 29 days old"
    assert rig.retention.delete(T0 + YEAR + timedelta(days=130)) == "1 learners deleted, 0 kept for assessment data"


def test_the_practice_attempts_are_erased_and_the_account_row_and_its_pseudonym_go(rig, sessions, audit):
    rig.learner(L1)
    rig.practice(L1, "a-PRACTICEONE111AA")
    rig.practice(L1, "a-PRACTICETWO222AA")
    rig.practice(L2, "a-SOMEONEELSE33AAA")
    rig.learner(L2, last_login_days_ago=-200)  # signed in 200 days after L1: not due yet
    with sessions.begin() as s:
        s.add(UserSession(id_hash="h" * 64, user_id=L1, last_seen_at=T0, absolute_expires_at=T0))
    rig.retention._audit.append(actor="x", action="seed", subject=L1)  # a pseudonym exists for the learner
    assert rig.retention.warn(T0 + YEAR - WARN) == "1 warned"
    rig.retention.delete(T0 + YEAR)
    assert sorted(rig.eraser.calls) == ["a-PRACTICEONE111AA", "a-PRACTICETWO222AA"], "only the learner's own practice attempts"
    assert rig.user(L1) is None and rig.user(L2) is not None
    with sessions() as s:
        assert s.scalar(select(SubjectMap.user_id).where(SubjectMap.user_id == L1)) is None, "the audit entries identify nobody now"
    [(action, actor, subject, details)] = entries(audit, "retention.learner_deleted")
    assert (action, actor, details) == ("retention.learner_deleted", "job:learner_retention", {"attempts": 2})
    assert subject.startswith("s-") and L1 not in str(entries(audit))


def test_an_account_that_took_part_in_an_assessment_keeps_its_account_but_loses_its_practice_data(rig, sessions):
    rig.learner(L1, roles=("learner", "candidate"))
    rig.practice(L1, "a-PRACTICEONE111AA")
    rig.practice(L1, "a-ASSESSMENT1111AA", org="o-1")
    rig.retention.warn(T0 + YEAR - WARN)
    assert rig.retention.delete(T0 + YEAR) == "0 learners deleted, 1 kept for assessment data"
    assert rig.eraser.calls == ["a-PRACTICEONE111AA"], "the company's attempt is not touched"
    assert rig.user(L1) is not None
    with sessions.begin() as s:
        s.delete(s.get(Attempt, "a-ASSESSMENT1111AA"))
    assert rig.retention.delete(T0 + YEAR + timedelta(days=1)) == "1 learners deleted, 0 kept for assessment data", "once the assessment data is gone the account can go"


def test_a_consent_record_alone_keeps_the_account(rig, sessions):
    rig.learner(L1, roles=("learner", "candidate"))
    with sessions.begin() as s:
        s.add(ConsentRecord(id="k-AAAAAAAAAAAAAAAA", user_id=L1, attempt_id="a-GONEGONEGONE1AA", notice_version="v", notice_text_sha256="0" * 64, notice_text_snapshot="t",
                            retention_days_shown=30, controller_name_shown="Acme", action="declined", at=T0, audit_seq=1))
    rig.retention.warn(T0 + YEAR - WARN)
    assert rig.retention.delete(T0 + YEAR) == "0 learners deleted, 1 kept for assessment data"


def test_without_a_way_to_erase_the_job_fails_and_deletes_nothing(sessions, audit, clock):
    rig = Rig(sessions, audit, clock, eraser=None)
    rig.learner(L1)
    rig.practice(L1, "a-PRACTICEONE111AA")
    rig.retention.warn(T0 + YEAR - WARN)
    with pytest.raises(NoEraser):
        rig.retention.delete(T0 + YEAR)
    assert rig.user(L1) is not None


def test_a_learner_with_no_attempts_needs_no_eraser(sessions, audit, clock):
    rig = Rig(sessions, audit, clock, eraser=None)
    rig.learner(L1)
    rig.retention.warn(T0 + YEAR - WARN)
    assert rig.retention.delete(T0 + YEAR) == "1 learners deleted, 0 kept for assessment data"


def test_a_failing_erase_leaves_the_learner_for_the_next_run(rig):
    rig.learner(L1)
    rig.practice(L1, "a-PRACTICEONE111AA")
    rig.retention.warn(T0 + YEAR - WARN)

    def broken(attempt_id):
        raise ConnectionError("the lab database is away")

    rig.retention._eraser = broken
    with pytest.raises(ConnectionError):
        rig.retention.delete(T0 + YEAR)
    assert rig.user(L1) is not None
    rig.retention._eraser = rig.eraser
    assert rig.retention.delete(T0 + YEAR) == "1 learners deleted, 0 kept for assessment data"
