"""AttemptPort over the attempt engine of `vulnmart-attempts` (story 8.1, D-95). Stream L owns it.

The engine keeps ids, states, instants and the two things the platform's port shows (`org_id`, purge). With a stored
`AttemptStore` (Postgres, `vulnmart.lab.pg`) nothing here is held in memory: a restart keeps every attempt, its
organisation and its purge.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from vulnmart_attempts import AttemptEngine, AttemptRecord, InvalidTransition, Rules

from vulnmart.ports.attempts import Attempt, AttemptMode, AttemptState
from vulnmart.ports.errors import AttemptGone, AttemptNotFound, AttemptStateInvalid


def attempt_rules(invite_rules: Mapping[str, Any] | None) -> Rules:
    """The engine's rules from the rules an invite carries (H-140: `Invite.rules`, copied from the template when the invite was made). Only the members the engine knows
    are taken (`time_limit_min` and `reset_limit`); the others (hints, challenge list, retention, visibility) belong to other layers. Strict: a value of the wrong type
    is a ValueError, never a silent default."""
    if not invite_rules:
        return Rules()
    data = Rules().to_dict()
    if "time_limit_min" in invite_rules:
        data["time_limit_minutes"] = invite_rules["time_limit_min"]
    if "reset_limit" in invite_rules:
        data["reset_limit"] = invite_rules["reset_limit"]
    return Rules.from_dict(data)


PLATFORM_EVENTS = ("invite_created", "invite_opened", "consent_given")  # FR-TIM-04 events whose instants the platform knows


class EngineAttemptPort:
    def __init__(self, engine: AttemptEngine, log: Any = None) -> None:
        self._engine = engine
        self._log = log  # the ids-only attempt log (FR-TIM-04); without one the history of an invite is not written

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
                            attempt_id: str | None = None, rules: Mapping[str, Any] | None = None, history: Mapping[str, Any] | None = None) -> Attempt:
        """A `ready` attempt under the invite's rules; a second call for the same user and template returns the first (idempotent). `history` carries the instants the
        platform knows (`invite_created`, `invite_opened`, `consent_given`); they go into the attempt log with their real times, each at most once."""
        rec = self._engine.create(user_id, template_id, consent_id, rules=attempt_rules(rules), attempt_id=attempt_id, org_id=org_id)
        self._journal_history(rec.id, history)
        return self._view(rec)

    def _journal_history(self, attempt_id: str, history: Mapping[str, Any] | None) -> None:
        """Best effort: a failing log never undoes the creation of the attempt."""
        if not history or self._log is None:
            return
        try:
            have = {e["event"] for e in self._log.read(attempt_id)}
            for name in PLATFORM_EVENTS:
                at = history.get(name)
                if at is not None and name not in have:
                    self._log.append({"event": name, "attempt_id": attempt_id, "at": at.isoformat()})
        except Exception:
            logging.getLogger("vulnmart.ports").warning("writing the invite history of an attempt failed", exc_info=True)

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
