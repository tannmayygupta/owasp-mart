"""In-memory fakes of the three ports stream L provides (IF-9): attempts, reports, instances.

PROPOSAL from stream P (story P-05) for P's own tests and screens until stream L ships the real ports; they follow
the provisional Protocols in `attempts.py`, `reports.py` and `instances.py`. Test hooks (`seed`, `advance`,
`put_*`) set up the states a screen needs. Every fake is safe to share between threads; the ones that record a time take
an injectable clock.
"""
from __future__ import annotations

import secrets
import threading
from collections.abc import Mapping
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Any

from .attempts import CANCELLABLE, WITHDRAWABLE, Attempt, AttemptMode, AttemptState
from .errors import (
    AttemptGone, AttemptNotFound, AttemptStateInvalid, ChallengeNotFound, InstanceMissing, InstanceNotReady,
    InstanceQuotaReached, InstanceStateInvalid,
)
from .fakes import Clock, FakeQuotaPort, utc_now
from .instance_host import RESETTABLE, Access, Health, InstanceState
from .instances import OPENABLE, Capacity, InstanceView, Ticket
from .quota import QuotaPort
from .reports import CHALLENGE_KEYS, ChallengeResult, EvidenceItem, IntegrityFlag, Milestone, Score

_GONE = frozenset({InstanceState.STOPPING, InstanceState.DESTROYED, InstanceState.FAILED})
_NOT_COUNTED = frozenset({InstanceState.DESTROYED, InstanceState.FAILED})  # states that no longer hold a quota place
TICKET_SECONDS = 60  # a one-time ticket is short-lived (architecture 03)


def new_id(prefix: str) -> str:
    """An id of the shape the contracts use: a prefix and 16 Base32 characters."""
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    return prefix + "".join(secrets.choice(alphabet) for _ in range(16))


class _Attempts:
    """The shared attempt store, so the report and instance fakes refuse an attempt the attempt fake does not know."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.items: dict[str, Attempt] = {}
        self.purged: set[str] = set()

    def get(self, attempt_id: str) -> Attempt:
        if attempt_id in self.purged:
            raise AttemptGone(f"{attempt_id} was purged")
        if attempt_id not in self.items:
            raise AttemptNotFound(attempt_id)
        return self.items[attempt_id]


class FakeAttemptPort:
    def __init__(self, store: _Attempts | None = None):
        self.store = store or _Attempts()
        self.cancelled_by: dict[str, str] = {}

    def seed(self, *, user_id: str, mode: AttemptMode = AttemptMode.LEARNER, state: AttemptState = AttemptState.READY,
             org_id: str | None = None, attempt_id: str | None = None) -> Attempt:
        """Test hook: put an attempt in any state."""
        a = Attempt(attempt_id or new_id("a-"), user_id, org_id, mode, state, None, None)
        with self.store.lock:
            self.store.items[a.attempt_id] = a
        return a

    def create_from_consent(self, *, user_id: str, org_id: str, template_id: str, invite_id: str, consent_id: str,
                            attempt_id: str | None = None, rules: Mapping[str, Any] | None = None) -> Attempt:
        with self.store.lock:
            for a in self.store.items.values():
                if a.consent_id == consent_id:
                    return a
            a = Attempt(attempt_id or new_id("a-"), user_id, org_id, AttemptMode.CANDIDATE, AttemptState.READY, template_id, consent_id)
            self.store.items[a.attempt_id] = a
            return a

    def get(self, attempt_id: str) -> Attempt:
        with self.store.lock:
            return self.store.get(attempt_id)

    def _move(self, attempt_id: str, allowed: frozenset[AttemptState], to: AttemptState) -> Attempt:
        with self.store.lock:
            a = self.store.get(attempt_id)
            if a.state not in allowed:
                raise AttemptStateInvalid(f"{a.state} cannot become {to}")
            a = replace(a, state=to)
            self.store.items[attempt_id] = a
            return a

    def cancel(self, attempt_id: str, *, by: str) -> Attempt:
        with self.store.lock:
            a = self._move(attempt_id, CANCELLABLE, AttemptState.CANCELLED)
            self.cancelled_by[attempt_id] = by
            return a

    def withdraw(self, attempt_id: str) -> Attempt:
        return self._move(attempt_id, WITHDRAWABLE, AttemptState.WITHDRAWN)

    def purge(self, attempt_id: str) -> None:
        with self.store.lock:
            self.store.get(attempt_id)
            del self.store.items[attempt_id]
            self.store.purged.add(attempt_id)


class FakeReportPort:
    """Reports put in by tests (`put_score`, `put_evidence`, `put_flag`); an attempt with nothing put in has score 0."""

    def __init__(self, attempts: FakeAttemptPort, *, now: Clock = utc_now):
        self._attempts = attempts
        self._now = now
        self._lock = threading.Lock()
        self._scores: dict[str, Score] = {}
        self._evidence: dict[str, list[tuple[EvidenceItem, bytes]]] = {}
        self._flags: dict[str, list[IntegrityFlag]] = {}

    def _check(self, attempt_id: str) -> None:
        self._attempts.get(attempt_id)

    def put_score(self, attempt_id: str, score: int, per_challenge: tuple[ChallengeResult, ...] = ()) -> Score:
        if not 0 <= score <= 1000:
            raise ValueError("a score is 0 to 1000")
        s = Score(attempt_id, score, per_challenge, self._now())
        with self._lock:
            self._scores[attempt_id] = s
        return s

    def put_evidence(self, attempt_id: str, challenge_key: str, body: bytes) -> EvidenceItem:
        item = EvidenceItem(new_id("e-"), challenge_key, self._now(), len(body))
        with self._lock:
            self._evidence.setdefault(attempt_id, []).append((item, bytes(body)))
        return item

    def put_flag(self, attempt_id: str, flag: IntegrityFlag) -> None:
        with self._lock:
            self._flags.setdefault(attempt_id, []).append(flag)

    def score(self, attempt_id: str) -> Score:
        self._check(attempt_id)
        with self._lock:
            found = self._scores.get(attempt_id)
        return found or Score(attempt_id, 0, (), self._now())

    def challenge(self, attempt_id: str, challenge_key: str) -> ChallengeResult:
        self._check(attempt_id)
        if challenge_key not in CHALLENGE_KEYS:
            raise ChallengeNotFound(challenge_key)
        for r in self.score(attempt_id).per_challenge:
            if r.challenge_key == challenge_key:
                return r
        return ChallengeResult(challenge_key, Milestone.NONE, 0, 0)

    def evidence(self, attempt_id: str) -> tuple[EvidenceItem, ...]:
        self._check(attempt_id)
        with self._lock:
            return tuple(item for item, _ in self._evidence.get(attempt_id, []))

    def evidence_body(self, attempt_id: str, evidence_id: str) -> bytes:
        self._check(attempt_id)
        with self._lock:
            for item, body in self._evidence.get(attempt_id, []):
                if item.evidence_id == evidence_id:
                    return body
        # missing and not this attempt's give the same answer (IF-2: the same 404)
        raise AttemptNotFound(f"no evidence {evidence_id} in {attempt_id}")

    def integrity_flags(self, attempt_id: str) -> tuple[IntegrityFlag, ...]:
        self._check(attempt_id)
        with self._lock:
            return tuple(self._flags.get(attempt_id, []))


class FakeInstancePort:
    """One instance per attempt; the QuotaPort decides how many a user may run. With `auto_ready` an instance is ready
    at once; without it, it stays `requested` until `advance`."""

    def __init__(self, attempts: FakeAttemptPort, *, quota: QuotaPort | None = None, memory_per_instance_mb: int = 512,
                 total_memory_mb: int = 4096, auto_ready: bool = True, now: Clock = utc_now):
        self._attempts = attempts
        self._quota = quota or FakeQuotaPort()
        self._per = memory_per_instance_mb
        self._total = total_memory_mb
        self._auto_ready = auto_ready
        self._now = now
        self._lock = threading.Lock()
        self._items: dict[str, InstanceView] = {}
        self._owner: dict[str, str] = {}
        self._org: dict[str, str] = {}
        self.forced_by: dict[str, str] = {}

    def _get(self, instance_id: str) -> InstanceView:
        if instance_id not in self._items:
            raise InstanceMissing(instance_id)
        return self._items[instance_id]

    def _running(self) -> list[InstanceView]:
        return [v for v in self._items.values() if v.state not in _GONE]

    def request(self, attempt_id: str, *, user_id: str, org_id: str | None = None) -> InstanceView:
        self._attempts.get(attempt_id)
        with self._lock:
            # a repeat is answered from every instance of the attempt that is not destroyed (also stopping and failed), before any
            # quota check: a repeat of an accepted request is never refused by quota
            for v in self._items.values():
                if v.attempt_id == attempt_id and v.state is not InstanceState.DESTROYED:
                    return v
            # Quotas (story 3.6, FR-INS-06): per user, per company and for the platform; any one reached refuses the request before
            # anything is created. Only live instances count: `destroyed` and `failed` free their place.
            live = [v for v in self._items.values() if v.state not in _NOT_COUNTED]
            limits = self._quota.limits(user_id, org_id)
            mine = [v for v in live if self._owner[v.instance_id] == user_id]
            if len(mine) >= limits.user:
                raise InstanceQuotaReached(f"{user_id} already runs {len(mine)} instance(s)")
            if limits.company is not None and sum(1 for v in live if org_id is not None and self._org.get(v.instance_id) == org_id) >= limits.company:
                raise InstanceQuotaReached(f"the company {org_id} is at its limit of {limits.company} instance(s)")
            if len(live) >= limits.total:
                raise InstanceQuotaReached(f"the platform is at its limit of {limits.total} instance(s)")
            state = InstanceState.READY if self._auto_ready else InstanceState.REQUESTED
            v = InstanceView(new_id("i-"), attempt_id, state, Access.OPEN if self._auto_ready else Access.CLOSED,
                             Health.HEALTHY if self._auto_ready else Health.UNKNOWN, 1)
            self._items[v.instance_id] = v
            self._owner[v.instance_id] = user_id
            if org_id is not None:
                self._org[v.instance_id] = org_id
            return v

    def advance(self, instance_id: str, state: InstanceState, *, access: Access | None = None, error_code: str | None = None) -> InstanceView:
        """Test hook: move an instance to any state."""
        with self._lock:
            v = replace(self._get(instance_id), state=state, access=access or self._get(instance_id).access, error_code=error_code)
            self._items[instance_id] = v
            return v

    def get(self, instance_id: str) -> InstanceView:
        with self._lock:
            return self._get(instance_id)

    def open_ticket(self, instance_id: str) -> Ticket:
        with self._lock:
            v = self._get(instance_id)
            if v.state not in OPENABLE or v.access is not Access.OPEN:
                raise InstanceNotReady(f"{instance_id} is {v.state}, access {v.access}")
            issued = datetime.fromisoformat(self._now().replace("Z", "+00:00"))
            expires = (issued + timedelta(seconds=TICKET_SECONDS)).isoformat().replace("+00:00", "Z")
            return Ticket(f"https://{instance_id.lower()}.labs.example.invalid/?ticket=FAKE-{secrets.token_hex(8)}", expires)

    def reset(self, instance_id: str) -> InstanceView:
        with self._lock:
            v = self._get(instance_id)
            if v.state not in RESETTABLE:
                raise InstanceStateInvalid(f"{instance_id} is {v.state}")
            v = replace(v, epoch=v.epoch + 1, state=InstanceState.READY, error_code=None)
            self._items[instance_id] = v
            return v

    def stop(self, instance_id: str) -> InstanceView:
        with self._lock:
            v = replace(self._get(instance_id), state=InstanceState.DESTROYED, access=Access.CLOSED)
            self._items[instance_id] = v
            return v

    def force_stop(self, instance_id: str, *, by: str) -> InstanceView:
        v = self.stop(instance_id)
        self.forced_by[instance_id] = by
        return v

    def capacity(self) -> Capacity:
        with self._lock:
            running = len(self._running())
            return Capacity(self._total, running * self._per, running)
