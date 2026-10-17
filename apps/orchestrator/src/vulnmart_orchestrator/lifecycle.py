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
    reconcile_interval_s: float = 60.0  # how often the reconciler compares Docker with the records (story 3.5)
    max_parallel_builds: int = 4  # builds that run at the same time; more wait in `requested` (story 3.6, FR-INS-07)
    start_retries: int = 1  # how often a failed start (INST-START-FAILED, INST-HEALTH-TIMEOUT) is tried again, 0 to 2 (FR-INS-08)

    def __post_init__(self) -> None:
        if not (type(self.max_parallel_builds) is int and 1 <= self.max_parallel_builds <= 64):
            raise ValueError("max_parallel_builds must be an integer from 1 to 64")
        if not (type(self.start_retries) is int and 0 <= self.start_retries <= 2):
            raise ValueError("start_retries must be an integer from 0 to 2")
        # a zero interval would busy-loop the reaper and a zero ceiling or window would end every instance at once
        if not (isinstance(self.reaper_interval_s, (int, float)) and 0 < self.reaper_interval_s <= 3600):
            raise ValueError("reaper_interval_s must be above 0 and at most 3600")
        if not (isinstance(self.reconcile_interval_s, (int, float)) and 0 < self.reconcile_interval_s <= 3600):
            raise ValueError("reconcile_interval_s must be above 0 and at most 3600")
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
