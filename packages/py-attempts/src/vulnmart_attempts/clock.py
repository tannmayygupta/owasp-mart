"""The injected clock: absolute UTC instants only (D-82). SystemClock is the only place the system clock is read."""
from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

Clock = Callable[[], datetime]


def require_aware(value: datetime, name: str = "datetime") -> datetime:
    """Refuse a naive datetime (ValueError); return the value unchanged."""
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware (UTC); a naive datetime is refused")
    return value


class SystemClock:
    def __call__(self) -> datetime:
        return datetime.now(UTC)


class FakeClock:
    """A settable clock for tests."""

    def __init__(self, start: datetime) -> None:
        self._now = require_aware(start, "start")

    def __call__(self) -> datetime:
        return self._now

    def set(self, value: datetime) -> None:
        self._now = require_aware(value, "value")

    def advance(self, **kwargs: float) -> datetime:
        self._now = self._now + timedelta(**kwargs)
        return self._now
