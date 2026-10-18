"""AttemptPort over the attempt engine of `vulnmart-attempts` (story 8.1, D-95). Stream L owns it.

The engine keeps only ids, states and instants; this adapter adds the two things the platform's port shows and the
engine does not hold (`org_id`, `mode`) in memory, and the set of purged attempts. The real, stored version is Akshay's
(handoff H-330); until then the demo runtime uses this one.
"""
from __future__ import annotations

import threading

from vulnmart_attempts import AttemptEngine, AttemptRecord, InvalidTransition

from vulnmart.ports.attempts import Attempt, AttemptMode, AttemptState
from vulnmart.ports.errors import AttemptGone, AttemptNotFound, AttemptStateInvalid


class EngineAttemptPort:
    def __init__(self, engine: AttemptEngine) -> None:
        self._engine = engine
        self._lock = threading.Lock()
        self._org: dict[str, str | None] = {}
        self._gone: set[str] = set()

    def set_org(self, attempt_id: str, org_id: str) -> None:
        with self._lock:
            self._org[attempt_id] = org_id

    def _view(self, rec: AttemptRecord) -> Attempt:
        org = self._org.get(rec.id)
        return Attempt(
            attempt_id=rec.id, user_id=rec.user_id, org_id=org,
            mode=AttemptMode.CANDIDATE if org else AttemptMode.LEARNER,
            state=AttemptState(rec.state.value), template_id=rec.template_id, consent_id=rec.consent_id,
        )

    def _record(self, attempt_id: str) -> AttemptRecord:
        if attempt_id in self._gone:
            raise AttemptGone("the attempt was purged")
        try:
            return self._engine.get(attempt_id)
        except KeyError:
            raise AttemptNotFound("no such attempt") from None

    def create_from_consent(self, *, user_id: str, org_id: str | None, template_id: str, invite_id: str, consent_id: str,
                            attempt_id: str | None = None) -> Attempt:
        """A `ready` attempt; a second call for the same user and template returns the first (idempotent)."""
        rec = self._engine.create(user_id, template_id, consent_id, attempt_id=attempt_id)
        with self._lock:
            self._org.setdefault(rec.id, org_id)
        return self._view(rec)

    def get(self, attempt_id: str) -> Attempt:
        return self._view(self._record(attempt_id))

    def cancel(self, attempt_id: str, *, by: str) -> Attempt:
        self._record(attempt_id)
        try:
            return self._view(self._engine.cancel(attempt_id, by, "cancelled"))
        except InvalidTransition:
            raise AttemptStateInvalid("the attempt cannot be cancelled in its state") from None

    def withdraw(self, attempt_id: str) -> Attempt:
        """Story L-26: lock the attempt, destroy the instance, schedule deletion after the undo window."""
        self._record(attempt_id)
        try:
            return self._view(self._engine.withdraw(attempt_id))
        except InvalidTransition:
            raise AttemptStateInvalid("the attempt cannot be withdrawn in its state") from None

    def purge(self, attempt_id: str) -> None:
        self._record(attempt_id)
        with self._lock:
            self._gone.add(attempt_id)
