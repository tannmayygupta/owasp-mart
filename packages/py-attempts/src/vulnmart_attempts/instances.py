"""The `InstanceControl` Protocol (the two calls the engine makes on a lab instance) and a recording fake for tests."""
from __future__ import annotations

from typing import Protocol


class InstanceControl(Protocol):
    def freeze(self, instance_id: str) -> None:
        """Set the instance access to `frozen` (IF-5). Idempotent. Raises on failure; the engine retries next tick."""
        ...

    def destroy(self, instance_id: str) -> None:
        """Destroy the instance. Idempotent. Raises on failure; the engine retries next tick."""
        ...


class InMemoryInstanceControl:
    """Records calls; `fail_freeze` and `fail_destroy` make the next N calls raise."""

    def __init__(self) -> None:
        self.access: dict[str, str] = {}
        self.destroyed: set[str] = set()
        self.freeze_calls: list[str] = []
        self.destroy_calls: list[str] = []
        self.fail_freeze = 0
        self.fail_destroy = 0

    def freeze(self, instance_id: str) -> None:
        self.freeze_calls.append(instance_id)
        if self.fail_freeze > 0:
            self.fail_freeze -= 1
            raise RuntimeError("freeze failed")
        if instance_id not in self.destroyed:
            self.access[instance_id] = "frozen"

    def destroy(self, instance_id: str) -> None:
        self.destroy_calls.append(instance_id)
        if self.fail_destroy > 0:
            self.fail_destroy -= 1
            raise RuntimeError("destroy failed")
        self.destroyed.add(instance_id)
