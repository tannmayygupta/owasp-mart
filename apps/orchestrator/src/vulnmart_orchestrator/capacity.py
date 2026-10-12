"""Capacity of the host (contract sections 3 and 7, D8 of story 3.2): counted in memory only. The used memory is the sum of
`limits.memory_mb` of every instance that is not destroyed; a create that would pass the capacity is refused with 429 `ORCH-BUSY` and
creates nothing. A destroyed instance (a tombstone) holds no memory. A reset has no capacity check of its own (it keeps the memory the
instance holds: handoff H-57)."""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

DEFAULT_CAPACITY_MB = 8192


@dataclass(frozen=True, slots=True)
class Capacity:
    total_mb: int | None = None  # None: no limit (the engine tests and a laptop without a limit)

    def would_fit(self, used_mb: int, wanted_mb: int) -> bool:
        return self.total_mb is None or used_mb + wanted_mb <= self.total_mb

    @staticmethod
    def used(memory_of_live_instances: Iterable[int]) -> int:
        return sum(memory_of_live_instances)
