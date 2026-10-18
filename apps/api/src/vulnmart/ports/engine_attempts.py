"""AttemptPort over the attempt engine of `vulnmart-attempts` (story 8.1, D-95). Stream L owns it.

The engine keeps ids, states, instants and the two things the platform's port shows (`org_id`, purge). With a stored
`AttemptStore` (Postgres, `vulnmart.lab.pg`) nothing here is held in memory: a restart keeps every attempt, its
organisation and its purge.
"""
from __future__ import annotations

from vulnmart_attempts import AttemptEngine, AttemptRecord, InvalidTransition

from vulnmart.ports.attempts import Attempt, AttemptMode, AttemptState
from vulnmart.ports.errors import AttemptGone, AttemptNotFound, AttemptStateInvalid


class EngineAttemptPort:
    def __init__(self, engine: AttemptEngine) -> None:
        self._engine = engine

    def set_org(self, attempt_id: str, org_id: str) -> None:
        self._record(attempt_id)
        self._engine.set_org(attempt_id, org_id)

    def _view(self, rec: AttemptRecord) -> Attempt:
        return Attempt(
            attempt_id=rec.id, user_id=rec.user_id, org_id=rec.org_id,
            mode=AttemptMode.CANDIDATE if rec.org_id else AttemptMode.LEARNER,
            state=AttemptState(rec.state.value), template_id=rec.template_id, consent_id=rec.consent_id,
        )

    def _record(self, attempt_id: str) -> AttemptRecord:
        try:
            rec = self._engine.get(attempt_id)
        except KeyError:
            raise AttemptNotFound("no such attempt") from None
        if rec.purged_at is not None:
            raise AttemptGone("the attempt was purged")
        return rec

    def create_from_consent(self, *, user_id: str, org_id: str | None, template_id: str, invite_id: str, consent_id: str,
                            attempt_id: str | None = None) -> Attempt:
        """A `ready` attempt; a second call for the same user and template returns the first (idempotent)."""
        rec = self._engine.create(user_id, template_id, consent_id, attempt_id=attempt_id, org_id=org_id)
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
        self._engine.mark_purged(attempt_id)
