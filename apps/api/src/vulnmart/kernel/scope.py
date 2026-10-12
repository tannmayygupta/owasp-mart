"""The real ScopePort: the scope of the running request or job, held in a context variable.

The session middleware (P-12, accounts) sets it from the session cookie; a job sets it with `acting_as`. Until then
nothing sets it, so every org-scoped query is refused, which is the safe default (ADR 0014).
"""
from __future__ import annotations

import contextvars
from collections.abc import Iterator
from contextlib import contextmanager

from vulnmart.ports.errors import ScopeMissing
from vulnmart.ports.scope import Scope

_scope: contextvars.ContextVar[Scope | None] = contextvars.ContextVar("vulnmart_scope", default=None)


def scope_or_none() -> Scope | None:
    """For the database session: the scope, or None (the session decides whether None is allowed)."""
    return _scope.get()


class ContextScopePort:
    def current(self) -> Scope:
        scope = _scope.get()
        if scope is None:
            raise ScopeMissing("no user in scope")
        return scope

    def require_org(self) -> str:
        org = self.current().org_id
        if org is None:
            raise ScopeMissing("no organisation in scope")
        return org

    @contextmanager
    def acting_as(self, scope: Scope) -> Iterator[Scope]:
        token = _scope.set(scope)
        try:
            yield scope
        finally:
            _scope.reset(token)
