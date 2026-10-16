"""Timing numbers of the instance lifecycle in one place (story 3.4, D-54, ADR 0035).

The engine reads every number from a `SettingsPort`, never from a constant of its own. The only port today is a fake that lives in
the process; the platform's settings store replaces it later (open points P-4 and P-19), and nothing else changes.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, replace
from typing import Protocol


@dataclass(frozen=True, slots=True)
class Settings:
    """All timing defaults. Minutes unless the name says seconds."""

    default_idle_minutes: int = 60  # what the platform puts in `limits.idle_minutes` of a learner instance
    default_max_minutes: int = 240  # what the platform puts in `limits.max_minutes` of a learner instance
    max_minutes_ceiling: int = 1440  # no instance lives longer than this, whatever its `limits.max_minutes` says
    active_window_minutes: int = 5  # no activity for this long moves `active` to `idle`
    reaper_interval_s: float = 30.0  # how often the reaper looks at the instances

    def __post_init__(self) -> None:
        # a zero interval would busy-loop the reaper and a zero ceiling or window would end every instance at once
        if not (isinstance(self.reaper_interval_s, (int, float)) and 0 < self.reaper_interval_s <= 3600):
            raise ValueError("reaper_interval_s must be above 0 and at most 3600")
        if not (isinstance(self.active_window_minutes, int) and self.active_window_minutes >= 1):
            raise ValueError("active_window_minutes must be an integer of at least 1")
        if not (isinstance(self.max_minutes_ceiling, int) and self.max_minutes_ceiling >= 1):
            raise ValueError("max_minutes_ceiling must be an integer of at least 1")


class SettingsPort(Protocol):
    def get(self) -> Settings: ...


class FakeSettingsPort:
    """Settings held in the process. `set` changes named values (a test, or the future admin screen)."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or Settings()
        self._lock = threading.Lock()

    def get(self) -> Settings:
        with self._lock:
            return self._settings

    def set(self, **values: object) -> Settings:
        with self._lock:
            self._settings = replace(self._settings, **values)
            return self._settings
