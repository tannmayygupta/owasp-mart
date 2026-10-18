"""The lab's domain events for the live hub (IF-3, story P-22, handoff H-142).

The platform's live hub fans durable events out to the dashboards. Nothing in the lab published before; this module is the one place that builds and sends them:
`instance.state_changed`, `attempt.state_changed`, `attempt.milestone_reached`, `attempt.flag_captured`, `attempt.score_updated` and `attempt.hint_unlocked`.

An event carries ids, states, numbers and fixed words only: never a flag, a hint text or a pasted value (the schema refuses them). The audiences are decided later by the
relay from the attempt row, never here. Publishing is best effort: a failure is logged and never undoes the step that caused it, and without a publisher (tests, the laptop
demo) every call does nothing.
"""
from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any

log = logging.getLogger("vulnmart.lab.live")

Publish = Callable[[Mapping[str, Any]], Any]
SCHEMA_VERSION = 1
ATTEMPT_STATES = {"invited", "consent", "ready", "running", "submitted", "reported", "withdrawn", "expired", "cancelled", "deleted"}
INSTANCE_STATES = {"requested", "provisioning", "starting", "ready", "active", "idle", "resetting", "stopping", "destroyed", "failed"}


def stamp(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class LiveAnnouncer:
    def __init__(self, *, clock: Callable[[], datetime], record_of: Callable[[str], Any | None], score_of: Callable[[str], tuple[int, list[dict[str, Any]]]]) -> None:
        self._clock, self._record_of, self._score_of = clock, record_of, score_of
        self._publish: Publish | None = None

    def attach(self, publish: Publish | None) -> None:
        self._publish = publish

    def _mode(self, rec: Any) -> str:
        return "candidate" if getattr(rec, "org_id", None) else "learner"

    def _send(self, type_: str, data: dict[str, Any]) -> None:
        if self._publish is None:
            return
        try:
            self._publish({"schema_version": SCHEMA_VERSION, "type": type_, "occurred_at": stamp(self._clock()), "data": data})
        except Exception:
            log.warning("publishing %s failed", type_, exc_info=True)

    def attempt_state(self, attempt_id: str, previous: str | None, state: str) -> None:
        rec = self._record_of(attempt_id)
        if rec is None or state not in ATTEMPT_STATES:
            return
        deadline = getattr(rec, "deadline_at", None)
        self._send("attempt.state_changed", {"attempt_id": attempt_id, "mode": self._mode(rec), "state": state,
                                             "previous_state": previous if previous in ATTEMPT_STATES else None,
                                             "deadline_at": stamp(deadline) if deadline else None})

    def milestone(self, attempt_id: str, challenge_key: str, level: str) -> None:
        rec = self._record_of(attempt_id)
        if rec is None or level not in ("M1", "M2", "M3"):
            return
        self._send("attempt.milestone_reached", {"attempt_id": attempt_id, "mode": self._mode(rec), "challenge_key": challenge_key, "milestone": level})
        if level == "M3":  # a counted capture (a held one is not announced)
            self._send("attempt.flag_captured", {"attempt_id": attempt_id, "mode": self._mode(rec), "challenge_key": challenge_key})

    def hint(self, attempt_id: str, challenge_key: str, level: int) -> None:
        rec = self._record_of(attempt_id)
        if rec is not None:
            self._send("attempt.hint_unlocked", {"attempt_id": attempt_id, "mode": self._mode(rec), "challenge_key": challenge_key, "level": level})

    def score(self, attempt_id: str) -> None:
        rec = self._record_of(attempt_id)
        if rec is None or self._publish is None:
            return
        try:
            total, rows = self._score_of(attempt_id)
        except Exception:
            log.warning("computing the score for the live event failed", exc_info=True)
            return
        per = [{"challenge_key": r["challenge_key"], "best_milestone": r["best_milestone"], "points": int(r["points"])} for r in rows]
        self._send("attempt.score_updated", {"attempt_id": attempt_id, "mode": self._mode(rec), "score": max(0, min(1000, int(total))),
                                             "computed_at": stamp(self._clock()), "per_challenge": per})

    def instance(self, *, instance_id: str, attempt_id: str, state: str, health: str, epoch: int, error_code: str | None, access: str) -> None:
        if state not in INSTANCE_STATES:
            return
        self._send("instance.state_changed", {"instance_id": instance_id, "attempt_id": attempt_id, "state": state, "access": access,
                                              "health": health if health in ("unknown", "healthy", "unhealthy") else "unknown",
                                              "epoch": max(1, int(epoch)), "error_code": error_code if state == "failed" else None})
