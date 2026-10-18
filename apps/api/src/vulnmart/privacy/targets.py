"""ConsentTargets: what the consent routes need from the invite and attempt side (story P-16; the real one is `assessments.accept.InviteConsentTargets`, story P-21).

A candidate attempt waits in state `consent` after an invite is opened and verified (architecture 04 section 10.1). The consent routes need to
find that attempt for the caller and, once the person decides, move it on: a grant makes it `ready`, a decline ends it. Today the attempt port
(IF-9, stream L) can only create an attempt already `ready` from a granted consent, and invites do not exist yet, so this small port is the
shape P needs and `FakeConsentTargets` is the in-memory stand-in for tests and demonstrations. Story P-21 implements it over the invite and attempt
tables and asks stream L for the step out of `consent` (handoff H-136). Nothing here pretends to be the owner's code.

`proceed` must be idempotent per consent id: a request that is repeated after a failure between writing the record and moving the attempt
finishes the job instead of failing.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, replace
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class ConsentTarget:
    attempt_id: str
    user_id: str  # whose attempt it is: only that person may decide
    org_id: str
    template_id: str
    company_name: str  # the party that decides how results are used (FR-PRV-01)
    state: str  # the attempt state; only `consent` can be decided
    retention_days: int | None = None  # what the template set for this attempt (story P-21); None: the platform default is shown


@runtime_checkable
class ConsentTargets(Protocol):
    def find(self, attempt_id: str) -> ConsentTarget | None:
        """The attempt, or None when it does not exist. The caller compares `user_id`: someone else's attempt is answered like a missing one."""
        ...

    def proceed(self, attempt_id: str, *, decision: str, consent_id: str) -> None:
        """Apply a recorded decision: `granted` moves the attempt to `ready`, `declined` ends it. Idempotent for the same `consent_id`."""
        ...


class FakeConsentTargets:
    """In-memory targets. `add` puts an attempt in state `consent`; `proceed` records what was applied in `applied`."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._targets: dict[str, ConsentTarget] = {}
        self.applied: list[tuple[str, str, str]] = []
        self.fail_next = 0  # tests: make the next `proceed` calls raise, as a down attempt service would

    def add(self, *, attempt_id: str, user_id: str, org_id: str = "o-ORG", template_id: str = "t-TEMPLATE", company_name: str = "Example Company Ltd",
            state: str = "consent", retention_days: int | None = None) -> ConsentTarget:
        target = ConsentTarget(attempt_id, user_id, org_id, template_id, company_name, state, retention_days)
        with self._lock:
            self._targets[attempt_id] = target
        return target

    def find(self, attempt_id: str) -> ConsentTarget | None:
        with self._lock:
            return self._targets.get(attempt_id)

    def proceed(self, attempt_id: str, *, decision: str, consent_id: str) -> None:
        with self._lock:
            if self.fail_next > 0:
                self.fail_next -= 1
                raise RuntimeError("attempt service unavailable")
            if any(a == attempt_id and c == consent_id for a, _, c in self.applied):
                return
            target = self._targets[attempt_id]
            self._targets[attempt_id] = replace(target, state="ready" if decision == "granted" else "cancelled")
            self.applied.append((attempt_id, decision, consent_id))
