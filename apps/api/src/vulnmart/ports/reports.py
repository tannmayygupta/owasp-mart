"""ReportPort: score, per-challenge results, evidence and integrity flags of an attempt (IF-9, provided by stream L).

PROPOSAL written by stream P in story P-05 (decision 2 of its plan); stream L owns it and confirms or changes it
(H-06, H-79). The platform's report and review screens read through it and never read L's tables. Values follow
IF-2 and architecture 04 section 2.6: a score from 0 to 1000, milestones none, M1, M2, M3, integrity flags are
evidence for a human and never an automatic fail.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable

CHALLENGE_KEYS = tuple(f"C{n:02d}" for n in range(1, 12))


class Milestone(StrEnum):
    NONE = "none"
    M1 = "M1"
    M2 = "M2"
    M3 = "M3"


class IntegrityType(StrEnum):
    DECOY = "decoy"
    SHARING = "sharing"
    TIMING = "timing"
    ACTIVITY = "activity"
    SIMILARITY = "similarity"


@dataclass(frozen=True, slots=True)
class ChallengeResult:
    challenge_key: str
    milestone: Milestone
    hints_used: int
    points: int


@dataclass(frozen=True, slots=True)
class Score:
    attempt_id: str
    score: int  # 0..1000
    per_challenge: tuple[ChallengeResult, ...]
    computed_at: str


@dataclass(frozen=True, slots=True)
class EvidenceItem:
    """Metadata of one captured request; the body is read with `evidence_body` (decrypted with the attempt key)."""

    evidence_id: str
    challenge_key: str
    captured_at: str
    size: int


@dataclass(frozen=True, slots=True)
class IntegrityFlag:
    flag_id: str
    type: IntegrityType
    explanation: str
    status: str  # open, accepted, dismissed


@runtime_checkable
class ReportPort(Protocol):
    def score(self, attempt_id: str) -> Score:
        """The latest score snapshot. Raises AttemptNotFound, AttemptGone."""
        ...

    def challenge(self, attempt_id: str, challenge_key: str) -> ChallengeResult:
        """One challenge's result. Raises AttemptNotFound, AttemptGone, ChallengeNotFound (not C01..C11)."""
        ...

    def evidence(self, attempt_id: str) -> tuple[EvidenceItem, ...]:
        """The evidence of the attempt, oldest first. Raises AttemptNotFound, AttemptGone."""
        ...

    def evidence_body(self, attempt_id: str, evidence_id: str) -> bytes:
        """The decrypted captured request (already redacted at capture). Raises AttemptNotFound (also for an evidence id that is
        missing or not this attempt's), AttemptGone (purged, or the attempt key shredded: KeyShredded)."""
        ...

    def integrity_flags(self, attempt_id: str) -> tuple[IntegrityFlag, ...]:
        """Raises AttemptNotFound, AttemptGone."""
        ...
