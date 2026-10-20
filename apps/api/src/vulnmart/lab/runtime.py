"""LabRuntime: the attempt engine, scoring, flag checking, milestone engine and the event receiver in one process (D-95, D-96).

With `VULNMART_LAB_STORE=postgres` (the deployed mode) the state is in Postgres (`vulnmart.lab.pg`) and the keys come from the platform key
service (`DbKeyPort`), so a restart loses nothing. Without it (tests, the laptop demo) all state is in memory and the keys are random per
process, so no flag or event key of one run is valid in another. Answers of this class hold ids, states, numbers and result words, never
a flag, a digest, a key or a pasted text.
"""
from __future__ import annotations

import base64
import logging
import os
import secrets
import ssl
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from vulnmart_attempts import AttemptEngine, Fact, InvalidTransition
from vulnmart_attempts import AttemptState as AttemptState_, Milestone as ScoreMilestone, ResetLimitReached, Rules
from vulnmart_attempts.catalogue import Catalogue as Catalogue_
from vulnmart_attempts.metrics import time_metrics
from vulnmart_attempts.review import HeldCaptureReview, HeldItem, default_may_review

from vulnmart.flags.checker import FlagChecker
from vulnmart.flags.material import CHALLENGE_KEYS, build_material
from vulnmart.flags.submit import FlagSubmissionResult, FlagSubmitService
from vulnmart.ingest.bots import BotRecorder
from vulnmart.ingest.engine import MilestoneEngine
from vulnmart.ingest.evidence import EvidenceReader, EvidenceRecorder
from vulnmart.ingest.handler import IngestHandler
from vulnmart.ingest.gate import RecordedActivityGate
from vulnmart.lab.live import LiveAnnouncer
from vulnmart.ingest.stores import ActivityGate, InstanceInfo, MilestoneStore
from vulnmart.lab.catalog import Catalog, default_catalog_dir, load_catalog
from vulnmart.lab.clock import OffsetClock
from vulnmart.lab.control import HostInstanceControl
from vulnmart.lab.sequence import ACTIVE, READY, SOLVED, ChallengeClock, InMemoryChallengeClockLedger, Sequence, SequencedMilestones
from vulnmart.lab.state_reports import StateReportStore
from vulnmart.lab.stores import HintLedger, LabStores, OrgOf, memory_stores
from vulnmart.ports.attempts import AttemptState
from vulnmart.ports.engine_attempts import EngineAttemptPort
from vulnmart.ports.engine_cohort import EngineCohortPort
from vulnmart.ports.engine_reports import EngineReportPort
from vulnmart.ports.errors import AttemptStateInvalid, ChallengeNotFound, InstanceNotReady
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.fakes import FakeKeyPort
from vulnmart.ports.http_instance_host import HttpInstanceHost
from vulnmart.ports.instance_host import Access, CreateRequest, InstanceHost, InstanceNotFound, InstanceState, InvalidState, Limits, ResetRequest
from vulnmart.ports.reports import Milestone as PortMilestone, Score

log = logging.getLogger("vulnmart.lab")
ACTIVITY_REPORT_EVERY_S = 60.0  # at most one activity report per instance per minute (the idle limits are counted in minutes)

READY_TIMEOUT_S = 120.0
READY_POLL_S = 1.0
MAX_HINT_LEVEL = 3
# What the platform puts in `limits` of a learner instance (the orchestrator's own defaults, `lifecycle.py`): an abandoned instance frees its slot after an hour without play
# and no instance lives longer than four hours. It was 1440 and 1440, so a closed browser tab held one of the seven slots of vm-i for a whole day (found by the load check,
# 2026-10-19). A candidate's instance is longer, see `LabRuntime._limits_for`.
DEFAULT_TEMPLATE_LIMITS = Limits(memory_mb=256, cpu_limit=1.0, pids_limit=256, idle_minutes=60, max_minutes=240)
SEEN_MARKER_GAP_S = 300  # a `request_seen` marker at most every five minutes per instance
CANDIDATE_IDLE_MINUTES = 120  # a candidate may think for a while without touching the shop
CANDIDATE_MARGIN_MINUTES = 30  # the instance outlives the template's time limit by this much (the attempt's own clock ends the assessment)


def clamp_to_start(captures: Mapping[str, datetime], started: datetime) -> dict[str, datetime]:
    """A capture the engine dates before the start (a clock step, a start recorded late) counts as zero seconds in, instead of failing the whole report
    (the library refuses it with ValueError: audit 2026-10-18, L-25)."""
    return {key: (when if when >= started else started) for key, when in captures.items()}


def new_attempt_id() -> str:
    return "a-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")  # a- and 16 Base32 characters (IF-2 AttemptId)


def new_instance_id() -> str:
    return "i-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")  # 16 Base32 characters


@dataclass(frozen=True, slots=True)
class StartedAttempt:
    attempt_id: str
    instance_id: str
    state: str


class RuntimeFacts:
    """Scoring facts from the milestone store and the hint ledger. A held capture counts at its fallback (D-86)."""

    def __init__(self, milestones: MilestoneStore, hints: HintLedger, charged: Callable[[str], bool] = lambda attempt_id: True) -> None:
        # `charged(attempt_id)`: hints cost points only in an assessment (FR-SCR-03); a learner's hints are free (PRD section 4, journey step 5; audit finding)
        self._milestones, self._hints, self._charged = milestones, hints, charged

    def facts(self, attempt_id: str) -> Mapping[str, Fact]:
        out: dict[str, Fact] = {}
        for ck in CHALLENGE_KEYS:
            best = ScoreMilestone[self._milestones.best(attempt_id, ck).name]
            levels = self._hints.levels(attempt_id, ck)
            paid = levels if self._charged(attempt_id) else ()
            held = self._milestones.is_held(attempt_id, ck) and best < ScoreMilestone.M3
            if held:
                out[ck] = Fact(milestone=ScoreMilestone.M3, hint_levels=paid, held=True, fallback=best)
            elif best is not ScoreMilestone.NONE or paid:
                out[ck] = Fact(milestone=best, hint_levels=paid)
        return out


class LabRuntime:
    def __init__(self, *, host: InstanceHost, clock: Callable[[], datetime] | None = None, keys: FakeKeyPort | None = None,
                 template_id: str = "shop-v0", challenge_keys: tuple[str, ...] = CHALLENGE_KEYS,
                 hostname_suffix: str = "instances.example.invalid", ready_timeout_s: float = READY_TIMEOUT_S,
                 ready_poll_s: float = READY_POLL_S, sleep: Callable[[float], None] = time.sleep, gate: ActivityGate | None = None,
                 limits: Limits = DEFAULT_TEMPLATE_LIMITS, stores: LabStores | None = None, catalog: Catalog | None = None,
                 sequenced: bool = False) -> None:
        # sequenced: a learner's run goes one challenge at a time with a countdown each (the deployed mode, `VULNMART_LAB_SEQUENCE=1`);
        # off for the plain runtime of the older tests and demos, where every challenge is open at once.
        self.sequenced = sequenced
        self.clock: Callable[[], datetime] = clock or OffsetClock()
        self.host = host
        # Random master keys per process, never the fixed FAKE_* constants (D-96).
        self.keys = keys or FakeKeyPort(event_master=secrets.token_bytes(32), flag_key=secrets.token_bytes(32),
                                        owner_key=secrets.token_bytes(32))
        self.template_id, self.challenge_keys = template_id, challenge_keys
        self._suffix, self._ready_timeout, self._ready_poll, self._sleep = hostname_suffix, ready_timeout_s, ready_poll_s, sleep
        self._limits = limits
        self._lock = threading.RLock()

        s = stores or memory_stores()
        self.stores = s
        self.catalog = catalog or Catalog({})  # titles and hint texts (IF-7); empty means keys and placeholders
        self.attempt_log = s.attempt_log  # ids and metadata only (FR-TIM-04)
        self.hints = s.hints
        # A learner's run goes one challenge at a time, each with its own countdown (`vulnmart.lab.sequence`). The sequence reads the stored milestones; everything
        # that credits (events, pasted flags, reviewers) goes through the wrapper, which counts only the challenge that is active now. A company assessment passes through.
        self.sequence = Sequence(s.challenge_clock or InMemoryChallengeClockLedger(), s.milestones, challenge_keys,
                                 lambda key: (self.catalog.get(key).tier if self.catalog.get(key) else None), self.clock)
        self.milestones = SequencedMilestones(s.milestones, self.sequence, self.is_sequenced)
        self.integrity = s.integrity
        self.directory = s.directory
        self.epochs = s.epochs
        self.state_reports = StateReportStore()  # what the orchestrator reported per instance (H-347); empty without a receiver
        self.events = s.events
        self.engine = AttemptEngine(s.attempts, HostInstanceControl(host), self.clock, events=self._engine_event)
        self.attempts = EngineAttemptPort(self.engine, self.attempt_log)
        self.evidence_store = s.evidence
        self.reports = EngineReportPort(attempts=self.attempts, facts=RuntimeFacts(self.milestones, self.hints, lambda aid: bool(getattr(self._record_or_none(aid), "org_id", None))),
                                        integrity=self.integrity, clock=self.clock,
                                        evidence=EvidenceReader(store=self.evidence_store, keys=self.keys))
        self.cohort = EngineCohortPort(engine=self.engine, facts=RuntimeFacts(self.milestones, self.hints, lambda aid: bool(getattr(self._record_or_none(aid), "org_id", None))),
                                       milestones=self.milestones, active_seconds_of=self._active_seconds)  # the private cohort view (L-28); the route is stream P's
        self.checker = FlagChecker(self.keys)
        gate_kw = {"gate": gate} if gate is not None else {}
        self.milestone_engine = MilestoneEngine(log=self.events, milestones=self.milestones, integrity=self.integrity,
                                                directory=self.directory, checker=self.checker, is_open=self._attempt_open, **gate_kw)
        self.activity = s.activity
        self.bots = BotRecorder(s.bots)
        self.evidence = EvidenceRecorder(keys=self.keys, store=self.evidence_store, directory=self.directory, checker=self.checker,
                                         milestones=self.milestones, integrity=self.integrity)
        self.flag_log = s.flag_log
        # FR-ACH-02 (audit blocker B6): a pasted flag is checked against the activity the sidecar recorded; an explicit `gate` (tests) replaces the check
        paste_gate = gate if gate is not None else RecordedActivityGate(activity=s.activity, directory=self.directory, record_of=self._record_or_none,
                                                                        integrity=self.integrity)
        self.submit_service = FlagSubmitService(attempts=self.attempts, directory=self.directory, checker=self.checker,
                                                milestones=self.milestones, integrity=self.integrity, log=self.flag_log,
                                                clock=self.clock, gate=paste_gate)
        self.handler = IngestHandler(keys=self.keys, epochs=self.epochs, store=s.event_store, security=s.security,
                                     sink=self._on_event, now=self.clock)
        self._starting: dict[str, str] = {}  # attempt id -> the instance whose start is under way (one start per attempt)
        self._activity_sent: dict[str, float] = {}  # instance id -> monotonic time of the last activity report to the orchestrator
        self._activity_every = ACTIVITY_REPORT_EVERY_S
        self._resetting: set[str] = set()
        self.org_of_attempt = OrgOf(s.attempts)
        self.held_store, self.audit = s.held, s.audit
        self.review = HeldCaptureReview(self.held_store, self.audit, self.clock, default_may_review(self.org_of_attempt),
                                        events=self.attempt_log.append)
        # the domain events of the live hub (H-142): attached by `_mount_lab` when the platform has a durable event port, silent otherwise
        self.live = LiveAnnouncer(clock=self.clock, record_of=self._record_or_none, score_of=self.score_rows)
        self._seen_marker: dict[str, datetime] = {}  # instance id -> when `request_seen` was last written (FR-TIM-04: a marker, not a request log)
        self._bump_pending: set[str] = set()  # accounts whose access bump failed; `tick` tries again
        self._recover_windows()
    def _recover_windows(self) -> None:
        """After a restart: rebuild the open C09 windows of the running attempts from the stored events (audit blocker B5). Never raises."""
        try:
            infos = [i for rec in self.engine.in_states(AttemptState_.READY, AttemptState_.RUNNING)
                     if (i := self.directory.for_attempt(rec.id)) is not None]
            if infos:
                self.milestone_engine.recover(infos)
        except Exception:
            log.exception("recovering the negative-observation windows failed; the next restart tries again")

    def _attempt_open(self, attempt_id: str, at: datetime) -> bool:
        """Was the attempt running at `at`: started, not over, and `at` not past its deadline (the tick that submits an expired attempt runs up to a
        minute later, so the deadline itself is checked as well). Audit blocker B5: events after the end store and credit nothing."""
        rec = self._record_or_none(attempt_id)
        if rec is None or rec.state not in (AttemptState_.READY, AttemptState_.RUNNING):
            return False
        return rec.deadline_at is None or at <= rec.deadline_at

    def score_rows(self, attempt_id: str) -> tuple[int, list[dict[str, Any]]]:
        """The score and one row per challenge (best milestone, held, hints used, points): what the API and the live events show."""
        score = self.score(attempt_id)
        by_key = {r.challenge_key: r for r in score.per_challenge}
        rows = []
        for key in self.challenge_keys:
            r = by_key.get(key)
            rows.append({"challenge_key": key, "best_milestone": (r.milestone.value if r else self.milestones.best(attempt_id, key).value),
                         "held": self.milestones.is_held(attempt_id, key), "hints_used": len(self.hints.levels(attempt_id, key)),
                         "points": r.points if r else 0})
        return score.score, rows

    def announce_instance(self, report: Any) -> None:
        """An instance moved to a new state (the orchestrator's report): tell the live hub. Never raises."""
        info = self.directory.get(report.instance_id)
        if info is None:
            return
        rec = self._record_or_none(info.attempt_id)
        state = report.to_state.value
        access = "frozen" if rec is not None and getattr(rec, "access", None) == "frozen" else ("open" if state in ("ready", "active", "idle") else "closed")
        health = getattr(report.health, "value", report.health)
        self.live.instance(instance_id=report.instance_id, attempt_id=info.attempt_id, state=state, health=str(health), epoch=report.epoch,
                           error_code=report.error_code, access=access)

    def _record_or_none(self, attempt_id: str) -> Any | None:
        try:
            return self.engine.get(attempt_id)
        except Exception:  # an unknown attempt has no rules: the gate uses the defaults
            return None

    # ---- one challenge at a time, each with a countdown (vulnmart.lab.sequence) ----

    def is_sequenced(self, attempt_id: str) -> bool:
        """True for a learner's practice run when the runtime runs sequenced. A company assessment, an unknown attempt and a plain runtime are not."""
        if not self.sequenced:
            return False
        rec = self._record_or_none(attempt_id)
        return rec is not None and rec.org_id is None

    def challenge_clocks(self, attempt_id: str) -> list[ChallengeClock]:
        """One clock per challenge in order; for an attempt that is not sequenced every challenge is `active` without a countdown."""
        if self.is_sequenced(attempt_id):
            return self.sequence.clocks(attempt_id)
        return [ChallengeClock(k, ACTIVE, 0, None, None) for k in self.challenge_keys]

    def require_playable(self, attempt_id: str, challenge_key: str, *, allow_solved: bool = False) -> None:
        """Raise what the API turns into 404 (a challenge that does not exist for the learner yet) or 409 (not begun, or its time is over)."""
        if not self.is_sequenced(attempt_id):
            return
        c = self.sequence.clock_of(attempt_id, challenge_key)
        if c is None or c.state == "future":
            raise ChallengeNotFound("no such challenge for this run yet")
        if c.state == ACTIVE or (allow_solved and c.state == SOLVED):
            return
        raise AttemptStateInvalid(f"the challenge is {c.state}")

    def begin_challenge(self, attempt_id: str, challenge_key: str) -> ChallengeClock:
        """Start the countdown of the current challenge. Idempotent. ChallengeNotFound when it is not the current one (or the run is not sequenced),
        AttemptStateInvalid when the attempt is not running or the challenge already ended."""
        rec = self.engine.get(attempt_id)
        if rec.state is not AttemptState_.RUNNING:
            raise AttemptStateInvalid("the attempt is not running")
        if not self.is_sequenced(attempt_id):
            raise ChallengeNotFound("this run is not sequenced")
        c = self.sequence.clock_of(attempt_id, challenge_key)
        if c is None or c.state == "future":
            raise ChallengeNotFound("no such challenge for this run yet")
        if c.state in (SOLVED, "expired"):
            raise AttemptStateInvalid(f"the challenge is {c.state}")
        if c.state == READY:
            self.sequence.begin(attempt_id, challenge_key, self.clock())  # the stored instant is the record; the attempt log's allow-list (FR-TIM-04) stays as it is
        out = self.sequence.clock_of(attempt_id, challenge_key)
        assert out is not None
        return out

    def account_progress(self, user_id: str) -> dict[str, Any]:
        """The best points per challenge over every run of a learner (a repeated challenge never counts twice), the total out of 1000 and the number of runs."""
        best: dict[str, int] = {k: 0 for k in self.challenge_keys}
        runs = 0
        for rec in self.engine.for_user(user_id):
            if rec.org_id is not None or rec.purged_at is not None or rec.state is AttemptState_.DELETED:
                continue
            runs += 1
            _, rows = self.score_rows(rec.id)
            for row in rows:
                best[row["challenge_key"]] = max(best[row["challenge_key"]], int(row["points"]))
        per = [{"challenge_key": k, "best_points": best[k]} for k in self.challenge_keys]
        weight_total = Catalogue_().total  # the same scale as a run's score: points of all challenges out of the weight total, shown out of 1000, half up
        shown = (2 * 1000 * sum(best.values()) + weight_total) // (2 * weight_total)
        return {"total_points": min(1000, shown), "runs": runs, "per_challenge": per}

    def _engine_event(self, payload: Mapping[str, Any]) -> None:
        """The engine's events go to the ids-only log; a withdrawn attempt that reaches `deleted` is erased at once. The engine swallows an error of this
        sink, so a failed erase is not lost: `tick` erases every `deleted` attempt that is not yet marked purged."""
        self.attempt_log.from_engine(payload)
        if payload.get("event") == "attempt.state_changed":
            self.live.attempt_state(payload["attempt_id"], payload.get("from"), payload.get("to"))
        if self.stores.purge and payload.get("event") == "attempt.state_changed" and payload.get("to") == "deleted":
            try:
                self._erase(payload["attempt_id"])
            except Exception:
                log.exception("erasing attempt %s failed; the next tick tries again", payload["attempt_id"])

    def _erase(self, attempt_id: str) -> None:
        """FR-SES-10: the key is shredded first (the sealed rows are unreadable even if the next step fails), then the rows go, then the attempt is
        marked purged. Every step is safe to repeat, so a failure anywhere is finished by a later call."""
        self.keys.shred(attempt_id)
        if self.stores.purge:
            self.stores.purge(attempt_id)
        self.engine.mark_purged(attempt_id)

    def erase(self, attempt_id: str) -> None:
        """Erase everything the lab keeps about an attempt (key shredded, rows deleted, attempt marked purged). Safe to repeat. The platform's retention and
        deletion jobs call it (story P-24, handoff H-144)."""
        self._erase(attempt_id)

    def _erase_pending(self) -> None:
        """A `deleted` attempt whose erase did not finish (the database was away, the process stopped): finish it. Never raises."""
        if not self.stores.purge:
            return
        for rec in self.engine.in_states(AttemptState_.DELETED):
            if rec.purged_at is None:
                try:
                    self._erase(rec.id)
                except Exception:
                    log.exception("erasing attempt %s failed; the next tick tries again", rec.id)

    @property
    def instance_states(self) -> dict[str, str]:
        """instance id -> the state the orchestrator last reported (a copy; empty when no receiver is mounted or nothing arrived)."""
        return self.state_reports.states()

    def _sync_held(self, attempt_id: str) -> None:
        """Every capture the milestone store holds becomes an open item of the review (FR-ACH-07)."""
        for ck, at in self.milestones.held_for(attempt_id).items():
            if self.held_store.get(attempt_id, ck) is None:
                best = ScoreMilestone[self.milestones.best(attempt_id, ck).name]
                self.held_store.add(HeldItem(attempt_id, ck, ScoreMilestone.M3, best, at))

    def held_captures(self, attempt_id: str) -> tuple[HeldItem, ...]:
        self.attempts.get(attempt_id)
        self._sync_held(attempt_id)
        return self.review.held(attempt_id)

    def decide_held(self, attempt_id: str, challenge_key: str, reviewer: Mapping[str, str], decision: str, note: str = "") -> str:
        """A named reviewer accepts or rejects a held capture; the decision is audited and final. Accept credits M3; reject keeps
        it out of the score, never zeroes anything, and releases the `reported` block. Raises ReviewForbidden / ReviewFinal / NotHeld."""
        self.attempts.get(attempt_id)
        self._sync_held(attempt_id)
        item = self.review.decide(attempt_id, challenge_key, reviewer, decision, note)
        with self._lock:
            # also on a repeated decision: a credit that failed after the first one is made good here (review finding A6)
            if item.status == "accepted":
                self.milestones.credit(attempt_id, challenge_key, PortMilestone.M3, self.clock())
            self.milestones.clear_held(attempt_id, challenge_key)
        return decision

    def _on_event(self, event: Mapping[str, Any], at: datetime) -> None:
        """Every verified event: the milestone engine first, then evidence, activity buckets and bot visits."""
        result = self.milestone_engine.process(event, at)
        if result.stored is False:
            return  # a replay: nothing else sees it
        for credit in result.credits:
            if event.get("type") == "proxy.flag_seen" and (event.get("data") or {}).get("kind") == "real":
                self._journal("flag_auto_detected", credit.attempt_id, challenge_key=credit.challenge_key, instance_id=event["instance_id"])  # FR-TIM-04
            self._journal("milestone_reached", credit.attempt_id, challenge_key=credit.challenge_key, level=credit.milestone.value,
                          instance_id=event["instance_id"])
            self.live.milestone(credit.attempt_id, credit.challenge_key, credit.milestone.value)
        for attempt_id in dict.fromkeys(c.attempt_id for c in result.credits):
            self.live.score(attempt_id)
        self.evidence.observe(event, at, result)
        self.activity.record(event, at)
        self.bots.observe(event, at)
        if event.get("session_kind") == "player":
            self._note_activity(event["instance_id"], at)
            if event.get("type") == "proxy.request":
                self._mark_request_seen(event["instance_id"], at)

    def _mark_request_seen(self, instance_id: str, at: datetime) -> None:
        """FR-TIM-04 `request_seen`: one line when the player's traffic starts and again after five quiet minutes, never one line per request and never a request."""
        with self._lock:
            last = self._seen_marker.get(instance_id)
            if last is not None and (at - last).total_seconds() < SEEN_MARKER_GAP_S:
                return
            self._seen_marker[instance_id] = at
            if len(self._seen_marker) > 2000:
                self._seen_marker = {k: v for k, v in self._seen_marker.items() if (at - v).total_seconds() < SEEN_MARKER_GAP_S}
        info = self.directory.get(instance_id)
        if info is not None:
            self._journal("request_seen", info.attempt_id, instance_id=instance_id)

    def _note_activity(self, instance_id: str, at: datetime | None = None) -> None:
        """Tell the orchestrator that a player is active (audit blocker B1: without it the idle limit ran from `ready` and cut players off mid-attempt).
        Throttled per instance and sent from a short-lived thread, so the answer to the sidecar or the player never waits for the orchestrator. Best effort:
        a failure is logged; the next event tries again."""
        now = time.monotonic()
        with self._lock:
            last = self._activity_sent.get(instance_id)
            if last is not None and now - last < self._activity_every:
                return
            self._activity_sent[instance_id] = now
            if len(self._activity_sent) > 2000:  # forget instances that have been quiet for a long time
                self._activity_sent = {k: v for k, v in self._activity_sent.items() if now - v < 600}
        threading.Thread(target=self._send_activity, args=(instance_id, at or self.clock()), name=f"lab-activity-{instance_id[:8]}", daemon=True).start()

    def _send_activity(self, instance_id: str, at: datetime) -> None:
        try:
            self.host.record_activity(instance_id, at)
        except (InstanceNotFound, InvalidState):
            pass  # the instance is gone or not in a state that counts activity: nothing to do
        except Exception:
            log.warning("reporting activity of instance %s failed", instance_id[:10], exc_info=True)

    # ---- calls ----

    def journal(self, event: str, attempt_id: str, **extra: Any) -> None:
        """The same one-line journal for the callers outside the runtime (the routes): ids only, never raises."""
        self._journal(event, attempt_id, **extra)

    def _journal(self, event: str, attempt_id: str, **extra: Any) -> None:
        """One line of the ids-only attempt log (FR-TIM-04). A failing log never undoes the step it describes."""
        try:
            self.attempt_log.append({"event": event, "attempt_id": attempt_id, "at": self.clock().isoformat(), **extra})
        except Exception:
            log.exception("attempt log append failed (%s)", event)

    def instance_alive(self, instance_id: str | None) -> bool:
        """True while the orchestrator still holds the instance in a state that can serve (not stopping, destroyed or failed)."""
        if not instance_id:
            return False
        try:
            return self.host.get(instance_id).state not in (InstanceState.DESTROYED, InstanceState.FAILED, InstanceState.STOPPING)
        except InstanceNotFound:
            return False

    def _begin(self, user_id: str, template: str, org_id: str | None) -> tuple[Any, str, int, str] | StartedAttempt:
        """The fast half of a start, under the lock: the attempt, its data key, a fresh instance asked of the orchestrator.

        Returns what the slow half needs, or a `StartedAttempt` when there is nothing to do (the attempt already has a live instance,
        or a start is already under way for it)."""
        with self._lock:
            previous = self.engine.find(user_id, template) if org_id is None else None
            rec = self.engine.create(user_id, template, consent_id=f"demo-consent-{secrets.token_hex(4)}", org_id=org_id,
                                     attempt_id=new_attempt_id(), rules=self._rules_for(org_id))
            if previous is not None and previous.id != rec.id:
                self._retire(previous)  # a new run began: the finished one keeps its results but no longer holds an instance
            return self._prepare(rec, user_id, template)

    def _prepare(self, rec: Any, user_id: str, template: str) -> tuple[Any, str, int, str] | StartedAttempt:
        """The rest of the fast half, for an attempt that exists (a new learner run, or a candidate attempt a consent created): under the lock `_begin` holds."""
        with self._lock:
            if rec.id in self._starting:
                return StartedAttempt(rec.id, self._starting[rec.id], rec.state.value)
            if rec.state.value not in ("ready", "running"):
                # submitted, cancelled, withdrawn, reported: no new instance (review finding A1)
                raise AttemptStateInvalid("the attempt cannot be started in its state")
            if self.instance_alive(rec.instance_id):
                return StartedAttempt(rec.id, rec.instance_id, rec.state.value)
            self.keys.create_attempt_key(rec.id)  # the data key that seals this attempt's evidence (without it every capture is dropped)
            stale = self.directory.for_attempt(rec.id)
            if stale is not None:
                # a start that died midway (the process stopped between the orchestrator's create and the attempt learning the instance), or an
                # instance that was lost: the directory is about to replace it, so the orchestrator must not keep it either (review finding)
                try:
                    self.host.destroy(stale.instance_id)
                except Exception:
                    log.exception("destroying the stale instance %s failed; the orchestrator's idle timer remains", stale.instance_id[:10])
            instance_id = new_instance_id()
            material = build_material(self.keys, instance_id, 1, self.challenge_keys)
            request = CreateRequest(instance_id=instance_id, template_id=template, epoch=1, material=material,
                                    hostname=f"{instance_id.lower()}.{self._suffix}", limits=self._limits_for(rec),
                                    owner_hash=self.keys.owner_hash(user_id))
            self.host.create(request)
            self._journal("instance_requested", rec.id, instance_id=instance_id)  # FR-TIM-04
            # registered at once: the owner can poll the instance while it starts, and an event of epoch 1 has a known epoch
            self.directory.add(InstanceInfo(instance_id, rec.id, template, 1, tuple(self.challenge_keys)))
            self.epochs.set(instance_id, 1)
            self._starting[rec.id] = instance_id
            return rec, instance_id, 1, template

    def _rules_for(self, org_id: str | None) -> Rules | None:
        """A sequenced learner run lasts as long as all its challenge times plus a margin (Easy 20, Medium 40, Hard 60 minutes each); everything else uses the defaults."""
        if org_id is None and self.sequenced:
            return Rules(time_limit_minutes=self.sequence.run_limit_minutes())
        return None

    def _retire(self, finished: Any) -> None:
        """Destroy what a finished learner run still holds (an instance frozen for its 15 minutes). Best effort: the reconciler of the orchestrator cleans up."""
        info = self.directory.for_attempt(finished.id)
        if info is None or not self.instance_alive(info.instance_id):
            return
        try:
            self.host.destroy(info.instance_id)
        except Exception:
            log.exception("retiring the instance of the finished run %s failed; the orchestrator's timers remain", finished.id)

    def _limits_for(self, rec: Any) -> Limits:
        """The limits of the instance of this attempt: the learner default (longer when the run is sequenced: it must outlive its challenge times), or for a candidate
        attempt a longer idle limit and a total limit that covers the template's time limit."""
        if not getattr(rec, "org_id", None):
            if self.sequenced:
                return replace(self._limits, max_minutes=max(self._limits.max_minutes, min(1440, int(rec.rules.time_limit_minutes) + CANDIDATE_MARGIN_MINUTES)))
            return self._limits
        total = max(self._limits.max_minutes, int(rec.rules.time_limit_minutes) + CANDIDATE_MARGIN_MINUTES)
        return replace(self._limits, idle_minutes=max(self._limits.idle_minutes, CANDIDATE_IDLE_MINUTES), max_minutes=min(total, 1440))

    def _finish(self, rec: Any, instance_id: str, epoch: int, template: str) -> StartedAttempt:
        """The slow half, outside the lock (it waits for the orchestrator): ready, access open, directory, epoch, clock."""
        try:
            self._wait_ready(instance_id)
            self.host.set_access(instance_id, Access.OPEN, 1)
            self._journal("instance_ready", rec.id, instance_id=instance_id)  # FR-TIM-04 (before the clock starts: `session_started` follows)
            started = self.engine.instance_ready(rec.id, self.clock(), instance_id)
            if started.instance_id != instance_id:  # a running attempt whose old instance died now points at the new one
                started = self.engine.set_instance(rec.id, instance_id)
            return StartedAttempt(started.id, instance_id, started.state.value)
        except Exception:
            # no leaked instance when a step fails (review finding A2); _wait_ready already destroys on timeout
            try:
                self.host.destroy(instance_id)
            except Exception:
                log.exception("cleanup of %s failed", instance_id)
            self.directory.remove(instance_id)
            raise
        finally:
            with self._lock:
                self._starting.pop(rec.id, None)

    def start_attempt(self, user_id: str, template_id: str | None = None, org_id: str | None = None) -> StartedAttempt:
        """Create the attempt, start its instance, wait for ready, open access and start the clock (D-80). Blocks until ready."""
        begun = self._begin(user_id, template_id or self.template_id, org_id)
        return begun if isinstance(begun, StartedAttempt) else self._finish(*begun)

    def start_attempt_async(self, user_id: str, template_id: str | None = None, org_id: str | None = None) -> StartedAttempt:
        """The same start without the wait: answers at once with the new instance id while a background thread waits for ready
        (the browser polls the instance, IF-2 requestInstance). A start that fails leaves the attempt as it was and destroys the instance."""
        begun = self._begin(user_id, template_id or self.template_id, org_id)
        if isinstance(begun, StartedAttempt):
            return begun
        rec, instance_id, epoch, template = begun

        def work() -> None:
            try:
                self._finish(rec, instance_id, epoch, template)
            except Exception:
                log.exception("the start of instance %s failed", instance_id)

        threading.Thread(target=work, name=f"lab-start-{instance_id[:8]}", daemon=True).start()
        return StartedAttempt(rec.id, instance_id, rec.state.value)

    def start_existing_async(self, attempt_id: str) -> StartedAttempt:
        """Ask for the instance of a candidate attempt that a consent created (state `ready`, no instance): IF-2 `startAttempt`, handoff H-356, OI-22.

        D-80: the Start button only asks for the instance; the clock starts when the instance is ready (the `_finish` step moves the attempt to `running`), so cold start never
        counts against the candidate. Answers at once like `start_attempt_async`; a second call while the start is under way, or once it runs, answers the same attempt.
        AttemptStateInvalid for a learner attempt (a learner starts through `requestInstance`) and for a state that cannot start (submitted, withdrawn, cancelled...)."""
        rec = self.engine.get(attempt_id)
        if rec.org_id is None:
            raise AttemptStateInvalid("a learner starts through requestInstance")
        with self._lock:
            # the orchestrator knows only its own template names; the attempt keeps the invite's versioned name
            begun = self._prepare(rec, rec.user_id, self.template_id)
        if isinstance(begun, StartedAttempt):
            return begun
        rec, instance_id, epoch, template = begun

        def work() -> None:
            try:
                self._finish(rec, instance_id, epoch, template)
            except Exception:
                log.exception("the start of the instance %s of candidate attempt %s failed", instance_id, rec.id)

        threading.Thread(target=work, name=f"lab-start-{instance_id[:8]}", daemon=True).start()
        return StartedAttempt(rec.id, instance_id, rec.state.value)

    def _wait_ready(self, instance_id: str) -> None:
        deadline = time.monotonic() + self._ready_timeout
        while True:
            state = self.host.get(instance_id).state
            if state is InstanceState.READY:
                return
            if state in (InstanceState.FAILED, InstanceState.DESTROYED) or time.monotonic() >= deadline:
                try:
                    self.host.destroy(instance_id)
                except Exception:  # best effort; the reconciler of the orchestrator cleans up
                    log.exception("destroy after a failed start did not work")
                raise InstanceNotReady("the instance did not become ready")
            self._sleep(self._ready_poll)

    def submit_flag(self, attempt_id: str, challenge_key: str, text: str) -> FlagSubmissionResult:
        self.attempts.get(attempt_id)  # AttemptNotFound, AttemptGone
        rec = self._record_or_none(attempt_id)
        if rec is not None and rec.state is AttemptState_.RUNNING and rec.deadline_at is not None and self.clock() > rec.deadline_at:
            raise AttemptStateInvalid("the attempt is over: its deadline has passed")  # the tick that submits it runs up to a minute later
        self.require_playable(attempt_id, challenge_key, allow_solved=True)  # a sequenced run: only the challenge that is active now (or one already captured) takes a flag
        result = self.submit_service.submit_flag(attempt_id, challenge_key, text)
        info = self.directory.for_attempt(attempt_id)
        extra = {"instance_id": info.instance_id} if info else {}
        if info:
            self._note_activity(info.instance_id)  # a flag paste is a player action even when the shop shows nothing
        self._journal("flag_submitted", attempt_id, challenge_key=challenge_key, result=result.result, **extra)
        if result.credit == "credited":
            self._journal("milestone_reached", attempt_id, challenge_key=challenge_key, level="M3", **extra)
            self.live.milestone(attempt_id, challenge_key, "M3")
            self.live.score(attempt_id)
        return result

    def unlock_hint(self, attempt_id: str, challenge_key: str, level: int) -> int:
        """Levels unlock in order, each once. Returns the number of levels now unlocked for the challenge."""
        attempt = self.attempts.get(attempt_id)
        if attempt.state is not AttemptState.RUNNING:
            raise AttemptStateInvalid("the attempt is not running")
        if challenge_key not in self.challenge_keys:
            raise ChallengeNotFound("not a challenge of this template")
        self.require_playable(attempt_id, challenge_key)  # a sequenced run: hints only for the challenge that is active now
        with self._lock:
            have = self.hints.levels(attempt_id, challenge_key)
            if type(level) is not int or level < 1 or level > MAX_HINT_LEVEL:
                raise AttemptStateInvalid("hint levels unlock in order")
            if level in have:
                return len(have)  # unlocked before: the same answer, no second cost
            if level != len(have) + 1:
                raise AttemptStateInvalid("hint levels unlock in order")
            self.hints.add(attempt_id, challenge_key, level, self.clock())
            self._journal("hint_unlocked", attempt_id, challenge_key=challenge_key, level=level, cost=0)
            self.live.hint(attempt_id, challenge_key, level)
            self.live.score(attempt_id)
            return len(have) + 1

    def _begin_reset(self, attempt_id: str) -> tuple[str, int]:
        """The fast half of a reset, under the lock: every check, then the orchestrator is asked. Returns (instance id, new epoch)."""
        attempt = self.attempts.get(attempt_id)
        if attempt.state not in (AttemptState.READY, AttemptState.RUNNING):
            raise AttemptStateInvalid("the attempt cannot be reset in its state")
        with self._lock:
            info = self.directory.for_attempt(attempt_id)  # read inside the lock: two resets cannot both compute the same epoch
            if info is None:
                raise InstanceNotReady("the attempt has no instance")
            if attempt_id in self._resetting:
                raise AttemptStateInvalid("a reset is already under way")
            try:
                self.engine.can_reset(attempt_id)  # raises before the instance is touched when the limit is used up
            except (ResetLimitReached, InvalidTransition):
                raise AttemptStateInvalid("no reset left") from None
            epoch = info.epoch + 1
            material = build_material(self.keys, info.instance_id, epoch, info.challenge_keys)
            self.host.reset(info.instance_id, ResetRequest(epoch=epoch, material=material))
            self.directory.add(InstanceInfo(info.instance_id, attempt_id, info.template_id, epoch, info.challenge_keys))
            self.epochs.set(info.instance_id, epoch)  # from now an event of the old epoch is stale, even while the instance restarts
            self._resetting.add(attempt_id)
            return info.instance_id, epoch

    def _finish_reset(self, attempt_id: str, instance_id: str) -> None:
        """The slow half, outside the lock: wait for ready, then count the reset (a reset that never got ready is not counted)."""
        try:
            self._wait_ready(instance_id)
        except Exception:
            # the orchestrator's reconciler owns the rest; the attempt stays as it was and a new instance can replace the dead one
            log.exception("reset of %s did not reach ready", instance_id)
            raise
        finally:
            with self._lock:
                self._resetting.discard(attempt_id)
        self.engine.record_reset(attempt_id)  # the engine writes the `instance_reset` line of the log itself

    def reset_attempt(self, attempt_id: str) -> int:
        """New epoch, new flags (FR-INS-07). Counted against the template limit while the attempt runs (FR-SES-09); the clock does
        not move. Returns the new epoch once the instance is ready again. The wait is outside the lock; a second reset of the same
        attempt meanwhile is refused (review findings A3, A4, A5)."""
        instance_id, epoch = self._begin_reset(attempt_id)
        self._finish_reset(attempt_id, instance_id)
        return epoch

    def reset_attempt_async(self, attempt_id: str) -> int:
        """The same reset without the wait: returns the new epoch at once while a background thread waits for ready (IF-2 resetInstance)."""
        instance_id, epoch = self._begin_reset(attempt_id)

        def work() -> None:
            try:
                self._finish_reset(attempt_id, instance_id)
            except Exception:
                log.exception("the reset of instance %s failed", instance_id)

        threading.Thread(target=work, name=f"lab-reset-{instance_id[:8]}", daemon=True).start()
        return epoch
    def stop_instance(self, attempt_id: str) -> str:
        """Free the instance (the learner pressed stop). The attempt keeps its state and clock; `start_attempt` can ask for a new instance."""
        rec = self.engine.get(attempt_id)
        if rec.state.value not in ("ready", "running") or rec.access == "frozen":
            raise AttemptStateInvalid("the instance cannot be stopped in this state")
        if rec.instance_id and self.instance_alive(rec.instance_id):
            self.host.destroy(rec.instance_id)
        return rec.instance_id or ""
    def force_stop(self, attempt_id: str) -> str:
        """An admin stops the attempt's instance whatever the attempt's state (story P-28, FR-ADM-04). The attempt keeps its state and clock. Returns the instance id that was
        destroyed, or '' when there was none alive."""
        rec = self.engine.get(attempt_id)
        if rec.instance_id and self.instance_alive(rec.instance_id):
            self.host.destroy(rec.instance_id)
            return rec.instance_id
        return ""

    def withdraw(self, attempt_id: str) -> str:
        return self.attempts.withdraw(attempt_id).state.value

    def undo_withdrawal(self, attempt_id: str) -> str:
        """Inside the undo window: cancel the scheduled deletion; the attempt stays `withdrawn` (D-91). InvalidTransition when it is not withdrawn,
        WindowClosed after the window."""
        self.attempts.get(attempt_id)  # AttemptNotFound or AttemptGone
        return self.engine.undo_withdrawal(attempt_id).state.value

    def _active_seconds(self, attempt_id: str) -> int | None:
        try:
            return self.time_metrics(attempt_id).active_seconds
        except Exception:
            log.warning("the active time of an attempt could not be computed for the cohort view", exc_info=True)
            return None

    def time_metrics(self, attempt_id: str):
        """FR-TIM-01 to 03: headline time to capture, estimated active time, resets and retries (the score never reads them)."""
        rec = self.engine.get(attempt_id)
        info = self.directory.for_attempt(attempt_id)
        captures = self.milestones.captures(attempt_id)
        stamps = [b.minute for b in self.activity.buckets(info.instance_id)] if info else []
        started = rec.started_at or rec.created_at
        return time_metrics(started, clamp_to_start(captures, started), stamps, self.attempt_log.read(attempt_id))

    def submit(self, attempt_id: str) -> str:
        self.attempts.get(attempt_id)
        return self.engine.submit(attempt_id).state.value

    def score(self, attempt_id: str) -> Score:
        return self.reports.score(attempt_id)

    def state(self, attempt_id: str) -> dict[str, Any]:
        self.attempts.get(attempt_id)  # AttemptNotFound for an unknown id
        rec = self.engine.get(attempt_id)
        iso = lambda v: v.isoformat() if v else None  # noqa: E731
        return {"attempt_id": rec.id, "state": rec.state.value, "instance_id": rec.instance_id, "access": rec.access,
                "started_at": iso(rec.started_at), "deadline_at": iso(rec.deadline_at), "submitted_at": iso(rec.submitted_at),
                "frozen_until": iso(rec.frozen_until), "destroyed": rec.destroyed, "reported_at": iso(rec.reported_at)}

    def tick(self) -> tuple[str, ...]:
        """Do what is due: engine steps, the milestone engine's timers, and `submitted` to `reported` (D-88)."""
        now = self.clock()
        changed = list(self.engine.tick())
        for credit in self.milestone_engine.tick(now) or ():  # a pending M2 whose window passed
            self._journal("milestone_reached", credit.attempt_id, challenge_key=credit.challenge_key, level=credit.milestone.value)
            self.live.milestone(credit.attempt_id, credit.challenge_key, credit.milestone.value)
            self.live.score(credit.attempt_id)
        self.review.remind_overdue()  # an open held capture older than 7 days: a reminder, never a score change
        if self.sequenced:  # a learner's run whose challenges are all solved or timed out is complete: submit it, so the report is ready and the instance is freed
            for rec in self.engine.in_states(AttemptState_.RUNNING):
                if rec.org_id is None and self.sequence.finished(rec.id, now):
                    try:
                        self.submit(rec.id)
                        changed.append(rec.id)
                    except Exception:
                        log.warning("submitting the finished run %s failed; the next tick tries again", rec.id, exc_info=True)
        for rec in self.engine.in_states(AttemptState_.SUBMITTED):
            if rec.destroyed:  # the engine destroys only a `submitted` attempt
                held_open = len(self.milestones.held_for(rec.id))
                if self.engine.mark_reported(rec.id, held_open).state.value == "reported":
                    changed.append(rec.id)
        self._heal_access()
        self._retry_bumps()
        self._erase_pending()
        return tuple(dict.fromkeys(changed))

    def bump_access_for_user(self, user_id: str) -> int:
        """FR-SES-11 (handoff H-341): a new login raises the access epoch of the account's live instances, so the gate refuses the older browser tab (it
        holds a ticket of the old epoch) while the new login can open a new ticket. Only an instance that is ready and open is touched: a closed or
        frozen one stays as it is. Returns how many instances were bumped. A host failure never raises: the account is retried by the next `tick`."""
        bumped, failed = 0, False
        for rec in self.engine.for_user(user_id):
            if rec.state.value not in ("ready", "running") or not rec.instance_id or rec.access == "frozen":
                continue
            try:
                st = self.host.get(rec.instance_id)
                if st.state in (InstanceState.READY, InstanceState.ACTIVE, InstanceState.IDLE) and st.access is Access.OPEN:
                    self.host.set_access(rec.instance_id, Access.OPEN, st.access_epoch + 1)
                    bumped += 1
            except InstanceNotFound:
                continue
            except Exception:
                failed = True
                log.warning("raising the access epoch of instance %s failed; it is retried", rec.instance_id[:10], exc_info=True)
        if failed:
            self._bump_pending.add(user_id)
        else:
            self._bump_pending.discard(user_id)
        return bumped

    def _retry_bumps(self) -> None:
        for user_id in tuple(self._bump_pending):
            self.bump_access_for_user(user_id)

    def _heal_access(self) -> None:
        """A running attempt whose instance is ready but closed (the orchestrator restarted and adopted it closed) is opened again with the
        next access epoch. Never raises: the next tick tries again."""
        for rec in self.engine.in_states(AttemptState_.RUNNING):
            if not rec.instance_id or rec.access == "frozen":
                continue
            try:
                st = self.host.get(rec.instance_id)
                if st.state in (InstanceState.READY, InstanceState.ACTIVE, InstanceState.IDLE) and st.access is Access.CLOSED:
                    self.host.set_access(rec.instance_id, Access.OPEN, st.access_epoch + 1)
                    log.info("access of instance %s opened again after an adoption", rec.instance_id[:10])
            except Exception:
                log.exception("healing the access of %s failed", rec.instance_id)


def _host_from_environ(environ: Mapping[str, str]) -> InstanceHost:
    url, key_file = environ.get("VULNMART_ORCH_URL"), environ.get("VULNMART_ORCH_KEY_FILE")
    if not (url and key_file):
        return FakeInstanceHost()
    key = Path(key_file).read_bytes().strip()
    context = None
    if url.startswith("https://"):
        ca, cert, cert_key = (environ.get(n) for n in ("VULNMART_ORCH_CA_FILE", "VULNMART_ORCH_CERT_FILE", "VULNMART_ORCH_CERT_KEY_FILE"))
        if not (ca and cert and cert_key):
            raise ValueError("an https orchestrator URL needs VULNMART_ORCH_CA_FILE, _CERT_FILE and _CERT_KEY_FILE")
        context = ssl.create_default_context(cafile=ca)
        context.load_cert_chain(cert, cert_key)
    return HttpInstanceHost(url, key, ssl_context=context)


def build_lab_runtime(environ: Mapping[str, str] | None = None, *, host: InstanceHost | None = None,
                      clock: Callable[[], datetime] | None = None, gate: ActivityGate | None = None) -> LabRuntime:
    """The runtime from the environment. `VULNMART_LAB_STORE=postgres` keeps everything in the database (needs `VULNMART_POSTGRES_DSN`) and uses the
    platform's key service (`DbKeyPort` over `vm_keystore`, story P-17: the KEK, the three masters and `VULNMART_KEYSTORE_DSN` come from the same
    settings as the rest of the API, read from the process environment); without it the state is in memory (tests and the laptop demo)."""
    env = os.environ if environ is None else environ
    stores, keys = None, None
    if env.get("VULNMART_LAB_STORE") == "postgres":
        from vulnmart.kernel.db import make_engine
        from vulnmart.kernel.services import key_port_from
        from vulnmart.kernel.settings import Settings
        from vulnmart.lab.pg import build_pg_stores

        dsn = env.get("VULNMART_POSTGRES_DSN")
        if not dsn or not env.get("VULNMART_KEYSTORE_DSN"):
            raise ValueError("VULNMART_LAB_STORE=postgres needs VULNMART_POSTGRES_DSN and VULNMART_KEYSTORE_DSN (the key service of story P-17)")
        stores = build_pg_stores(make_engine(dsn, pool_size=10, max_overflow=10))
        keys = key_port_from(Settings())
    extra: dict[str, Any] = {}
    if env.get("VULNMART_LABS_ZONE"):
        extra["hostname_suffix"] = env["VULNMART_LABS_ZONE"]
    if env.get("VULNMART_LAB_TEMPLATE_ID"):
        extra["template_id"] = env["VULNMART_LAB_TEMPLATE_ID"]
    if env.get("VULNMART_LAB_READY_TIMEOUT_S"):
        extra["ready_timeout_s"] = float(env["VULNMART_LAB_READY_TIMEOUT_S"])
    extra["sequenced"] = env.get("VULNMART_LAB_SEQUENCE") == "1"  # one challenge at a time with a countdown each (the deployed learner mode)
    return LabRuntime(host=host or _host_from_environ(env), clock=clock, gate=gate, stores=stores, keys=keys,
                      catalog=load_catalog(default_catalog_dir(env)), **extra)

