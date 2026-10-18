"""Story P-24 (FR-PRV-06, 14, 15, 18): the housekeeping jobs (sessions and tokens, learner evidence, logs, consent purge, live cleanup, invite jobs, the audit anchor) and the scheduler
built from all of them. SQLite; the privileged database functions (audit purge with a checkpoint, the consent purge) are tested on Postgres in test_retention_postgres.py."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

import vulnmart.accounts.models  # noqa: F401
import vulnmart.assessments.models  # noqa: F401
import vulnmart.lab.models  # noqa: F401
import vulnmart.live.models  # noqa: F401
from test_assessments import ANA, CAND, active_company, assessments, basic  # noqa: F401
from test_companies import T0, audit, clock, companies, ended, sessions  # noqa: F401
from vulnmart.accounts.models import EmailToken, User, UserSession
from vulnmart.kernel.models import JobRun
from vulnmart.lab.models import Attempt, Evidence, SecurityEvent
from vulnmart.live.models import DomainEvent
from vulnmart.live.store import MemoryStreamStore
from vulnmart.notifications.models import EmailOutbox
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.privacy.retention.build import build_scheduler
from vulnmart.privacy.retention.candidates import months
from vulnmart.privacy.retention.housekeeping import (
    AccountHousekeeping, ConsentPurge, EvidenceRetention, InviteJobs, LiveCleanup, LogPurge, anchor_audit,
)
from vulnmart.privacy.retention.records import SqlAttemptRecords

DAY = timedelta(days=1)


def ago(days, now=T0):
    return now - timedelta(days=days)


# ---- sessions and tokens (FR-PRV-14) -----------------------------------------------------------------------------------------------------------

def test_a_session_that_ended_ninety_days_ago_is_deleted_with_its_network_prefix_and_browser_class(sessions):
    with sessions.begin() as s:
        s.add(User(id="u-AAAAAAAAAAAAAAAA", account_type="participant", email="a@example.org", email_ci="a@example.org", password_hash="x", display_name="A", status="active"))
        s.flush()
        for name, ended in (("old", ago(91)), ("edge", ago(89)), ("live", T0 + DAY)):
            s.add(UserSession(id_hash=name.ljust(64, "0"), user_id="u-AAAAAAAAAAAAAAAA", last_seen_at=ago(100), absolute_expires_at=ended, ip_trunc="203.0.113.0/24", ua_class="browser"))
        s.add(EmailToken(token_hash="t" * 64, user_id="u-AAAAAAAAAAAAAAAA", purpose="verify", expires_at=ago(31), attempts=0))
        s.add(EmailToken(token_hash="u" * 64, user_id="u-AAAAAAAAAAAAAAAA", purpose="reset", expires_at=ago(29), attempts=0))
    job = AccountHousekeeping(sessions, FakeSettingsPort())
    assert job.run(T0) == "1 sessions and 1 tokens deleted"
    with sessions() as s:
        assert sorted(r.id_hash[:4] for r in s.scalars(select(UserSession))) == ["edge", "live"]
        assert [r.token_hash[0] for r in s.scalars(select(EmailToken))] == ["u"]
    assert job.run(T0) == "0 sessions and 0 tokens deleted"


def test_the_session_details_time_is_a_setting(sessions):
    with sessions.begin() as s:
        s.add(User(id="u-AAAAAAAAAAAAAAAA", account_type="participant", email="a@example.org", email_ci="a@example.org", password_hash="x", display_name="A", status="active"))
        s.flush()
        s.add(UserSession(id_hash="s" * 64, user_id="u-AAAAAAAAAAAAAAAA", last_seen_at=ago(40), absolute_expires_at=ago(31), ip_trunc="203.0.113.0/24", ua_class="browser"))
    settings = FakeSettingsPort({"session_details_days": 30})
    assert AccountHousekeeping(sessions, settings).run(T0).startswith("1 sessions")


# ---- evidence (FR-PRV-06) -----------------------------------------------------------------------------------------------------------------------

def attempt_with_evidence(sessions, attempt_id, *, org=None, destroyed=True, destroyed_days_ago=40, items=2):
    with sessions.begin() as s:
        s.add(Attempt(id=attempt_id, user_id="u-AAAAAAAAAAAAAAAA", template_id=f"t-{attempt_id}", org_id=org, state="reported", version=0,
                      record={"destroyed": destroyed, "destroy_claim_at": ago(destroyed_days_ago).isoformat(), "submitted_at": ago(destroyed_days_ago + 1).isoformat()}))
        s.flush()
        for n in range(items):
            s.add(Evidence(id=f"{attempt_id}-e{n}", attempt_id=attempt_id, challenge_key="C01", captured_at=ago(destroyed_days_ago + 1), size=10, dek_id="d", kek_version=1,
                           nonce="n", ciphertext=b"x", aad=b"y"))


def evidence_left(sessions):
    with sessions() as s:
        return sorted({e.attempt_id for e in s.scalars(select(Evidence))})


def test_a_learners_evidence_goes_thirty_days_after_the_instance_was_destroyed(sessions):
    attempt_with_evidence(sessions, "a-OLD", destroyed_days_ago=40)
    attempt_with_evidence(sessions, "a-RECENT", destroyed_days_ago=10)
    attempt_with_evidence(sessions, "a-RUNNING", destroyed=False, destroyed_days_ago=90)
    job = EvidenceRetention(sessions, SqlAttemptRecords(sessions), FakeSettingsPort())
    assert job.run(T0) == "evidence of 1 attempts deleted (2 items)"
    assert evidence_left(sessions) == ["a-RECENT", "a-RUNNING"]
    assert job.run(T0 + timedelta(days=21)) == "evidence of 1 attempts deleted (2 items)"
    assert evidence_left(sessions) == ["a-RUNNING"], "an instance that still exists keeps its evidence"
    assert job.run(T0 + timedelta(days=100)) == "evidence of 0 attempts deleted (0 items)"


def test_the_evidence_of_a_candidate_attempt_is_not_touched_by_the_learner_rule(sessions):
    attempt_with_evidence(sessions, "a-CAND", org="o-1", destroyed_days_ago=400)
    assert EvidenceRetention(sessions, SqlAttemptRecords(sessions), FakeSettingsPort()).run(T0) == "evidence of 0 attempts deleted (0 items)"
    assert evidence_left(sessions) == ["a-CAND"], "a candidate's evidence goes with the assessment record (candidate retention)"


def test_the_evidence_time_is_a_setting(sessions):
    attempt_with_evidence(sessions, "a-OLD", destroyed_days_ago=10)
    job = EvidenceRetention(sessions, SqlAttemptRecords(sessions), FakeSettingsPort({"learner_evidence_days": 7}))
    assert job.run(T0).startswith("evidence of 1 attempts")


# ---- logs (FR-PRV-15) ---------------------------------------------------------------------------------------------------------------------------

def test_the_logs_are_purged_after_twelve_months_and_the_sealed_address_of_a_dead_mail_after_thirty_days(sessions):
    now = T0 + months(12) + timedelta(days=2)
    with sessions.begin() as s:
        for number, (name, at) in enumerate((("old", now - months(12) - DAY), ("new", now - months(11))), start=1):
            s.add(SecurityEvent(id=number, kind=name, instance_id="i", epoch=1, seq=1, created_at=at))  # SQLite does not number a bigint key by itself
            s.add(JobRun(job=name, started_at=at, finished_at=at, status="succeeded"))
        s.add(JobRun(job="running", started_at=now - months(13), status="running"))
        s.add(EmailOutbox(template="system.test", to_user_id="u-A", params={}, state="sent", attempts=1, next_attempt_at=now, sent_at=now - months(12) - DAY))
        s.add(EmailOutbox(template="system.test", to_user_id="u-B", params={}, state="sent", attempts=1, next_attempt_at=now, sent_at=now - DAY))
        s.add(EmailOutbox(template="candidate.invite", to_user_id="i-OLDFAILED", to_address_sealed="v1.sealed", params={}, state="failed", attempts=5, next_attempt_at=now,
                          updated_at=now - timedelta(days=31)))
        s.add(EmailOutbox(template="candidate.invite", to_user_id="i-NEWFAILED", to_address_sealed="v1.sealed", params={}, state="failed", attempts=5, next_attempt_at=now,
                          updated_at=now - timedelta(days=29)))
        s.add(EmailOutbox(template="candidate.invite", to_user_id="i-PENDING", to_address_sealed="v1.sealed", params={}, state="pending", attempts=0, next_attempt_at=now,
                          updated_at=now - timedelta(days=60)))
    assert LogPurge(sessions, FakeSettingsPort()).run(now) == "0 audit entries, 1 security events, 1 job runs, 1 mails purged; 1 sealed addresses cleared"
    with sessions() as s:
        assert [e.kind for e in s.scalars(select(SecurityEvent))] == ["new"]
        assert sorted(j.job for j in s.scalars(select(JobRun))) == ["new", "running"], "a run that never finished is not a log to purge"
        assert {r.to_user_id: r.to_address_sealed for r in s.scalars(select(EmailOutbox)) if r.to_user_id.startswith("i-")} == {
            "i-OLDFAILED": None, "i-NEWFAILED": "v1.sealed", "i-PENDING": "v1.sealed"}, "a mail still waiting to be sent keeps its address"
        assert sorted(r.to_user_id for r in s.scalars(select(EmailOutbox)) if r.state == "sent") == ["u-B"]


def test_the_consent_purge_has_nothing_to_do_without_the_database_function(sessions):
    assert ConsentPurge(sessions).run(T0) == "0 consent records purged (no database function here)"


# ---- live cleanup -------------------------------------------------------------------------------------------------------------------------------

def test_published_event_rows_are_deleted_after_a_week_and_idle_streams_are_cleared(sessions):
    now = T0
    with sessions.begin() as s:
        s.add(DomainEvent(type="a.b", payload={}, created_at=ago(9), published_at=ago(8)))
        s.add(DomainEvent(type="a.b", payload={}, created_at=ago(9), published_at=ago(2)))
        s.add(DomainEvent(type="a.b", payload={}, created_at=ago(9), published_at=None))
    store = MemoryStreamStore(clock=lambda: (now - timedelta(hours=3)).timestamp())
    store.append("live:user:u-IDLE", 1, "{}")
    fresh = MemoryStreamStore(clock=lambda: now.timestamp())
    assert LiveCleanup(sessions, FakeSettingsPort(), store).run(now) == "1 event rows deleted, 1 idle streams cleared"
    with sessions() as s:
        assert [e.published_at is not None for e in s.scalars(select(DomainEvent).order_by(DomainEvent.id))] == [True, False]
    fresh.append("live:user:u-ACTIVE", 1, "{}")
    assert LiveCleanup(sessions, FakeSettingsPort(), fresh).run(now).endswith("0 idle streams cleared")
    assert LiveCleanup(sessions, FakeSettingsPort(), None).run(now).endswith("0 idle streams cleared")


# ---- invites -------------------------------------------------------------------------------------------------------------------------------------

def test_the_invite_jobs_close_what_ran_out_and_empty_the_token_of_what_closed_a_week_ago(sessions, companies, assessments, clock):
    owner = active_company(companies, sessions)
    template = assessments.create_template(owner, basic())
    invite = assessments.create_invite(owner, template.template_id, CAND)
    jobs = InviteJobs(assessments, FakeSettingsPort())
    clock.advance(days=8)
    assert jobs.expire(clock.now) == "1 invites expired"
    assert jobs.purge_tokens(clock.now) == "0 tokens emptied", "closed just now: the token goes a week later"
    assert jobs.purge_tokens(clock.now + timedelta(days=8)) == "1 tokens emptied"
    assert jobs.purge_tokens(clock.now + timedelta(days=9)) == "0 tokens emptied" and invite.invite_id


# ---- the audit anchor ----------------------------------------------------------------------------------------------------------------------------

def test_the_anchor_job_reports_a_new_anchor_and_an_old_one_and_fails_when_the_chain_is_broken():
    class Result:
        def __init__(self, created):
            self.created, self.head_seq = created, 42

    class Anchors:
        def __init__(self, outcome):
            self.outcome = outcome

        def anchor(self):
            if isinstance(self.outcome, Exception):
                raise self.outcome
            return Result(self.outcome)

    assert anchor_audit(Anchors(True))(T0) == "anchored entry 42"
    assert anchor_audit(Anchors(False))(T0) == "already anchored today at entry 42"
    with pytest.raises(RuntimeError):
        anchor_audit(Anchors(RuntimeError("the chain is broken")))(T0)


# ---- the whole scheduler -------------------------------------------------------------------------------------------------------------------------

def test_the_scheduler_has_every_job_and_runs_them_all_on_an_empty_database(sessions, companies, assessments, audit, clock):
    scheduler = build_scheduler(sessions=sessions, assessments=assessments, settings=FakeSettingsPort(), audit=audit, subjects=None, eraser=lambda a: None, anchors=None,
                                streams=None, public_origin="https://vulnmart.example", now=lambda: T0)
    names = [job.name for job in scheduler.jobs]
    assert names == ["invite_expiry", "invite_purge", "candidate_retention", "consent_purge", "learner_warning", "learner_retention", "evidence_retention",
                     "account_housekeeping", "log_purge", "live_cleanup"]
    assert scheduler.run_due() == names
    assert [s.last_status for s in scheduler.status()] == ["succeeded"] * len(names)
    assert scheduler.run_due() == [], "each job waits for its interval"
    assert audit.records == []


def test_with_anchors_the_scheduler_also_has_the_daily_anchor_job(sessions, assessments, audit):
    class Anchors:
        pass

    scheduler = build_scheduler(sessions=sessions, assessments=assessments, settings=FakeSettingsPort(), audit=audit, subjects=None, eraser=None, anchors=Anchors(),  # type: ignore[arg-type]
                                streams=None, public_origin="https://vulnmart.example")
    assert scheduler.jobs[-1].name == "audit_anchor" and scheduler.jobs[-1].interval == DAY
