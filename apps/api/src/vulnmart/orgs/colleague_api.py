"""The company owner's routes for colleagues (FR-ORG-03): who asked to join, the decision, the members, removing a member.

Only the company's owner (`requires(Role.ORG_OWNER)`) reaches them: a recruiter who is not the owner, a learner or an admin is answered 404 REQ-ROUTE-UNKNOWN, as for a route
that does not exist. `CompanyService` takes the owner's user id and works only inside the owner's own company, so a request id or a member id of another company is
404 ATT-NOT-FOUND (not yours is not found). A decision on a request that was decided already, a company that is not active, and removing the owner are 409 ATT-INVALID-STATE.
No new error code (ADR 0073). There is no role change: a member is a member and the one owner stays the owner (the service has no such step and no requirement asks for it).
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import JSONResponse, Response
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import Authenticated, Strict, read_json, requires, timestamp
from vulnmart.kernel.service import NO_STORE
from vulnmart.ports.scope import Role
from vulnmart.problem import ProblemError

from .service import CompanyNotFound, CompanyService, InvalidTransition, NotARecruiter, NotTheOwner

router = APIRouter(tags=["company"])

owner_read = requires(Role.ORG_OWNER)
owner_write = requires(Role.ORG_OWNER, csrf=True)

JOIN_REQUEST_ID = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
USER_ID = r"^u-[A-Z2-7]{16}$"


class JoinDecisionBody(Strict):
    decision: Literal["approve", "reject"]


def companies_of(request: Request) -> CompanyService:
    companies = getattr(request.app.state, "companies", None)
    if companies is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return companies


async def run(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return await asyncio.to_thread(lambda: fn(*args))
    except CompanyNotFound:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except (NotTheOwner, NotARecruiter):
        raise ProblemError(ErrorCode.REQ_ROUTE_UNKNOWN) from None
    except InvalidTransition:
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None


@router.get("/api/v1/company/join-requests", operation_id="listJoinRequests")
async def list_join_requests(request: Request, auth: Authenticated = Depends(owner_read)) -> JSONResponse:
    rows = await run(companies_of(request).join_requests, auth.session.user.id)
    return JSONResponse({"items": [{"request_id": r.request_id, "display_name": r.display_name, "requested_at": timestamp(r.requested_at)} for r in rows]}, headers=NO_STORE)


@router.post("/api/v1/company/join-requests/{request_id}/decision", operation_id="decideJoinRequest", status_code=204)
async def decide_join_request(request: Request, request_id: Annotated[str, Path(pattern=JOIN_REQUEST_ID)], auth: Authenticated = Depends(owner_write)) -> Response:
    body = await read_json(request, JoinDecisionBody)
    service = companies_of(request)
    await run(service.approve_join if body.decision == "approve" else service.reject_join, auth.session.user.id, request_id.lower())
    return Response(status_code=204, headers=NO_STORE)


@router.get("/api/v1/company/members", operation_id="listCompanyMembers")
async def list_members(request: Request, auth: Authenticated = Depends(owner_read)) -> JSONResponse:
    rows = await run(companies_of(request).members, auth.session.user.id)
    return JSONResponse({"items": [{"user_id": m.user_id, "display_name": m.display_name, "role": m.role} for m in rows]}, headers=NO_STORE)


@router.delete("/api/v1/company/members/{user_id}", operation_id="removeCompanyMember", status_code=204)
async def remove_member(request: Request, user_id: Annotated[str, Path(pattern=USER_ID)], auth: Authenticated = Depends(owner_write)) -> Response:
    await run(companies_of(request).remove_member, auth.session.user.id, user_id)
    return Response(status_code=204, headers=NO_STORE)
