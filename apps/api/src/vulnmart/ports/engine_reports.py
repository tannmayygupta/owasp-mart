"""ReportPort over the scoring function of `vulnmart-attempts` (story 8.1, D-95). Stream L owns it.

The score is `compute_score` over the facts a `FactSource` gives (best milestone, hint levels, held capture). Evidence bodies
are not served by the demo runtime (the sealed store is Akshay's, H-130): `evidence` is empty and `evidence_body` raises
`AttemptNotFound`. Integrity flags are read from the sink the milestone engine writes to.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Protocol

from vulnmart_attempts import Catalogue, Fact, ScoringRules, compute_score

from vulnmart.ingest.stores import InMemoryIntegritySink
from vulnmart.ports.attempts import AttemptPort
from vulnmart.ports.errors import ChallengeNotFound
from vulnmart.ports.reports import (
    CHALLENGE_KEYS, ChallengeResult, EvidenceItem, IntegrityFlag, Milestone, Score,
)
from vulnmart.ports.errors import AttemptNotFound


class FactSource(Protocol):
    def facts(self, attempt_id: str) -> Mapping[str, Fact]:
        """The scoring facts of the attempt, by challenge key; a challenge without an entry has none."""
        ...


class EngineReportPort:
    def __init__(self, *, attempts: AttemptPort, facts: FactSource, integrity: InMemoryIntegritySink | None = None,
                 catalogue: Catalogue | None = None, rules: ScoringRules | None = None,
                 clock: Callable[[], datetime] | None = None, evidence=None) -> None:
        self._attempts, self._facts, self._integrity = attempts, facts, integrity
        self._evidence = evidence  # an `EvidenceReader` (ingest/evidence.py) or None: then there is no evidence
        self._catalogue, self._rules = catalogue or Catalogue(), rules or ScoringRules()
        self._clock = clock or (lambda: datetime.now(UTC))

    def score(self, attempt_id: str) -> Score:
        self._attempts.get(attempt_id)  # raises AttemptNotFound or AttemptGone
        result = compute_score(self._facts.facts(attempt_id), self._catalogue, self._rules)
        rows = tuple(ChallengeResult(r.challenge_key, Milestone(r.milestone.label), r.hints_used, r.points) for r in result.per_challenge)
        return Score(attempt_id, result.shown, rows, self._clock().strftime("%Y-%m-%dT%H:%M:%SZ"))

    def challenge(self, attempt_id: str, challenge_key: str) -> ChallengeResult:
        if challenge_key not in CHALLENGE_KEYS:
            self._attempts.get(attempt_id)
            raise ChallengeNotFound("not a challenge key")
        for row in self.score(attempt_id).per_challenge:
            if row.challenge_key == challenge_key:
                return row
        raise ChallengeNotFound("this template has no such challenge")

    def evidence(self, attempt_id: str) -> tuple[EvidenceItem, ...]:
        self._attempts.get(attempt_id)
        return self._evidence.evidence(attempt_id) if self._evidence is not None else ()

    def evidence_body(self, attempt_id: str, evidence_id: str) -> bytes:
        self._attempts.get(attempt_id)
        if self._evidence is None:
            raise AttemptNotFound("no such evidence")
        return self._evidence.evidence_body(attempt_id, evidence_id)

    def integrity_flags(self, attempt_id: str) -> tuple[IntegrityFlag, ...]:
        self._attempts.get(attempt_id)
        if self._integrity is None:
            return ()
        return tuple(IntegrityFlag(f"f-{n}", row.kind, row.explanation, "open")
                     for n, row in enumerate(self._integrity.of(attempt_id), start=1))
