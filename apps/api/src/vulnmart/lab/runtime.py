"""LabRuntime: the attempt engine, scoring, flag checking, milestone engine and the event receiver in one process (D-95, D-96).

All state is in memory; a restart loses attempts (the real tables are Akshay's, H-130). Keys are random per process, so no
flag or event key of one run is valid in another. Answers of this class hold ids, states, numbers and result words, never
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
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from vulnmart_attempts import AttemptEngine, Fact, InMemoryAttemptStore, InvalidTransition, Milestone as ScoreMilestone, ResetLimitReached
from vulnmart_attempts.attempt_log import InMemoryAttemptLog
from vulnmart_attempts.metrics import time_metrics
from vulnmart_attempts.review import HeldCaptureReview, HeldItem, InMemoryAudit, InMemoryHeldStore, default_may_review

from vulnmart.flags.checker import FlagChecker
from vulnmart.flags.material import CHALLENGE_KEYS, build_material
from vulnmart.flags.submit import FlagSubmissionResult, FlagSubmitService
from vulnmart.ingest.activity import InMemoryActivityStore
from vulnmart.ingest.bots import BotRecorder, InMemoryBotVisitStore
from vulnmart.ingest.engine import MilestoneEngine
from vulnmart.ingest.evidence import EvidenceReader, EvidenceRecorder, InMemoryEvidenceStore
from vulnmart.ingest.handler import IngestHandler
from vulnmart.ingest.store import MemoryEventStore, MemoryInstanceEpochs, MemorySecuritySink
from vulnmart.ingest.stores import (
    ActivityGate,
    InMemoryEventLog, InMemoryFlagSubmissionLog, InMemoryInstanceDirectory, InMemoryIntegritySink,
    InMemoryMilestoneStore, InstanceInfo,
)
from vulnmart.lab.clock import OffsetClock
from vulnmart.lab.control import HostInstanceControl
from vulnmart.ports.attempts import AttemptState
from vulnmart.ports.engine_attempts import EngineAttemptPort
from vulnmart.ports.engine_reports import EngineReportPort
from vulnmart.ports.errors import AttemptStateInvalid, ChallengeNotFound, InstanceNotReady
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.fakes import FakeKeyPort
from vulnmart.ports.http_instance_host import HttpInstanceHost
from vulnmart.ports.instance_host import Access, CreateRequest, InstanceHost, InstanceState, Limits, ResetRequest
from vulnmart.ports.reports import Milestone as PortMilestone, Score

log = logging.getLogger("vulnmart.lab")

READY_TIMEOUT_S = 120.0
READY_POLL_S = 1.0
MAX_HINT_LEVEL = 3
DEFAULT_TEMPLATE_LIMITS = Limits(memory_mb=256, cpu_limit=1.0, pids_limit=256, idle_minutes=1440, max_minutes=1440)


def new_instance_id() -> str:
    return "i-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")  # 16 Base32 characters


@dataclass(frozen=True, slots=True)
class StartedAttempt:
    attempt_id: str
    instance_id: str
    state: str


class RuntimeFacts:
    """Scoring facts from the milestone store and the hint ledger. A held capture counts at its fallback (D-86)."""

    def __init__(self, milestones: InMemoryMilestoneStore, hints: dict[tuple[str, str], set[int]]) -> None:
        self._milestones, self._hints = milestones, hints

    def facts(self, attempt_id: str) -> Mapping[str, Fact]:
        out: dict[str, Fact] = {}
        for ck in CHALLENGE_KEYS:
            best = ScoreMilestone[self._milestones.best(attempt_id, ck).name]
            levels = tuple(sorted(self._hints.get((attempt_id, ck), ())))
            held = (attempt_id, ck) in self._milestones.held and best < ScoreMilestone.M3
            if held:
                out[ck] = Fact(milestone=ScoreMilestone.M3, hint_levels=levels, held=True, fallback=best)
            elif best is not ScoreMilestone.NONE or levels:
                out[ck] = Fact(milestone=best, hint_levels=levels)
        return out


class LabRuntime:
    def __init__(self, *, host: InstanceHost, clock: Callable[[], datetime] | None = None, keys: FakeKeyPort | None = None,
                 template_id: str = "shop-v0", challenge_keys: tuple[str, ...] = CHALLENGE_KEYS,
                 hostname_suffix: str = "instances.example.invalid", ready_timeout_s: float = READY_TIMEOUT_S,
                 ready_poll_s: float = READY_POLL_S, sleep: Callable[[float], None] = time.sleep, gate: ActivityGate | None = None,
                 limits: Limits = DEFAULT_TEMPLATE_LIMITS) -> None:
        self.clock: Callable[[], datetime] = clock or OffsetClock()
        self.host = host
        # Random master keys per process, never the fixed FAKE_* constants (D-96).
        self.keys = keys or FakeKeyPort(event_master=secrets.token_bytes(32), flag_key=secrets.token_bytes(32),
                                        owner_key=secrets.token_bytes(32))
        self.template_id, self.challenge_keys = template_id, challenge_keys
        self._suffix, self._ready_timeout, self._ready_poll, self._sleep = hostname_suffix, ready_timeout_s, ready_poll_s, sleep
        self._limits = limits
        self._lock = threading.RLock()

        self.attempt_log = InMemoryAttemptLog()  # ids and metadata only (FR-TIM-04)
        self.hints: dict[tuple[str, str], set[int]] = {}
        self.milestones = InMemoryMilestoneStore()
        self.integrity = InMemoryIntegritySink()
        self.directory = InMemoryInstanceDirectory()
        self.epochs = MemoryInstanceEpochs()
        self.events = InMemoryEventLog()
        self.engine = AttemptEngine(InMemoryAttemptStore(), HostInstanceControl(host), self.clock, events=self.attempt_log.from_engine)
        self.attempts = EngineAttemptPort(self.engine)
        self.evidence_store = InMemoryEvidenceStore()
        self.reports = EngineReportPort(attempts=self.attempts, facts=RuntimeFacts(self.milestones, self.hints),
                                        integrity=self.integrity, clock=self.clock,
                                        evidence=EvidenceReader(store=self.evidence_store, keys=self.keys))
        self.checker = FlagChecker(self.keys)
        gate_kw = {"gate": gate} if gate is not None else {}
        self.milestone_engine = MilestoneEngine(log=self.events, milestones=self.milestones, integrity=self.integrity,
                                                directory=self.directory, checker=self.checker, **gate_kw)
        self.activity = InMemoryActivityStore()
        self.bots = BotRecorder(InMemoryBotVisitStore())
        self.evidence = EvidenceRecorder(keys=self.keys, store=self.evidence_store, directory=self.directory, checker=self.checker,
                                         milestones=self.milestones, integrity=self.integrity)
        self.flag_log = InMemoryFlagSubmissionLog()
        self.submit_service = FlagSubmitService(attempts=self.attempts, directory=self.directory, checker=self.checker,
                                                milestones=self.milestones, integrity=self.integrity, log=self.flag_log,
                                                clock=self.clock, **gate_kw)
        self.handler = IngestHandler(keys=self.keys, epochs=self.epochs, store=MemoryEventStore(), security=MemorySecuritySink(),
                                     sink=self._on_event, now=self.clock)
        self._attempt_ids: list[str] = []
        self.org_of_attempt: dict[str, str] = {}
        self.held_store, self.audit = InMemoryHeldStore(), InMemoryAudit()
        self.review = HeldCaptureReview(self.held_store, self.audit, self.clock, default_may_review(self.org_of_attempt),
                                        events=self.attempt_log.append)

    def _sync_held(self, attempt_id: str) -> None:
        """Every capture the milestone store holds becomes an open item of the review (FR-ACH-07)."""
        for (aid, ck), at in tuple(self.milestones.held.items()):
            if aid == attempt_id and self.held_store.get(aid, ck) is None:
                best = ScoreMilestone[self.milestones.best(aid, ck).name]
                self.held_store.add(HeldItem(aid, ck, ScoreMilestone.M3, best, at))

    def held_captures(self, attempt_id: str) -> tuple[HeldItem, ...]:
        self.attempts.get(attempt_id)
        self._sync_held(attempt_id)
        return self.review.held(attempt_id)

    def decide_held(self, attempt_id: str, challenge_key: str, reviewer: Mapping[str, str], decision: str, note: str = "") -> str:
        """A named reviewer accepts or rejects a held capture; the decision is audited and final. Accept credits M3; reject keeps
        it out of the score, never zeroes anything, and releases the `reported` block. Raises ReviewForbidden / ReviewFinal / NotHeld."""
        self.attempts.get(attempt_id)
        self._sync_held(attempt_id)
        self.review.decide(attempt_id, challenge_key, reviewer, decision, note)
        with self._lock:
            if decision == "accept":
                self.milestones.credit(attempt_id, challenge_key, PortMilestone.M3, self.clock())
            self.milestones.held.pop((attempt_id, challenge_key), None)
        return decision

    def _on_event(self, event: Mapping[str, Any], at: datetime) -> None:
        """Every verified event: the milestone engine first, then evidence, activity buckets and bot visits."""
        result = self.milestone_engine.process(event, at)
        if result.stored is False:
            return  # a replay: nothing else sees it
        self.evidence.observe(event, at, result)
        self.activity.record(event, at)
        self.bots.observe(event, at)

    # ---- calls ----

    def start_attempt(self, user_id: str, template_id: str | None = None, org_id: str | None = None) -> StartedAttempt:
        """Create the attempt, start its instance, wait for ready, open access and start the clock (D-80)."""
        template = template_id or self.template_id
        with self._lock:
            rec = self.engine.create(user_id, template, consent_id=f"demo-consent-{secrets.token_hex(4)}")
            if rec.state.value == "running" and rec.instance_id:
                return StartedAttempt(rec.id, rec.instance_id, rec.state.value)
            if org_id:
                self.org_of_attempt[rec.id] = org_id
                self.attempts.set_org(rec.id, org_id)
            if rec.id not in self._attempt_ids:
                self._attempt_ids.append(rec.id)
            instance_id = new_instance_id()
            material = build_material(self.keys, instance_id, 1, self.challenge_keys)
            request = CreateRequest(instance_id=instance_id, template_id=template, epoch=1, material=material,
                                    hostname=f"{instance_id.lower()}.{self._suffix}", limits=self._limits,
                                    owner_hash=self.keys.owner_hash(user_id))
            self.host.create(request)
            self._wait_ready(instance_id)
            self.host.set_access(instance_id, Access.OPEN, 1)
            self.directory.add(InstanceInfo(instance_id, rec.id, template, 1, tuple(self.challenge_keys)))
            self.epochs.set(instance_id, 1)
            started = self.engine.instance_ready(rec.id, self.clock(), instance_id)
            return StartedAttempt(started.id, instance_id, started.state.value)

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
        return self.submit_service.submit_flag(attempt_id, challenge_key, text)

    def unlock_hint(self, attempt_id: str, challenge_key: str, level: int) -> int:
        """Levels unlock in order, each once. Returns the number of levels now unlocked for the challenge."""
        attempt = self.attempts.get(attempt_id)
        if attempt.state is not AttemptState.RUNNING:
            raise AttemptStateInvalid("the attempt is not running")
        if challenge_key not in self.challenge_keys:
            raise ChallengeNotFound("not a challenge of this template")
        with self._lock:
            have = self.hints.setdefault((attempt_id, challenge_key), set())
            if type(level) is not int or level != len(have) + 1 or level > MAX_HINT_LEVEL:
                raise AttemptStateInvalid("hint levels unlock in order")
            have.add(level)
            return len(have)

    def reset_attempt(self, attempt_id: str) -> int:
        """New epoch, new flags (FR-INS-07). Counted against the template limit while the attempt runs (FR-SES-09); the clock does
        not move. Returns the new epoch."""
        attempt = self.attempts.get(attempt_id)
        if attempt.state not in (AttemptState.READY, AttemptState.RUNNING):
            raise AttemptStateInvalid("the attempt cannot be reset in its state")
        info = self.directory.for_attempt(attempt_id)
        if info is None:
            raise InstanceNotReady("the attempt has no instance")
        with self._lock:
            try:
                self.engine.can_reset(attempt_id)  # raises before the instance is touched when the limit is used up
            except (ResetLimitReached, InvalidTransition):
                raise AttemptStateInvalid("no reset left") from None
            epoch = info.epoch + 1
            material = build_material(self.keys, info.instance_id, epoch, info.challenge_keys)
            self.host.reset(info.instance_id, ResetRequest(epoch=epoch, material=material))
            self._wait_ready(info.instance_id)
            self.directory.add(InstanceInfo(info.instance_id, attempt_id, info.template_id, epoch, info.challenge_keys))
            self.epochs.set(info.instance_id, epoch)
            self.engine.record_reset(attempt_id)
            return epoch

    def withdraw(self, attempt_id: str) -> str:
        return self.attempts.withdraw(attempt_id).state.value

    def time_metrics(self, attempt_id: str):
        """FR-TIM-01 to 03: headline time to capture, estimated active time, resets and retries (the score never reads them)."""
        rec = self.engine.get(attempt_id)
        info = self.directory.for_attempt(attempt_id)
        captures = {ck: at for (aid, ck), (m, at) in self.milestones.items.items() if aid == attempt_id and m.value == "M3"}
        stamps = [b.minute for b in self.activity.buckets(info.instance_id)] if info else []
        started = rec.started_at or rec.created_at
        return time_metrics(started, captures, stamps, self.attempt_log.read(attempt_id))

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
        self.milestone_engine.tick(now)
        for attempt_id in tuple(self._attempt_ids):
            rec = self.engine.get(attempt_id)
            if rec.state.value == "submitted" and rec.destroyed:  # the engine destroys only a `submitted` attempt
                held_open = sum(1 for (aid, _ck) in self.milestones.held if aid == attempt_id)
                if self.engine.mark_reported(attempt_id, held_open).state.value == "reported":
                    changed.append(attempt_id)
        return tuple(dict.fromkeys(changed))


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
    env = os.environ if environ is None else environ
    return LabRuntime(host=host or _host_from_environ(env), clock=clock, gate=gate)

