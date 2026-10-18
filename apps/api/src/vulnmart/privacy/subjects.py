"""Pseudonymous subjects for the audit log (story P-17, FR-PRV-10): `SubjectService` and `PseudonymisingAudit`.

The audit log holds `s-...` ids, never a user id, an email address or a name. `SubjectService.pseudonym(user_id)` gives a person one random,
stable pseudonym (the row of `subject_map`); `forget(user_id)` deletes that row, after which the log still holds the entries and nobody can say
whom they are about (the deletion workflow of story P-25 calls it). `PseudonymisingAudit` wraps an `AuditPort` and replaces every user id it
finds in the actor, the subject or the details by the pseudonym, so no module has to remember to do it.
"""
from __future__ import annotations

import base64
import re
import secrets
from collections.abc import Mapping
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.audit import AuditPort, AuditRecord

from .models import SubjectMap

USER_ID = re.compile(r"^u-[A-Z2-7]{16}$")
SUBJECT_ID = re.compile(r"^s-[A-Z2-7]{16}$")


def new_subject_id() -> str:
    return "s-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")


class SubjectService:
    def __init__(self, sessions: sessionmaker[Session]):
        self._sessions = sessions

    def pseudonym(self, user_id: str) -> str:
        """The pseudonym of a user, made on first use. Safe when two callers ask at once (one row, one pseudonym)."""
        if not USER_ID.match(user_id):
            raise ValueError("not a user id")
        with self._sessions() as session:
            found = session.scalar(select(SubjectMap.subject_id).where(SubjectMap.user_id == user_id))
        if found:
            return found
        try:
            with self._sessions.begin() as session:
                subject = new_subject_id()
                session.add(SubjectMap(subject_id=subject, user_id=user_id))
            return subject
        except IntegrityError:  # another caller made it first
            with self._sessions() as session:
                found = session.scalar(select(SubjectMap.subject_id).where(SubjectMap.user_id == user_id))
            if found is None:
                raise
            return found

    def identity(self, subject_id: str) -> str | None:
        """The user id behind a pseudonym, or None once the mapping was deleted. Only the break-glass and deletion code may call this."""
        with self._sessions() as session:
            return session.scalar(select(SubjectMap.user_id).where(SubjectMap.subject_id == subject_id))

    def forget(self, user_id: str) -> bool:
        """Delete the person's mapping: the audit entries stay and identify nobody. True when a mapping existed."""
        with self._sessions.begin() as session:
            return session.execute(delete(SubjectMap).where(SubjectMap.user_id == user_id)).rowcount > 0


class PseudonymisingAudit:
    """An `AuditPort` that writes pseudonyms instead of user ids to the port it wraps."""

    def __init__(self, inner: AuditPort, subjects: SubjectService):
        self._inner, self._subjects = inner, subjects

    def _swap(self, value: Any) -> Any:
        if isinstance(value, str):
            return self._subjects.pseudonym(value) if USER_ID.match(value) else value
        if isinstance(value, Mapping):
            return {k: self._swap(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._swap(v) for v in value]
        return value

    def append(self, *, actor: str, action: str, subject: str | None = None, details: Mapping[str, Any] | None = None) -> AuditRecord:
        return self._inner.append(actor=self._swap(actor), action=action, subject=None if subject is None else self._swap(subject),
                                  details=self._swap(details or {}))

    def __getattr__(self, name: str) -> Any:  # head, entries, verify: reading goes straight to the log
        return getattr(self._inner, name)
