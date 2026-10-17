"""Pure timing rules: what is due at a given instant. No clock is read here; `now` is always passed in."""
from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta

from .clock import require_aware
from .rules import Rules


@dataclass(frozen=True, slots=True)
class AttemptTimes:
    """The stored instants of one attempt (all aware). The deadline is stored once, never recomputed."""

    ready_at: datetime | None = None
    started_at: datetime | None = None
    deadline_at: datetime | None = None
    submitted_at: datetime | None = None
    frozen_until: datetime | None = None

    def __post_init__(self) -> None:
        for name in ("ready_at", "started_at", "deadline_at", "submitted_at", "frozen_until"):
            value = getattr(self, name)
            if value is not None:
                require_aware(value, name)


def deadline_for(started_at: datetime, rules: Rules) -> datetime:
    """D-80: started_at is the instance-ready instant stamped by the server."""
    return require_aware(started_at, "started_at") + timedelta(minutes=rules.time_limit_minutes)


def frozen_until_for(submitted_at: datetime, rules: Rules) -> datetime:
    return require_aware(submitted_at, "submitted_at") + timedelta(minutes=rules.freeze_minutes)


def _before_start(now: datetime, times: AttemptTimes) -> bool:
    return times.started_at is not None and now < times.started_at


def accepts_request(now: datetime, times: AttemptTimes, rules: Rules) -> bool:
    """A request is accepted until the deadline plus the grace (inclusive). Without a deadline the clock has not started."""
    require_aware(now, "now")
    if times.deadline_at is None:
        return True
    return now <= times.deadline_at + timedelta(seconds=rules.grace_seconds)


def warnings_due(now: datetime, times: AttemptTimes, rules: Rules, already_sent: Collection[int]) -> tuple[int, ...]:
    """Warning minutes now due and not yet sent, longest first. Only while the attempt is running before its deadline."""
    require_aware(now, "now")
    if times.deadline_at is None or times.submitted_at is not None:
        return ()
    if _before_start(now, times) or now >= times.deadline_at:
        return ()
    sent = set(already_sent)
    return tuple(
        m for m in rules.warning_minutes
        if m not in sent and now >= times.deadline_at - timedelta(minutes=m)
    )


def expiry_due(now: datetime, times: AttemptTimes) -> bool:
    """True once the deadline is reached and the attempt has not been submitted (a lost connection changes nothing)."""
    require_aware(now, "now")
    if times.deadline_at is None or times.submitted_at is not None:
        return False
    if _before_start(now, times):
        return False
    return now >= times.deadline_at


def destroy_due(now: datetime, times: AttemptTimes) -> bool:
    """True at the instant frozen_until is reached, not before."""
    require_aware(now, "now")
    if times.frozen_until is None:
        return False
    if _before_start(now, times):
        return False
    return now >= times.frozen_until
