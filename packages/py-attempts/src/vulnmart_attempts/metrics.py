"""Time metrics (FR-TIM-01 to 04, D-90): pure functions over plain data, derived on demand, never stored.

Only server instants go in (engine clock, platform arrival time). Nothing here reads a clock.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .clock import require_aware

IDLE_GAP_SECONDS = 300  # PRD placeholder (OI-25): a gap of 300 s or more counts zero
HEADLINE_LABEL = "time into the assessment"


def headline_seconds(started_at: datetime, captures: Mapping[str, datetime]) -> dict[str, int]:
    """Whole seconds from instance ready to each capture; the same start for every challenge (FR-TIM-01).
    A capture before `started_at` is refused with ValueError."""
    require_aware(started_at, "started_at")
    out: dict[str, int] = {}
    for key, when in captures.items():
        require_aware(when, f"capture {key}")
        if when < started_at:
            raise ValueError(f"capture {key} is earlier than the start of the assessment")
        out[key] = int((when - started_at).total_seconds())
    return out


def active_seconds(stamps: Iterable[datetime], idle_gap_s: int = IDLE_GAP_SECONDS) -> int:
    """Estimated active time: the sum of gaps between sorted activity instants that are strictly shorter than
    `idle_gap_s` (FR-TIM-02). Duplicates count once. Assessment level only."""
    if idle_gap_s <= 0:
        raise ValueError("idle_gap_s must be positive")
    ordered = sorted({require_aware(s, "stamp") for s in stamps})
    total = 0.0
    for earlier, later in zip(ordered, ordered[1:]):
        gap = (later - earlier).total_seconds()
        if gap < idle_gap_s:
            total += gap
    return int(total)


def reset_count(events: Iterable[Mapping[str, Any]]) -> int:
    return sum(1 for e in events if e.get("event") == "instance_reset")


def retry_counts(events: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    """`flag_submitted` events per challenge (FR-TIM-03: every attempt is kept as a separate event)."""
    counts = Counter(e["challenge_key"] for e in events if e.get("event") == "flag_submitted" and e.get("challenge_key"))
    return dict(counts)


@dataclass(frozen=True, slots=True)
class TimeMetrics:
    headline: Mapping[str, int]  # challenge key -> seconds, labelled HEADLINE_LABEL
    active_seconds: int
    resets: int
    retries: Mapping[str, int]


def time_metrics(
    started_at: datetime,
    captures: Mapping[str, datetime],
    activity_stamps: Iterable[datetime],
    events: Iterable[Mapping[str, Any]],
    idle_gap_s: int = IDLE_GAP_SECONDS,
) -> TimeMetrics:
    log = tuple(events)
    return TimeMetrics(
        headline=headline_seconds(started_at, captures),
        active_seconds=active_seconds(activity_stamps, idle_gap_s),
        resets=reset_count(log),
        retries=retry_counts(log),
    )
