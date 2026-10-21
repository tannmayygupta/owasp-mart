"""The admin routes of IF-1 (story P-28, FR-ADM-01, 02, 04, 05, 06, FR-PRV-18): the approval queue, the company list, user management, force-stop, settings, quotas, capacity and the scheduler's last runs.

Every route needs an admin session (`requires(Role.ADMIN)`); a caller who is not an admin is answered 404 REQ-ROUTE-UNKNOWN, the same as for a route that does not exist, so the answer
does not even say the route is there. The routes that change state also need the CSRF header and the Origin check. Every change is audited by `AdminOps`; no route here reads
anything a candidate wrote (FR-ADM-08). A company, user, attempt, setting or quota that does not exist is the same 404; a change that does not start from the state it is
asked for (a company already decided, an account not active) is 409 ATT-INVALID-STATE (the registry has no admin codes, ADR 0057); a value outside its range is 422.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import Authenticated, Strict, invalid, read_json, requires, timestamp
from vulnmart.accounts.roles import NotAnAdmin
from vulnmart.accounts.service import InvalidInput
from vulnmart.accounts.status import InvalidAccountState
from vulnmart.kernel.service import NO_STORE
from vulnmart.orgs.service import InvalidTransition
from vulnmart.ports.scope import Role
from vulnmart.problem import ProblemError

from .breakglass import BreakGlassService, SessionNotFound, SessionState, SessionView
from .ops import AdminOps, NoStopper, NotAllowed, NotFound, SettingRow

router = APIRouter(tags=["admin"])

admin_read = requires(Role.ADMIN)
admin_write = requires(Role.ADMIN, csrf=True)

ORG_ID = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
USER_ID = r"^u-[A-Z2-7]{16}$"
ATTEMPT_ID = r"^a-[A-Z2-7]{16}$"
SETTING_NAME = r"^[a-z][a-z0-9_]{0,63}$"


class CompanyDecisionBody(Strict):
    decision: Literal["approve", "reject", "suspend", "reinstate", "delete"]
    reason: str | None = Field(default=None, min_length=1, max_length=500)


class InviteCapBody(Strict):
    invite_cap: int | None = Field(ge=0, le=100_000)  # null: back to the global setting


class UserActionBody(Strict):
    action: Literal["lock", "unlock", "reset_password", "delete"]
    reason: str | None = Field(default=None, min_length=1, max_length=500)


class SettingBody(Strict):
    value: int | bool | str


class QuotaBody(Strict):
    scope: Literal["user", "org", "global"]
    scope_id: str | None = Field(default=None, max_length=64)
    max_instances: int = Field(ge=0, le=10000)


def ops_of(request: Request) -> AdminOps:
    ops = getattr(request.app.state, "admin_ops", None)
    if ops is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return ops


async def run(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run a service call off the event loop and turn its refusals into the contract's answers."""
    try:
        return await asyncio.to_thread(lambda: fn(*args, **kwargs))
    except (NotFound, NotAnAdmin, SessionNotFound):
        raise ProblemError(ErrorCode.REQ_ROUTE_UNKNOWN) from None
    except (NotAllowed, InvalidAccountState, InvalidTransition, SessionState):
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    except InvalidInput as exc:
        raise invalid(exc) from None
    except NoStopper:
        raise ProblemError(ErrorCode.REQ_INTERNAL) from None


def company_body(r: Any) -> dict[str, Any]:
    return {"org_id": r.org_id, "name": r.name, "status": r.status, "owner_name": r.owner_name, "owner_email_domain": r.owner_email_domain, "created_at": timestamp(r.created_at),
            "members": r.members, "invite_cap": r.invite_cap, "invite_cap_override": r.invite_cap_override}


def setting_body(row: SettingRow) -> dict[str, Any]:
    return {"name": row.name, "value": row.value, "default": row.default, "overridden": row.overridden, "minimum": row.minimum, "maximum": row.maximum}


def quota_body(row: Any) -> dict[str, Any]:
    return {"scope": row.scope, "scope_id": row.scope_id, "max_instances": row.max_instances}


# ---- the approval queue ----

@router.get("/api/v1/admin/companies/pending", operation_id="listPendingCompanies")
async def list_pending_companies(request: Request, auth: Authenticated = Depends(admin_read), limit: Annotated[int, Query(ge=1, le=100)] = 50) -> JSONResponse:
    rows = await run(ops_of(request).queue, auth.session.scope, limit)
    return JSONResponse({"items": [{"org_id": r.org_id, "name": r.name, "owner_name": r.owner_name, "owner_email_domain": r.owner_email_domain,
                                    "applied_at": timestamp(r.applied_at)} for r in rows]}, headers=NO_STORE)


@router.post("/api/v1/admin/companies/{org_id}/decision", operation_id="decideCompany", status_code=204)
async def decide_company(request: Request, org_id: Annotated[str, Path(pattern=ORG_ID)], auth: Authenticated = Depends(admin_write)) -> Response:
    body = await read_json(request, CompanyDecisionBody)
    await run(ops_of(request).decide_company, auth.session.scope, org_id.lower(), body.decision, body.reason)
    return Response(status_code=204, headers=NO_STORE)


@router.get("/api/v1/admin/companies", operation_id="listCompanies")
async def list_companies(request: Request, auth: Authenticated = Depends(admin_read), status: Annotated[Literal["pending", "active", "rejected", "suspended", "deleted"] | None, Query()] = None,
                         limit: Annotated[int, Query(ge=1, le=100)] = 50) -> JSONResponse:
    rows = await run(ops_of(request).companies, auth.session.scope, status=status, limit=limit)
    return JSONResponse({"items": [company_body(r) for r in rows]}, headers=NO_STORE)


@router.get("/api/v1/admin/attempts", operation_id="listOpenAttempts")
async def list_open_attempts(request: Request, auth: Authenticated = Depends(admin_read), kind: Annotated[Literal["all", "waiting", "failing"], Query()] = "all",
                             limit: Annotated[int, Query(ge=1, le=100)] = 50) -> JSONResponse:
    """A-27: the open attempts with the ones that wait or fail to start marked (ids, states and instants only; no name and no result)."""
    rows = await run(ops_of(request).open_attempts, auth.session.scope, kind=kind, limit=limit)
    return JSONResponse({"items": [{"attempt_id": r.attempt_id, "mode": r.mode, "state": r.state, "created_at": timestamp(r.created_at), "deadline_at": r.deadline_at,
                                    "instance_id": r.instance_id, "instance_state": r.instance_state, "issue": r.issue} for r in rows]}, headers=NO_STORE)


@router.put("/api/v1/admin/companies/{org_id}/invite-cap", operation_id="setCompanyInviteCap")
async def set_company_invite_cap(request: Request, org_id: Annotated[str, Path(pattern=ORG_ID)], auth: Authenticated = Depends(admin_write)) -> JSONResponse:
    body = await read_json(request, InviteCapBody)
    row = await run(ops_of(request).set_company_invite_cap, auth.session.scope, org_id.lower(), body.invite_cap)
    return JSONResponse(company_body(row), headers=NO_STORE)


# ---- users ----

@router.get("/api/v1/admin/users", operation_id="listUsers")
async def list_users(request: Request, auth: Authenticated = Depends(admin_read), q: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
                     status: Annotated[Literal["active", "disabled"] | None, Query()] = None, limit: Annotated[int, Query(ge=1, le=100)] = 50) -> JSONResponse:
    rows = await run(ops_of(request).users, auth.session.scope, query=q, status=status, limit=limit)
    return JSONResponse({"items": [{"user_id": u.user_id, "display_name": u.display_name, "email": u.email, "account_type": u.account_type, "status": u.status,
                                    "roles": list(u.roles), "email_verified": u.email_verified, "created_at": timestamp(u.created_at),
                                    "last_login_at": None if u.last_login_at is None else timestamp(u.last_login_at)} for u in rows]}, headers=NO_STORE)


@router.post("/api/v1/admin/users/{user_id}/actions", operation_id="actOnUser")
async def act_on_user(request: Request, user_id: Annotated[str, Path(pattern=USER_ID)], auth: Authenticated = Depends(admin_write)) -> JSONResponse:
    body = await read_json(request, UserActionBody)
    outcome = await run(ops_of(request).act_on_user, auth.session.scope, user_id, body.action, body.reason)
    return JSONResponse({"outcome": outcome}, headers=NO_STORE)


# ---- force-stop ----

@router.post("/api/v1/admin/attempts/{attempt_id}/force-stop", operation_id="forceStopInstance")
async def force_stop(request: Request, attempt_id: Annotated[str, Path(pattern=ATTEMPT_ID)], auth: Authenticated = Depends(admin_write)) -> JSONResponse:
    instance_id = await run(ops_of(request).force_stop, auth.session.scope, attempt_id)
    return JSONResponse({"attempt_id": attempt_id, "instance_stopped": bool(instance_id)}, headers=NO_STORE)


# ---- settings and quotas ----

@router.get("/api/v1/admin/settings", operation_id="listSettings")
async def list_settings(request: Request, auth: Authenticated = Depends(admin_read)) -> JSONResponse:
    rows = await run(ops_of(request).settings, auth.session.scope)
    return JSONResponse({"items": [setting_body(r) for r in rows]}, headers=NO_STORE)


@router.put("/api/v1/admin/settings/{name}", operation_id="updateSetting")
async def update_setting(request: Request, name: Annotated[str, Path(pattern=SETTING_NAME)], auth: Authenticated = Depends(admin_write)) -> JSONResponse:
    body = await read_json(request, SettingBody)
    row = await run(ops_of(request).set_setting, auth.session.scope, name, body.value)
    return JSONResponse(setting_body(row), headers=NO_STORE)


@router.delete("/api/v1/admin/settings/{name}", operation_id="resetSetting")
async def reset_setting(request: Request, name: Annotated[str, Path(pattern=SETTING_NAME)], auth: Authenticated = Depends(admin_write)) -> JSONResponse:
    row = await run(ops_of(request).reset_setting, auth.session.scope, name)
    return JSONResponse(setting_body(row), headers=NO_STORE)


@router.get("/api/v1/admin/quotas", operation_id="listQuotas")
async def list_quotas(request: Request, auth: Authenticated = Depends(admin_read)) -> JSONResponse:
    rows = await run(ops_of(request).quotas, auth.session.scope)
    return JSONResponse({"items": [quota_body(r) for r in rows]}, headers=NO_STORE)


@router.put("/api/v1/admin/quotas", operation_id="setQuota")
async def set_quota(request: Request, auth: Authenticated = Depends(admin_write)) -> JSONResponse:
    body = await read_json(request, QuotaBody)
    row = await run(ops_of(request).set_quota, auth.session.scope, body.scope, body.scope_id, body.max_instances)
    return JSONResponse(quota_body(row), headers=NO_STORE)


@router.delete("/api/v1/admin/quotas", operation_id="removeQuota", status_code=204)
async def remove_quota(request: Request, auth: Authenticated = Depends(admin_write), scope: Annotated[Literal["user", "org", "global"], Query()] = "global",
                       scope_id: Annotated[str | None, Query(max_length=64)] = None) -> Response:
    await run(ops_of(request).remove_quota, auth.session.scope, scope, scope_id)
    return Response(status_code=204, headers=NO_STORE)


# ---- capacity and jobs ----

@router.get("/api/v1/admin/capacity", operation_id="getCapacity")
async def get_capacity(request: Request, auth: Authenticated = Depends(admin_read)) -> JSONResponse:
    return JSONResponse(await run(ops_of(request).capacity, auth.session.scope), headers=NO_STORE)


@router.get("/api/v1/admin/jobs", operation_id="listJobs")
async def list_jobs(request: Request, auth: Authenticated = Depends(admin_read)) -> JSONResponse:
    rows = await run(ops_of(request).jobs, auth.session.scope)

    def when(moment: Any) -> str | None:
        return None if moment is None else timestamp(moment)

    return JSONResponse({"items": [{"name": j.name, "interval_seconds": int(j.interval.total_seconds()), "last_started_at": when(j.last_started_at),
                                    "last_finished_at": when(j.last_finished_at), "last_status": j.last_status, "last_detail": j.last_detail,
                                    "last_success_at": when(j.last_success_at), "next_due_at": when(j.next_due_at)} for j in rows]}, headers=NO_STORE)


# ---- the audit log and break-glass (story P-31, FR-ADM-03, FR-ADM-07, FR-ADM-08) ----

SESSION_ID = r"^g-[A-Z2-7]{16}$"


class BreakGlassBody(Strict):
    attempt_id: str = Field(pattern=ATTEMPT_ID)
    reason: str = Field(min_length=20, max_length=500)  # the same bounds as the service and the contract (BreakGlassRequest)


class ReviewBody(Strict):
    note: str = Field(min_length=1, max_length=2000)


def glass_of(request: Request) -> BreakGlassService:
    service = getattr(request.app.state, "break_glass", None)
    if service is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service


def session_body(v: SessionView) -> dict[str, Any]:
    def when(moment: Any) -> str | None:
        return None if moment is None else timestamp(moment)

    return {"session_id": v.session_id, "admin_id": v.admin_id, "admin_name": v.admin_name, "attempt_id": v.attempt_id, "org_id": v.org_id, "reason": v.reason,
            "started_at": timestamp(v.started_at), "expires_at": timestamp(v.expires_at), "closed_at": when(v.closed_at), "reads": list(v.reads),
            "reviewed_by": v.reviewed_by, "reviewed_at": when(v.reviewed_at), "review_note": v.review_note, "state": v.state}


@router.get("/api/v1/admin/audit", operation_id="listAuditLog")
async def list_audit_log(request: Request, auth: Authenticated = Depends(admin_read), action: Annotated[str | None, Query(pattern=r"^[a-z_]+(\.[a-z_]+)*$", max_length=64)] = None,
                         after_seq: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=200)] = 100) -> JSONResponse:
    rows = await run(glass_of(request).audit_entries, auth.session.scope, action=action, after_seq=after_seq, limit=limit)
    items = [{"seq": r.seq, "at": r.at, "actor": r.actor, "action": r.action, "subject": r.subject, "details": dict(r.details)} for r in rows]
    return JSONResponse({"items": items, "next_after_seq": items[-1]["seq"] if len(items) == limit else None}, headers=NO_STORE)


@router.get("/api/v1/admin/break-glass", operation_id="listBreakGlassSessions")
async def list_break_glass(request: Request, auth: Authenticated = Depends(admin_read), limit: Annotated[int, Query(ge=1, le=100)] = 50) -> JSONResponse:
    rows = await run(glass_of(request).sessions, auth.session.scope, limit)
    return JSONResponse({"items": [session_body(v) for v in rows]}, headers=NO_STORE)


@router.post("/api/v1/admin/break-glass", operation_id="openBreakGlass", status_code=201)
async def open_break_glass(request: Request, auth: Authenticated = Depends(admin_write)) -> JSONResponse:
    body = await read_json(request, BreakGlassBody)
    view = await run(glass_of(request).open, auth.session.scope, body.attempt_id, body.reason)
    return JSONResponse(session_body(view), status_code=201, headers=NO_STORE)


@router.get("/api/v1/admin/break-glass/{session_id}/attempt", operation_id="readBreakGlassAttempt")
async def read_break_glass(request: Request, session_id: Annotated[str, Path(pattern=SESSION_ID)], auth: Authenticated = Depends(admin_read)) -> JSONResponse:
    return JSONResponse(await run(glass_of(request).read, auth.session.scope, session_id), headers=NO_STORE)


@router.post("/api/v1/admin/break-glass/{session_id}/close", operation_id="closeBreakGlass")
async def close_break_glass(request: Request, session_id: Annotated[str, Path(pattern=SESSION_ID)], auth: Authenticated = Depends(admin_write)) -> JSONResponse:
    return JSONResponse(session_body(await run(glass_of(request).close, auth.session.scope, session_id)), headers=NO_STORE)


@router.post("/api/v1/admin/break-glass/{session_id}/review", operation_id="reviewBreakGlass")
async def review_break_glass(request: Request, session_id: Annotated[str, Path(pattern=SESSION_ID)], auth: Authenticated = Depends(admin_write)) -> JSONResponse:
    body = await read_json(request, ReviewBody)
    return JSONResponse(session_body(await run(glass_of(request).review, auth.session.scope, session_id, body.note)), headers=NO_STORE)
