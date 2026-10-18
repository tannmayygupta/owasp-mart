"""Story P-24 (FR-PRV-18): the scheduler that runs the retention jobs: when a job is due, how a run is recorded, how a failure is reported, the lease that lets one process run
a job, a run that died, and what the admin dashboard reads. On SQLite; the lease under real concurrency is in test_retention_postgres.py."""
from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import vulnmart.kernel.models  # noqa: F401
from vulnmart.kernel.db import Base
from vulnmart.kernel.models import JobRun
from vulnmart.ports.fakes import FakeAuditPort
from vulnmart.privacy.retention.scheduler import DETAIL_MAX, LEASE, RETRY, Job, Scheduler, SchedulerLoop

T0 = datetime(2026, 10, 19, 3, 0, 0, tzinfo=UTC)
DAY = timedelta(days=1)


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


@pytest.fixture
def sessions():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def audit():
    return FakeAuditPort()


def runs(sessions, job=None):
    with sessions() as s:
        query = select(JobRun).order_by(JobRun.started_at, JobRun.id)
        return [r for r in s.scalars(query) if job is None or r.job == job]


def test_a_job_that_never_ran_is_due_and_a_success_is_recorded_with_its_summary(sessions, clock, audit):
    calls = []
    scheduler = Scheduler(sessions, [Job("tidy", DAY, lambda now: (calls.append(now), "3 deleted")[1])], audit, now=clock)
    assert scheduler.run_due() == ["tidy"] and calls == [T0]
    [run] = runs(sessions)
    assert (run.job, run.status, run.detail, run.started_at.replace(tzinfo=UTC), run.finished_at.replace(tzinfo=UTC)) == ("tidy", "succeeded", "3 deleted", T0, T0)
    assert audit.records == [], "a success writes no audit entry"


def test_a_job_is_not_due_again_until_its_interval_after_the_last_success(sessions, clock, audit):
    count = []
    scheduler = Scheduler(sessions, [Job("tidy", DAY, lambda now: (count.append(1), "ok")[1])], audit, now=clock)
    scheduler.run_due()
    clock.advance(hours=23, minutes=59)
    assert scheduler.run_due() == [] and len(count) == 1
    clock.advance(minutes=2)
    assert scheduler.run_due() == ["tidy"] and len(count) == 2


def test_each_job_has_its_own_interval(sessions, clock, audit):
    seen = []
    scheduler = Scheduler(sessions, [Job("hourly", timedelta(hours=1), lambda n: seen.append("h") or ""), Job("daily", DAY, lambda n: seen.append("d") or "")], audit, now=clock)
    scheduler.run_due()
    clock.advance(hours=1, minutes=1)
    assert scheduler.run_due() == ["hourly"]
    assert seen == ["h", "d", "h"]


def test_a_failure_is_recorded_with_the_class_only_reported_to_the_admins_and_the_log_and_the_next_job_still_runs(sessions, clock, audit, caplog):
    def boom(now):
        raise ValueError("secret value alice@example.org")

    scheduler = Scheduler(sessions, [Job("bad", DAY, boom), Job("good", DAY, lambda n: "fine")], audit, now=clock)
    caplog.set_level(logging.ERROR, logger="vulnmart.retention")
    assert scheduler.run_due() == ["bad", "good"]
    [bad] = runs(sessions, "bad")
    assert (bad.status, bad.detail) == ("failed", "ValueError"), "the class of the exception, never its text"
    assert runs(sessions, "good")[0].status == "succeeded"
    [entry] = audit.records
    assert (entry.actor, entry.action, entry.details) == ("job:bad", "job.failed", {"job": "bad", "reason": "ValueError"})
    assert "alice@example.org" not in str(entry.details) and "alice@example.org" not in bad.detail
    assert any("retention job bad failed" in r.getMessage() for r in caplog.records)


def test_a_failed_job_is_tried_again_after_ten_minutes_not_at_once_and_not_a_day_later(sessions, clock, audit):
    state = {"fail": True, "runs": 0}

    def flaky(now):
        state["runs"] += 1
        if state["fail"]:
            raise RuntimeError
        return "ok"

    scheduler = Scheduler(sessions, [Job("flaky", DAY, flaky)], audit, now=clock)
    scheduler.run_due()
    assert scheduler.run_due() == [], "not at once"
    clock.advance(minutes=9)
    assert scheduler.run_due() == []
    clock.advance(minutes=2)
    state["fail"] = False
    assert scheduler.run_due() == ["flaky"] and state["runs"] == 2
    assert scheduler.run_due() == [], "after a success the interval is a day again"
    assert [r.status for r in runs(sessions)] == ["failed", "succeeded"]


def test_a_job_that_keeps_failing_is_tried_every_ten_minutes_not_on_every_pass(sessions, clock, audit):
    count = []

    def boom(now):
        count.append(1)
        raise RuntimeError

    scheduler = Scheduler(sessions, [Job("w", DAY, boom)], audit, now=clock)
    scheduler.run_due()
    clock.advance(days=3)  # long overdue: the pause after a failure still holds
    scheduler.run_due()
    assert len(count) == 2
    for _ in range(5):
        assert scheduler.run_due() == []
    clock.advance(minutes=11)
    scheduler.run_due()
    assert len(count) == 3


def test_a_failure_after_an_old_success_is_retried_without_waiting_for_the_day(sessions, clock, audit):
    state = {"fail": False}

    def work(now):
        if state["fail"]:
            raise RuntimeError
        return "ok"

    scheduler = Scheduler(sessions, [Job("w", DAY, work)], audit, now=clock)
    scheduler.run_due()
    clock.advance(days=1, minutes=1)
    state["fail"] = True
    scheduler.run_due()
    clock.advance(minutes=11)
    state["fail"] = False
    assert scheduler.run_due() == ["w"]


def test_a_running_job_is_not_started_a_second_time_and_a_run_that_died_is_written_off_and_reported(sessions, clock, audit):
    count = []
    scheduler = Scheduler(sessions, [Job("slow", DAY, lambda n: count.append(1) or "ok")], audit, now=clock)
    with sessions.begin() as s:  # another process is in the middle of a run
        s.add(JobRun(job="slow", started_at=clock.now - timedelta(minutes=5), status="running"))
    assert scheduler.run_due() == [] and scheduler.run("slow") is False and count == []
    clock.advance(minutes=56)  # the lease (an hour) has run out: that run died
    assert scheduler.run_due() == [] and count == [], "a dead run is a failure: written off and reported now, the job is tried again after the pause"
    clock.advance(minutes=11)
    assert scheduler.run_due() == ["slow"] and count == [1]
    dead = runs(sessions, "slow")[0]
    assert (dead.status, dead.detail) == ("failed", "the run did not finish")
    assert [e.action for e in audit.records] == ["job.failed"] and audit.records[0].details["reason"] == "the run did not finish"


def test_a_long_summary_is_cut_and_an_unknown_job_name_is_an_error(sessions, clock, audit):
    scheduler = Scheduler(sessions, [Job("long", DAY, lambda n: "x" * 5000)], audit, now=clock)
    scheduler.run("long")
    assert len(runs(sessions)[0].detail) == DETAIL_MAX
    with pytest.raises(KeyError):
        scheduler.run("nope")
    with pytest.raises(ValueError):
        Scheduler(sessions, [Job("a", DAY, lambda n: ""), Job("a", DAY, lambda n: "")], audit)


def test_a_failure_that_cannot_be_audited_is_still_recorded(sessions, clock):
    class BrokenAudit:
        def append(self, **kw):
            raise ConnectionError

    def boom(now):
        raise RuntimeError

    scheduler = Scheduler(sessions, [Job("bad", DAY, boom)], BrokenAudit(), now=clock)  # type: ignore[arg-type]
    assert scheduler.run("bad") is True
    assert runs(sessions)[0].status == "failed"


def test_the_status_is_what_the_dashboard_shows_the_last_run_the_last_success_and_when_the_next_is_due(sessions, clock, audit):
    state = {"fail": False}

    def work(now):
        if state["fail"]:
            raise RuntimeError
        return "5 deleted"

    scheduler = Scheduler(sessions, [Job("work", DAY, work), Job("other", timedelta(hours=1), lambda n: "")], audit, now=clock)
    never = {s.name: s for s in scheduler.status()}
    assert never["work"].last_status is None and never["work"].last_success_at is None and never["work"].next_due_at == T0
    scheduler.run_due()
    first = {s.name: s for s in scheduler.status()}["work"]
    assert (first.last_status, first.last_detail, first.last_success_at, first.next_due_at) == ("succeeded", "5 deleted", T0, T0 + DAY)
    clock.advance(days=1, hours=1)
    state["fail"] = True
    scheduler.run_due()
    failed = {s.name: s for s in scheduler.status()}["work"]
    assert (failed.last_status, failed.last_detail, failed.last_success_at) == ("failed", "RuntimeError", T0)
    assert failed.next_due_at == clock.now + RETRY, "a failure is shown, and the retry is ten minutes away"


def test_the_loop_runs_the_scheduler_by_itself_and_survives_a_failing_pass(sessions, clock, audit):
    class Flaky:
        passes = 0

        def __init__(self, inner):
            self.inner = inner

        def run_due(self):
            self.passes += 1
            if self.passes == 1:
                raise ConnectionError("database down")
            return self.inner.run_due()

    done = []
    inner = Scheduler(sessions, [Job("tidy", DAY, lambda n: done.append(1) or "ok")], audit, now=clock)
    flaky = Flaky(inner)
    loop = SchedulerLoop(flaky, 0.05)  # type: ignore[arg-type]
    loop.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not done:
            time.sleep(0.02)
    finally:
        loop.stop()
    assert done == [1] and flaky.passes >= 2
