"""Story P-25 against a real Postgres 18 as the application role: migration 0015, the privileges of `deletion_requests` and `data_views`, the one-open-request indexes, a candidate's
request carried out through row-level security (the invite of the company goes, no other company's does), and a learner's request through the account cascade. Skipped unless
VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py)."""
from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

import vulnmart.live.models  # noqa: F401
import vulnmart.privacy.models  # noqa: F401
from support import ROOT
from test_assessments_postgres import BASIC, assessments, company  # noqa: F401
from test_companies_postgres import APP, OWNER, app_engine, clean, companies, database, owner, sessions  # noqa: F401
from test_kernel_postgres import with_db
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.privacy.deletion import DeletionExists, DeletionNotFound, DeletionService
from vulnmart.privacy.retention.candidates import months
from vulnmart.privacy.retention.records import SqlAttemptRecords
from vulnmart.privacy.subjects import SubjectService
from vulnmart.privacy.views import ViewHistory

pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
NOW = datetime.now(UTC).replace(microsecond=0)
CAND = "u-CANDIDATECANDID2"
LEARNER = "u-LEARNERONE222222"


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


@pytest.fixture(autouse=True)
def clean_deletion(owner):
    with owner.begin() as c:
        for table in ("deletion_requests", "data_views", "evidence", "attempts", "consent_records", "subject_map"):
            c.execute(text(f"DELETE FROM {table}"))
    yield


def scalar(engine, sql, **params):
    with engine.connect() as c:
        return c.execute(text(sql), params).scalar_one()


def request_row(owner, request_id="d-AAAAAAAAAAAAAAAA", kind="learner", user=LEARNER, attempt=None, org=None, status="pending"):
    with owner.begin() as c:
        c.execute(text("INSERT INTO deletion_requests (id, kind, user_id, attempt_id, org_id, status, requested_at) VALUES (:i, :k, :u, :a, :o, :s, now())"),
                  {"i": request_id, "k": kind, "u": user, "a": attempt, "o": org, "s": status})


# ---- migration 0015 and the privileges ------------------------------------------------------------------------------------------------------------

def test_migration_0015_goes_down_and_up_again(database, owner):
    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, database[2])
    command.downgrade(cfg, "0014")
    assert scalar(owner, "SELECT to_regclass('deletion_requests')") is None and scalar(owner, "SELECT to_regclass('data_views')") is None
    command.upgrade(cfg, "head")
    assert scalar(owner, "SELECT to_regclass('deletion_requests')") is not None and scalar(owner, "SELECT to_regclass('data_views')") is not None


def test_the_application_role_can_move_a_request_on_but_not_change_who_asked_or_delete_it(owner, app_engine):
    request_row(owner, kind="candidate", attempt="a-AAAAAAAAAAAAAAAA", org="o1")
    with app_engine.begin() as c:
        c.execute(text("UPDATE deletion_requests SET status = 'approved', decided_at = now(), execute_after = now(), escalated_at = now(), finished_at = now()"))
    for column in ("user_id", "kind", "attempt_id", "org_id", "requested_at", "decide_by", "id"):
        value = "now()" if column in ("requested_at", "decide_by") else "'x'"
        with pytest.raises(DBAPIError):
            with app_engine.begin() as c:
                c.execute(text(f"UPDATE deletion_requests SET {column} = {value}"))
    with pytest.raises(DBAPIError):
        with app_engine.begin() as c:
            c.execute(text("DELETE FROM deletion_requests"))


def test_a_view_can_be_added_read_and_deleted_but_never_changed(owner, app_engine):
    with app_engine.begin() as c:
        c.execute(text("INSERT INTO data_views (candidate_user_id, org_id, org_name, action, at) VALUES (:u, 'o1', 'Acme', 'viewed', now())"), {"u": CAND})
    assert scalar(app_engine, "SELECT count(*) FROM data_views") == 1
    for column, value in (("org_name", "'Other'"), ("action", "'exported'"), ("candidate_user_id", "'u-X'")):
        with pytest.raises(DBAPIError):
            with app_engine.begin() as c:
                c.execute(text(f"UPDATE data_views SET {column} = {value}"))
    with app_engine.begin() as c:
        assert c.execute(text("DELETE FROM data_views")).rowcount == 1


def test_the_database_allows_one_open_request_per_learner_and_per_candidate_attempt(owner):
    request_row(owner, "d-AAAAAAAAAAAAAAAA")
    with pytest.raises(DBAPIError):
        request_row(owner, "d-BBBBBBBBBBBBBBBB")
    request_row(owner, "d-CCCCCCCCCCCCCCCC", kind="candidate", attempt="a-AAAAAAAAAAAAAAAA", org="o1")
    request_row(owner, "d-DDDDDDDDDDDDDDDD", kind="candidate", attempt="a-BBBBBBBBBBBBBBBB", org="o1")  # another attempt: allowed
    with pytest.raises(DBAPIError):
        request_row(owner, "d-EEEEEEEEEEEEEEEE", kind="candidate", attempt="a-AAAAAAAAAAAAAAAA", org="o1")
    with owner.begin() as c:
        c.execute(text("UPDATE deletion_requests SET status = 'cancelled' WHERE id = 'd-AAAAAAAAAAAAAAAA'"))
    request_row(owner, "d-FFFFFFFFFFFFFFFF")  # after an undo a new request is fine
    with pytest.raises(DBAPIError):
        request_row(owner, "d-GGGGGGGGGGGGGGGG", kind="candidate", attempt=None, org=None)  # a candidate request must name its attempt and company


# ---- the flows -------------------------------------------------------------------------------------------------------------------------------------

def test_a_candidates_request_is_carried_out_through_row_level_security(owner, app_engine, sessions, companies, assessments):
    ana = company(companies, owner)
    bo = company(companies, owner, "bo@other.example", "Other")
    template = assessments.create_template(ana, BASIC)
    invite = assessments.create_invite(ana, template.template_id, "taker@example.org")
    other_invite = assessments.create_invite(bo, assessments.create_template(bo, BASIC).template_id, "someone@example.org")
    assessments.advance(ana.org_id, invite.invite_id, "opened")
    attempt = assessments.bind_candidate(ana.org_id, invite.invite_id, CAND).attempt_id
    assessments.advance(ana.org_id, invite.invite_id, "consented")
    assessments.advance(ana.org_id, invite.invite_id, "started")
    with owner.begin() as c:
        c.execute(text("INSERT INTO attempts (id, user_id, template_id, org_id, state, version, record) VALUES (:a, :u, :t, :o, 'submitted', 0, "
                       "jsonb_build_object('submitted_at', now()::text))"), {"a": attempt, "u": CAND, "t": template.template_id, "o": ana.org_id})
        c.execute(text("INSERT INTO consent_records (id, user_id, attempt_id, org_id, template_id, notice_version, notice_text_sha256, notice_text_snapshot, retention_days_shown, "
                       "controller_name_shown, action, at, method, audit_seq) VALUES ('k-CONSENTAAAAAAAAA', :u, :a, :o, :t, 'v', :h, 't', 30, 'Acme', 'granted', now(), 'web', 1)"),
                  {"u": CAND, "a": attempt, "o": ana.org_id, "t": template.template_id, "h": "0" * 64})
    clock, erased, audit = Clock(NOW), [], FakeAuditPort()
    service = DeletionService(sessions, assessments, SqlAttemptRecords(sessions), FakeSettingsPort(), audit, SubjectService(sessions), erased.append, now=clock)
    views = ViewHistory(sessions, now=clock)
    views.record(candidate_user_id=CAND, org_id=ana.org_id, org_name="Acme", action="viewed")
    views.record(candidate_user_id=CAND, org_id=bo.org_id, org_name="Other", action="viewed")

    request = service.request_candidate(CAND, attempt)
    assert request.company_name == "Acme"
    with pytest.raises(DeletionExists):
        service.request_candidate(CAND, attempt)
    with pytest.raises(DeletionNotFound):
        service.decide(bo.org_id, request.request_id, approve=True, actor_id=bo.user_id)  # the other company cannot decide it
    assert scalar(owner, "SELECT status FROM deletion_requests") == "pending"
    service.decide(ana.org_id, request.request_id, approve=True, actor_id=ana.user_id)
    clock.now = NOW + timedelta(days=6)
    assert service.run(clock.now).split(", ")[1].startswith("0 candidate requests done") and erased == []
    clock.now = NOW + timedelta(days=7, minutes=1)
    assert "1 candidate requests done" in service.run(clock.now)
    assert erased == [attempt]
    assert scalar(owner, "SELECT count(*) FROM invites WHERE id = :i", i=invite.invite_id) == 0
    assert scalar(owner, "SELECT count(*) FROM invites WHERE id = :i", i=other_invite.invite_id) == 1, "the other company's invite is untouched"
    due = scalar(owner, "SELECT erase_after FROM consent_records")
    assert abs((due - (clock.now + months(12))).total_seconds()) < 60
    assert [r[0] for r in owner.connect().execute(text("SELECT org_name FROM data_views"))] == ["Other"]
    assert scalar(owner, "SELECT status FROM deletion_requests") == "done"


def test_a_learners_request_deletes_the_account_with_its_sessions_and_roles_and_the_pseudonym(owner, app_engine, sessions):
    with owner.begin() as c:
        c.execute(text("INSERT INTO users (id, account_type, email, email_ci, password_hash, display_name, status, email_verified_at, last_login_at) VALUES "
                       "(:i, 'participant', 'l@example.org', 'l@example.org', 'x', 'L', 'active', now(), now())"), {"i": LEARNER})
        c.execute(text("INSERT INTO user_roles (user_id, role, account_type) VALUES (:i, 'learner', 'participant')"), {"i": LEARNER})
        c.execute(text("INSERT INTO attempts (id, user_id, template_id, org_id, state, version, record) VALUES ('a-PRACTICEONE22222', :u, 't', NULL, 'reported', 0, '{}'::jsonb)"),
                  {"u": LEARNER})
    subjects = SubjectService(sessions)
    pseudonym = subjects.pseudonym(LEARNER)
    clock, erased = Clock(NOW), []
    service = DeletionService(sessions, None, SqlAttemptRecords(sessions), FakeSettingsPort(), FakeAuditPort(), subjects, erased.append, now=clock)
    request = service.request_learner(LEARNER)
    clock.now = NOW + timedelta(days=7) - timedelta(minutes=1)
    service.run(clock.now)
    assert scalar(owner, "SELECT count(*) FROM users WHERE id = :i", i=LEARNER) == 1
    service.cancel(LEARNER, request.request_id)
    clock.now = NOW + timedelta(days=30)
    service.run(clock.now)
    assert scalar(owner, "SELECT count(*) FROM users WHERE id = :i", i=LEARNER) == 1 and erased == []  # undone: nothing happened
    again = service.request_learner(LEARNER)
    clock.now = NOW + timedelta(days=30, minutes=1) + timedelta(days=7)
    service.run(clock.now)
    assert scalar(owner, "SELECT count(*) FROM users WHERE id = :i", i=LEARNER) == 0
    assert scalar(owner, "SELECT count(*) FROM user_roles WHERE user_id = :i", i=LEARNER) == 0
    assert erased == ["a-PRACTICEONE22222"] and subjects.identity(pseudonym) is None
    assert scalar(owner, "SELECT status FROM deletion_requests WHERE id = :i", i=again.request_id) == "done"
