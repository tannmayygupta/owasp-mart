"""The runtime clock: the system clock plus an offset that can only grow (the demo clock, D-96)."""
from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta

MAX_ADVANCE_SECONDS = 7200


class OffsetClock:
    def __init__(self, base=None) -> None:
        self._base = base or (lambda: datetime.now(UTC))
        self._offset = 0
        self._lock = threading.Lock()

    def __call__(self) -> datetime:
        with self._lock:
            return self._base() + timedelta(seconds=self._offset)

    @property
    def offset_seconds(self) -> int:
        return self._offset

    def advance(self, seconds: int) -> int:
        """Move the clock forward. Refuses anything but a whole number from 1 to 7200; never goes back."""
        if type(seconds) is not int or not 1 <= seconds <= MAX_ADVANCE_SECONDS:
            raise ValueError(f"seconds must be a whole number from 1 to {MAX_ADVANCE_SECONDS}")
        with self._lock:
            self._offset += seconds
            return self._offset
