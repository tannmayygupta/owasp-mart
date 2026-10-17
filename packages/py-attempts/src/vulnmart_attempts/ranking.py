"""The ranking aid (FR-SCR-08, D-93 for OI-26): a suggested order for a recruiter. Pure, dependency-free.

Order, best first: higher shown score, more full captures, lower hint cost, lower active time, earlier last
capture (no capture sorts last), then attempt id for a stable order. No row is dropped, hidden or marked failed.
"""
from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from .scoring import ScoreResult

RANKING_LABEL = "ranking aid, the recruiter decides"
_KEYS = ("score", "full captures", "hint cost", "active time", "last capture")
_BETTER = ("higher score", "more full captures", "lower hint cost", "lower active time", "earlier last capture")


@dataclass(frozen=True, slots=True)
class RankRow:
    attempt_id: str
    score: ScoreResult
    last_capture_at: datetime | None = None
    active_seconds: int | None = None


@dataclass(frozen=True, slots=True)
class RankedRow:
    position: int  # 1-based
    attempt_id: str
    shown: int
    full_captures: int
    hint_cost_units: int
    active_seconds: int | None
    last_capture_at: datetime | None
    reason: str
    label: str = RANKING_LABEL


def ranking_key(score: ScoreResult, last_capture_at: datetime | None, active_seconds: int | None) -> tuple:
    """Sorts best first (attempt id is appended by `suggest_order`)."""
    return (
        -score.shown,
        -score.tie_break.full_captures,
        score.tie_break.hint_cost_units,
        math.inf if active_seconds is None else active_seconds,
        math.inf if last_capture_at is None else last_capture_at.timestamp(),
    )


def _reason(a: tuple, b: tuple | None) -> str:
    if b is None:
        return "last in the suggested order"
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            same = ", ".join(_KEYS[:i])
            return f"same {same}; {_BETTER[i]}" if i else _BETTER[0]
    return "no difference"


def suggest_order(rows: Iterable[RankRow]) -> tuple[RankedRow, ...]:
    items = [(ranking_key(r.score, r.last_capture_at, r.active_seconds), r) for r in rows]
    ids = [r.attempt_id for _, r in items]
    if len(set(ids)) != len(ids):
        raise ValueError("an attempt can appear only once")
    items.sort(key=lambda kr: (*kr[0], kr[1].attempt_id))
    out = []
    for i, (key, r) in enumerate(items):
        nxt = items[i + 1][0] if i + 1 < len(items) else None
        out.append(RankedRow(i + 1, r.attempt_id, r.score.shown, r.score.tie_break.full_captures,
                             r.score.tie_break.hint_cost_units, r.active_seconds, r.last_capture_at,
                             _reason(key, nxt)))
    return tuple(out)
