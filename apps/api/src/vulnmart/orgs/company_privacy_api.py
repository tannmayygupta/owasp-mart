"""The company's side of candidate deletion requests (FR-PRV-08, FR-PRV-09) and the private cohort view (FR-SCR-07, FR-SCR-08, D-93).

Every route needs a recruiter's session (`requires(Role.RECRUITER)`; a learner or an admin is answered 404 REQ-ROUTE-UNKNOWN) and acts only on the recruiter's own company: the
company is the one the account is an active recruiter of (`CompanyService.active_company_of`, so a suspended or deleted company is refused), and it must be the company in the
session's scope. A request, attempt or template of another company is 404 ATT-NOT-FOUND (not yours is not found), exactly as for one that does not exist. A request that was
decided already is 409 ATT-INVALID-STATE, so is a cohort board that the assessment keeps off. No new error code (ADR 0073).

- `listCompanyDeletionRequests`: the candidates' requests for this company, oldest first, with the deadline and whether it was escalated to the admins (the company did not decide
  in time). The candidate's address is the company's own invite data, joined here from the invite of the attempt.
- `decideDeletionRequest`: approve (the 7-day hold starts, the candidate is told) or decline (the candidate is told).
- `deleteCandidateRecord`: the company deletes a candidate's record now, no request needed (FR-PRV-08); an open request for it is settled.
- `getCohort`: the ranking aid for one template, ids only, off unless the template turns it on.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import JSONResponse
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import Authenticated, Strict, limit, read_json, requires, services, timestamp
from vulnmart.assessments.service import TemplateNotFound
from vulnmart.kernel.service import NO_STORE
from vulnmart.ports.engine_cohort import CohortDisabled, CohortForbidden
from vulnmart.ports.scope import Role
from vulnmart.privacy.deletion import DeletionNotFound, DeletionState
from vulnmart.privacy.retention.candidates import NoEraser
from vulnmart.problem import ProblemError

from .company_api import TEMPLATE_ID, parts
from .service import CompanyNotFound, NotActiveRecruiter, NotARecruiter

router = APIRouter(tags=["company"])

recruiter_read = requires(Role.RECRUITER)
recruiter_write = requires(Role.RECRUITER, csrf=True)

REQUEST_ID = r"^d-[A-Z2-7]{16}$"
ATTEMPT_ID_PATTERN = r"^a-[A-Z2-7]{16}$"


class DeletionDecisionBody(Strict):
    decision: Literal["approve", "decline"]


def deletion_of(request: Request):
    service = getattr(request.app.state, "deletion_service", None)
    if service is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service


async def my_org(request: Request, auth: Authenticated) -> str:
    """The company of the caller, checked against the database and the session's scope."""
    companies, _ = parts(request)
    try:
        org = await asyncio.to_thread(companies.active_company_of, auth.session.user.id)
    except (NotActiveRecruiter, CompanyNotFound):
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    except NotARecruiter:
        raise ProblemError(ErrorCode.REQ_ROUTE_UNKNOWN) from None
    if auth.session.scope.org_id is None or str(auth.session.scope.org_id) != org:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND)
    return org


async def run(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        return await asyncio.to_thread(lambda: fn(*args, **kwargs))
    except (DeletionNotFound, TemplateNotFound, CompanyNotFound):
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except (DeletionState, CohortDisabled):
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    except CohortForbidden:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except NoEraser:
        raise ProblemError(ErrorCode.REQ_INTERNAL) from None


def request_body(r: Any, email: str | None) -> dict[str, Any]:
    def when(value: Any) -> str | None:
        return None if value is None else timestamp(value)

    return {"request_id": r.request_id, "attempt_id": r.attempt_id, "candidate_email": email, "status": r.status, "requested_at": timestamp(r.requested_at),
            "decide_by": when(r.decide_by), "execute_after": when(r.execute_after), "escalated": r.escalated}


async def emails_by_attempt(request: Request, auth: Authenticated) -> dict[str, str]:
    _, assessments = parts(request)
    invites = await asyncio.to_thread(lambda: assessments.list_invites(auth.session.scope, limit=500))
    return {i.attempt_id: i.email for i in invites if i.attempt_id}


@router.get("/api/v1/company/deletion-requests", operation_id="listCompanyDeletionRequests")
async def list_requests(request: Request, auth: Authenticated = Depends(recruiter_read), open_only: Annotated[bool, Query()] = True) -> JSONResponse:
    org = await my_org(request, auth)
    rows = await run(deletion_of(request).for_company, org, open_only=open_only, limit=100)
    emails = await emails_by_attempt(request, auth)
    return JSONResponse({"items": [request_body(r, emails.get(r.attempt_id)) for r in rows]}, headers=NO_STORE)


@router.post("/api/v1/company/deletion-requests/{request_id}/decision", operation_id="decideDeletionRequest")
async def decide_request(request: Request, request_id: Annotated[str, Path(pattern=REQUEST_ID)], auth: Authenticated = Depends(recruiter_write)) -> JSONResponse:
    org = await my_org(request, auth)
    _, limiter = services(request)
    limit(request, limiter, "deletion-decide:user", auth.session.user.id, "rate_deletion_per_user_per_day")
    body = await read_json(request, DeletionDecisionBody)
    out = await run(deletion_of(request).decide, org, request_id, approve=body.decision == "approve", actor_id=auth.session.user.id)
    emails = await emails_by_attempt(request, auth)
    return JSONResponse(request_body(out, emails.get(out.attempt_id)), headers=NO_STORE)


@router.delete("/api/v1/company/attempts/{attempt_id}", operation_id="deleteCandidateRecord")
async def delete_record(request: Request, attempt_id: Annotated[str, Path(pattern=ATTEMPT_ID_PATTERN)], auth: Authenticated = Depends(recruiter_write)) -> JSONResponse:
    org = await my_org(request, auth)
    _, limiter = services(request)
    limit(request, limiter, "deletion-decide:user", auth.session.user.id, "rate_deletion_per_user_per_day")
    erased = await run(deletion_of(request).company_delete, org, attempt_id, actor_id=auth.session.user.id)
    return JSONResponse({"attempt_id": attempt_id, "attempts_erased": erased}, headers=NO_STORE)


@router.get("/api/v1/company/templates/{template_id}/cohort", operation_id="getCohort")
async def get_cohort(request: Request, template_id: Annotated[str, Path(pattern=TEMPLATE_ID)], auth: Authenticated = Depends(recruiter_read)) -> JSONResponse:
    org = await my_org(request, auth)
    _, assessments = parts(request)
    lab = getattr(request.app.state, "lab", None)
    if lab is None or getattr(lab, "cohort", None) is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    template = await run(assessments.get_template, auth.session.scope, template_id.lower())
    view = await run(lab.cohort.cohort, org, org, template.template_id, template.cohort_board)

    def when(value: Any) -> str | None:
        return None if value is None else timestamp(value)

    return JSONResponse({"template_id": template.template_id, "label": view.rows[0].label if view.rows else "ranking aid, the recruiter decides",
                         "items": [{"position": r.position, "attempt_id": r.attempt_id, "score": r.shown, "full_captures": r.full_captures, "hint_cost_units": r.hint_cost_units,
                                    "active_seconds": r.active_seconds, "last_capture_at": when(r.last_capture_at), "reason": r.reason} for r in view.rows]}, headers=NO_STORE)
