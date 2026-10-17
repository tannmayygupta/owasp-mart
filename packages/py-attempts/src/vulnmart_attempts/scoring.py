"""The hiring score: a pure function of three facts per challenge and the weight table (D-85, D-86, D-87).

Time, wrong or decoy submissions, technique labels and other players' results are not parameters, so they cannot
change a score. Integer arithmetic only; rounding is exact half-up.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import IntEnum

from .catalogue import Catalogue, ScoringRules


class Milestone(IntEnum):
    NONE = 0
    M1 = 1
    M2 = 2
    M3 = 3

    @property
    def label(self) -> str:
        return "none" if self is Milestone.NONE else self.name


def _milestone(value: object) -> Milestone:
    if isinstance(value, Milestone):
        return value
    if isinstance(value, str):
        for m in Milestone:
            if m.label == value:
                return m
    raise ValueError(f"unknown milestone: {value!r}")


@dataclass(frozen=True, slots=True)
class Fact:
    """What the platform knows about one challenge: the best milestone on any valid path, the hint levels unlocked,
    whether the capture is held for review. For a held capture `fallback` is the best milestone that is not held."""

    milestone: Milestone = Milestone.NONE
    hint_levels: tuple[int, ...] = ()
    held: bool = False
    fallback: Milestone = Milestone.NONE

    _KEYS = ("milestone", "hint_levels", "held", "fallback")

    def __post_init__(self) -> None:
        object.__setattr__(self, "milestone", _milestone(self.milestone))
        object.__setattr__(self, "fallback", _milestone(self.fallback))
        levels = tuple(self.hint_levels)
        if any(type(n) is not int for n in levels):
            raise ValueError("hint levels must be whole numbers")
        if len(set(levels)) != len(levels):
            raise ValueError("a hint level cannot be listed twice")
        object.__setattr__(self, "hint_levels", tuple(sorted(levels)))
        if type(self.held) is not bool:
            raise ValueError("held must be true or false")
        if self.held and not self.fallback < self.milestone:
            raise ValueError("a held capture needs a fallback milestone below the held one")
        if not self.held and self.fallback is not Milestone.NONE:
            raise ValueError("fallback is only for a held capture")

    @classmethod
    def from_mapping(cls, data: Mapping[str, object]) -> Fact:
        """Build a fact from a dict; any key that is not one of the three facts (or fallback) is refused."""
        extra = set(data) - set(cls._KEYS)
        if extra:
            raise ValueError(f"not a scoring fact: {sorted(extra)}")
        return cls(**dict(data))  # type: ignore[arg-type]


@dataclass(frozen=True, slots=True)
class ChallengeScore:
    challenge_key: str
    milestone: Milestone  # the milestone that counts (the fallback when held)
    hints_used: int
    points: int  # net points, half-up whole number, 0..W
    held: bool


@dataclass(frozen=True, slots=True)
class TieBreak:
    """Facts for the ranking aid only (OI-26): more full captures, then lower hint cost. Time facts live elsewhere."""

    full_captures: int
    hint_cost_units: int  # sum of W x hint percent over the challenges (100 units = 1 point)


@dataclass(frozen=True, slots=True)
class ScoreResult:
    shown: int  # 0..1000
    per_challenge: tuple[ChallengeScore, ...]
    tie_break: TieBreak


def _half_up(numerator: int, denominator: int) -> int:
    return (2 * numerator + denominator) // (2 * denominator)


def compute_score(
    facts: Mapping[str, Fact],
    catalogue: Catalogue | None = None,
    rules: ScoringRules | None = None,
) -> ScoreResult:
    cat = catalogue if catalogue is not None else Catalogue()
    rl = rules if rules is not None else ScoringRules()
    unknown = set(facts) - set(cat.weights)
    if unknown:
        raise ValueError(f"unknown challenge: {sorted(unknown)}")
    shares = (0, *rl.milestone_pct)
    max_level = len(rl.hint_cost_pct)
    rows: list[ChallengeScore] = []
    s_total = 0
    hint_units = 0
    full = 0
    for key, weight in cat.weights.items():
        fact = facts.get(key, Fact())
        if not isinstance(fact, Fact):
            raise ValueError(f"{key}: the fact must be a Fact")
        for level in fact.hint_levels:
            if level < 1 or level > max_level:
                raise ValueError(f"{key}: hint level {level} is outside 1 to {max_level}")
        counted = fact.fallback if fact.held else fact.milestone
        hint_pct = sum(rl.hint_cost_pct[level - 1] for level in fact.hint_levels)
        net_pct = max(0, shares[counted] - hint_pct)
        s_total += weight * net_pct
        hint_units += weight * hint_pct
        if counted is Milestone.M3:
            full += 1
        rows.append(ChallengeScore(key, counted, len(fact.hint_levels), _half_up(weight * net_pct, 100), fact.held))
    shown = _half_up(1000 * s_total, 100 * cat.total)
    return ScoreResult(shown, tuple(rows), TieBreak(full, hint_units))


@dataclass(frozen=True, slots=True)
class LearnerProgress:
    stars: int  # 0 to 3 by milestone
    solved: bool  # tick at M3
    no_hints_badge: bool  # M3 with zero hints


def learner_progress(fact: Fact) -> LearnerProgress:
    """Learner mode: the same milestones as stars, a solved tick, an optional no-hints badge. Hints never lower it."""
    if not isinstance(fact, Fact):
        raise ValueError("the fact must be a Fact")
    solved = fact.milestone is Milestone.M3
    return LearnerProgress(int(fact.milestone), solved, solved and not fact.hint_levels)


def learner_overview(facts: Mapping[str, Fact], catalogue: Catalogue | None = None) -> dict[str, LearnerProgress]:
    cat = catalogue if catalogue is not None else Catalogue()
    unknown = set(facts) - set(cat.weights)
    if unknown:
        raise ValueError(f"unknown challenge: {sorted(unknown)}")
    return {key: learner_progress(facts.get(key, Fact())) for key in cat.weights}
