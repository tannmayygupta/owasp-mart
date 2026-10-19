"""The deletion and view-history routes of IF-1: createDeletionRequest, listMyDeletionRequests, cancelDeletionRequest, listMyDataViews (story P-25, FR-PRV-08, 09, 11).

Every route needs a session and acts only on the caller's own requests and history; a request id that is not the caller's is 404 ATT-NOT-FOUND (not yours is not found). A second open
request, a request that is not open any more and a candidate request for an attempt that is not over are 409 ATT-INVALID-STATE (the registry has no deletion codes yet, ADR 0055). The
company's side (the decision, the direct deletion) has no routes yet: it comes with the recruiter routes of story 5.3.
"""
from __future__ import annotations

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field, model_validator
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import Authenticated, Strict, authenticated, authenticated_with_csrf, limit, read_json, services, timestamp
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .deletion import DeletionExists, DeletionNotFound, DeletionService, DeletionState, NotLearner, RequestView
from .views import ViewHistory

router = APIRouter(tags=["privacy"])

ATTEMPT_ID = r"^a-[A-Z2-7]{16}$"
REQUEST_ID = r"^d-[A-Z2-7]{16}$"


class DeletionBody(Strict):
    kind: Literal["learner", "candidate"]
    attempt_id: str | None = Field(default=None, pattern=ATTEMPT_ID)

    @model_validator(mode="after")
    def _target(self):
        if (self.kind == "candidate") != (self.attempt_id is not None):
            raise ValueError("a candidate request names an attempt, a learner request does not")
        return self


def deletion_service(request: Request) -> DeletionService:
    service = getattr(request.app.state, "deletion_service", None)
    if service is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service


def view_history(request: Request) -> ViewHistory:
    history = getattr(request.app.state, "view_history", None)
    if history is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return history


def request_body(view: RequestView) -> dict[str, object]:
    return {"request_id": view.request_id, "kind": view.kind, "status": view.status, "requested_at": timestamp(view.requested_at), "attempt_id": view.attempt_id,
            "company_name": view.company_name, "decide_by": None if view.decide_by is None else timestamp(view.decide_by),
            "decided_at": None if view.decided_at is None else timestamp(view.decided_at),
            "execute_after": None if view.execute_after is None else timestamp(view.execute_after),
            "finished_at": None if view.finished_at is None else timestamp(view.finished_at), "can_undo": view.can_undo}


@router.post("/api/v1/me/deletion-requests", operation_id="createDeletionRequest", status_code=201)
async def create_request(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    service = deletion_service(request)
    _, limiter = services(request)
    user_id = auth.session.user.id
    limit(request, limiter, "deletion:user", user_id, "rate_deletion_per_user_per_day")
    body = await read_json(request, DeletionBody)
    try:
        if body.kind == "learner":
            view = await asyncio.to_thread(service.request_learner, user_id)
        else:
            view = await asyncio.to_thread(service.request_candidate, user_id, body.attempt_id or "")
    except DeletionNotFound:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except (DeletionExists, DeletionState, NotLearner):
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    return JSONResponse(request_body(view), status_code=201, headers=NO_STORE)


@router.get("/api/v1/me/deletion-requests", operation_id="listMyDeletionRequests")
async def list_requests(request: Request, auth: Authenticated = Depends(authenticated), limit_: Annotated[int, Query(alias="limit", ge=1, le=100)] = 50) -> JSONResponse:
    service = deletion_service(request)
    items = await asyncio.to_thread(service.mine, auth.session.user.id, limit_)
    return JSONResponse({"items": [request_body(v) for v in items]}, headers=NO_STORE)


@router.delete("/api/v1/me/deletion-requests/{request_id}", operation_id="cancelDeletionRequest")
async def cancel_request(request: Request, request_id: Annotated[str, Path(pattern=REQUEST_ID)], auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    service = deletion_service(request)
    _, limiter = services(request)
    user_id = auth.session.user.id
    limit(request, limiter, "deletion:user", user_id, "rate_deletion_per_user_per_day")
    try:
        view = await asyncio.to_thread(service.cancel, user_id, request_id)
    except DeletionNotFound:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except DeletionState:
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    return JSONResponse(request_body(view), headers=NO_STORE)


@router.get("/api/v1/me/data-views", operation_id="listMyDataViews")
async def list_views(request: Request, auth: Authenticated = Depends(authenticated), limit_: Annotated[int, Query(alias="limit", ge=1, le=100)] = 50) -> JSONResponse:
    history = view_history(request)
    items, has_more = await asyncio.to_thread(history.list_mine, auth.session.user.id, limit_)
    return JSONResponse({"items": [{"company_name": e.company_name, "action": e.action, "at": timestamp(e.at)} for e in items], "has_more": has_more}, headers=NO_STORE)
