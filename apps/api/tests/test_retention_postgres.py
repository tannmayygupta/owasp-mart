"""Story P-24 against a real Postgres 18 as the application role: migration 0014, the two privileged functions (the audit purge with its checkpoint, the scheduled consent purge) and
what they refuse, the column-level and row-level privileges the jobs rely on, the lease of the scheduler under real concurrency, the learner deletion cascade, and the whole
scheduler on the real tables. Skipped unless VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN are set (see test_kernel_postgres.py)."""
from __future__ import annotations

import os
import threading
import time
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import sessionmaker

import vulnmart.live.models  # noqa: F401
from support import ROOT
from test_assessments_postgres import BASIC, assessments, company  # noqa: F401
from test_companies_postgres import APP, OWNER, app_engine, clean, companies, database, owner, sessions  # noqa: F401
from test_kernel_postgres import with_db
from vulnmart.kernel.audit import DbAuditPort
from vulnmart.ports.fakes import FakeAuditPort, FakeSettingsPort
from vulnmart.privacy.subjects import SubjectService
from vulnmart.privacy.retention.build import build_scheduler
from vulnmart.privacy.retention.candidates import CandidateRetention, months
from vulnmart.privacy.retention.learners import LearnerRetention
from vulnmart.privacy.retention.records import SqlAttemptRecords
from vulnmart.privacy.retention.scheduler import Job, Scheduler

pytestmark = pytest.mark.skipif(not (OWNER and APP), reason="needs VULNMART_TEST_POSTGRES_DSN and VULNMART_TEST_APP_DSN")
NOW = datetime.now(UTC)


@pytest.fixture(autouse=True)
def clean_retention(owner):
    with owner.begin() as c:
        for table in ("domain_events", "evidence", "attempts", "consent_records", "job_runs", "audit_checkpoint", "subject_map", "security_events"):
            c.execute(text(f"DELETE FROM {table}"))
        c.execute(text("DELETE FROM audit_anchor"))
        c.execute(text("DELETE FROM audit_log"))
    yield


def scalar(owner, sql, **params):
    with owner.connect() as c:
        return c.execute(text(sql), params).scalar_one()


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


def audit_chain(sessions, ages_in_days):
    """A real hash chain whose entries were written `ages_in_days` ago (oldest first)."""
    clock = Clock(NOW)
    port = DbAuditPort(sessions, now=clock)
    for n, days in enumerate(ages_in_days):
        clock.now = NOW - timedelta(days=days)
        port.append(actor="job:test", action="test.entry", subject=None, details={"n": n})
    return port


# ---- migration 0014 ------------------------------------------------------------------------------------------------------------------------------

def test_the_columns_the_functions_and_who_may_run_them_exist(owner):
    with owner.connect() as c:
        cols = {(r[0], r[1]) for r in c.execute(text("SELECT table_name, column_name FROM information_schema.columns WHERE column_name IN ('retention_warned_at', 'erase_after')"))}
        assert cols == {("users", "retention_warned_at"), ("consent_records", "erase_after")}
        for fn in ("purge_audit_log(timestamptz)", "purge_consent_records()"):
            assert c.execute(text(f"SELECT has_function_privilege('vulnmart_app', '{fn}', 'EXECUTE')")).scalar_one() is True
            assert c.execute(text(f"SELECT has_function_privilege('public', '{fn}', 'EXECUTE')")).scalar_one() is False
            assert c.execute(text(f"SELECT prosecdef FROM pg_proc WHERE oid = '{fn}'::regprocedure")).scalar_one() is True


def test_migration_0014_goes_down_and_up_again(database, owner):
    cfg = Config(str(ROOT / "apps" / "api" / "alembic.ini"))
    os.environ["VULNMART_MIGRATE_DSN"] = with_db(OWNER, database[2])
    command.downgrade(cfg, "0013")
    with owner.connect() as c:
        assert c.execute(text("SELECT to_regprocedure('purge_audit_log(timestamptz)')")).scalar_one() is None
        assert c.execute(text("SELECT count(*) FROM information_schema.columns WHERE column_name IN ('retention_warned_at', 'erase_after')")).scalar_one() == 0
    command.upgrade(cfg, "head")
    with owner.connect() as c:
        assert c.execute(text("SELECT to_regprocedure('purge_consent_records()')")).scalar_one() is not None


# ---- the audit purge -------------------------------------------------------------------------------------------------------------------------------

def test_the_audit_purge_removes_what_is_older_than_twelve_months_writes_the_checkpoint_and_the_chain_still_verifies(sessions, app_engine):
    port = audit_chain(sessions, [500, 450, 400, 380, 100, 10, 1])
    head = port.head()
    with app_engine.begin() as c:
        removed = c.execute(text("SELECT purge_audit_log(:b)"), {"b": NOW}).scalar_one()
    assert removed == 4, "the four entries older than twelve months"
    assert port.head() == head
    verify = port.verify()
    assert verify.ok and verify.checked == 3, "verification starts at the checkpoint and walks the rest"
    with app_engine.connect() as c:
        seqs = [r[0] for r in c.execute(text("SELECT seq FROM audit_log ORDER BY seq"))]
        (cp_seq, cp_reason) = c.execute(text("SELECT seq, reason FROM audit_checkpoint")).one()
    assert len(seqs) == 3 and cp_seq == seqs[0] - 1 and cp_reason == "retention"
    port.append(actor="job:test", action="test.after", subject=None, details={})
    assert port.verify().ok, "an entry written after the purge chains on as before"
    with app_engine.begin() as c:
        assert c.execute(text("SELECT purge_audit_log(:b)"), {"b": NOW}).scalar_one() == 0


def test_the_audit_purge_never_deletes_what_is_younger_than_twelve_months_whatever_it_is_asked(sessions, app_engine):
    audit_chain(sessions, [364, 200, 5])
    with app_engine.begin() as c:
        assert c.execute(text("SELECT purge_audit_log(:b)"), {"b": NOW + timedelta(days=3650)}).scalar_one() == 0
        assert c.execute(text("SELECT purge_audit_log(:b)"), {"b": NOW}).scalar_one() == 0
    assert scalar(app_engine, "SELECT count(*) FROM audit_log") == 3


def test_the_newest_entry_always_stays_even_when_every_entry_is_old(sessions, app_engine):
    port = audit_chain(sessions, [900, 800, 700])
    with app_engine.begin() as c:
        assert c.execute(text("SELECT purge_audit_log(:b)"), {"b": NOW}).scalar_one() == 2
    assert scalar(app_engine, "SELECT count(*) FROM audit_log") == 1
    assert port.verify().ok
    port.append(actor="job:test", action="test.after", subject=None, details={})
    assert port.verify().ok and scalar(app_engine, "SELECT count(*) FROM audit_log") == 2


def test_the_application_role_still_cannot_touch_the_audit_log_directly(sessions, app_engine):
    audit_chain(sessions, [500, 1])
    for statement in ("DELETE FROM audit_log", "UPDATE audit_log SET actor = 'x'", "TRUNCATE audit_log", "DELETE FROM audit_checkpoint", "DELETE FROM audit_anchor"):
        with pytest.raises(DBAPIError, match="permission denied"):
            with app_engine.begin() as c:
                c.execute(text(statement))


# ---- the consent purge -----------------------------------------------------------------------------------------------------------------------------

def consent_row(owner, n, erase_after):
    with owner.begin() as c:
        c.execute(text("INSERT INTO consent_records (id, user_id, attempt_id, org_id, template_id, notice_version, notice_text_sha256, notice_text_snapshot, retention_days_shown, "
                       "controller_name_shown, action, at, method, audit_seq, erase_after) VALUES (:i, 'u-AAAAAAAAAAAAAAAA', :a, 'o', 't', 'v', :h, 't', 30, 'Acme', 'granted', now(), "
                       "'web', 1, :e)"), {"i": f"k-AAAAAAAAAAAAAAA{n}", "a": f"a-AAAAAAAAAAAAAAA{n}", "h": "0" * 64, "e": erase_after})


def test_the_consent_purge_deletes_only_records_whose_erase_date_has_passed(owner, app_engine):
    consent_row(owner, 1, NOW - timedelta(days=1))
    consent_row(owner, 2, NOW + timedelta(days=30))
    consent_row(owner, 3, None)
    with app_engine.begin() as c:
        assert c.execute(text("SELECT purge_consent_records()")).scalar_one() == 1
    assert scalar(owner, "SELECT string_agg(id, ',' ORDER BY id) FROM consent_records") == "k-AAAAAAAAAAAAAAA2,k-AAAAAAAAAAAAAAA3"
    with app_engine.begin() as c:
        assert c.execute(text("SELECT purge_consent_records()")).scalar_one() == 0


def test_the_application_role_can_set_the_erase_date_and_nothing_else_of_a_consent_record(owner, app_engine):
    consent_row(owner, 1, None)
    with app_engine.begin() as c:
        assert c.execute(text("UPDATE consent_records SET erase_after = :e"), {"e": NOW}).rowcount == 1
    for statement in ("UPDATE consent_records SET action = 'declined'", "UPDATE consent_records SET notice_text_snapshot = 'x'", "DELETE FROM consent_records", "TRUNCATE consent_records"):
        with pytest.raises(DBAPIError, match="permission denied"):
            with app_engine.begin() as c:
                c.execute(text(statement))


# ---- candidate retention on the real tables ------------------------------------------------------------------------------------------------------

def test_a_due_candidate_record_goes_through_row_level_security_and_the_consent_record_follows_later(owner, app_engine, sessions, companies, assessments):
    ana = company(companies, owner)
    template = assessments.create_template(ana, {**BASIC, "retention_days": 30})
    invite = assessments.create_invite(ana, template.template_id, "taker@example.org")
    assessments.advance(ana.org_id, invite.invite_id, "opened")
    attempt = assessments.bind_candidate(ana.org_id, invite.invite_id, "u-CANDIDATECANDID2").attempt_id
    assessments.advance(ana.org_id, invite.invite_id, "consented")
    assessments.advance(ana.org_id, invite.invite_id, "started")
    with owner.begin() as c:
        c.execute(text("INSERT INTO attempts (id, user_id, template_id, org_id, state, version, record) VALUES (:a, 'u-CANDIDATECANDID2', :t, :o, 'submitted', 0, "
                       "jsonb_build_object('submitted_at', now()::text))"), {"a": attempt, "t": template.template_id, "o": ana.org_id})
        c.execute(text("INSERT INTO consent_records (id, user_id, attempt_id, org_id, template_id, notice_version, notice_text_sha256, notice_text_snapshot, retention_days_shown, "
                       "controller_name_shown, action, at, method, audit_seq) VALUES ('k-CONSENTAAAAAAAAA', 'u-CANDIDATECANDID2', :a, :o, :t, 'v', :h, 't', 30, 'Acme', 'granted', now(), "
                       "'web', 1)"), {"a": attempt, "o": ana.org_id, "t": template.template_id, "h": "0" * 64})
    erased = []
    retention = CandidateRetention(sessions, assessments, SqlAttemptRecords(sessions), FakeSettingsPort(), FakeAuditPort(), erased.append)
    assert retention.run(NOW + timedelta(days=5)) == "0 invites deleted, 0 attempts erased"
    assert retention.run(NOW + timedelta(days=31)) == "1 invites deleted, 1 attempts erased"
    assert erased == [attempt] and scalar(owner, "SELECT count(*) FROM invites") == 0
    due = scalar(owner, "SELECT erase_after FROM consent_records")
    assert abs((due - (NOW + timedelta(days=31) + months(12))).total_seconds()) < 60
    with owner.begin() as c:  # a year on: the date has passed
        c.execute(text("UPDATE consent_records SET erase_after = now() - interval '1 day'"))
    with app_engine.begin() as c:
        assert c.execute(text("SELECT purge_consent_records()")).scalar_one() == 1
    assert scalar(owner, "SELECT count(*) FROM consent_records") == 0


def test_an_invite_of_another_company_cannot_be_deleted_by_a_job_that_names_the_wrong_company(owner, companies, assessments):
    ana = company(companies, owner)
    bo = company(companies, owner, "bo@other.example", "Other")
    mine = assessments.create_invite(ana, assessments.create_template(ana, BASIC).template_id, "a@example.org")
    theirs = assessments.create_invite(bo, assessments.create_template(bo, BASIC).template_id, "b@example.org")
    assert assessments.delete_invites(bo.org_id, [mine.invite_id]) == 0, "row-level security hides it"
    assert assessments.delete_invites(bo.org_id, [theirs.invite_id]) == 1
    assert scalar(owner, "SELECT count(*) FROM invites") == 1


# ---- learners ------------------------------------------------------------------------------------------------------------------------------------

def test_a_deleted_learner_takes_the_sessions_tokens_roles_and_pseudonym_with_it(owner, app_engine, sessions):
    uid = "u-LEARNERONE222222"
    with owner.begin() as c:
        c.execute(text("INSERT INTO users (id, account_type, email, email_ci, password_hash, display_name, status, email_verified_at, last_login_at) VALUES "
                       "(:i, 'participant', 'l@example.org', 'l@example.org', 'x', 'L', 'active', now(), :l)"), {"i": uid, "l": NOW - months(13)})
        c.execute(text("INSERT INTO user_roles (user_id, role, account_type) VALUES (:i, 'learner', 'participant')"), {"i": uid})
        c.execute(text("INSERT INTO sessions (id_hash, user_id, last_seen_at, absolute_expires_at) VALUES (:h, :i, now(), now())"), {"h": "h" * 64, "i": uid})
        c.execute(text("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, attempts) VALUES (:h, :i, 'verify', now(), 0)"), {"h": "t" * 64, "i": uid})
        c.execute(text("INSERT INTO subject_map (subject_id, user_id) VALUES ('s-AAAAAAAAAAAAAAAA', :i)"), {"i": uid})
        c.execute(text("INSERT INTO attempts (id, user_id, template_id, org_id, state, version, record) VALUES ('a-PRACTICEONE111AA', :i, 't', NULL, 'reported', 0, '{}'::jsonb)"), {"i": uid})
    erased = []
    retention = LearnerRetention(sessions, SqlAttemptRecords(sessions), FakeSettingsPort(), FakeAuditPort(), SubjectService(sessions), erased.append, public_origin="https://vulnmart.example")
    assert retention.warn(NOW) == "1 warned"
    assert scalar(owner, "SELECT count(*) FROM email_outbox WHERE template = 'learner.retention_warning' AND to_user_id = :i", i=uid) == 1
    assert retention.delete(NOW + timedelta(days=29)) == "0 learners deleted, 0 kept for assessment data"
    assert retention.delete(NOW + timedelta(days=31)) == "1 learners deleted, 0 kept for assessment data"
    assert erased == ["a-PRACTICEONE111AA"]
    for table in ("users", "user_roles", "sessions", "email_tokens", "subject_map"):
        assert scalar(owner, f"SELECT count(*) FROM {table} WHERE user_id = :i" if table != "users" else "SELECT count(*) FROM users WHERE id = :i", i=uid) == 0, table


# ---- the scheduler ---------------------------------------------------------------------------------------------------------------------------------

def test_six_processes_starting_the_same_job_at_once_run_it_once(sessions):
    ran = []
    gate = threading.Barrier(6)

    def slow(now):
        ran.append(1)
        time.sleep(0.4)
        return "done"

    scheduler = Scheduler(sessions, [Job("slow", timedelta(days=1), slow)], FakeAuditPort())
    results = []

    def go():
        gate.wait()
        results.append(scheduler.run("slow"))

    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == [False] * 5 + [True] and ran == [1]


def test_the_whole_scheduler_runs_on_the_real_tables_with_the_application_role(sessions, assessments, owner, app_engine):
    port = audit_chain(sessions, [500, 450, 5])
    consent_row(owner, 1, NOW - timedelta(days=1))
    scheduler = build_scheduler(sessions=sessions, assessments=assessments, settings=FakeSettingsPort(), audit=FakeAuditPort(), subjects=SubjectService(sessions),
                                eraser=lambda a: None, anchors=None, streams=None, public_origin="https://vulnmart.example")
    assert scheduler.run_due() == [job.name for job in scheduler.jobs]
    statuses = {s.name: (s.last_status, s.last_detail) for s in scheduler.status()}
    assert all(status == "succeeded" for status, _ in statuses.values()), statuses
    assert statuses["log_purge"][1].startswith("2 audit entries"), statuses["log_purge"]
    assert statuses["consent_purge"][1] == "1 consent records purged"
    assert port.verify().ok
    assert scalar(owner, "SELECT count(*) FROM job_runs WHERE status = 'succeeded'") == len(scheduler.jobs)
