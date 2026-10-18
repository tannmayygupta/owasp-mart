"""The scheduler of the retention and housekeeping jobs (story P-24, FR-PRV-18, ADR 0054): runs each job when it is due, records every run, reports failures.

A `Job` is a name, how often it runs and a function that does the work and returns a short fixed summary (counts, never a value). `Scheduler.run_due` looks at the
`job_runs` table: a job is due when its last success is older than its interval, or, after a failure, when `RETRY` has passed. A run is claimed by inserting a
`running` row inside a transaction that holds a Postgres advisory lock, and only when no other run of that job is `running` and younger than `LEASE`: several API
processes can all run the scheduler and one of them does each job. A run that died (the process stopped) is marked failed by the next scheduler that sees it.

Every run ends as `succeeded` or `failed` with a `detail` that is a fixed summary or the *class* of the exception, never its text (an exception can hold a value). A
failure is reported to the admins three ways: the failed run stays in `job_runs` (the admin dashboard shows the last run of each job), an audit entry
`job.failed` names the job, and an ERROR line is logged. `Scheduler.status` is what the dashboard reads (the route is the admin area's, story P-28).
"""
from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text, update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.kernel.models import JobRun
from vulnmart.ports.audit import AuditPort

logger = logging.getLogger("vulnmart.retention")

RETRY = timedelta(minutes=10)  # after a failure the job is tried again this soon
LEASE = timedelta(hours=1)  # a `running` row older than this belongs to a run that died
DETAIL_MAX = 500


@dataclass(frozen=True, slots=True)
class Job:
    name: str
    interval: timedelta
    run: Callable[[datetime], str]  # does the work as of `now`; returns a short summary such as "3 deleted"


@dataclass(frozen=True, slots=True)
class JobStatus:
    """What the admin dashboard shows for one job."""
    name: str
    interval: timedelta
    last_started_at: datetime | None
    last_finished_at: datetime | None
    last_status: str | None  # running, succeeded, failed
    last_detail: str | None
    last_success_at: datetime | None
    next_due_at: datetime


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _now() -> datetime:
    return datetime.now(UTC)


class Scheduler:
    def __init__(self, sessions: sessionmaker[Session], jobs: list[Job], audit: AuditPort, *, now: Callable[[], datetime] = _now):
        names = [j.name for j in jobs]
        if len(set(names)) != len(names):
            raise ValueError("job names are unique")
        self._sessions, self._jobs, self._audit, self._now = sessions, {j.name: j for j in jobs}, audit, now

    @property
    def jobs(self) -> list[Job]:
        return list(self._jobs.values())

    # ---- what the dashboard reads ----

    def status(self) -> list[JobStatus]:
        now = self._now()
        out = []
        with self._sessions() as session:
            for job in self._jobs.values():
                last = session.scalar(select(JobRun).where(JobRun.job == job.name).order_by(JobRun.started_at.desc()).limit(1))
                ok = session.scalar(select(JobRun).where(JobRun.job == job.name, JobRun.status == "succeeded").order_by(JobRun.started_at.desc()).limit(1))
                out.append(JobStatus(job.name, job.interval, _aware(last.started_at) if last else None,
                                     _aware(last.finished_at) if last and last.finished_at else None, last.status if last else None,
                                     last.detail if last else None, _aware(ok.finished_at or ok.started_at) if ok else None,
                                     self._next_due(job, last, ok, now)))
        return out

    def _next_due(self, job: Job, last: JobRun | None, ok: JobRun | None, now: datetime) -> datetime:
        if last is None:
            return now  # never ran: due at once
        if last.status == "running":
            return _aware(last.started_at) + LEASE  # until the run finishes, or its lease runs out and the run is written off as dead
        if last.status == "failed":
            return _aware(last.finished_at or last.started_at) + RETRY  # always a pause after a failure, however overdue the job already was
        return _aware(ok.finished_at or ok.started_at) + job.interval if ok else now

    # ---- running ----

    def run_due(self) -> list[str]:
        """Run every job that is due, one after the other. Returns the names that ran. Never raises: a failing job is recorded and the next one still runs."""
        ran = []
        self._reap()
        for status in self.status():
            if status.next_due_at <= self._now() and self.run(status.name):
                ran.append(status.name)
        return ran

    def run(self, name: str) -> bool:
        """Run one job now if no other run of it is going on. True when this call ran it (whether it succeeded or not)."""
        job = self._jobs[name]
        run_id = self._claim(name)
        if run_id is None:
            return False
        status, detail = "succeeded", ""
        try:
            detail = job.run(self._now())[:DETAIL_MAX]
        except Exception as exc:  # noqa: BLE001 - recorded and reported below; the loop goes on
            status, detail = "failed", f"{type(exc).__name__}"
            logger.exception("retention job %s failed", name)
        with self._sessions.begin() as session:
            session.execute(update(JobRun).where(JobRun.id == run_id).values(status=status, finished_at=self._now(), detail=detail))
        if status == "failed":
            self._report(name, detail)
        else:
            logger.info("retention job %s: %s", name, detail or "done")
        return True

    def _claim(self, name: str) -> uuid.UUID | None:
        now = self._now()
        with self._sessions.begin() as session:
            if session.get_bind().dialect.name == "postgresql":
                session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"job:{name}"})
            live = session.scalar(select(JobRun.id).where(JobRun.job == name, JobRun.status == "running", JobRun.started_at > now - LEASE).limit(1))
            if live is not None:
                return None
            row = JobRun(id=uuid.uuid4(), job=name, started_at=now, status="running")
            session.add(row)
            return row.id

    def _reap(self) -> None:
        """A `running` row past its lease is a run that died: it is a failure, and reported like one."""
        now = self._now()
        with self._sessions.begin() as session:
            dead = session.scalars(select(JobRun).where(JobRun.status == "running", JobRun.started_at <= now - LEASE)).all()
            names = []
            for row in dead:
                row.status, row.finished_at, row.detail = "failed", now, "the run did not finish"
                names.append(row.job)
        for name in names:
            self._report(name, "the run did not finish")

    def _report(self, name: str, detail: str) -> None:
        logger.error("retention job %s failed: %s", name, detail)
        try:
            self._audit.append(actor=f"job:{name}", action="job.failed", subject=None, details={"job": name, "reason": detail})
        except Exception:  # noqa: BLE001 - the failure is already in job_runs and the log
            logger.exception("the failure of job %s could not be written to the audit log", name)


class SchedulerLoop:
    """Calls `Scheduler.run_due` every `interval` seconds on a thread of its own (the API process starts it when the scheduler is enabled)."""

    def __init__(self, scheduler: Scheduler, interval: float = 60.0):
        self._scheduler, self._interval = scheduler, interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="retention-scheduler", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._scheduler.run_due()
            except Exception:  # noqa: BLE001 - a database outage must not end the loop
                logger.exception("the retention scheduler pass failed; trying again in %ss", self._interval)
            self._stop.wait(self._interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=10)
