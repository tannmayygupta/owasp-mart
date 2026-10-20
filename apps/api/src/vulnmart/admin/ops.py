"""The admin's operations (story P-28, FR-ADM-01, 02, 04, 05, 06, ADR 0057): the approval queue, user management, force-stop, settings and quotas, the capacity view, the scheduler's
last runs.

Every method takes the caller's `Scope` and refuses anyone who is not an admin (`RoleService.require_admin`, the same check the company and status services make); the routes put
the same rule in front (`requires(Role.ADMIN)`), so a non-admin gets 404 before any of this runs. Every change writes an audit entry that names the admin and what was changed,
never a reason's text, never an address, never anything a candidate wrote. An admin sees accounts (name, address, type, status, roles), companies, settings and counts; no method here
reads an attempt's answers, write-ups or evidence (FR-ADM-08; the break-glass step is story P-31).

- **Queue:** `queue` lists the companies waiting; `decide_company` approves, rejects (with a reason), suspends or reinstates through `CompanyService`, which audits and mails the outcome.
- **Users:** `users` searches accounts; `act_on_user` locks (the account is disabled and its sessions end), unlocks, sends a password-reset link to the account's own address (the admin
  never sees or sets a password) or deletes. A participant's account is deleted through the deletion service (practice attempts erased, account and pseudonym gone; one that holds assessment
  data is locked instead, as in ADR 0054); a recruiter's account is marked deleted and its sessions end; an admin account is never changed through here.
- **Force-stop:** `force_stop` destroys the instance of an attempt whatever its state, audits it and mails the owner (FR-ADM-04); the attempt keeps its state and clock.
- **Settings and quotas:** `settings` lists every setting with its default, `set_setting` checks the type and the range (a candidate retention default outside 30 to 365 days is refused,
  FR-ADM-05) and audits old and new value, `reset_setting` returns to the default; `quotas`, `set_quota` and `remove_quota` change the instance quotas the lab enforces.
- **Capacity:** `capacity` shows running instances, memory, queue depth (mails waiting, events not yet relayed) and failures (mails, jobs, instances).
"""
from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from vulnmart.accounts.models import User, UserRole, UserSession
from vulnmart.accounts.roles import NotAnAdmin, RoleService, UnknownUser
from vulnmart.accounts.service import AccountService, InvalidInput
from vulnmart.accounts.status import AccountStatusService, InvalidAccountState, clean_reason
from vulnmart.kernel.quota import MAX_QUOTA, SCOPES, DbQuotaPort, QuotaRow
from vulnmart.live.models import DomainEvent
from vulnmart.notifications.models import EmailOutbox
from vulnmart.notifications.service import DbOutboxPort
from vulnmart.notifications.templates import validate_params
from vulnmart.orgs.service import CompanyService, PendingCompany
from vulnmart.ports.audit import AuditPort
from vulnmart.ports.scope import Scope
from vulnmart.ports.settings import SETTINGS, SettingsPort
from vulnmart.privacy.deletion import DeletionService
from vulnmart.privacy.retention.records import SqlAttemptRecords

logger = logging.getLogger("vulnmart.admin")

USER_ID = re.compile(r"^u-[A-Z2-7]{16}$")
ATTEMPT_ID = re.compile(r"^a-[A-Z2-7]{16}$")
COMPANY_ACTIONS = ("approve", "reject", "suspend", "reinstate")
USER_ACTIONS = ("lock", "unlock", "reset_password", "delete")
MAX_SEARCH = 100
MAX_TEXT_SETTING = 200

# What an admin may set a number to. Anything not listed is 0 to 1,000,000; a name outside `SETTINGS` is refused before this.
RANGES: dict[str, tuple[int, int]] = {
    "candidate_retention_days": (30, 365),  # FR-ADM-05, FR-PRV-04
    "consent_withdraw_undo_days": (1, 30),  # FR-PRV-09
    "deletion_decide_days": (1, 90),
    "consent_record_extra_months": (0, 60),
    "learner_retention_months": (1, 120),
    "learner_warning_days": (1, 90),
    "learner_evidence_days": (1, 365),
    "session_details_days": (1, 365),
    "log_retention_months": (12, 120),  # the database function refuses a shorter audit retention anyway
    "session_idle_minutes": (1, 1440),
    "session_idle_minutes_admin": (1, 1440),
    "session_absolute_hours": (1, 168),
    "instance_idle_minutes": (1, 1440),
    "instance_max_minutes": (1, 1440),
    "instance_company_cap": (0, MAX_QUOTA),
    "instance_total_cap": (0, MAX_QUOTA),
    "invite_cap_per_company_per_day": (0, 100_000),
    "evidence_max_bytes": (256, 1_048_576),
}
GENERIC_RANGE = (0, 1_000_000)


class NotFound(Exception):
    """No such company, user, attempt or quota for this admin."""


class NotAllowed(Exception):
    """The change is not made through here (an admin account, or the admin's own)."""


class NoStopper(RuntimeError):
    """This process has no lab to stop an instance with."""


@dataclass(frozen=True, slots=True)
class UserRow:
    user_id: str
    display_name: str
    email: str
    account_type: str
    status: str
    roles: tuple[str, ...]
    email_verified: bool
    created_at: datetime
    last_login_at: datetime | None


@dataclass(frozen=True, slots=True)
class SettingRow:
    name: str
    value: int | bool | str
    default: int | bool | str
    overridden: bool
    minimum: int | None
    maximum: int | None


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


class AdminOps:
    def __init__(self, *, sessions: sessionmaker[Session], roles: RoleService, companies: CompanyService, status: AccountStatusService, accounts: AccountService,
                 settings: Any, quotas: DbQuotaPort, audit: AuditPort, records: SqlAttemptRecords, deletion: DeletionService | None,
                 end_sessions: Callable[[str], object], stopper: Callable[[str], str] | None = None, host_status: Callable[[], Any] | None = None,
                 instance_states: Callable[[], Mapping[str, str]] | None = None, job_status: Callable[[], list[Any]] | None = None,
                 pseudonym: Callable[[str], str] | None = None, now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._sessions, self._roles, self._companies, self._status, self._accounts = sessions, roles, companies, status, accounts
        self._settings, self._quotas, self._audit, self._records, self._deletion = settings, quotas, audit, records, deletion
        self._end_sessions, self._stopper, self._host_status, self._instance_states = end_sessions, stopper, host_status, instance_states
        self._job_status, self._pseudonym, self._now = job_status, pseudonym, now

    def _admin(self, actor: Scope) -> str:
        return self._roles.require_admin(actor)

    # ---- the approval queue (FR-ADM-01) ----

    def queue(self, actor: Scope, limit: int = 100) -> list[PendingCompany]:
        """The companies waiting. The queue shows the owners' names and address domains, personal data, so the read is audited (FR-DSH-05, story P-30)."""
        admin_id = self._admin(actor)
        rows = self._companies.pending(actor, limit=limit)
        self._audit.append(actor=admin_id, action="admin.queue_read", subject=None, details={"count": len(rows)})
        return rows

    def decide_company(self, actor: Scope, org_id: str, decision: str, reason: str | None = None) -> None:
        """approve, reject (reason needed), suspend (reason needed) or reinstate (reason needed) a company. Raises NotFound, InvalidInput (`/reason`), and the company service's
        InvalidTransition when the company is not in a state the decision starts from."""
        from vulnmart.orgs.service import CompanyNotFound

        self._admin(actor)
        if decision not in COMPANY_ACTIONS:
            raise InvalidInput("/decision")
        if decision != "approve" and not reason:
            raise InvalidInput("/reason")
        try:
            if decision == "approve":
                self._companies.approve(actor, org_id)
            elif decision == "reject":
                self._companies.reject(actor, org_id, reason or "")
            elif decision == "suspend":
                self._companies.suspend(actor, org_id, reason or "")
            else:
                self._companies.reinstate(actor, org_id, reason or "")
        except CompanyNotFound:
            raise NotFound from None

    # ---- users (FR-ADM-02) ----

    def users(self, actor: Scope, *, query: str | None = None, status: str | None = None, limit: int = 50) -> list[UserRow]:
        admin_id = self._admin(actor)
        limit = max(1, min(limit, MAX_SEARCH))
        stmt = select(User).where(User.status != "deleted")
        if status is not None:
            stmt = stmt.where(User.status == status)
        if query:
            needle = query.strip().lower()[:80]
            like = "%" + needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            stmt = stmt.where(or_(func.lower(User.email_ci).like(like, escape="\\"), func.lower(User.display_name).like(like, escape="\\"), User.id == query.strip()))
        with self._sessions() as session:
            rows = session.scalars(stmt.order_by(User.created_at.desc(), User.id).limit(limit)).all()
            roles: dict[str, list[str]] = {}
            if rows:
                for uid, role in session.execute(select(UserRole.user_id, UserRole.role).where(UserRole.user_id.in_([r.id for r in rows]))):
                    roles.setdefault(uid, []).append(role)
            found = [UserRow(u.id, u.display_name, u.email, u.account_type, u.status, tuple(sorted(roles.get(u.id, ()))), u.email_verified_at is not None,
                             _aware(u.created_at), _aware(u.last_login_at)) for u in rows]
        # every admin read of personal data is itself logged (FR-DSH-05, story P-30): who and how many, never the search text (it may be an address)
        self._audit.append(actor=admin_id, action="admin.users_read", subject=None,
                           details={"count": len(found), "searched": bool(query), "status": status})
        return found

    def act_on_user(self, actor: Scope, user_id: str, action: str, reason: str | None = None) -> str:
        """lock, unlock, reset_password or delete. Returns the outcome word (`locked`, `unlocked`, `reset_sent`, `deleted`, `locked_instead` for an account that holds assessment data).
        Raises NotFound, NotAllowed (an admin account, or the admin's own), InvalidInput, InvalidAccountState."""
        admin_id = self._admin(actor)
        if action not in USER_ACTIONS:
            raise InvalidInput("/action")
        if not USER_ID.match(user_id):
            raise NotFound
        with self._sessions() as session:
            user = session.get(User, user_id)
            if user is None or user.status == "deleted":
                raise NotFound
            kind, email, status = user.account_type, user.email_ci, user.status
        if kind == "admin" or user_id == admin_id:
            raise NotAllowed
        if action in ("lock", "unlock", "delete") and not reason:
            raise InvalidInput("/reason")
        if action == "lock":
            self._status_call(self._status.suspend, actor, user_id, reason or "")
            return "locked"
        if action == "unlock":
            self._status_call(self._status.reinstate, actor, user_id, reason or "")
            return "unlocked"
        if action == "reset_password":
            if status != "active":
                raise InvalidAccountState(status)
            self._accounts.request_reset(email=email)
            self._audit.append(actor=admin_id, action="admin.user_reset_sent", subject=user_id, details={})
            return "reset_sent"
        clean_reason(reason or "")
        return self._delete_user(admin_id, user_id, kind)

    def _status_call(self, fn: Callable[..., None], actor: Scope, user_id: str, reason: str) -> None:
        try:
            fn(actor, user_id, reason)
        except UnknownUser:
            raise NotFound from None
        except NotAnAdmin:
            raise NotAllowed from None

    def _delete_user(self, admin_id: str, user_id: str, kind: str) -> str:
        if kind == "participant":
            if self._deletion is None:
                raise NoStopper("this process cannot delete an account's data")
            gone = self._deletion.delete_learner_account(user_id)
            if not gone:  # the account holds assessment data that is the company's to keep: it is locked, and goes with that data
                with self._sessions.begin() as session:
                    session.execute(update(User).where(User.id == user_id, User.status == "active").values(status="disabled"))
                self._end_sessions(user_id)
                self._audit.append(actor=admin_id, action="admin.user_deleted", subject=user_id, details={"outcome": "locked_instead"})
                return "locked_instead"
            self._audit.append(actor=admin_id, action="admin.user_deleted", subject=user_id, details={"outcome": "deleted"})
            return "deleted"
        with self._sessions.begin() as session:
            session.execute(update(User).where(User.id == user_id).values(status="deleted", deleted_at=self._now()))
            session.execute(update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None)).values(revoked_at=self._now()))
        self._audit.append(actor=admin_id, action="admin.user_deleted", subject=user_id, details={"outcome": "marked_deleted"})
        return "deleted"

    # ---- force-stop (FR-ADM-04) ----

    def force_stop(self, actor: Scope, attempt_id: str) -> str:
        """Destroy the attempt's instance whatever its state; audit it; mail the owner. Returns the instance id that was stopped ('' when there was none). Raises NotFound, NoStopper."""
        admin_id = self._admin(actor)
        if not ATTEMPT_ID.match(attempt_id):
            raise NotFound
        info = self._records.get(attempt_id)
        if info is None:
            raise NotFound
        if self._stopper is None:
            raise NoStopper("this process has no lab to stop an instance with")
        instance_id = self._stopper(attempt_id)
        self._audit.append(actor=admin_id, action="admin.instance_force_stopped", subject=info.user_id,
                           details={"attempt": attempt_id, "org": info.org_id, "had_instance": bool(instance_id)})
        with self._sessions.begin() as session:
            DbOutboxPort(lambda: session, None, now=self._now, validator=validate_params).enqueue_email(template="instance.force_stopped", to_user_id=info.user_id, params={})
        return instance_id

    # ---- settings (FR-ADM-05) ----

    def settings(self, actor: Scope) -> list[SettingRow]:
        self._admin(actor)
        overrides = self._settings.overrides()
        rows = []
        for name, default in sorted(SETTINGS.items()):
            low, high = self._range(name, default)
            value = overrides[name][0] if name in overrides else self._settings.get(name)
            rows.append(SettingRow(name, value, default, name in overrides, low, high))
        return rows

    @staticmethod
    def _range(name: str, default: Any) -> tuple[int | None, int | None]:
        if type(default) is not int:
            return None, None
        return RANGES.get(name, GENERIC_RANGE)

    def set_setting(self, actor: Scope, name: str, value: Any) -> SettingRow:
        """Raises NotFound (a name outside the list), InvalidInput (`/value`: wrong type or outside the range)."""
        admin_id = self._admin(actor)
        if name not in SETTINGS:
            raise NotFound
        default = SETTINGS[name]
        if type(value) is not type(default):
            raise InvalidInput("/value")
        if type(default) is int:
            low, high = RANGES.get(name, GENERIC_RANGE)
            if not low <= value <= high:
                raise InvalidInput("/value", "range")
        elif type(default) is str and not 1 <= len(value) <= MAX_TEXT_SETTING:
            raise InvalidInput("/value")
        old = self._settings.get(name)
        self._settings.set(name, value, updated_by=self._pseudonym(admin_id) if self._pseudonym else None)
        self._audit.append(actor=admin_id, action="admin.setting_changed", subject=None, details={"name": name, "old": old, "new": value})
        low, high = self._range(name, default)
        return SettingRow(name, value, default, True, low, high)

    def reset_setting(self, actor: Scope, name: str) -> SettingRow:
        admin_id = self._admin(actor)
        if name not in SETTINGS:
            raise NotFound
        old = self._settings.get(name)
        had = self._settings.clear(name)
        self._audit.append(actor=admin_id, action="admin.setting_reset", subject=None, details={"name": name, "old": old, "had_override": had})
        low, high = self._range(name, SETTINGS[name])
        return SettingRow(name, SETTINGS[name], SETTINGS[name], False, low, high)

    # ---- quotas (FR-ADM-05) ----

    def quotas(self, actor: Scope) -> list[QuotaRow]:
        self._admin(actor)
        return self._quotas.rows()

    @staticmethod
    def _check_quota_target(scope: str, scope_id: str | None) -> str | None:
        """The id as the lab looks it up: a company id in lower case (the session carries it so; an upper-case row would never be read)."""
        if scope not in SCOPES:
            raise InvalidInput("/scope")
        if scope == "global":
            if scope_id is not None:
                raise InvalidInput("/scope_id")
        elif scope == "user":
            if scope_id is None or not USER_ID.match(scope_id):
                raise InvalidInput("/scope_id")
        else:
            try:
                if scope_id is None or str(uuid.UUID(scope_id)) != scope_id.lower():
                    raise ValueError
            except ValueError:
                raise InvalidInput("/scope_id") from None
            return scope_id.lower()
        return scope_id

    def set_quota(self, actor: Scope, scope: str, scope_id: str | None, max_instances: Any) -> QuotaRow:
        admin_id = self._admin(actor)
        scope_id = self._check_quota_target(scope, scope_id)
        if type(max_instances) is not int or not 0 <= max_instances <= MAX_QUOTA:
            raise InvalidInput("/max_instances", "range")
        old = next((r.max_instances for r in self._quotas.rows() if r.scope == scope and r.scope_id == scope_id), None)
        self._quotas.set(scope, scope_id, max_instances)
        self._audit.append(actor=admin_id, action="admin.quota_changed", subject=None, details={"scope": scope, "scope_id": scope_id, "old": old, "new": max_instances})
        return QuotaRow(scope, scope_id, max_instances)

    def remove_quota(self, actor: Scope, scope: str, scope_id: str | None) -> None:
        admin_id = self._admin(actor)
        scope_id = self._check_quota_target(scope, scope_id)
        if not self._quotas.remove(scope, scope_id):
            raise NotFound
        self._audit.append(actor=admin_id, action="admin.quota_removed", subject=None, details={"scope": scope, "scope_id": scope_id})

    # ---- capacity (FR-ADM-06) and the jobs (FR-PRV-18) ----

    def capacity(self, actor: Scope) -> dict[str, Any]:
        self._admin(actor)
        host = self._host_status() if self._host_status else None
        states = dict(self._instance_states()) if self._instance_states else {}
        with self._sessions() as session:
            waiting = session.scalar(select(func.count()).select_from(EmailOutbox).where(EmailOutbox.state == "pending")) or 0
            failed_mail = session.scalar(select(func.count()).select_from(EmailOutbox).where(EmailOutbox.state == "failed")) or 0
            unpublished = session.scalar(select(func.count()).select_from(DomainEvent).where(DomainEvent.published_at.is_(None))) or 0
        jobs = self._job_status() if self._job_status else []
        running = sum(1 for s in states.values() if s in ("ready", "active", "idle", "starting", "provisioning", "running"))
        return {
            "instances": {"running": host.instances if host is not None else running, "reported": len(states), "failed": sum(1 for s in states.values() if s == "failed")},
            "memory": None if host is None else {"capacity_mb": host.capacity_memory_mb, "used_mb": host.used_memory_mb, "health": getattr(host.health, "value", str(host.health))},
            "queue": {"emails_waiting": waiting, "events_unpublished": unpublished},
            "failures": {"emails_failed": failed_mail, "jobs_failed": sum(1 for j in jobs if j.last_status == "failed"), "instances_failed": sum(1 for s in states.values() if s == "failed")},
        }

    def jobs(self, actor: Scope) -> list[Any]:
        self._admin(actor)
        return self._job_status() if self._job_status else []
