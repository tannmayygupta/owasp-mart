"""The scheduler with its jobs (story P-24, ADR 0054): which job runs how often and what it needs. Every job is the same on every process; the scheduler's lease lets
one process run each.

Daily: candidate retention, consent purge, learner warning, learner retention, learner evidence, account housekeeping (sessions and tokens), log purge, audit anchor,
invite token purge. Hourly: invite expiry, live cleanup. All times are intervals after the last success, not clock times; a failed job is tried again after ten minutes.
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy.orm import Session, sessionmaker

from vulnmart.assessments.service import AssessmentService
from vulnmart.kernel.audit import AuditAnchors
from vulnmart.live.store import StreamWriter
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.settings import SettingsPort
from vulnmart.privacy.deletion import DeletionService
from vulnmart.privacy.subjects import SubjectService

from .candidates import CandidateRetention
from .housekeeping import AccountHousekeeping, ConsentPurge, EvidenceRetention, InviteJobs, LiveCleanup, LogPurge, anchor_audit
from .learners import LearnerRetention
from .records import SqlAttemptRecords
from .scheduler import Job, Scheduler

DAY, HOUR = timedelta(days=1), timedelta(hours=1)


def build_scheduler(*, sessions: sessionmaker[Session], assessments: AssessmentService, settings: SettingsPort, audit: AuditPort, subjects: SubjectService | None,
                    eraser: Callable[[str], None] | None, anchors: AuditAnchors | None, streams: StreamWriter | None, public_origin: str,
                    now: Callable[[], datetime] | None = None, deletion: DeletionService | None = None) -> Scheduler:
    records = SqlAttemptRecords(sessions)
    candidates = CandidateRetention(sessions, assessments, records, settings, audit, eraser)
    learners = LearnerRetention(sessions, records, settings, audit, subjects, eraser, public_origin=public_origin)
    invites = InviteJobs(assessments, settings)
    jobs = [
        Job("invite_expiry", HOUR, invites.expire),
        Job("invite_purge", DAY, invites.purge_tokens),
        Job("candidate_retention", DAY, candidates.run),
        Job("consent_purge", DAY, ConsentPurge(sessions).run),
        Job("learner_warning", DAY, learners.warn),
        Job("learner_retention", DAY, learners.delete),
        Job("evidence_retention", DAY, EvidenceRetention(sessions, records, settings).run),
        Job("account_housekeeping", DAY, AccountHousekeeping(sessions, settings).run),
        Job("log_purge", DAY, LogPurge(sessions, settings).run),
        Job("live_cleanup", HOUR, LiveCleanup(sessions, settings, streams).run),
    ]
    if deletion is not None:
        jobs.append(Job("deletion_requests", HOUR, deletion.run))  # story P-25: due requests after the undo window, late company decisions
    if anchors is not None:
        jobs.append(Job("audit_anchor", DAY, anchor_audit(anchors)))
    return Scheduler(sessions, jobs, audit, **({"now": now} if now is not None else {}))
