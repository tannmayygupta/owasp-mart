"""Shared helpers for the engine tests (imported by name, not a pytest conftest)."""
from datetime import UTC, datetime, timedelta

from vulnmart_attempts import AttemptEngine, FakeClock, InMemoryAttemptStore, InMemoryInstanceControl

T0 = datetime(2026, 10, 17, 9, 0, 0, tzinfo=UTC)


class Rig:
    def __init__(self, store=None, clock=None, instances=None):
        self.clock = clock or FakeClock(T0)
        self.store = store or InMemoryAttemptStore()
        self.instances = instances or InMemoryInstanceControl()
        self.events: list[dict] = []
        self.engine = AttemptEngine(self.store, self.instances, self.clock, self.events.append)

    def second_engine(self):
        return AttemptEngine(self.store, self.instances, self.clock, self.events.append)

    def names(self, name):
        return [e for e in self.events if e["event"] == name]

    def started(self, user="u1", template="t1", instance="i1"):
        a = self.engine.create(user, template, "c1", instance_id=instance)
        return self.engine.instance_ready(a.id, self.clock())


def at(minutes=0, seconds=0):
    return T0 + timedelta(minutes=minutes, seconds=seconds)
