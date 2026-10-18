"""The snapshot behind `GET /api/v1/live/snapshot` (story P-22, FR-LIV-04): the caller's attempts and instances as they are now, in the shapes of the IF-3 events.

A dashboard reads it before it opens the stream, after a `stream.resync`, and polls it when the stream keeps failing, so it answers the same whatever state the stream
is in. `LabSnapshotSource` reads the lab runtime in this process (the attempts of the caller and the state of their instances); a process with no lab has nothing to show
and answers empty lists. A recruiter has no attempts of their own: the company's candidate attempts are a dashboard read (story P-27), not this one.
"""
from __future__ import annotations

from typing import Any, Protocol

MAX_ITEMS = 100  # the contract's maxItems


class SnapshotSource(Protocol):
    def snapshot(self, user_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """The caller's (attempts, instances), newest first, at most `MAX_ITEMS` of each, in the shapes of AttemptSummary and InstanceSummary."""
        ...


class EmptySnapshot:
    def snapshot(self, user_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        return [], []


class LabSnapshotSource:
    def __init__(self, lab: Any):
        self._lab = lab

    def snapshot(self, user_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        from vulnmart.lab.api import mode_of, stamp
        from vulnmart.ports.instance_host import InstanceNotFound

        rt = self._lab
        records = [r for r in rt.engine.for_user(user_id) if r.purged_at is None and r.state.value != "deleted"][:MAX_ITEMS]
        attempts = [{"attempt_id": r.id, "mode": mode_of(r), "state": r.state.value, "instance_id": r.instance_id, "created_at": stamp(r.created_at),
                     "deadline_at": stamp(r.deadline_at)} for r in records]
        instances: list[dict[str, Any]] = []
        for rec in records:
            info = rt.directory.for_attempt(rec.id)
            if info is None:
                continue
            try:
                st = rt.host.get(info.instance_id)
            except InstanceNotFound:
                continue
            instances.append({"instance_id": info.instance_id, "attempt_id": rec.id, "state": st.state.value, "access": st.access.value, "health": st.health.value,
                              "epoch": st.epoch, "error_code": st.error_code if st.state.value == "failed" else None})
        return attempts, instances
