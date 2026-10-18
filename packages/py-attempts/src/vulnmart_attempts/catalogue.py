"""The weight table and the scoring percentages (all numbers are placeholders: OI-4, OI-16, OI-25).

Weights follow docs/design/challenge-specs.md section 6.2 with C03 as Medium: 3 Easy x 60, 6 Medium x 90,
2 Hard x 120, total 960. Nothing here reads a clock or any input; it is plain data.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from collections.abc import Mapping

EASY, MEDIUM, HARD = 60, 90, 120

_DEFAULT_WEIGHTS = {
    "C01": EASY, "C02": MEDIUM, "C03": MEDIUM, "C04": MEDIUM, "C05": EASY, "C06": HARD,
    "C07": EASY, "C08": MEDIUM, "C09": MEDIUM, "C10": HARD, "C11": MEDIUM,
}


@dataclass(frozen=True, slots=True)
class ScoringRules:
    """Milestone shares (M1, M2, M3) and hint cost per level (1, 2, 3), all in percent of a challenge's weight."""

    milestone_pct: tuple[int, int, int] = (20, 40, 100)
    hint_cost_pct: tuple[int, ...] = (10, 20, 30)

    def __post_init__(self) -> None:
        shares = tuple(self.milestone_pct)
        hints = tuple(self.hint_cost_pct)
        if len(shares) != 3 or any(type(s) is not int or s < 0 or s > 100 for s in shares):
            raise ValueError("milestone_pct must be three whole percentages from 0 to 100")
        if list(shares) != sorted(shares):
            raise ValueError("milestone_pct must not decrease from M1 to M3")
        if any(type(h) is not int or h < 0 or h > 100 for h in hints):
            raise ValueError("hint_cost_pct must be whole percentages from 0 to 100")
        object.__setattr__(self, "milestone_pct", shares)
        object.__setattr__(self, "hint_cost_pct", hints)


@dataclass(frozen=True, slots=True)
class Catalogue:
    """Challenge key to weight W. Defaults to the real 11 challenges (sum 960)."""

    weights: Mapping[str, int] = field(default_factory=lambda: dict(_DEFAULT_WEIGHTS))

    def __post_init__(self) -> None:
        data = dict(self.weights)
        if not data:
            raise ValueError("the catalogue needs at least one challenge")
        if any(type(w) is not int or w <= 0 for w in data.values()):
            raise ValueError("every weight must be a positive whole number")
        object.__setattr__(self, "weights", MappingProxyType(data))

    @property
    def total(self) -> int:
        return sum(self.weights.values())

    def keys(self) -> tuple[str, ...]:
        return tuple(self.weights)
