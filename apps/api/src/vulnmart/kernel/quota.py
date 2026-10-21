"""QuotaPort over the `quotas` table (story P-28, FR-ADM-05, OI-21): how many instances a user may run, and the caps a request is checked against.

`max_instances` is the most one user may run at once: the user's own row, else the company's row, else the global row, else `DEFAULT_MAX_INSTANCES` (one running instance
per learner, FR-INS-06). `limits` adds the two caps that apply on top (all three are checked, a request is refused when any is reached): the company cap (`instance_company_cap`,
for a user with a company) and the platform cap (`instance_total_cap`), both settings an admin can change. The admin's writes (`set`, `remove`, `rows`) are what
`vulnmart.admin.ops.AdminOps` calls; the lab only reads. A value is read at the moment of the request, so a change is enforced by the next request without a restart.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.ports.quota import DEFAULT_MAX_INSTANCES, QuotaLimits
from vulnmart.ports.settings import SettingsPort

from .models import Quota

SCOPES = ("user", "org", "global")
MAX_QUOTA = 10_000


@dataclass(frozen=True, slots=True)
class QuotaRow:
    scope: str
    scope_id: str | None
    max_instances: int


class DbQuotaPort:
    def __init__(self, sessions: sessionmaker[Session], settings: SettingsPort):
        self._sessions, self._settings = sessions, settings

    def _find(self, session: Session, scope: str, scope_id: str | None) -> int | None:
        query = select(Quota.max_instances).where(Quota.scope == scope)
        query = query.where(Quota.scope_id.is_(None)) if scope_id is None else query.where(Quota.scope_id == scope_id)
        return session.scalar(query)

    def max_instances(self, user_id: str, org_id: str | None = None) -> int:
        with self._sessions() as session:
            found = self._find(session, "user", user_id)
            if found is None and org_id is not None:
                found = self._find(session, "org", org_id)
            if found is None:
                found = self._find(session, "global", None)
        return DEFAULT_MAX_INSTANCES if found is None else found

    def limits(self, user_id: str, org_id: str | None = None) -> QuotaLimits:
        company = None if org_id is None else int(self._settings.get("instance_company_cap"))
        return QuotaLimits(self.max_instances(user_id, org_id), company, int(self._settings.get("instance_total_cap")), int(self._settings.get("instance_assessment_reserve")))

    # ---- the admin's side ----

    def rows(self) -> list[QuotaRow]:
        with self._sessions() as session:
            return [QuotaRow(r.scope, r.scope_id, r.max_instances) for r in session.scalars(select(Quota).order_by(Quota.scope, Quota.scope_id))]

    def set(self, scope: str, scope_id: str | None, max_instances: int) -> None:
        """Insert or change one row. The scope names a user, a company or (with no id) the whole platform; the number is 0 to 10000 (0 stops a user or company)."""
        if scope not in SCOPES or (scope == "global") != (scope_id is None):
            raise ValueError("a global quota has no id, a user or company quota has one")
        if not isinstance(max_instances, int) or isinstance(max_instances, bool) or not 0 <= max_instances <= MAX_QUOTA:
            raise ValueError(f"a quota is 0 to {MAX_QUOTA}")
        with self._sessions.begin() as session:
            query = select(Quota).where(Quota.scope == scope)
            query = query.where(Quota.scope_id.is_(None)) if scope_id is None else query.where(Quota.scope_id == scope_id)
            row = session.scalar(query)
            if row is None:
                session.add(Quota(scope=scope, scope_id=scope_id, max_instances=max_instances))
            else:
                row.max_instances = max_instances

    def remove(self, scope: str, scope_id: str | None) -> bool:
        with self._sessions.begin() as session:
            query = select(Quota).where(Quota.scope == scope)
            query = query.where(Quota.scope_id.is_(None)) if scope_id is None else query.where(Quota.scope_id == scope_id)
            row = session.scalar(query)
            if row is None:
                return False
            session.delete(row)
            return True
