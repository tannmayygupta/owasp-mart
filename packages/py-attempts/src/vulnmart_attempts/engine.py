"""The attempt engine (story 7.2, D-83, D-84, D-88). The only writer of attempt state.

Every step reads the record, decides from the injected clock, and stores the change with a compare-and-set
on the version. A lost compare-and-set reloads and decides again, so a repeated or concurrent tick has one
effect. A failed freeze or destroy leaves the record unchanged and the next tick retries. A lost connection
is not an input: only the clock and the stored instants move an attempt.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Any

from .clock import Clock, require_aware
from .instances import InstanceControl
from .rules import Rules
from .schedule import accepts_request, deadline_for, destroy_due, expiry_due, frozen_until_for, warnings_due
from .states import CANCELLABLE, AttemptState, InvalidTransition, move
from .store import AttemptRecord, AttemptStore, Conflict, allows_new_run

log = logging.getLogger(__name__)

Events = Callable[[dict[str, Any]], None]

MAX_RETRIES = 10
DESTROY_CLAIM_LEASE_SECONDS = 300  # a claim whose owner crashed is taken over after this long (a destroy can take a while: finding B11)
READY_AT_TOLERANCE_SECONDS = 300
FREEZE_PATIENCE = timedelta(minutes=5)  # how long after its first failure a freeze may hold up the destroy


class ResetLimitReached(Exception):
    """The template's reset limit is used up (FR-SES-09). Refused before the instance is touched."""

    def __init__(self, attempt_id: str, limit: int) -> None:
        super().__init__(f"attempt {attempt_id} has used all {limit} resets")
        self.attempt_id = attempt_id
        self.limit = limit


class WindowClosed(Exception):
    """The 7-day undo window of a withdrawal has passed (FR-SES-10)."""


def _iso(value: datetime) -> str:
    return value.isoformat()


class AttemptEngine:
    def __init__(
        self,
        store: AttemptStore,
        instances: InstanceControl,
        clock: Clock,
        events: Events | None = None,
    ) -> None:
        self._store = store
        self._instances = instances
        self._clock = clock
        self._events: Events = events or (lambda _event: None)

    # ------------------------------------------------------------------ helpers

    def _emit(self, event: str, rec: AttemptRecord, **extra: Any) -> None:
        payload: dict[str, Any] = {"event": event, "attempt_id": rec.id, "state": rec.state.value, "at": _iso(self._clock())}
        payload.update(extra)
        try:
            self._events(payload)
        except Exception:  # an event sink failure never undoes a stored step
            log.exception("attempt event sink failed (%s)", event)

    def _state_changed(self, rec: AttemptRecord, previous: AttemptState) -> None:
        self._emit("attempt.state_changed", rec, **{"from": previous.value, "to": rec.state.value})

    def _load(self, attempt_id: str) -> AttemptRecord:
        rec = self._store.get(attempt_id)
        if rec is None:
            raise KeyError(attempt_id)
        return rec

    def _save(self, rec: AttemptRecord, **changes: Any) -> AttemptRecord:
        """One compare-and-set; raises Conflict if the record moved."""
        return self._store.put_if_version(replace(rec, **changes), rec.version)

    # ------------------------------------------------------------------ public calls

    def create(self, user_id: str, template_id: str, consent_id: str, rules: Rules | None = None,
               instance_id: str | None = None, attempt_id: str | None = None, org_id: str | None = None) -> AttemptRecord:
        """A `ready` attempt. One attempt per user per template: a second call returns the first. The exception is a learner's finished practice run
        (submitted, reported, withdrawn or cancelled): the next call starts a new run and the old one stays as history."""
        existing = self._store.find(user_id, template_id)
        if existing is not None and not allows_new_run(existing):
            return existing
        now = self._clock()
        rec = AttemptRecord(
            id=attempt_id or uuid.uuid4().hex, user_id=user_id, template_id=template_id, consent_id=consent_id,
            created_at=now, rules=rules or Rules(), state=AttemptState.READY, instance_id=instance_id, ready_at=now,
            org_id=org_id,
        )
        try:
            return self._store.add(rec)
        except Conflict:
            found = self._store.find(user_id, template_id)
            if found is None:
                raise
            return found

    def get(self, attempt_id: str) -> AttemptRecord:
        return self._load(attempt_id)

    def ids(self) -> list[str]:
        return self._store.ids()

    def for_user(self, user_id: str) -> list[AttemptRecord]:
        return self._store.for_user(user_id)

    def in_states(self, *states: AttemptState) -> list[AttemptRecord]:
        return self._store.in_states(*states)

    def find(self, user_id: str, template_id: str) -> AttemptRecord | None:
        """The one attempt of this user for this template, if any."""
        return self._store.find(user_id, template_id)

    def set_org(self, attempt_id: str, org_id: str) -> AttemptRecord:
        """Record the organisation of a candidate attempt, once; a later call keeps the first."""
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            if rec.org_id is not None:
                return rec
            try:
                return self._save(rec, org_id=org_id)
            except Conflict:
                continue
        raise Conflict("set_org: too many conflicts")

    def set_instance(self, attempt_id: str, instance_id: str) -> AttemptRecord:
        """Point the attempt at a new instance (the old one was lost and replaced). The clock and the reset count do not change."""
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            if rec.instance_id == instance_id:
                return rec
            try:
                return self._save(rec, instance_id=instance_id)
            except Conflict:
                continue
        raise Conflict("set_instance: too many conflicts")

    def mark_purged(self, attempt_id: str) -> AttemptRecord:
        """The platform's deletion workflow purged the attempt's data: the attempt is gone for every reader."""
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            if rec.purged_at is not None:
                return rec
            try:
                return self._save(rec, purged_at=self._clock())
            except Conflict:
                continue
        raise Conflict("mark_purged: too many conflicts")

    def instance_ready(self, attempt_id: str, at: datetime, instance_id: str | None = None) -> AttemptRecord:
        """D-80: the clock starts when the instance is ready. Repeated calls return the same record."""
        require_aware(at, "at")
        now = self._clock()
        if abs((at - now).total_seconds()) > READY_AT_TOLERANCE_SECONDS:
            at = now  # the clock is the server's: a stale or future instant from a caller never moves the deadline (finding B8)
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            if rec.state == AttemptState.RUNNING:
                return rec
            target = move(rec.state, AttemptState.RUNNING)
            try:
                new = self._save(rec, state=target, started_at=at, deadline_at=deadline_for(at, rec.rules),
                                 instance_id=instance_id or rec.instance_id)
            except Conflict:
                continue
            self._state_changed(new, rec.state)
            return new
        raise Conflict("instance_ready: too many conflicts")

    def submit(self, attempt_id: str) -> AttemptRecord:
        """Manual submit: only from running and within deadline plus grace; submitted_at is now."""
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            now = self._clock()
            if (rec.state == AttemptState.SUBMITTED and rec.deadline_at is not None and rec.submitted_at == rec.deadline_at
                    and now <= rec.deadline_at + timedelta(seconds=rec.rules.grace_seconds)):
                return rec  # the tick already submitted it at the deadline; a submit inside the grace window gets the same answer (finding B3)
            if rec.state != AttemptState.RUNNING or not accepts_request(now, rec.times, rec.rules):
                raise InvalidTransition(rec.state, AttemptState.SUBMITTED)
            try:
                new = self._save(rec, state=move(rec.state, AttemptState.SUBMITTED), submitted_at=now,
                                 frozen_until=frozen_until_for(now, rec.rules))
            except Conflict:
                continue
            self._state_changed(new, rec.state)
            self._emit("session_submitted", new, submitted_at=_iso(now), reason="manual")
            self._advance(new.id)
            return self._load(attempt_id)
        raise Conflict("submit: too many conflicts")

    def cancel(self, attempt_id: str, by: str, reason: str) -> AttemptRecord:
        """From ready or running. Records who and why, destroys the instance at once (retried by tick on failure)."""
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            if rec.state not in CANCELLABLE:
                raise InvalidTransition(rec.state, AttemptState.CANCELLED)
            now = self._clock()
            try:
                new = self._save(rec, state=move(rec.state, AttemptState.CANCELLED), cancelled_by=by,
                                 cancelled_reason=reason, cancelled_at=now, destroyed=rec.instance_id is None)
            except Conflict:
                continue
            self._state_changed(new, rec.state)
            self._advance(new.id)
            return self._load(attempt_id)
        raise Conflict("cancel: too many conflicts")

    # ---- reset (FR-SES-09, D-91)

    def can_reset(self, attempt_id: str) -> bool:
        """Pure check, no side effect. True: the reset will be counted (running). False: free (ready, not counted).
        Raises InvalidTransition in any other state and ResetLimitReached when the template limit is used up."""
        rec = self._load(attempt_id)
        return self._reset_counts(rec)

    def _reset_counts(self, rec: AttemptRecord) -> bool:
        if rec.state == AttemptState.READY:
            return False
        if rec.state != AttemptState.RUNNING or not accepts_request(self._clock(), rec.times, rec.rules):
            raise InvalidTransition(rec.state, AttemptState.RUNNING)
        if rec.reset_count >= rec.rules.reset_limit:
            raise ResetLimitReached(rec.id, rec.rules.reset_limit)
        return True

    def record_reset(self, attempt_id: str) -> AttemptRecord:
        """Call after the platform reset succeeded. Counts only while running; clock, deadline and started_at
        are not touched. The limit is checked inside the compare-and-set loop, so it is never exceeded."""
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            if not self._reset_counts(rec):
                return rec
            try:
                new = self._save(rec, reset_count=rec.reset_count + 1)
            except Conflict:
                continue
            self._emit("instance_reset", new, reset_count=new.reset_count)
            return new
        raise Conflict("record_reset: too many conflicts")

    # ---- withdrawal (FR-SES-10, D-91)

    def withdraw(self, attempt_id: str) -> AttemptRecord:
        """Lock the attempt, destroy the instance, schedule deletion after the undo window. Idempotent.
        A failed destroy raises and leaves the record unchanged (the next call retries)."""
        destroyed_here = False
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            if rec.state == AttemptState.WITHDRAWN:
                if rec.delete_after is not None:
                    return rec
                # withdrawn, then undone: a new request starts a new undo window (review finding B5)
                now = self._clock()
                try:
                    new = self._save(rec, withdrawn_at=now, delete_after=now + timedelta(days=rec.rules.withdrawal_undo_days), undone_at=None)
                except Conflict:
                    continue
                self._emit("attempt_withdrawn", new, delete_after=_iso(new.delete_after))  # type: ignore[arg-type]
                return new
            if rec.state == AttemptState.EXPIRED:
                self._advance(attempt_id)  # the tick's own step is between expired and submitted; let it finish (review finding B4)
                continue
            target = move(rec.state, AttemptState.WITHDRAWN)
            if rec.instance_id is not None and not rec.destroyed and not destroyed_here:
                self._instances.destroy(rec.instance_id)
                destroyed_here = True
            now = self._clock()
            try:
                new = self._save(rec, state=target, withdrawn_at=now, destroyed=True, destroy_claim_at=None,
                                 delete_after=now + timedelta(days=rec.rules.withdrawal_undo_days))
            except Conflict:
                continue
            self._state_changed(new, rec.state)
            if destroyed_here:
                self._emit("instance_destroyed", new, instance_id=new.instance_id)
            self._emit("attempt_withdrawn", new, delete_after=_iso(new.delete_after))  # type: ignore[arg-type]
            return new
        raise Conflict("withdraw: too many conflicts")

    def undo_withdrawal(self, attempt_id: str) -> AttemptRecord:
        """Inside the window: cancel the scheduled deletion. The attempt stays `withdrawn` (D-91). Idempotent."""
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            if rec.state != AttemptState.WITHDRAWN:
                raise InvalidTransition(rec.state, AttemptState.WITHDRAWN)
            if rec.delete_after is None:
                return rec  # already undone
            now = self._clock()
            if now >= rec.delete_after:
                raise WindowClosed(rec.id)
            try:
                new = self._save(rec, delete_after=None, undone_at=now)
            except Conflict:
                continue
            self._emit("withdrawal_undone", new)
            return new
        raise Conflict("undo_withdrawal: too many conflicts")

    def mark_reported(self, attempt_id: str, held_open: int, scoring_exists: bool = True) -> AttemptRecord:
        """D-88: `submitted` to `reported` only after scoring exists and with no held capture open."""
        for _ in range(MAX_RETRIES):
            rec = self._load(attempt_id)
            if rec.state == AttemptState.REPORTED:
                return rec
            target = move(rec.state, AttemptState.REPORTED)
            if held_open > 0 or not scoring_exists:
                return rec
            now = self._clock()
            try:
                new = self._save(rec, state=target, reported_at=now)
            except Conflict:
                continue
            self._state_changed(new, rec.state)
            return new
        raise Conflict("mark_reported: too many conflicts")

    def tick(self) -> tuple[str, ...]:
        """Do everything that is due, for every attempt, in order: warnings, expiry, submit, freeze, destroy.

        Returns the ids of attempts that changed. Safe to repeat and to run from two processes.
        """
        changed: list[str] = []
        for rec in self._store.due(self._clock()):
            if self._advance(rec.id):
                changed.append(rec.id)
        return tuple(changed)

    # ------------------------------------------------------------------ the steps

    def _advance(self, attempt_id: str) -> bool:
        """Run steps for one attempt until none makes progress. True if any did."""
        progressed = False
        for _ in range(MAX_RETRIES * 4):
            rec = self._store.get(attempt_id)
            if rec is None or not self._step(rec):
                return progressed
            progressed = True
        return progressed

    def _step(self, rec: AttemptRecord) -> bool:
        now = self._clock()
        if rec.state == AttemptState.RUNNING:
            if expiry_due(now, rec.times):
                return self._expire(rec)
            return self._warn(rec, now)
        if rec.state == AttemptState.EXPIRED:
            return self._submit_expired(rec)
        if rec.state == AttemptState.SUBMITTED:
            if not rec.destroyed and destroy_due(now, rec.times):
                # a freeze that keeps failing must not keep an instance alive for ever: after the patience the instance goes anyway
                # (review finding B2); until then a failed freeze blocks the destroy, so a live instance is never cut off unfrozen
                gave_up = rec.freeze_failed_at is not None and now >= rec.freeze_failed_at + FREEZE_PATIENCE
                if rec.access == "frozen" or gave_up:
                    return self._destroy(rec, now)
            if rec.access != "frozen" and not rec.destroyed:
                return self._freeze(rec)
            return False
        if rec.state == AttemptState.REPORTED:
            # reported before the freeze window ended: the instance still has to be destroyed (review finding B1)
            if not rec.destroyed and destroy_due(now, rec.times):
                return self._destroy(rec, now)
            return False
        if rec.state == AttemptState.CANCELLED:
            return False if rec.destroyed else self._destroy(rec, now)
        if rec.state == AttemptState.WITHDRAWN:
            if rec.delete_after is None or now < rec.delete_after:
                return False
            try:
                new = self._save(rec, state=move(rec.state, AttemptState.DELETED), deleted_at=now)
            except Conflict:
                return True
            self._state_changed(new, rec.state)  # the platform's purge job deletes the data on this signal
            return True
        return False

    def _warn(self, rec: AttemptRecord, now: datetime) -> bool:
        due = warnings_due(now, rec.times, rec.rules, rec.warnings_sent)
        if not due:
            return False
        try:
            new = self._save(rec, warnings_sent=tuple(rec.warnings_sent) + tuple(due))
        except Conflict:
            return True  # reload and decide again; the winner sent them
        self._emit("time_warning_sent", new, minutes_left=min(due))  # a late first tick tells the urgent one only (finding B10)
        return True

    def _expire(self, rec: AttemptRecord) -> bool:
        try:
            new = self._save(rec, state=move(rec.state, AttemptState.EXPIRED))
        except Conflict:
            return True
        self._state_changed(new, rec.state)
        self._emit("session_expired", new, deadline_at=_iso(new.deadline_at) if new.deadline_at else None)
        return True

    def _submit_expired(self, rec: AttemptRecord) -> bool:
        assert rec.deadline_at is not None
        try:
            new = self._save(rec, state=move(rec.state, AttemptState.SUBMITTED), submitted_at=rec.deadline_at,
                             frozen_until=frozen_until_for(rec.deadline_at, rec.rules))
        except Conflict:
            return True
        self._state_changed(new, rec.state)
        self._emit("session_submitted", new, submitted_at=_iso(rec.deadline_at), reason="expired")
        return True

    def _freeze(self, rec: AttemptRecord) -> bool:
        if rec.instance_id is not None:
            try:
                self._instances.freeze(rec.instance_id)
            except Exception:
                log.exception("freeze failed for attempt %s; retried next tick", rec.id)
                if rec.freeze_failed_at is None:
                    try:
                        self._save(rec, freeze_failed_at=self._clock())  # the patience of the destroy counts from here (finding B2)
                    except Conflict:
                        pass
                return False
        try:
            self._save(rec, access="frozen")
        except Conflict:
            pass
        return True

    def _destroy(self, rec: AttemptRecord, now: datetime) -> bool:
        if rec.instance_id is None:
            try:
                self._save(rec, destroyed=True)
            except Conflict:
                pass
            return True
        lease = timedelta(seconds=DESTROY_CLAIM_LEASE_SECONDS)
        if rec.destroy_claim_at is not None and now - rec.destroy_claim_at < lease:
            return False  # another process is destroying it
        try:
            claimed = self._save(rec, destroy_claim_at=now)
        except Conflict:
            return True
        try:
            self._instances.destroy(rec.instance_id)
        except Exception:
            log.exception("destroy failed for attempt %s; retried next tick", rec.id)
            self._release_claim(claimed.id)
            return False
        for _ in range(MAX_RETRIES):
            current = self._load(claimed.id)
            try:
                done = self._save(current, destroyed=True, destroy_claim_at=None)
            except Conflict:
                continue
            self._emit("instance_destroyed", done, instance_id=done.instance_id)
            return True
        return False

    def _release_claim(self, attempt_id: str) -> None:
        for _ in range(MAX_RETRIES):
            current = self._store.get(attempt_id)
            if current is None or current.destroy_claim_at is None:
                return
            try:
                self._save(current, destroy_claim_at=None)
                return
            except Conflict:
                continue
