"""The admin routes of IF-1 (story P-28, FR-ADM-01, 02, 04, 05, 06, FR-PRV-18): the approval queue, user management, force-stop, settings, quotas, capacity and the scheduler's last runs.

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

from .ops import AdminOps, NoStopper, NotAllowed, NotFound, SettingRow

router = APIRouter(tags=["admin"])

admin_read = requires(Role.ADMIN)
admin_write = requires(Role.ADMIN, csrf=True)

ORG_ID = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
USER_ID = r"^u-[A-Z2-7]{16}$"
ATTEMPT_ID = r"^a-[A-Z2-7]{16}$"
SETTING_NAME = r"^[a-z][a-z0-9_]{0,63}$"


class CompanyDecisionBody(Strict):
    decision: Literal["approve", "reject", "suspend", "reinstate"]
    reason: str | None = Field(default=None, min_length=1, max_length=500)


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
    except (NotFound, NotAnAdmin):
        raise ProblemError(ErrorCode.REQ_ROUTE_UNKNOWN) from None
    except (NotAllowed, InvalidAccountState, InvalidTransition):
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    except InvalidInput as exc:
        raise invalid(exc) from None
    except NoStopper:
        raise ProblemError(ErrorCode.REQ_INTERNAL) from None


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
